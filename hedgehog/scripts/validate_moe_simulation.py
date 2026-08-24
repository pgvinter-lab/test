#!/usr/bin/env python3
"""Validation Script for Hedgehog Distributed MoE Simulation & Numerical Reference."""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path
from typing import Any

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HEDGEHOG_DIR))

from moe.topology import ClusterTopology
from moe.model_config import MoEModelConfig
from moe.expert_placement import PlacementEngine, PlacementPolicy
from moe.router import MoERouter, OverflowPolicy
from moe.reference import SingleProcessMoEReference
from moe.distributed_layer import DistributedMoELayerSim


def validate_deterministic_placement() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(num_layers=4, num_experts=16, num_experts_per_token=2)
    
    plan1 = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    plan2 = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    
    errors = plan1.validate_placement()
    if errors:
        return {"outcome": "fail", "details": f"Placement validation failed: {errors}"}
    
    # Check bit-exact deterministic reproducibility
    for key in plan1.locations:
        loc1 = plan1.locations[key]
        loc2 = plan2.locations[key]
        if loc1.primary_node != loc2.primary_node or loc1.replica_nodes != loc2.replica_nodes:
            return {"outcome": "fail", "details": f"Non-deterministic placement for {key}"}
        if loc1.primary_node in loc1.replica_nodes:
            return {"outcome": "fail", "details": f"Primary node in replicas for {key}"}

    return {
        "outcome": "pass",
        "details": f"Deterministic placement validated: {len(plan1.locations)} expert slots placed across 4 nodes with zero errors.",
    }


def validate_routing_determinism() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(hidden_dim=128, ffn_dim=256, num_layers=2, num_experts=8, num_experts_per_token=2)
    plan = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    router = MoERouter(config, plan, overflow_policy=OverflowPolicy.BUFFER, seed=42)
    
    rng = random.Random(999)
    hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(32)]
    gw = [[rng.uniform(-0.1, 0.1) for _ in range(config.num_experts)] for _ in range(config.hidden_dim)]
    
    decisions1, stats1 = router.route_tokens(0, hidden_states, gw)
    decisions2, stats2 = router.route_tokens(0, hidden_states, gw)
    
    if len(decisions1) != len(decisions2):
        return {"outcome": "fail", "details": "Decision length mismatch"}
    
    for d1, d2 in zip(decisions1, decisions2):
        if d1.selected_experts != d2.selected_experts:
            return {"outcome": "fail", "details": "Non-deterministic expert selection"}
        for w1, w2 in zip(d1.routing_weights, d2.routing_weights):
            if abs(w1 - w2) > 1e-12:
                return {"outcome": "fail", "details": f"Weight mismatch {w1} vs {w2}"}

    return {
        "outcome": "pass",
        "details": f"Routing determinism verified for 32 tokens across 8 experts (CV={stats1.coefficient_of_variation:.4f}).",
    }


def validate_capacity_and_overflow_policy() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(hidden_dim=64, ffn_dim=128, num_layers=1, num_experts=4, num_experts_per_token=1, expert_capacity_factor=1.0)
    plan = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    
    # Intentionally skew gating weights to send all tokens to expert 0
    gw = [[0.0] * 4 for _ in range(64)]
    for i in range(64):
        gw[i][0] = 5.0  # Massive bias for expert 0
    
    hidden_states = [[1.0] * 64 for _ in range(40)]  # 40 tokens
    
    # 1. Under DROP policy, capacity = ceil((40 * 1 / 4) * 1.0) = 10 tokens. Excess 30 must be dropped.
    drop_router = MoERouter(config, plan, overflow_policy=OverflowPolicy.DROP, seed=42)
    decisions_drop, stats_drop = drop_router.route_tokens(0, hidden_states, gw)
    
    if stats_drop.dropped_tokens_count != 30:
        return {
            "outcome": "fail",
            "details": f"DROP policy failed: expected 30 dropped, got {stats_drop.dropped_tokens_count}",
        }
    
    # 2. Under BUFFER policy, 0 dropped, all 40 routed
    buffer_router = MoERouter(config, plan, overflow_policy=OverflowPolicy.BUFFER, seed=42)
    decisions_buf, stats_buf = buffer_router.route_tokens(0, hidden_states, gw)
    if stats_buf.dropped_tokens_count != 0 or stats_buf.total_routed_expert_tokens != 40:
        return {
            "outcome": "fail",
            "details": f"BUFFER policy failed: dropped {stats_buf.dropped_tokens_count}, routed {stats_buf.total_routed_expert_tokens}",
        }

    return {
        "outcome": "pass",
        "details": "Capacity factor enforcement verified: DROP policy dropped 30/40 skewed tokens; BUFFER policy preserved all 40 tokens.",
    }


