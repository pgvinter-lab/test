"""Model Architecture Configuration for MoE Inference."""

from __future__ import annotations

import dataclasses
from typing import Any


@dataclasses.dataclass
class MoEModelConfig:
    model_name: str = "hedgehog-moe-synthetic"
    hidden_dim: int = 4096
    ffn_dim: int = 14336
    num_layers: int = 32
    num_experts: int = 64
    num_experts_per_token: int = 2
    expert_capacity_factor: float = 1.25
    activation_type: str = "swiglu"
    dtype: str = "float32"

    def dtype_bytes(self) -> int:
        if self.dtype in ("float32", "fp32"):
            return 4
        elif self.dtype in ("float16", "fp16", "bfloat16", "bf16"):
            return 2
        elif self.dtype in ("int8", "q8_0"):
            return 1
        elif self.dtype in ("int4", "q4_0", "q4_k"):
            return 0.5  # half byte per weight
        raise ValueError(f"Unsupported dtype: {self.dtype!r}")

    def parameters_per_expert(self) -> int:
        if self.activation_type == "swiglu":
            # SwiGLU has W1 (D->H), W_gate (D->H), W2 (H->D)
            return 3 * self.hidden_dim * self.ffn_dim
        elif self.activation_type == "gelu":
            # GeLU has W1 (D->H), W2 (H->D) + bias
            return 2 * self.hidden_dim * self.ffn_dim + self.ffn_dim + self.hidden_dim
        raise ValueError(f"Unsupported activation_type: {self.activation_type!r}")

    def bytes_per_expert(self) -> int:
        raw = self.parameters_per_expert() * self.dtype_bytes()
        return int(raw)

    def activation_bytes_per_token(self) -> int:
        return int(self.hidden_dim * self.dtype_bytes())

    def total_expert_parameters(self) -> int:
        return self.parameters_per_expert() * self.num_experts * self.num_layers

    def total_expert_weights_bytes(self) -> int:
        return self.bytes_per_expert() * self.num_experts * self.num_layers

    def validate(self) -> list[str]:
        errors: list[str] = []
        if self.hidden_dim <= 0:
            errors.append("hidden_dim must be positive")
        if self.ffn_dim <= 0:
            errors.append("ffn_dim must be positive")
        if self.num_layers <= 0:
            errors.append("num_layers must be positive")
        if self.num_experts <= 0:
            errors.append("num_experts must be positive")
        if self.num_experts_per_token <= 0:
            errors.append("num_experts_per_token must be positive")
        if self.num_experts_per_token > self.num_experts:
            errors.append("num_experts_per_token cannot exceed num_experts")
        if self.expert_capacity_factor < 1.0:
            errors.append("expert_capacity_factor must be >= 1.0")
        if self.activation_type not in ("swiglu", "gelu"):
            errors.append(f"Invalid activation_type: {self.activation_type!r}")
        try:
            self.dtype_bytes()
        except ValueError as exc:
            errors.append(str(exc))
        return errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_name": self.model_name,
            "hidden_dim": self.hidden_dim,
            "ffn_dim": self.ffn_dim,
            "num_layers": self.num_layers,
            "num_experts": self.num_experts,
            "num_experts_per_token": self.num_experts_per_token,
            "expert_capacity_factor": self.expert_capacity_factor,
            "activation_type": self.activation_type,
            "dtype": self.dtype,
            "params_per_expert": self.parameters_per_expert(),
            "bytes_per_expert_mb": round(self.bytes_per_expert() / (1024**2), 2),
            "total_expert_params_billions": round(self.total_expert_parameters() / 1e9, 3),
            "total_expert_weights_gb": round(self.total_expert_weights_bytes() / (1024**3), 2),
            "activation_bytes_per_token_kb": round(self.activation_bytes_per_token() / 1024, 2),
        }
