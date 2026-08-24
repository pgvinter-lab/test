"""Golden Single-Process Numerical Reference Implementation for MoE."""

from __future__ import annotations

import math
import random
from typing import Any, Callable

from .model_config import MoEModelConfig


def silu(x: float) -> float:
    # Stable SiLU: x / (1.0 + exp(-x))
    if x > 20.0:
        return x
    if x < -20.0:
        return 0.0
    return x / (1.0 + math.exp(-x))


def gelu(x: float) -> float:
    # Standard tanh approximation of GeLU
    return 0.5 * x * (1.0 + math.tanh(math.sqrt(2.0 / math.pi) * (x + 0.044715 * (x**3))))


def _matvec(matrix: list[list[float]], vec: list[float]) -> list[float]:
    # matrix is rows x cols, vec length is rows. Computes vec^T * matrix (cols length)
    rows = len(vec)
    cols = len(matrix[0])
    out = [0.0] * cols
    for r in range(rows):
        vr = vec[r]
        if vr != 0.0:
            row = matrix[r]
            for c in range(cols):
                out[c] += vr * row[c]
    return out


def _vec_matvec(vec: list[float], matrix: list[list[float]]) -> list[float]:
    # matrix is rows x cols, vec is length cols. Computes matrix * vec (rows length)
    rows = len(matrix)
    cols = len(vec)
    out = [0.0] * rows
    for r in range(rows):
        row = matrix[r]
        s = 0.0
        for c in range(cols):
            s += row[c] * vec[c]
        out[r] = s
    return out


class SwiGLUExpert:
    def __init__(
        self,
        w1: list[list[float]],
        w_gate: list[list[float]],
        w2: list[list[float]],
    ) -> None:
        self.w1 = w1          # D x H
        self.w_gate = w_gate  # D x H
        self.w2 = w2          # H x D

    def forward(self, x: list[float]) -> list[float]:
        # h1 = x * W1
        h1 = _matvec(self.w1, x)
        # h_gate = x * W_gate
        h_gate = _matvec(self.w_gate, x)
        # h_act = h1 * silu(h_gate)
        h_act = [h1[i] * silu(h_gate[i]) for i in range(len(h1))]
        # y = h_act * W2
        y = _matvec(self.w2, h_act)
        return y


class GeluExpert:
    def __init__(
        self,
        w1: list[list[float]],
        w2: list[list[float]],
        b1: list[float] | None = None,
        b2: list[float] | None = None,
    ) -> None:
        self.w1 = w1  # D x H
        self.w2 = w2  # H x D
        self.b1 = b1 or [0.0] * len(w1[0])
        self.b2 = b2 or [0.0] * len(w2[0])

    def forward(self, x: list[float]) -> list[float]:
        h = _matvec(self.w1, x)
        h_act = [gelu(h[i] + self.b1[i]) for i in range(len(h))]
        y = _matvec(self.w2, h_act)
        if self.b2:
            y = [y[i] + self.b2[i] for i in range(len(y))]
        return y


