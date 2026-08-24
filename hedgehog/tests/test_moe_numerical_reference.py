#!/usr/bin/env python3
"""Unit and Numerical Reference Tests for MoE Computation & Parity."""

from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HEDGEHOG_DIR))

from moe.topology import ClusterTopology
from moe.model_config import MoEModelConfig
from moe.expert_placement import PlacementEngine
from moe.reference import SingleProcessMoEReference, silu, gelu, SwiGLUExpert, GeluExpert
from moe.distributed_layer import DistributedMoELayerSim


class MoENumericalReferenceTests(unittest.TestCase):
    def setUp(self):
        self.topology = ClusterTopology.create_synthetic_cluster(num_nodes=4, gpus_per_node=4)

    def test_activation_functions(self):
        self.assertAlmostEqual(silu(0.0), 0.0, places=6)
        self.assertAlmostEqual(silu(1.0), 0.7310585786, places=6)
        self.assertAlmostEqual(silu(-1.0), -0.268941421, places=6)

        self.assertAlmostEqual(gelu(0.0), 0.0, places=6)
        self.assertAlmostEqual(gelu(1.0), 0.841192, places=4)
        self.assertAlmostEqual(gelu(-1.0), -0.158808, places=4)

    def test_swiglu_and_gelu_expert_forward(self):
        d, h = 16, 32
        rng = random.Random(42)
        w1 = [[rng.uniform(-0.1, 0.1) for _ in range(h)] for _ in range(d)]
        w_gate = [[rng.uniform(-0.1, 0.1) for _ in range(h)] for _ in range(d)]
        w2 = [[rng.uniform(-0.1, 0.1) for _ in range(d)] for _ in range(h)]
        
        swiglu = SwiGLUExpert(w1=w1, w_gate=w_gate, w2=w2)
        x = [rng.uniform(-1.0, 1.0) for _ in range(d)]
        out_swiglu = swiglu.forward(x)
        self.assertEqual(len(out_swiglu), d)
        self.assertTrue(all(isinstance(v, float) for v in out_swiglu))

        gelu_exp = GeluExpert(w1=w1, w2=w2)
        out_gelu = gelu_exp.forward(x)
        self.assertEqual(len(out_gelu), d)
        self.assertTrue(all(isinstance(v, float) for v in out_gelu))

    def test_numerical_parity_swiglu_top2(self):
        config = MoEModelConfig(
            hidden_dim=128,
            ffn_dim=256,
            num_layers=2,
            num_experts=8,
            num_experts_per_token=2,
            activation_type="swiglu",
        )
        plan = PlacementEngine.generate_placement(self.topology, config, num_replicas=1, seed=42)
        ref = SingleProcessMoEReference(config, seed=42)
        sim = DistributedMoELayerSim(config, self.topology, plan, ref)

        rng = random.Random(12345)
        hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(16)]

        for layer in range(config.num_layers):
            is_match, diff = sim.verify_against_reference(layer, hidden_states, tolerance=1e-6)
            self.assertTrue(is_match, f"Layer {layer} numerical mismatch, max_diff={diff}")
            self.assertLessEqual(diff, 1e-6)

    def test_numerical_parity_gelu_top1(self):
        config = MoEModelConfig(
            hidden_dim=64,
            ffn_dim=128,
            num_layers=2,
            num_experts=4,
            num_experts_per_token=1,
            activation_type="gelu",
        )
        plan = PlacementEngine.generate_placement(self.topology, config, num_replicas=1, seed=42)
        ref = SingleProcessMoEReference(config, seed=42)
        sim = DistributedMoELayerSim(config, self.topology, plan, ref)

        rng = random.Random(54321)
        hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(8)]

        for layer in range(config.num_layers):
            is_match, diff = sim.verify_against_reference(layer, hidden_states, tolerance=1e-6)
            self.assertTrue(is_match, f"Layer {layer} numerical mismatch, max_diff={diff}")
            self.assertLessEqual(diff, 1e-6)

    def test_mutation_triggers_failure(self):
        config = MoEModelConfig(
            hidden_dim=64,
            ffn_dim=128,
            num_layers=1,
            num_experts=4,
            num_experts_per_token=2,
        )
        plan = PlacementEngine.generate_placement(self.topology, config, num_replicas=1, seed=42)
        ref = SingleProcessMoEReference(config, seed=42)
        sim = DistributedMoELayerSim(config, self.topology, plan, ref)

        rng = random.Random(999)
        hidden_states = [[rng.uniform(-1.0, 1.0) for _ in range(config.hidden_dim)] for _ in range(8)]

        clean_out = ref.forward_layer(0, hidden_states)
        ref.experts[0][0].w2[0][0] += 50.0  # Mutate expert 0
        mutated_res = sim.execute_layer(0, hidden_states)

        max_diff = max(
            abs(mutated_res.output_activations[t][d] - clean_out[t][d])
            for t in range(len(clean_out))
            for d in range(len(clean_out[0]))
        )
        self.assertGreater(max_diff, 0.1, "Mutation must trigger significant divergence")


if __name__ == "__main__":
    unittest.main()
