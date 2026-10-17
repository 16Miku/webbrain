"""Rewrite Bonsai 2 / Qwen3.5 decoder graphs for parallel WebGPU prefill.

The upstream ONNX export computes each GatedDeltaNet prefill with an ONNX
`Scan` over tokens. ONNX Runtime's WebGPU execution provider has no `Scan`
kernel, so prefill falls back to a CPU loop that round-trips the recurrent
state through the GPU once per token per layer.

This tool replaces every GatedDeltaNet `Scan` with the chunked delta-rule
formulation (the same algebra as `torch_chunk_gated_delta_rule` in
Transformers) built only from ops the WebGPU EP implements:

* inside each chunk the WY transform is computed with matmuls; the unit
  lower-triangular inverse uses stable recursive block inversion;
* chunk-to-chunk state propagation is a parallel (Hillis-Steele) prefix scan
  over the affine maps S -> A_c S + B_c, with steps skipped by `If` when the
  prompt has too few chunks to need them.

It also slices the final hidden state to the last position before the LM
head, so prefill returns logits for one token instead of
[sequence_length, vocab]. Generation in Transformers.js only reads the last
position.

All new weights are small constants stored inline. Existing initializers keep
their external-data references, so the large `.onnx_data` file is unchanged
and only the graph file needs to be replaced.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

INT64_MAX = 9223372036854775807

# Model-card text shared by build_vision.py and make_chunked_bundle.py. The
# validation claims are rendered only from verified evidence (see
# model_card_section) so an unvalidated build cannot publish them.
MODEL_CARD_INTRO = """
## Parallel prefill

