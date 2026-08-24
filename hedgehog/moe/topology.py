"""Cluster Topology Representation for Project Hedgehog."""

from __future__ import annotations

import dataclasses
from typing import Any


@dataclasses.dataclass
class GpuSpec:
    gpu_id: int
    name: str
    vram_bytes: int
    compute_capability: str
    pcie_gen: int
    numa_node: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "gpu_id": self.gpu_id,
            "name": self.name,
            "vram_bytes": self.vram_bytes,
            "vram_gb": round(self.vram_bytes / (1024**3), 2),
            "compute_capability": self.compute_capability,
            "pcie_gen": self.pcie_gen,
            "numa_node": self.numa_node,
        }


@dataclasses.dataclass
class NodeSpec:
    node_id: str
    hostname: str
    numa_nodes: list[int]
    ram_bytes: int
    gpus: list[GpuSpec]
    ip_address: str
    rack_id: str = "rack-0"

    def total_vram_bytes(self) -> int:
        return sum(gpu.vram_bytes for gpu in self.gpus)

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "hostname": self.hostname,
            "numa_nodes": self.numa_nodes,
            "ram_bytes": self.ram_bytes,
            "ram_gb": round(self.ram_bytes / (1024**3), 2),
            "total_vram_bytes": self.total_vram_bytes(),
            "total_vram_gb": round(self.total_vram_bytes() / (1024**3), 2),
            "gpu_count": len(self.gpus),
            "gpus": [g.to_dict() for g in self.gpus],
            "ip_address": self.ip_address,
            "rack_id": self.rack_id,
        }


@dataclasses.dataclass
class ClusterTopology:
    nodes: dict[str, NodeSpec]
    interconnect_bandwidth_gbps: float = 100.0
    base_network_latency_us: float = 2.5

    def get_node(self, node_id: str) -> NodeSpec:
        if node_id not in self.nodes:
            raise KeyError(f"Node {node_id!r} not found in topology")
        return self.nodes[node_id]

    def node_ids(self) -> list[str]:
        return sorted(self.nodes.keys())

    def total_ram_bytes(self) -> int:
        return sum(n.ram_bytes for n in self.nodes.values())

    def total_vram_bytes(self) -> int:
        return sum(n.total_vram_bytes() for n in self.nodes.values())

    def total_gpus(self) -> int:
        return sum(len(n.gpus) for n in self.nodes.values())

    def validate_topology(self) -> list[str]:
        errors: list[str] = []
        if not self.nodes:
            errors.append("Topology must contain at least one node")
        if self.interconnect_bandwidth_gbps <= 0:
            errors.append("interconnect_bandwidth_gbps must be positive")
        if self.base_network_latency_us < 0:
            errors.append("base_network_latency_us must be non-negative")

        seen_ips = set()
        for node_id, node in self.nodes.items():
            if node.node_id != node_id:
                errors.append(f"Node key {node_id!r} mismatch with spec id {node.node_id!r}")
            if node.ram_bytes <= 0:
                errors.append(f"Node {node_id} has invalid RAM {node.ram_bytes}")
            if node.ip_address in seen_ips:
                errors.append(f"Duplicate IP address {node.ip_address} on node {node_id}")
            seen_ips.add(node.ip_address)
            seen_gpu_ids = set()
            for gpu in node.gpus:
                if gpu.gpu_id in seen_gpu_ids:
                    errors.append(f"Node {node_id} has duplicate GPU ID {gpu.gpu_id}")
                seen_gpu_ids.add(gpu.gpu_id)
                if gpu.vram_bytes <= 0:
                    errors.append(f"Node {node_id} GPU {gpu.gpu_id} has invalid VRAM")
        return errors

    @classmethod
    def create_synthetic_cluster(
        cls,
        num_nodes: int = 4,
        gpus_per_node: int = 4,
        ram_gb_per_node: int = 512,
        vram_gb_per_gpu: int = 16,
        bandwidth_gbps: float = 100.0,
        base_latency_us: float = 2.5,
    ) -> ClusterTopology:
        nodes: dict[str, NodeSpec] = {}
        for i in range(num_nodes):
            node_id = f"node-{i}"
            gpus = [
                GpuSpec(
                    gpu_id=g,
                    name="NVIDIA Tesla P100-PCIE-16GB",
                    vram_bytes=vram_gb_per_gpu * (1024**3),
                    compute_capability="6.0",
                    pcie_gen=3,
                    numa_node=g // (max(1, gpus_per_node // 2)),
                )
                for g in range(gpus_per_node)
            ]
            nodes[node_id] = NodeSpec(
                node_id=node_id,
                hostname=f"hh-worker-{i:02d}.hh.internal",
                numa_nodes=[0, 1] if gpus_per_node >= 2 else [0],
                ram_bytes=ram_gb_per_node * (1024**3),
                gpus=gpus,
                ip_address=f"10.100.1.{10 + i}",
                rack_id=f"rack-{i // 8}",
            )
        return cls(
            nodes=nodes,
            interconnect_bandwidth_gbps=bandwidth_gbps,
            base_network_latency_us=base_latency_us,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_count": len(self.nodes),
            "total_gpus": self.total_gpus(),
            "total_ram_gb": round(self.total_ram_bytes() / (1024**3), 2),
            "total_vram_gb": round(self.total_vram_bytes() / (1024**3), 2),
            "interconnect_bandwidth_gbps": self.interconnect_bandwidth_gbps,
            "base_network_latency_us": self.base_network_latency_us,
            "nodes": {nid: n.to_dict() for nid, n in self.nodes.items()},
        }