def validate_worker_loss_failover() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(hidden_dim=128, ffn_dim=256, num_layers=2, num_experts=8, num_experts_per_token=2)
    plan = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    ref = SingleProcessMoEReference(config, seed=42)
    sim = DistributedMoELayerSim(config, topo, plan, ref, overflow_policy=OverflowPolicy.BUFFER)
    
    rng = random.Random(777)
    hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(20)]
    
    # Simulate loss of node-1
    active_nodes = {"node-0", "node-2", "node-3"}
    res = sim.execute_layer(0, hidden_states, active_nodes=active_nodes)
    
    if res.routing_stats.dropped_tokens_count != 0:
        return {
            "outcome": "fail",
            "details": f"Failover dropped tokens: {res.routing_stats.dropped_tokens_count}",
        }
    if res.routing_stats.rerouted_tokens_count == 0:
        return {
            "outcome": "fail",
            "details": "Expected rerouted tokens during worker loss, but got 0",
        }
    if "node-1" in res.active_nodes or "node-1" not in res.failed_nodes:
        return {
            "outcome": "fail",
            "details": f"Failed node tracking incorrect: active={res.active_nodes}, failed={res.failed_nodes}",
        }

    return {
        "outcome": "pass",
        "details": f"Worker loss failover verified: node-1 loss successfully rerouted {res.routing_stats.rerouted_tokens_count} tokens to standby replicas with 0 dropped tokens.",
    }


def validate_numerical_reference_parity() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(
        hidden_dim=256,
        ffn_dim=512,
        num_layers=4,
        num_experts=16,
        num_experts_per_token=2,
        activation_type="swiglu",
    )
    plan = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    ref = SingleProcessMoEReference(config, seed=42)
    sim = DistributedMoELayerSim(config, topo, plan, ref)
    
    rng = random.Random(54321)
    hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(16)]
    
    max_observed_diff = 0.0
    for layer in range(config.num_layers):
        is_match, diff = sim.verify_against_reference(layer, hidden_states, tolerance=1e-6)
        if not is_match:
            return {
                "outcome": "fail",
                "details": f"Numerical divergence in layer {layer}: max_diff={diff}",
            }
        if diff > max_observed_diff:
            max_observed_diff = diff

    return {
        "outcome": "pass",
        "details": f"Golden numerical reference parity verified across {config.num_layers} layers (max absolute diff = {max_observed_diff:.2e} <= 1e-6).",
    }


def validate_mutation_rejection() -> dict[str, Any]:
    topo = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
    config = MoEModelConfig(hidden_dim=128, ffn_dim=256, num_layers=2, num_experts=8, num_experts_per_token=2)
    plan = PlacementEngine.generate_placement(topo, config, num_replicas=1, seed=42)
    ref = SingleProcessMoEReference(config, seed=42)
    sim = DistributedMoELayerSim(config, topo, plan, ref)
    
    rng = random.Random(101)
    hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(8)]
    
    # 1. Mutate gating weight
    corrupted_gw = [row[:] for row in ref.gating_weights[0]]
    corrupted_gw[0][0] += 100.0  # Corrupt gating logit
    
    decisions, stats = sim.router.route_tokens(0, hidden_states, corrupted_gw)
    clean_decisions, _ = sim.router.route_tokens(0, hidden_states, ref.gating_weights[0])
    
    mutated_diffs = sum(
        1 for d1, d2 in zip(decisions, clean_decisions)
        if d1.selected_experts != d2.selected_experts
    )
    if mutated_diffs == 0:
        return {"outcome": "fail", "details": "Gating weight mutation was not detected"}

    # 2. Mutate expert weights and ensure divergence from clean reference output
    clean_ref_outputs = ref.forward_layer(0, hidden_states)
    ref.experts[0][0].w2[0][0] += 50.0  # Corrupt expert 0 w2
    mutated_sim_result = sim.execute_layer(0, hidden_states)
    
    max_mut_diff = max(
        abs(mutated_sim_result.output_activations[t][d] - clean_ref_outputs[t][d])
        for t in range(len(clean_ref_outputs))
        for d in range(len(clean_ref_outputs[0]))
    )
    
    if max_mut_diff < 0.1:
        return {
            "outcome": "fail",
            "details": f"Expert weight mutation did not produce expected divergence (max_diff={max_mut_diff})",
        }

    return {
        "outcome": "pass",
        "details": f"Mutation rejection verified: corruptions in gating and expert weights reliably produced detectable differences (diff={max_mut_diff:.4f} > 0.1).",
    }


def run_all_validations() -> dict[str, Any]:
    checks = [
        ("Deterministic Expert Placement & Replication", validate_deterministic_placement),
        ("Token Routing Determinism & Top-K Softmax", validate_routing_determinism),
        ("MoE Capacity Factor & Overflow Policy", validate_capacity_and_overflow_policy),
        ("Worker Loss Detection & Failover Recovery", validate_worker_loss_failover),
        ("Golden Numerical Reference Parity", validate_numerical_reference_parity),
        ("Injected Mutation Rejection", validate_mutation_rejection),
    ]
    
    results = []
    all_passed = True
    for name, func in checks:
        res = func()
        results.append({
            "name": name,
            "outcome": res["outcome"],
            "details": res["details"],
        })
        if res["outcome"] != "pass":
            all_passed = False
            
    return {
        "status": "pass" if all_passed else "fail",
        "checks": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Hedgehog MoE Simulation & Numerical Reference")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    summary = run_all_validations()
    
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("=== Hedgehog Distributed MoE Simulation Validation ===")
        for check in summary["checks"]:
            mark = "[PASS]" if check["outcome"] == "pass" else "[FAIL]"
            print(f"{mark} {check['name']}: {check['details']}")
        print(f"Overall Status: {summary['status'].upper()}")

    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