The upstream language graph computes every GatedDeltaNet prefill with an ONNX
`Scan` over tokens. ONNX Runtime's WebGPU execution provider has no `Scan`
kernel, so prompts were processed one token at a time through a CPU loop with
a GPU round trip per token and layer (0.13 s per prompt token for 2B and 0.19 s
for 4B on an RTX 5090; a faster GPU barely helps).
This graph replaces each `Scan` with the chunked gated delta rule
({chunk}-token chunks; stable recursive block inversion inside a chunk; a parallel
prefix scan across chunks), built only from ops the WebGPU EP implements, and
returns logits for the last position only. Weights, quantization and the
external data file are byte-identical to the previous revision; decode
(one token at a time) uses the unchanged recurrent path.
"""
CPU_EVIDENCE_KIND = "cpu-onnxruntime-comparison"
WEBGPU_EVIDENCE_KIND = "webgpu-prefill-benchmark"
# Last-position logits may differ by FP16 rounding only.
MAX_RELATIVE_LOGIT_DIFF = 5e-3
MAX_ABSOLUTE_LOGIT_DIFF = 0.05
MAX_KL = 1e-3
MAX_WEBGPU_KL = 1e-2
# Cache outputs (recurrent/conv states, KV) carry FP16 rounding through the
# stack: observed whole-tensor error stays below 1% and the worst single
# element below 3% of the tensor maximum. A corrupted cache is O(1).
MAX_CACHE_REL_FRO = 2e-2
MAX_CACHE_REL_MAX = 1e-1


def _require(condition, message):
    if not condition:
        raise ValueError(f"Prefill evidence rejected: {message}")


def verify_prefill_evidence(reports, graph_sha256, chunk_tokens, source_sha256):
    """Check attached reports and return the verified ones by kind.

    Raises on an unknown report kind or any failed comparison, so a bundle can
    never be sealed with evidence that contradicts its model card. CPU parity
    must cover the rewrite's own chunk size: a prompt ending exactly on a chunk
    boundary and one spanning several chunks (which exercises the prefix scan).
    Every report must name both the rewritten graph and the original (Scan)
    graph it was compared against.
    """
    verified = {}
    for report in reports:
        kind = report.get("kind")
        if kind == CPU_EVIDENCE_KIND:
            _require(report.get("rewritten_graph_sha256") == graph_sha256, "CPU report is for a different graph")
            _require(report.get("original_graph_sha256") == source_sha256,
                     "CPU report did not compare against this bundle's original graph")
            rows = list(report.get("fresh_prefill") or [])
            continuation = report.get("continuation_from_cache")
            _require(rows and continuation, "CPU report needs fresh prefills and a cached continuation")
            if "chunk_tokens" in report:
                _require(int(report["chunk_tokens"]) == chunk_tokens, "CPU report used a different chunk size")
            _require(any(row["tokens"] % chunk_tokens == 0 for row in rows)
                     and any(row["tokens"] > chunk_tokens for row in rows),
                     f"CPU report must cover a {chunk_tokens}-token chunk boundary and a multi-chunk prompt")
            _require(int(continuation.get("new_tokens", 0)) > chunk_tokens,
                     f"CPU continuation must span more than one {chunk_tokens}-token chunk")
            for row in rows + [continuation]:
                _require(row.get("top1_equal") is True, f"top-1 differs ({row})")
                _require(row.get("finite") is True, f"non-finite outputs ({row})")
                _require("worst_cache_rel_fro" in row and "worst_cache_rel_err" in row,
                         "CPU report must record cache-output errors (rerun validate_chunked_gdn.py)")
                _require(float(row["worst_cache_rel_fro"]) <= MAX_CACHE_REL_FRO
                         and float(row["worst_cache_rel_err"]) <= MAX_CACHE_REL_MAX,
                         f"cache outputs diverge ({row})")
                # Without a recorded scale, allow a few FP16 ulps at typical |logit| of 16-32.
                tolerance = (MAX_RELATIVE_LOGIT_DIFF * max(float(row["last_logits_scale"]), 1.0)
                             if row.get("last_logits_scale") else MAX_ABSOLUTE_LOGIT_DIFF)
                _require(float(row["last_logits_max_abs_diff"]) <= tolerance,
                         f"logit difference above FP16 tolerance ({row})")
                _require(float(row["kl_original_to_rewritten"]) <= MAX_KL, f"KL too large ({row})")
            for row in rows:
                _require(row.get("decode_step_top1_equal") is True, f"decode step differs ({row})")
        elif kind == WEBGPU_EVIDENCE_KIND:
            _require(report.get("rewritten_graph_sha256") == graph_sha256, "WebGPU report is for a different graph")
            _require(report.get("original_graph_sha256") == source_sha256,
                     "WebGPU report did not time this bundle's original graph")
            rewritten = [row for row in report.get("prefill") or [] if row.get("variant") == "rewritten"]
            original = [row for row in report.get("prefill") or [] if row.get("variant") == "original"]
            comparisons = list(report.get("webgpu_logit_comparison") or [])
            _require(rewritten and original and comparisons, "WebGPU report needs both timings and a logit comparison")
            for row in comparisons:
                _require(row.get("argmax_equal") is True and float(row["kl"]) <= MAX_WEBGPU_KL,
                         f"WebGPU logits differ ({row})")
        else:
            raise ValueError(f"Prefill evidence rejected: unknown report kind {kind!r}")
        verified[kind] = report
    return verified


def rewritten_chunk_tokens(graph_path):
    """Chunk size of a graph produced by this tool (the cumsum mask is CxC)."""
    model = onnx.load(graph_path, load_external_data=False)
    for tensor in model.graph.initializer:
        if tensor.name == "/webbrain/chunked_gdn/triu1":
            return int(tensor.dims[0])
    raise ValueError(f"{graph_path} was not rewritten by chunk_gdn_prefill.py")


def model_card_section(reports, graph_sha256, chunk_tokens, source_sha256):
    verified = verify_prefill_evidence(reports, graph_sha256, chunk_tokens, source_sha256)
    text = MODEL_CARD_INTRO.format(chunk=chunk_tokens) + "\n"
    if CPU_EVIDENCE_KIND in verified:
        text += ("`chunked-prefill-validation.json` records CPU comparisons with the original\n"
                 "graph on real text (prefill lengths across chunk boundaries and a cached\n"
                 "continuation): identical top-1 tokens, including the following decode step, and\n"
                 "logit differences at FP16 rounding level.")
        if WEBGPU_EVIDENCE_KIND in verified:
            text += " It also records WebGPU prefill timings against\nthe original graph."
        text += "\n"
    elif WEBGPU_EVIDENCE_KIND in verified:
        text += ("`chunked-prefill-validation.json` records WebGPU prefill timings and logit\n"
                 "comparisons against the original graph; CPU parity evidence is pending.\n")
    else:
        text += ("Parity and timing evidence for this build is pending:\n"
                 "`chunked-prefill-validation.json` records the rewrite only. Attach\n"
                 "`validate_chunked_gdn.py` and WebGPU timing reports before publishing.\n")
    return text + ("Reproduce with `scripts/models/bonsai/chunk_gdn_prefill.py` in the WebBrain\n"
                   "repository.\n")


class Builder:
    """Appends nodes to a (sub)graph with layer-unique names."""

    def __init__(self, graph: onnx.GraphProto, prefix: str):
        self.graph = graph
        self.prefix = prefix
        self.nodes: list[onnx.NodeProto] = []
        self.count = 0

    def name(self, hint: str) -> str:
        self.count += 1
        return f"{self.prefix}/{hint}_{self.count}"

    def op(self, op_type: str, inputs, hint: str | None = None, outputs=None, **attrs):
        out = outputs or [self.name(hint or op_type)]
        self.nodes.append(helper.make_node(op_type, list(inputs), out, name=self.name(f"{op_type}_node"), **attrs))
        return out[0] if len(out) == 1 else out


def add_constants(graph: onnx.GraphProto, chunk: int, head_dim: int, max_steps: int, ns: str) -> dict:
    c = {}

    def init(name, array):
        full = f"{ns}/{name}"
        graph.initializer.append(numpy_helper.from_array(np.ascontiguousarray(array), full))
        c[name] = full

    f32 = np.float32
    idx = np.arange(chunk)
    init("triu1", np.triu(np.ones((chunk, chunk), f32)))            # row-vector cumsum
    init("tril0", np.tril(np.ones((chunk, chunk), f32)))            # lower incl. diagonal
    init("neg_stril", -np.tril(np.ones((chunk, chunk), f32), -1))   # -strictly lower
    init("eyeC", np.eye(chunk, dtype=f32))
    init("eyeD", np.eye(head_dim, dtype=f32))
    b = 1
    while b < chunk:
        mask = (((idx[:, None] // b) % 2 == 1) & ((idx[None, :] // b) == (idx[:, None] // b) - 1)).astype(f32)
        init(f"blockmask_{b}", mask)
        b *= 2
    init("zero_f", np.array(0.0, f32))
    init("i0", np.array([0], np.int64))
    init("i1", np.array([1], np.int64))
    init("i2", np.array([2], np.int64))
    init("i3", np.array([3], np.int64))
    init("im1", np.array([-1], np.int64))
    init("im2", np.array([-2], np.int64))
    init("imax", np.array([INT64_MAX], np.int64))
    init("chunk", np.array([chunk], np.int64))
    init("pad4_head", np.zeros(6, np.int64))        # [b,h,s,d] begins..(s end)
    init("pad4_tail", np.zeros(1, np.int64))
    init("pad3_head", np.zeros(5, np.int64))
    init("pads5_head", np.zeros(2, np.int64))       # begin pads before axis 2 for rank 5
    init("pads5_tail", np.zeros(7, np.int64))       # begin d3,d4 + all end pads
    init("shape_q5", np.array([0, 0, -1, chunk, head_dim], np.int64))
    init("shape_g4", np.array([0, 0, -1, chunk], np.int64))
    init("shape_out4", np.array([0, 0, -1, head_dim], np.int64))
    for d in range(max_steps):
        init(f"shift_{d}", np.array([1 << d], np.int64))
    return c


def build_chunked_recurrence(b: Builder, c: dict, state, q, k, v, beta, g, out_state, out_y,
                             chunk: int, max_steps: int, always_steps: int):
    """Emit nodes computing the GatedDeltaNet recurrence over a whole prompt."""
    perm5 = [0, 1, 2, 4, 3]

    # --- pad the sequence to a multiple of the chunk size (zeros leave the state unchanged)
    shape = b.op("Shape", [q], "q_shape")
    seq = b.op("Gather", [shape, c["i2"]], "seq_len", axis=0)            # [1]
    rem = b.op("Mod", [seq, c["chunk"]], "seq_mod")
    pad = b.op("Mod", [b.op("Sub", [c["chunk"], rem], "pad_raw"), c["chunk"]], "pad_len")
    pads4 = b.op("Concat", [c["pad4_head"], pad, c["pad4_tail"]], "pads4", axis=0)
    pads3 = b.op("Concat", [c["pad3_head"], pad], "pads3", axis=0)
    qp = b.op("Pad", [q, pads4, c["zero_f"]], "q_pad")
    kp = b.op("Pad", [k, pads4, c["zero_f"]], "k_pad")
    vp = b.op("Pad", [v, pads4, c["zero_f"]], "v_pad")
    bp = b.op("Pad", [beta, pads3, c["zero_f"]], "beta_pad")
    gp = b.op("Pad", [g, pads3, c["zero_f"]], "g_pad")

    qc = b.op("Reshape", [qp, c["shape_q5"]], "q_chunks")                 # [B,H,N,C,D]
    kc = b.op("Reshape", [kp, c["shape_q5"]], "k_chunks")
    vc = b.op("Reshape", [vp, c["shape_q5"]], "v_chunks")
    bc = b.op("Reshape", [bp, c["shape_g4"]], "beta_chunks")              # [B,H,N,C]
    gc = b.op("Reshape", [gp, c["shape_g4"]], "g_chunks")

    # --- within-chunk cumulative log decay and pairwise decay matrix
    G = b.op("MatMul", [gc, c["triu1"]], "g_cumsum")                     # [B,H,N,C]
    Gi = b.op("Unsqueeze", [G, c["im1"]], "g_col")                       # [B,H,N,C,1]
    Gj = b.op("Unsqueeze", [G, c["im2"]], "g_row")
    diff = b.op("Sub", [Gi, Gj], "g_diff")                                # [B,H,N,C,C]
    decay = b.op("Mul", [b.op("Exp", [b.op("Mul", [diff, c["tril0"]], "g_diff_low")], "decay_exp"), c["tril0"]], "decay")

    beta_u = b.op("Unsqueeze", [bc, c["im1"]], "beta_col")
    kb = b.op("Mul", [kc, beta_u], "k_beta")
    vb = b.op("Mul", [vc, beta_u], "v_beta")
    kT = b.op("Transpose", [kc], "k_T", perm=perm5)
    A = b.op("Mul", [b.op("Mul", [b.op("MatMul", [kb, kT], "kbk"), decay], "kbk_decay"), c["neg_stril"]], "A_strict")

    # --- T = (I - A)^-1 by recursive block inversion (stable for unit lower-triangular)
    T = b.op("Add", [c["eyeC"], b.op("Mul", [A, c["blockmask_1"]], "A_blk1")], "T2")
    blk = 2
    while blk < chunk:
        Ab = b.op("Mul", [A, c[f"blockmask_{blk}"]], f"A_blk{blk}")
        T = b.op("Add", [T, b.op("MatMul", [b.op("MatMul", [T, Ab], f"TA{blk}"), T], f"TAT{blk}")], f"T{blk * 2}")
        blk *= 2

    expG = b.op("Exp", [G], "exp_g")
    vprime = b.op("MatMul", [T, vb], "v_prime")                                           # [B,H,N,C,Dv]
    kcum = b.op("MatMul", [T, b.op("Mul", [kb, b.op("Unsqueeze", [expG, c["im1"]], "exp_g_col")], "kb_decay")], "k_cumdecay")

    # --- per-chunk affine state maps: S_next = A_c S + B_c
    Glast = b.op("Slice", [G, c["im1"], c["imax"], c["i3"]], "g_last")                   # [B,H,N,1]
    Kd = b.op("Mul", [kc, b.op("Unsqueeze", [b.op("Exp", [b.op("Sub", [Glast, G], "g_to_end")], "decay_to_end"), c["im1"]], "dte_col")], "k_decayed")
    KdT = b.op("Transpose", [Kd], "k_decayed_T", perm=perm5)                              # [B,H,N,D,C]
    gamma = b.op("Unsqueeze", [b.op("Exp", [Glast], "chunk_decay"), c["im1"]], "chunk_decay_5d")  # [B,H,N,1,1]
    Ac = b.op("Sub", [b.op("Mul", [gamma, c["eyeD"]], "gamma_eye"), b.op("MatMul", [KdT, kcum], "kd_kcum")], "A_chunk")
    Bc = b.op("MatMul", [KdT, vprime], "B_chunk")

    # prepend the incoming state as the map (0, S0)
    s0 = b.op("Unsqueeze", [state, c["i2"]], "s0_5d")                                     # [B,H,1,D,Dv]
    zeros = b.op("Mul", [s0, c["zero_f"]], "zeros_5d")
    A_all = b.op("Concat", [zeros, Ac], "A_all0", axis=2)
    B_all = b.op("Concat", [s0, Bc], "B_all0", axis=2)
    M = b.op("Gather", [b.op("Shape", [B_all], "B_all_shape"), c["i2"]], "num_maps", axis=0)  # [1] = N + 1

    # --- Hillis-Steele inclusive scan; positions whose prefix already reaches the
    # (0, S0) map have A == 0, so zero padding is the exact identity element here.
    for d in range(max_steps):
        last = d == max_steps - 1
        sh = c[f"shift_{d}"]

        def emit_step(sb: Builder, A_in, B_in, need_a):
            keep = sb.op("Max", [sb.op("Sub", [M, sh], "keep_raw"), c["i0"]], "keep")
            padlen = sb.op("Min", [sh, M], "pad_maps")
            pads = sb.op("Concat", [c["pads5_head"], padlen, c["pads5_tail"]], "pads5", axis=0)
            B_sh = sb.op("Pad", [sb.op("Slice", [B_in, c["i0"], keep, c["i2"]], "B_head"), pads, c["zero_f"]], "B_shift")
            B_out = sb.op("Add", [sb.op("MatMul", [A_in, B_sh], "AB"), B_in], "B_next")
            if not need_a:
                return None, B_out
            A_sh = sb.op("Pad", [sb.op("Slice", [A_in, c["i0"], keep, c["i2"]], "A_head"), pads, c["zero_f"]], "A_shift")
            A_out = sb.op("MatMul", [A_in, A_sh], "A_next")
            return A_out, B_out

        if d < always_steps:
            A_new, B_new = emit_step(b, A_all, B_all, not last)
            A_all = A_new if A_new is not None else A_all
            B_all = B_new
            continue

        # Skip steps once the shift covers every map.
        cond = b.op("Squeeze", [b.op("Greater", [M, sh], f"need_step{d}")], f"need_step{d}_s")
        then_g = onnx.GraphProto()
        then_g.name = b.name(f"scan_step{d}_then")
        tb = Builder(then_g, f"{b.prefix}/step{d}")
        A_new, B_new = emit_step(tb, A_all, B_all, not last)
        then_outputs = [B_new] + ([A_new] if A_new is not None else [])
        then_g.node.extend(tb.nodes)
        else_g = onnx.GraphProto()
        else_g.name = b.name(f"scan_step{d}_else")
        eb = Builder(else_g, f"{b.prefix}/step{d}_skip")
        else_outputs = [eb.op("Identity", [B_all], "B_same")] + ([eb.op("Identity", [A_all], "A_same")] if A_new is not None else [])
        else_g.node.extend(eb.nodes)
        for graph_, outs in ((then_g, then_outputs), (else_g, else_outputs)):
            for o in outs:
                graph_.output.append(helper.make_tensor_value_info(o, TensorProto.FLOAT, None))
        if_outs = [b.name(f"B_step{d}")] + ([b.name(f"A_step{d}")] if A_new is not None else [])
        b.nodes.append(helper.make_node("If", [cond], if_outs, name=b.name(f"If_step{d}"), then_branch=then_g, else_branch=else_g))
        B_all = if_outs[0]
        if A_new is not None:
            A_all = if_outs[1]

    # --- states before each chunk, final state, and outputs
    N = b.op("Sub", [M, c["i1"]], "num_chunks")
    S_before = b.op("Slice", [B_all, c["i0"], N, c["i2"]], "S_before")                   # [B,H,N,D,Dv]
    b.op("Squeeze", [b.op("Slice", [B_all, N, M, c["i2"]], "S_last"), c["i2"]], outputs=[out_state])
    qkT = b.op("Mul", [b.op("MatMul", [qc, kT], "qk"), decay], "qk_decay")              # lower incl. diag
    vnew = b.op("Sub", [vprime, b.op("MatMul", [kcum, S_before], "kcum_S")], "v_new")
    inter = b.op("MatMul", [b.op("Mul", [qc, b.op("Unsqueeze", [expG, c["im1"]], "exp_g_col2")], "q_decay"), S_before], "o_inter")
    o = b.op("Add", [inter, b.op("MatMul", [qkT, vnew], "o_intra")], "o_chunks")         # [B,H,N,C,Dv]
    o4 = b.op("Reshape", [o, c["shape_out4"]], "o_padded")
    b.op("Slice", [o4, c["i0"], seq, c["i2"]], outputs=[out_y])


def rewrite_gdn(model: onnx.ModelProto, chunk: int, max_steps: int, always_steps: int, head_dim: int) -> int:
    graph = model.graph
    consts = add_constants(graph, chunk, head_dim, max_steps, "/webbrain/chunked_gdn")
    replaced = 0
    for node in graph.node:
        if node.op_type != "If" or "/gdn/" not in node.name:
            continue
        for attr in node.attribute:
            if attr.name != "else_branch":
                continue
            sub = attr.g
            scans = [n for n in sub.node if n.op_type == "Scan"]
            if len(scans) != 1:
                raise RuntimeError(f"{node.name}: expected one Scan, found {len(scans)}")
            scan = scans[0]
            attrs = {a.name: helper.get_attribute_value(a) for a in scan.attribute if a.type != onnx.AttributeProto.GRAPH}
            if attrs.get("num_scan_inputs") != 5 or list(attrs.get("scan_input_axes", [])) != [2] * 5 \
                    or list(attrs.get("scan_output_axes", [])) != [2] or len(scan.input) != 6 or len(scan.output) != 2:
                raise RuntimeError(f"{node.name}: unexpected Scan signature {attrs}")
            body = [a.g for a in scan.attribute if a.type == onnx.AttributeProto.GRAPH][0]
            expected_ops = ["Exp", "Unsqueeze", "Unsqueeze", "Mul", "Unsqueeze", "Mul", "ReduceSum", "Sub", "Unsqueeze",
                            "Mul", "Unsqueeze", "Mul", "Add", "Unsqueeze", "Mul", "ReduceSum"]
            if [n.op_type for n in body.node] != expected_ops:
                raise RuntimeError(f"{node.name}: Scan body is not the expected gated delta rule")
            prefix = scan.name.rsplit("/", 1)[0] + "/chunked"
            b = Builder(sub, prefix)
            state, q, k, v, beta, g = scan.input
            build_chunked_recurrence(b, consts, state, q, k, v, beta, g, scan.output[0], scan.output[1],
                                     chunk, max_steps, always_steps)
            position = list(sub.node).index(scan)
            new_nodes = list(sub.node[:position]) + b.nodes + list(sub.node[position + 1:])
            del sub.node[:]
            sub.node.extend(new_nodes)
            replaced += 1
    return replaced


def slice_last_logits(model: onnx.ModelProto) -> str:
    graph = model.graph
    lm = [n for n in graph.node if "logits" in n.output]
    if len(lm) != 1 or lm[0].op_type != "MatMulNBits":
        raise RuntimeError("expected a single MatMulNBits producing logits")
    lm = lm[0]
    hidden = lm.input[0]
    last = hidden + "/last_position"
    ns = "/webbrain/last_logits"
    graph.initializer.extend([
        numpy_helper.from_array(np.array([-1], np.int64), f"{ns}/start"),
        numpy_helper.from_array(np.array([INT64_MAX], np.int64), f"{ns}/end"),
        numpy_helper.from_array(np.array([1], np.int64), f"{ns}/axis"),
    ])
    slice_node = helper.make_node("Slice", [hidden, f"{ns}/start", f"{ns}/end", f"{ns}/axis"], [last], name=f"{ns}/Slice")
    index = list(graph.node).index(lm)
    graph.node.insert(index, slice_node)
    lm.input[0] = last
    for out in graph.output:
        if out.name == "logits":
            dims = out.type.tensor_type.shape.dim
            dims[1].Clear()
            dims[1].dim_value = 1
    return hidden


# Qwen3.5 / Bonsai 2 text_config.max_position_embeddings.
DEFAULT_CONTEXT_TOKENS = 262144


def prefix_scan_steps(chunk: int, context_tokens: int) -> int:
    """Fewest Hillis-Steele steps whose (2**steps - 1) chunks cover the context."""
    steps = 1
    while ((1 << steps) - 1) * chunk < context_tokens:
        steps += 1
    return steps


def rewrite_file(source: Path, output: Path, chunk: int = 128, context_tokens: int = DEFAULT_CONTEXT_TOKENS,
                 always_steps: int = 1, head_dim: int = 128, last_logits: bool = True) -> dict:
    """Rewrite `source` into `output`; the external data file name is unchanged.

    The prefix scan is sized for the full model context, so every prompt the
    model accepts propagates its recurrent state correctly.
    """
    if not 16 <= chunk <= 1024 or chunk & (chunk - 1):
        raise ValueError("chunk must be a power of two between 16 and 1024")
    if context_tokens < 1:
        raise ValueError("context_tokens must be positive")
    max_steps = prefix_scan_steps(chunk, context_tokens)
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    model = onnx.load(source, load_external_data=False)
    replaced = rewrite_gdn(model, chunk, max_steps, always_steps, head_dim)
    if not replaced:
        raise ValueError("no GatedDeltaNet Scan found")
    if last_logits:
        slice_last_logits(model)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never write through a hardlink into the upstream source graph.
    if output.exists():
        output.unlink()
    onnx.save(model, output)
    # The upstream graph uses ORT contrib ops in the default domain, so the strict
    # ONNX checker rejects it before and after this rewrite; validate with
    # onnxruntime instead (see validate_chunked_gdn.py).
    return {
        "tool": "scripts/models/bonsai/chunk_gdn_prefill.py",
        "source_sha256": source_sha,
        "output_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "output_bytes": output.stat().st_size,
        "gdn_layers_rewritten": replaced,
        "chunk_tokens": chunk,
        "context_tokens": context_tokens,
        "prefix_scan_steps": max_steps,
        "max_prompt_tokens": ((1 << max_steps) - 1) * chunk,
        "logits": "last position only" if last_logits else "every position",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="decoder_model_merged_q2f16.onnx (external data stays alongside)")
    parser.add_argument("output", type=Path)
    parser.add_argument("--chunk", type=int, default=128)
    parser.add_argument("--context-tokens", type=int, default=DEFAULT_CONTEXT_TOKENS,
                        help="longest prompt the prefix scan must cover (model context)")
    parser.add_argument("--always-steps", type=int, default=1, help="leading steps emitted without an If guard")
    parser.add_argument("--head-dim", type=int, default=128)
    parser.add_argument("--keep-all-logits", action="store_true")
    args = parser.parse_args()
    report = rewrite_file(args.input, args.output, args.chunk, args.context_tokens, args.always_steps,
                          args.head_dim, not args.keep_all_logits)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
