"""Distributed MoE Execution Simulation & Numerical Parity Verification."""

from __future__ import annotations

import dataclasses
import math
from typing import Any

from .topology import ClusterTopology
from .model_config import MoEModelConfig
from .expert_placement import ExpertPlacementPlan
from .router import MoERouter, RoutingDecision, RoutingStats, OverflowPolicy
from .reference import SingleProcessMoEReference, SwiGLUExpert, GeluExpert


@dataclasses.dataclass
class DistributedExecutionResult:
    layer_id: int
    output_activations: list[list[float]]
    routing_decisions: list[RoutingDecision]
    routing_stats: RoutingStats
    simulated_network_latency_us: float
    simulated_network_bytes: int
    simulated_compute_time_us: float
    active_nodes: list[str]
    failed_nodes: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "layer_id": self.layer_id,
            "token_count": len(self.output_activations),
            "simulated_network_latency_us": round(self.simulated_network_latency_us, 2),
            "simulated_network_bytes": self.simulated_network_bytes,
            "simulated_network_kb": round(self.simulated_network_bytes / 1024, 2),
            "simulated_compute_time_us": round(self.simulated_compute_time_us, 2),
            "active_nodes": self.active_nodes,
            "failed_nodes": self.failed_nodes,
            "routing_stats": self.routing_stats.to_dict(),
        }


class DistributedMoELayerSim:
    def __init__(
        self,
        model_config: MoEModelConfig,
        topology: ClusterTopology,
        placement_plan: ExpertPlacementPlan,
        reference_engine: SingleProcessMoEReference,
        overflow_policy: OverflowPolicy = OverflowPolicy.BUFFER,
    ) -> None:
        self.config = model_config
        self.topology = topology
        self.placement = placement_plan
        self.reference = reference_engine
        self.router = MoERouter(
            model_config=model_config,
            placement_plan=placement_plan,
            overflow_policy=overflow_policy,
        )

    def execute_layer(
        self,
        layer_id: int,
        hidden_states: list[list[float]],
        active_nodes: set[str] | None = None,
        coordinator_node: str = "node-0",
    ) -> DistributedExecutionResult:
        all_nodes = set(self.topology.node_ids())
        if active_nodes is None:
            active_nodes = all_nodes
        failed_nodes = sorted(list(all_nodes - active_nodes))

        gw = self.reference.gating_weights[layer_id]
        layer_exps = self.reference.experts[layer_id]
        d = self.config.hidden_dim
        num_tokens = len(hidden_states)
        tok_bytes = self.config.activation_bytes_per_token()

        # Step 1: Token Routing & Dispatch Decision
        decisions, stats = self.router.route_tokens(
            layer_id=layer_id,
            hidden_states=hidden_states,
            gating_weights=gw,
            active_nodes=active_nodes,
        )

        # Step 2: Compute Network Traffic & Latency Model
        # Tokens dispatched from coordinator to remote nodes and returned
        remote_dispatches = 0
        for decision in decisions:
            for node in decision.assigned_nodes:
                if node != coordinator_node:
                    remote_dispatches += 1

        # Each remote dispatch transfers:
        # - Request: 1 token activation vector (D * dtype_bytes)
        # - Response: 1 expert output activation vector (D * dtype_bytes)
        network_bytes = remote_dispatches * (2 * tok_bytes)

        # 100Gb fabric model: Latency = Base_RTT + (Bytes / Bandwidth)
        bw_bytes_per_sec = (self.topology.interconnect_bandwidth_gbps * 1e9) / 8.0
        serialization_time_us = (network_bytes / max(1.0, bw_bytes_per_sec)) * 1e6
        simulated_net_latency_us = (
            self.topology.base_network_latency_us + serialization_time_us
            if remote_dispatches > 0
            else 0.0
        )

        # Simulated compute time: rough P100 FLOPS model
        # Expert FLOPS per token = 2 * (params_per_expert)
        expert_flops = 2 * self.config.parameters_per_expert()
        total_flops = stats.total_routed_expert_tokens * expert_flops
        # P100 FP16 peak ~ 18.7 TFLOPS per GPU; assuming 4 GPUs per node
        cluster_gpus = max(1, len(active_nodes) * 4)
        peak_tflops = cluster_gpus * 18.7 * 1e12
        simulated_compute_us = (total_flops / peak_tflops) * 1e6

        # Step 3: Compute Expert Activations & Aggregation
        outputs: list[list[float]] = []

        for t_idx, decision in enumerate(decisions):
            tok = hidden_states[t_idx]
            combined = [0.0] * d

            for exp_idx, weight in zip(decision.selected_experts, decision.routing_weights):
                if exp_idx in decision.dropped_experts:
                    continue  # Dropped or unserviced expert due to capacity/node loss

                exp = layer_exps[exp_idx]
                exp_out = exp.forward(tok)
                for dim_i in range(d):
                    combined[dim_i] += weight * exp_out[dim_i]

            outputs.append(combined)

        return DistributedExecutionResult(
            layer_id=layer_id,
            output_activations=outputs,
            routing_decisions=decisions,
            routing_stats=stats,
            simulated_network_latency_us=simulated_net_latency_us,
            simulated_network_bytes=network_bytes,
            simulated_compute_time_us=simulated_compute_us,
            active_nodes=sorted(list(active_nodes)),
            failed_nodes=failed_nodes,
        )

    def verify_against_reference(
        self,
        layer_id: int,
        hidden_states: list[list[float]],
        tolerance: float = 1e-6,
    ) -> tuple[bool, float]:
        # Reference execution (all nodes active, unbounded capacity)
        ref_outputs = self.reference.forward_layer(layer_id, hidden_states)

        # Distributed simulation execution with unbounded capacity
        sim_result = self.execute_layer(layer_id, hidden_states)
        dist_outputs = sim_result.output_activations

        max_diff = 0.0
        for t in range(len(ref_outputs)):
            for d in range(len(ref_outputs[t])):
                diff = abs(dist_outputs[t][d] - ref_outputs[t][d])
                if diff > max_diff:
                    max_diff = diff

        is_match = max_diff <= tolerance
        return is_match, max_diff