class SingleProcessMoEReference:
    def __init__(self, model_config: MoEModelConfig, seed: int = 42) -> None:
        self.config = model_config
        self.seed = seed
        self.rng = random.Random(seed)

        self.gating_weights: list[list[list[float]]] = []  # L x D x E
        self.experts: list[list[SwiGLUExpert | GeluExpert]] = []  # L x E

        self._init_weights()

    def _init_weights(self) -> None:
        d = self.config.hidden_dim
        h = self.config.ffn_dim
        e = self.config.num_experts
        scale_d = 1.0 / math.sqrt(d)
        scale_h = 1.0 / math.sqrt(h)

        for layer in range(self.config.num_layers):
            # Gating weights: D x E
            gw = [
                [self.rng.uniform(-scale_d, scale_d) for _ in range(e)]
                for _ in range(d)
            ]
            self.gating_weights.append(gw)

            layer_experts: list[SwiGLUExpert | GeluExpert] = []
            for exp in range(e):
                if self.config.activation_type == "swiglu":
                    w1 = [[self.rng.uniform(-scale_d, scale_d) for _ in range(h)] for _ in range(d)]
                    w_gate = [[self.rng.uniform(-scale_d, scale_d) for _ in range(h)] for _ in range(d)]
                    w2 = [[self.rng.uniform(-scale_h, scale_h) for _ in range(d)] for _ in range(h)]
                    layer_experts.append(SwiGLUExpert(w1=w1, w_gate=w_gate, w2=w2))
                else:
                    w1 = [[self.rng.uniform(-scale_d, scale_d) for _ in range(h)] for _ in range(d)]
                    w2 = [[self.rng.uniform(-scale_h, scale_h) for _ in range(d)] for _ in range(h)]
                    b1 = [self.rng.uniform(-0.01, 0.01) for _ in range(h)]
                    b2 = [self.rng.uniform(-0.01, 0.01) for _ in range(d)]
                    layer_experts.append(GeluExpert(w1=w1, w2=w2, b1=b1, b2=b2))

            self.experts.append(layer_experts)

    def forward_layer(
        self,
        layer_id: int,
        hidden_states: list[list[float]],
    ) -> list[list[float]]:
        k = self.config.num_experts_per_token
        d = self.config.hidden_dim
        gw = self.gating_weights[layer_id]
        layer_exps = self.experts[layer_id]

        outputs: list[list[float]] = []

        for tok in hidden_states:
            # 1. Gate logits: length E
            logits = _matvec(gw, tok)

            # 2. Top-K Selection
            indexed = sorted(enumerate(logits), key=lambda x: x[1], reverse=True)
            topk = indexed[:k]
            top_indices = [idx for idx, _ in topk]
            top_logits = [val for _, val in topk]

            # 3. Softmax over Top-K
            max_logit = max(top_logits)
            exp_vals = [math.exp(v - max_logit) for v in top_logits]
            sum_exp = sum(exp_vals)
            weights = [v / sum_exp for v in exp_vals]

            # 4. Expert Computation & Weighted Accumulation
            combined = [0.0] * d
            for exp_idx, weight in zip(top_indices, weights):
                exp_out = layer_exps[exp_idx].forward(tok)
                for dim_i in range(d):
                    combined[dim_i] += weight * exp_out[dim_i]

            outputs.append(combined)

        return outputs

    def forward_layer_with_trace(
        self,
        layer_id: int,
        hidden_states: list[list[float]],
    ) -> dict[str, Any]:
        k = self.config.num_experts_per_token
        d = self.config.hidden_dim
        gw = self.gating_weights[layer_id]
        layer_exps = self.experts[layer_id]

        outputs: list[list[float]] = []
        token_traces: list[dict[str, Any]] = []

        for t_idx, tok in enumerate(hidden_states):
            logits = _matvec(gw, tok)
            indexed = sorted(enumerate(logits), key=lambda x: x[1], reverse=True)
            topk = indexed[:k]
            top_indices = [idx for idx, _ in topk]
            top_logits = [val for _, val in topk]

            max_logit = max(top_logits)
            exp_vals = [math.exp(v - max_logit) for v in top_logits]
            sum_exp = sum(exp_vals)
            weights = [v / sum_exp for v in exp_vals]

            combined = [0.0] * d
            expert_outputs: dict[int, list[float]] = {}
            for exp_idx, weight in zip(top_indices, weights):
                exp_out = layer_exps[exp_idx].forward(tok)
                expert_outputs[exp_idx] = exp_out
                for dim_i in range(d):
                    combined[dim_i] += weight * exp_out[dim_i]

            outputs.append(combined)
            token_traces.append({
                "token_id": t_idx,
                "top_indices": top_indices,
                "routing_weights": weights,
                "combined_norm": math.sqrt(sum(v**2 for v in combined)),
            })

        return {
            "layer_id": layer_id,
            "outputs": outputs,
            "traces": token_traces,
        }
