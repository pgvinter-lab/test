#!/usr/bin/env python3
"""Benchmark Harness for Distributed MoE Activation Routing & Memory Footprints."""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
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


def benchmark_cluster_scaling(
    node_scales: list[int] = [1, 2, 4, 8],
    num_experts: int = 64,
    hidden_dim: int = 4096,
    batch_tokens: int = 128,
    seed: int = 42,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    
    config = MoEModelConfig(
        hidden_dim=hidden_dim,
        ffn_dim=14336,
        num_layers=1,
        num_experts=num_experts,
        num_experts_per_token=2,
        expert_capacity_factor=1.25,
        dtype="float16",
    )
    
    rng = random.Random(seed)
    hidden_states = [
        [rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)]
        for _ in range(batch_tokens)
    ]
    
    for num_nodes in node_scales:
        topo = ClusterTopology.create_synthetic_cluster(
            num_nodes=num_nodes,
            gpus_per_node=4,
            bandwidth_gbps=100.0,
            base_latency_us=2.5,
        )
        plan = PlacementEngine.generate_placement(
            topology=topo,
            model_config=config,
            num_replicas=min(1, num_nodes - 1) if num_nodes > 1 else 0,
            policy=PlacementPolicy.BALANCED_ROUND_ROBIN,
            seed=seed,
        )
        
        gw = [
            [rng.uniform(-0.01, 0.01) for _ in range(config.num_experts)]
            for _ in range(config.hidden_dim)
        ]
        
        router = MoERouter(config, plan, overflow_policy=OverflowPolicy.BUFFER, seed=seed)
        
        t0 = time.perf_counter()
        decisions, stats = router.route_tokens(0, hidden_states, gw)
        routing_elapsed_us = (time.perf_counter() - t0) * 1e6
        
        # Calculate network transfer metrics
        coordinator_node = topo.node_ids()[0]
        remote_tokens = sum(
            1 for d in decisions for n in d.assigned_nodes if n != coordinator_node
        )
        tok_bytes = config.activation_bytes_per_token()
        total_net_bytes = remote_tokens * (2 * tok_bytes)  # Request + Response
        
        bw_bytes_per_sec = (topo.interconnect_bandwidth_gbps * 1e9) / 8.0
        serialization_us = (total_net_bytes / max(1.0, bw_bytes_per_sec)) * 1e6
        sim_net_lat_us = topo.base_network_latency_us + serialization_us if remote_tokens > 0 else 0.0
        
        results.append({
            "num_nodes": num_nodes,
            "total_gpus": topo.total_gpus(),
            "total_vram_gb": round(topo.total_vram_bytes() / (1024**3), 2),
            "total_ram_gb": round(topo.total_ram_bytes() / (1024**3), 2),
            "num_experts": num_experts,
            "batch_tokens": batch_tokens,
            "remote_dispatched_tokens": remote_tokens,
            "simulated_network_bytes": total_net_bytes,
            "simulated_network_kb": round(total_net_bytes / 1024, 2),
            "simulated_network_latency_us": round(sim_net_lat_us, 2),
            "routing_time_us": round(routing_elapsed_us, 2),
            "load_imbalance_ratio": round(stats.load_imbalance_ratio, 4),
            "coefficient_of_variation": round(stats.coefficient_of_variation, 4),
        })
        
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark MoE Activation Routing & Scaling")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    benchmarks = benchmark_cluster_scaling()
    
    if args.json:
        print(json.dumps({"status": "pass", "benchmarks": benchmarks}, indent=2))
    else:
        print("=== Hedgehog Distributed MoE Activation Routing Benchmarks ===")
        for b in benchmarks:
            print(
                f"Nodes: {b['num_nodes']:2d} | GPUs: {b['total_gpus']:2d} | "
                f"Net Bytes: {b['simulated_network_kb']:6.1f} KB | "
                f"Sim RTT: {b['simulated_network_latency_us']:5.2f} us | "
                f"Routing: {b['routing_time_us']:5.1f} us | "
                f"Imbalance: {b['load_imbalance_ratio']:.2f}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
