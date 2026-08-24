"""Topology-Aware Static Expert Placement and Replication for MoE."""

from __future__ import annotations

import dataclasses
import enum
import random
from typing import Any

from .topology import ClusterTopology
from .model_config import MoEModelConfig


class PlacementPolicy(str, enum.Enum):
    BALANCED_ROUND_ROBIN = "balanced_round_robin"
    NUMA_AWARE = "numa_aware"
    VRAM_PACKED = "vram_packed"


@dataclasses.dataclass
class ExpertLocation:
    layer_id: int
    expert_id: int
    primary_node: str
    primary_device: str
    is_vram_resident: bool
    replica_nodes: list[str]
    replica_devices: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "layer_id": self.layer_id,
            "expert_id": self.expert_id,
            "primary_node": self.primary_node,
            "primary_device": self.primary_device,
            "is_vram_resident": self.is_vram_resident,
            "replica_nodes": self.replica_nodes,
            "replica_devices": self.replica_devices,
        }


@dataclasses.dataclass
class ExpertPlacementPlan:
    topology: ClusterTopology
    model_config: MoEModelConfig
    locations: dict[tuple[int, int], ExpertLocation]
    policy: PlacementPolicy = PlacementPolicy.BALANCED_ROUND_ROBIN

    def get_location(self, layer_id: int, expert_id: int) -> ExpertLocation:
        key = (layer_id, expert_id)
        if key not in self.locations:
            raise KeyError(f"Expert (layer={layer_id}, expert={expert_id}) not placed")
        return self.locations[key]

    def get_owner(
        self,
        layer_id: int,
        expert_id: int,
        active_nodes: set[str] | None = None,
    ) -> tuple[str, str, bool]:
        """Returns (node_id, device, is_replica).
        
        If primary node is active, returns (primary_node, primary_device, False).
        If primary is inactive/failed, attempts failover to first available replica.
        If no replicas are available, returns ('', '', False).
        """
        loc = self.get_location(layer_id, expert_id)
        if active_nodes is None or loc.primary_node in active_nodes:
            return (loc.primary_node, loc.primary_device, False)

        # Failover to replica
        for r_node, r_dev in zip(loc.replica_nodes, loc.replica_devices):
            if r_node in active_nodes:
                return (r_node, r_dev, True)

        return ("", "", False)

    def validate_placement(self) -> list[str]:
        errors: list[str] = []
        node_ids = set(self.topology.node_ids())

        # Check all experts placed
        for layer in range(self.model_config.num_layers):
            for expert in range(self.model_config.num_experts):
                key = (layer, expert)
                if key not in self.locations:
                    errors.append(f"Missing placement for layer {layer} expert {expert}")
                    continue
                loc = self.locations[key]
                if loc.primary_node not in node_ids:
                    errors.append(f"Invalid primary node {loc.primary_node!r} for {key}")
                if loc.primary_node in loc.replica_nodes:
                    errors.append(f"Primary node {loc.primary_node} cannot be in replica nodes for {key}")
                if len(set(loc.replica_nodes)) != len(loc.replica_nodes):
                    errors.append(f"Duplicate replica nodes for {key}: {loc.replica_nodes}")
                for r_node in loc.replica_nodes:
                    if r_node not in node_ids:
                        errors.append(f"Invalid replica node {r_node!r} for {key}")

        # Check memory footprints
        expert_bytes = self.model_config.bytes_per_expert()
        node_vram_usage: dict[str, int] = {nid: 0 for nid in node_ids}
        node_ram_usage: dict[str, int] = {nid: 0 for nid in node_ids}

        for loc in self.locations.values():
            if loc.is_vram_resident:
                node_vram_usage[loc.primary_node] += expert_bytes
            else:
                node_ram_usage[loc.primary_node] += expert_bytes

            # Replicas consume RAM on replica nodes
            for r_node in loc.replica_nodes:
                node_ram_usage[r_node] += expert_bytes

        for nid in node_ids:
            node = self.topology.get_node(nid)
            if node_vram_usage[nid] > node.total_vram_bytes():
                errors.append(
                    f"Node {nid} VRAM footprint ({node_vram_usage[nid]/(1024**3):.2f} GB) "
                    f"exceeds capacity ({node.total_vram_bytes()/(1024**3):.2f} GB)"
                )
            if node_ram_usage[nid] > node.ram_bytes:
                errors.append(
                    f"Node {nid} RAM footprint ({node_ram_usage[nid]/(1024**3):.2f} GB) "
                    f"exceeds capacity ({node.ram_bytes/(1024**3):.2f} GB)"
                )

        return errors

    def node_expert_counts(self) -> dict[str, dict[str, int]]:
        counts: dict[str, dict[str, int]] = {
            nid: {"primary_vram": 0, "primary_ram": 0, "replicas": 0, "total": 0}
            for nid in self.topology.node_ids()
        }
        for loc in self.locations.values():
            if loc.is_vram_resident:
                counts[loc.primary_node]["primary_vram"] += 1
            else:
                counts[loc.primary_node]["primary_ram"] += 1
            counts[loc.primary_node]["total"] += 1

            for r_node in loc.replica_nodes:
                counts[r_node]["replicas"] += 1
                counts[r_node]["total"] += 1
        return counts

    def to_dict(self) -> dict[str, Any]:
        return {
            "policy": self.policy.value,
            "total_placements": len(self.locations),
            "node_counts": self.node_expert_counts(),
            "model_config": self.model_config.to_dict(),
            "sample_locations": [
                loc.to_dict()
                for key, loc in sorted(self.locations.items())[:8]
            ],
        }


