#!/usr/bin/env python3
"""Unit tests for Topology-Aware Static Expert Placement & Replication."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HEDGEHOG_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HEDGEHOG_DIR))

from moe.topology import ClusterTopology, NodeSpec, GpuSpec
from moe.model_config import MoEModelConfig
from moe.expert_placement import (
    ExpertPlacementPlan,
    PlacementEngine,
    PlacementPolicy,
    ExpertLocation,
)


class MoEExpertPlacementTests(unittest.TestCase):
    def setUp(self):
        self.topology = ClusterTopology.create_synthetic_cluster(
            num_nodes=4,
            gpus_per_node=4,
            ram_gb_per_node=512,
            vram_gb_per_gpu=16,
        )
        self.model_config = MoEModelConfig(
            hidden_dim=256,
            ffn_dim=512,
            num_layers=4,
            num_experts=16,
            num_experts_per_token=2,
        )

    def test_topology_validation_passes(self):
        errors = self.topology.validate_topology()
        self.assertEqual(errors, [], f"Topology validation failed: {errors}")
        self.assertEqual(len(self.topology.nodes), 4)
        self.assertEqual(self.topology.total_gpus(), 16)
        self.assertEqual(self.topology.total_ram_bytes(), 4 * 512 * (1024**3))
        self.assertEqual(self.topology.total_vram_bytes(), 16 * 16 * (1024**3))

    def test_deterministic_placement_reproducibility(self):
        plan1 = PlacementEngine.generate_placement(
            self.topology, self.model_config, num_replicas=1, seed=42
        )
        plan2 = PlacementEngine.generate_placement(
            self.topology, self.model_config, num_replicas=1, seed=42
        )
        self.assertEqual(plan1.validate_placement(), [])
        self.assertEqual(plan2.validate_placement(), [])
        
        for key in plan1.locations:
            loc1 = plan1.locations[key]
            loc2 = plan2.locations[key]
            self.assertEqual(loc1.primary_node, loc2.primary_node)
            self.assertEqual(loc1.primary_device, loc2.primary_device)
            self.assertEqual(loc1.replica_nodes, loc2.replica_nodes)
            self.assertEqual(loc1.is_vram_resident, loc2.is_vram_resident)

    def test_replica_failure_domain_isolation(self):
        plan = PlacementEngine.generate_placement(
            self.topology, self.model_config, num_replicas=2, seed=123
        )
        self.assertEqual(plan.validate_placement(), [])
        
        for (layer, exp), loc in plan.locations.items():
            self.assertNotIn(
                loc.primary_node,
                loc.replica_nodes,
                f"Primary node {loc.primary_node} found in replica nodes for layer {layer} expert {exp}",
            )
            self.assertEqual(
                len(set(loc.replica_nodes)),
                len(loc.replica_nodes),
                f"Duplicate replica nodes for layer {layer} expert {exp}",
            )

    def test_failover_owner_resolution(self):
        plan = PlacementEngine.generate_placement(
            self.topology, self.model_config, num_replicas=1, seed=42
        )
        loc = plan.get_location(0, 0)
        primary = loc.primary_node
        replica = loc.replica_nodes[0]

        # Case 1: All nodes active
        owner, dev, is_rep = plan.get_owner(0, 0, active_nodes={"node-0", "node-1", "node-2", "node-3"})
        self.assertEqual(owner, primary)
        self.assertFalse(is_rep)

        # Case 2: Primary node fails -> failover to replica
        surviving = {"node-0", "node-1", "node-2", "node-3"} - {primary}
        owner, dev, is_rep = plan.get_owner(0, 0, active_nodes=surviving)
        self.assertEqual(owner, replica)
        self.assertTrue(is_rep)

        # Case 3: Both primary and replica fail -> unavailable
        owner, dev, is_rep = plan.get_owner(0, 0, active_nodes=set())
        self.assertEqual(owner, "")
        self.assertFalse(is_rep)

    def test_placement_policies(self):
        for policy in [
            PlacementPolicy.BALANCED_ROUND_ROBIN,
            PlacementPolicy.NUMA_AWARE,
            PlacementPolicy.VRAM_PACKED,
        ]:
            plan = PlacementEngine.generate_placement(
                self.topology, self.model_config, num_replicas=1, policy=policy, seed=42
            )
            self.assertEqual(plan.validate_placement(), [])
            counts = plan.node_expert_counts()
            for nid, count in counts.items():
                self.assertGreater(count["total"], 0)


if __name__ == "__main__":
    unittest.main()
