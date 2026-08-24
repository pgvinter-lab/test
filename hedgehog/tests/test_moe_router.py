#!/usr/bin/env python3
"""Unit tests for MoE Token Dispatch, Top-K Gating, and Backpressure Router."""

from __future__ import annotations

import math
import random
import sys
import unittest
from pathlib import Path

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HEDGEHOG_DIR))

from moe.topology import ClusterTopology
from moe.model_config import MoEModelConfig
from moe.expert_placement import PlacementEngine
from moe.router import MoERouter, OverflowPolicy


class MoERouterTests(unittest.TestCase):
    def setUp(self):
        self.topology = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)
        self.model_config = MoEModelConfig(
            hidden_dim=128,
            ffn_dim=256,
            num_layers=2,
            num_experts=8,
            num_experts_per_token=2,
            expert_capacity_factor=1.25,
        )
        self.plan = PlacementEngine.generate_placement(
            self.topology, self.model_config, num_replicas=1, seed=42
        )
        self.router = MoERouter(
            self.model_config, self.plan, overflow_policy=OverflowPolicy.BUFFER, seed=42
        )

    def test_softmax_topk_properties(self):
        logits = [2.0, 1.0, 5.0, 0.5, 3.0, -1.0, 4.0, 0.0]
        top_indices, top_weights = self.router._softmax_topk(logits, k=2)
        
        # 5.0 is index 2, 4.0 is index 6
        self.assertEqual(top_indices, [2, 6])
        self.assertAlmostEqual(sum(top_weights), 1.0, places=6)
        self.assertGreater(top_weights[0], top_weights[1])

    def test_routing_determinism(self):
        rng = random.Random(1001)
        hidden_states = [
            [rng.uniform(-1.0, 1.0) for _ in range(self.model_config.hidden_dim)]
            for _ in range(16)
        ]
        gw = [
            [rng.uniform(-0.1, 0.1) for _ in range(self.model_config.num_experts)]
            for _ in range(self.model_config.hidden_dim)
        ]
        
        decisions1, stats1 = self.router.route_tokens(0, hidden_states, gw)
        decisions2, stats2 = self.router.route_tokens(0, hidden_states, gw)
        
        self.assertEqual(len(decisions1), len(decisions2))
        for d1, d2 in zip(decisions1, decisions2):
            self.assertEqual(d1.token_id, d2.token_id)
            self.assertEqual(d1.selected_experts, d2.selected_experts)
            self.assertEqual(d1.assigned_nodes, d2.assigned_nodes)
            for w1, w2 in zip(d1.routing_weights, d2.routing_weights):
                self.assertAlmostEqual(w1, w2, places=8)

    def test_capacity_drop_overflow_policy(self):
        config = MoEModelConfig(
            hidden_dim=32,
            ffn_dim=64,
            num_layers=1,
            num_experts=4,
            num_experts_per_token=1,
            expert_capacity_factor=1.0,
        )
        plan = PlacementEngine.generate_placement(self.topology, config, num_replicas=1, seed=42)
        drop_router = MoERouter(config, plan, overflow_policy=OverflowPolicy.DROP, seed=42)
        
        # Bias gating so all tokens route to expert 0
        gw = [[0.0] * 4 for _ in range(32)]
        for i in range(32):
            gw[i][0] = 10.0
            
        hidden_states = [[1.0] * 32 for _ in range(20)]  # 20 tokens, capacity = ceil(20*1/4) = 5
        decisions, stats = drop_router.route_tokens(0, hidden_states, gw)
        
        self.assertEqual(stats.total_tokens, 20)
        self.assertEqual(stats.total_routed_expert_tokens, 5)
        self.assertEqual(stats.dropped_tokens_count, 15)

    def test_worker_loss_failover_routing(self):
        rng = random.Random(2026)
        hidden_states = [
            [rng.uniform(-1.0, 1.0) for _ in range(self.model_config.hidden_dim)]
            for _ in range(16)
        ]
        gw = [
            [rng.uniform(-0.1, 0.1) for _ in range(self.model_config.num_experts)]
            for _ in range(self.model_config.hidden_dim)
        ]
        
        # Kill node-0
        active_nodes = {"node-1", "node-2", "node-3"}
        decisions, stats = self.router.route_tokens(0, hidden_states, gw, active_nodes=active_nodes)
        
        self.assertGreater(stats.rerouted_tokens_count, 0)
        self.assertEqual(stats.dropped_tokens_count, 0)
        for d in decisions:
            self.assertNotIn("node-0", d.assigned_nodes)


if __name__ == "__main__":
    unittest.main()