class PlacementEngine:
    @staticmethod
    def generate_placement(
        topology: ClusterTopology,
        model_config: MoEModelConfig,
        num_replicas: int = 1,
        policy: PlacementPolicy = PlacementPolicy.BALANCED_ROUND_ROBIN,
        seed: int = 42,
    ) -> ExpertPlacementPlan:
        node_ids = topology.node_ids()
        if not node_ids:
            raise ValueError("Topology has no nodes")

        if num_replicas >= len(node_ids):
            raise ValueError(
                f"num_replicas ({num_replicas}) must be < node_count ({len(node_ids)}) "
                "for strict failure domain isolation"
            )

        rng = random.Random(seed)
        locations: dict[tuple[int, int], ExpertLocation] = {}
        expert_bytes = model_config.bytes_per_expert()

        # Track VRAM used per GPU across all nodes
        node_gpu_vram_used: dict[str, dict[int, int]] = {
            nid: {g.gpu_id: 0 for g in topology.get_node(nid).gpus}
            for nid in node_ids
        }

        for layer in range(model_config.num_layers):
            for expert in range(model_config.num_experts):
                if policy == PlacementPolicy.BALANCED_ROUND_ROBIN:
                    node_idx = (layer * model_config.num_experts + expert) % len(node_ids)
                    primary_node = node_ids[node_idx]
                elif policy == PlacementPolicy.NUMA_AWARE:
                    # Alternating assignment aligned to NUMA sockets
                    flat_idx = layer * model_config.num_experts + expert
                    node_idx = flat_idx % len(node_ids)
                    primary_node = node_ids[node_idx]
                elif policy == PlacementPolicy.VRAM_PACKED:
                    node_idx = (expert) % len(node_ids)
                    primary_node = node_ids[node_idx]
                else:
                    node_idx = (layer + expert) % len(node_ids)
                    primary_node = node_ids[node_idx]

                node_spec = topology.get_node(primary_node)
                is_vram_resident = False
                primary_device = "cpu:numa0"

                # Check if GPU VRAM can fit this expert
                if node_spec.gpus:
                    # Select GPU with lowest utilization
                    best_gpu = min(
                        node_spec.gpus,
                        key=lambda g: node_gpu_vram_used[primary_node][g.gpu_id],
                    )
                    curr_used = node_gpu_vram_used[primary_node][best_gpu.gpu_id]
                    if curr_used + expert_bytes <= best_gpu.vram_bytes:
                        is_vram_resident = True
                        primary_device = f"gpu:{best_gpu.gpu_id}"
                        node_gpu_vram_used[primary_node][best_gpu.gpu_id] += expert_bytes
                    else:
                        primary_device = f"cpu:numa{best_gpu.numa_node}"
                else:
                    primary_device = "cpu:numa0"

                # Select distinct replica nodes
                remaining_nodes = [nid for nid in node_ids if nid != primary_node]
                # Deterministic shuffle / selection based on seed and expert coordinates
                expert_rng = random.Random(seed + layer * 1000 + expert)
                expert_rng.shuffle(remaining_nodes)
                replica_nodes = remaining_nodes[:num_replicas]
                replica_devices = ["cpu:ram" for _ in replica_nodes]

                locations[(layer, expert)] = ExpertLocation(
                    layer_id=layer,
                    expert_id=expert,
                    primary_node=primary_node,
                    primary_device=primary_device,
                    is_vram_resident=is_vram_resident,
                    replica_nodes=replica_nodes,
                    replica_devices=replica_devices,
                )

        plan = ExpertPlacementPlan(
            topology=topology,
            model_config=model_config,
            locations=locations,
            policy=policy,
        )
        return plan
