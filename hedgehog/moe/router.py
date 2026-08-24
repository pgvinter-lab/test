"""Deterministic Token Dispatch, Top-K Gating, and Backpressure Router."""

from __future__ import annotations

import dataclasses
import enum
import math
import random
from typing import Any

from .model_config import MoEModelConfig
from .expert_placement import ExpertPlacementPlan


class OverflowPolicy(str, enum.Enum):
    DROP = "drop"
    BUFFER = "buffer"
    UNBOUNDED = "unbounded"


@dataclasses.dataclass
class RoutingDecision:
    token_id: int
    selected_experts: list[int]
    routing_weights: list[float]
    assigned_nodes: list[str]
    dropped_experts: list[int]
    is_rerouted: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "token_id": self.token_id,
            "selected_experts": self.selected_experts,
            "routing_weights": [round(w, 6) for w in self.routing_weights],
            "assigned_nodes": self.assigned_nodes,
            "dropped_experts": self.dropped_experts,
            "is_rerouted": self.is_rerouted,
        }


@dataclasses.dataclass
class RoutingStats:
    total_tokens: int
    total_routed_expert_tokens: int
    dropped_tokens_count: int
    rerouted_tokens_count: int
    per_expert_token_counts: dict[int, int]
    per_node_token_counts: dict[str, int]
    load_imbalance_ratio: float
    coefficient_of_variation: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_tokens": self.total_tokens,
            "total_routed_expert_tokens": self.total_routed_expert_tokens,
            "dropped_tokens_count": self.dropped_tokens_count,
            "rerouted_tokens_count": self.rerouted_tokens_count,
            "load_imbalance_ratio": round(self.load_imbalance_ratio, 4),
            "coefficient_of_variation": round(self.coefficient_of_variation, 4),
            "per_expert_token_counts": {
                str(k): v for k, v in sorted(self.per_expert_token_counts.items())
            },
            "per_node_token_counts": self.per_node_token_counts,
        }


class MoERouter:
    def __init__(
        self,
        model_config: MoEModelConfig,
        placement_plan: ExpertPlacementPlan,
        overflow_policy: OverflowPolicy = OverflowPolicy.BUFFER,
        seed: int = 42,
    ) -> None:
        self.config = model_config
        self.placement = placement_plan
        self.overflow_policy = overflow_policy
        self.rng = random.Random(seed)

    @staticmethod
    def _matvec(matrix: list[list[float]], vec: list[float]) -> list[float]:
        # matrix is D x E, vec is length D. Output is length E.
        d = len(vec)
        e = len(matrix[0])
        out = [0.0] * e
        for i in range(d):
            xi = vec[i]
            if xi != 0.0:
                row = matrix[i]
                for j in range(e):
                    out[j] += xi * row[j]
        return out

    @staticmethod
    def _softmax_topk(logits: list[float], k: int) -> tuple[list[int], list[float]]:
        indexed = sorted(enumerate(logits), key=lambda x: x[1], reverse=True)
        topk = indexed[:k]
        top_indices = [idx for idx, _ in topk]
        top_logits = [val for _, val in topk]

        max_logit = max(top_logits) if top_logits else 0.0
        exp_vals = [math.exp(v - max_logit) for v in top_logits]
        sum_exp = sum(exp_vals)
        if sum_exp > 0:
            weights = [v / sum_exp for v in exp_vals]
        else:
            weights = [1.0 / k] * k
        return top_indices, weights

    def compute_gating_logits(
        self,
        hidden_states: list[list[float]],
        gating_weights: list[list[float]],
    ) -> list[list[float]]:
        # hidden_states: T x D, gating_weights: D x E
        return [self._matvec(gating_weights, tok) for tok in hidden_states]

    def route_tokens(
        self,
        layer_id: int,
        hidden_states: list[list[float]],
        gating_weights: list[list[float]],
        active_nodes: set[str] | None = None,
    ) -> tuple[list[RoutingDecision], RoutingStats]:
        num_tokens = len(hidden_states)
        k = self.config.num_experts_per_token
        num_experts = self.config.num_experts

        if self.overflow_policy == OverflowPolicy.UNBOUNDED:
            expert_capacity = 999999999
        else:
            # Standard MoE capacity factor formula
            tokens_per_expert = (num_tokens * k) / max(1, num_experts)
            expert_capacity = max(1, math.ceil(tokens_per_expert * self.config.expert_capacity_factor))

        logits_list = self.compute_gating_logits(hidden_states, gating_weights)
        decisions: list[RoutingDecision] = []

        expert_token_counts: dict[int, int] = {e: 0 for e in range(num_experts)}
        node_token_counts: dict[str, int] = {nid: 0 for nid in self.placement.topology.node_ids()}
        total_dropped = 0
        total_rerouted = 0
        total_routed_expert_tokens = 0

        for t_idx, logits in enumerate(logits_list):
            top_indices, top_weights = self._softmax_topk(logits, k)

            assigned_nodes: list[str] = []
            dropped_experts: list[int] = []
            is_rerouted_token = False

            for exp_id in top_indices:
                curr_count = expert_token_counts[exp_id]
                if curr_count >= expert_capacity and self.overflow_policy == OverflowPolicy.DROP:
                    dropped_experts.append(exp_id)
                    total_dropped += 1
                    continue

                owner_node, _, is_replica = self.placement.get_owner(
                    layer_id, exp_id, active_nodes=active_nodes
                )

                if not owner_node:
                    # Node failed and no replica available
                    dropped_experts.append(exp_id)
                    total_dropped += 1
                    continue

                if is_replica:
                    is_rerouted_token = True
                    total_rerouted += 1

                assigned_nodes.append(owner_node)
                expert_token_counts[exp_id] += 1
                node_token_counts[owner_node] += 1
                total_routed_expert_tokens += 1

            decisions.append(
                RoutingDecision(
                    token_id=t_idx,
                    selected_experts=top_indices,
                    routing_weights=top_weights,
                    assigned_nodes=assigned_nodes,
                    dropped_experts=dropped_experts,
                    is_rerouted=is_rerouted_token,
                )
            )

        # Imbalance metrics
        loads = list(expert_token_counts.values())
        mean_load = sum(loads) / max(1, len(loads))
        max_load = max(loads) if loads else 0
        imbalance_ratio = (max_load / mean_load) if mean_load > 0 else 1.0

        variance = sum((x - mean_load) ** 2 for x in loads) / max(1, len(loads))
        std_dev = math.sqrt(variance)
        cv = (std_dev / mean_load) if mean_load > 0 else 0.0

        stats = RoutingStats(
            total_tokens=num_tokens,
            total_routed_expert_tokens=total_routed_expert_tokens,
            dropped_tokens_count=total_dropped,
            rerouted_tokens_count=total_rerouted,
            per_expert_token_counts=expert_token_counts,
            per_node_token_counts=node_token_counts,
            load_imbalance_ratio=imbalance_ratio,
            coefficient_of_variation=cv,
        )

        return decisions, stats
