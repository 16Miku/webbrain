"""Compare an original Bonsai 2 decoder graph with its chunked-prefill rewrite.

Both graphs share the same external weight file. Real text is embedded with the
bundle's embed_tokens graph, then both decoders run on CPU onnxruntime with
identical inputs: a fresh prefill at several lengths (chunk boundaries
included) and a continuation prefill from a non-zero cache. Logits for the
last position, every recurrent/conv state and every KV cache are compared, as
well as one greedy decode step from each resulting cache.

Needs `tokenizers` in addition to requirements.txt:
  python scripts/models/bonsai/validate_chunked_gdn.py \
      --original <source>/onnx/decoder_model_merged_q2f16.onnx \
      --rewritten <bundle>/onnx/decoder_model_merged_q2f16.onnx \
      --embed <bundle>/onnx/embed_tokens_q2f16.onnx --tokenizer <bundle>/tokenizer.json
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import hashlib

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from chunk_gdn_prefill import CPU_EVIDENCE_KIND

TEXT = (
    "The nested set model is a technique for representing nested set collections in relational databases. "
    "It is based on Nested Intervals, that are immune to hierarchy reorganization problem, and allow answering "
    "ancestor path hierarchical queries algorithmically without accessing the stored hierarchy relation. "
    "The standard relational algebra and relational calculus, and the SQL operations based on them, are unable to "
    "express directly all desirable operations on hierarchies. The nested interval model numbers the nodes "
    "according to a tree traversal, which visits each node twice, assigning numbers in the order of visiting. "
)


def session(path: Path) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.log_severity_level = 3
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def empty_cache(sess: ort.InferenceSession) -> dict:
    feeds = {}
    for i in sess.get_inputs():
        if i.name.startswith(("past_conv", "past_recurrent", "past_key_values")):
            shape = [1 if d == "batch_size" else 0 if isinstance(d, str) else d for d in i.shape]
            feeds[i.name] = np.zeros(shape, np.float16)
    return feeds


def run(sess, embeds, cache, past_len):
    S = embeds.shape[1]
    pos = np.arange(past_len, past_len + S, dtype=np.int64)
    feeds = dict(cache)
    feeds.update({
        "inputs_embeds": embeds,
        "attention_mask": np.ones((1, past_len + S), np.int64),
        "position_ids": np.broadcast_to(pos, (3, 1, S)).copy(),
    })
    names = [o.name for o in sess.get_outputs()]
    t0 = time.perf_counter()
    out = dict(zip(names, sess.run(None, feeds)))
    return out, time.perf_counter() - t0


def to_cache(out: dict) -> dict:
    return {k.replace("present_conv", "past_conv").replace("present_recurrent", "past_recurrent").replace("present.", "past_key_values."): v
            for k, v in out.items() if k.startswith("present")}


def compare(a: dict, b: dict) -> dict:
    la = a["logits"][:, -1].astype(np.float32)
    lb = b["logits"][:, -1].astype(np.float32)
    worst_state = 0.0
    worst_name = ""
    for k in a:
        if k == "logits":
            continue
        x = a[k].astype(np.float32)
        y = b[k].astype(np.float32)
        scale = max(float(np.abs(x).max()), 1e-6)
        err = float(np.abs(x - y).max()) / scale
        if err > worst_state:
            worst_state, worst_name = err, k
    pa = np.exp(la - la.max()); pa /= pa.sum()
    pb = np.exp(lb - lb.max()); pb /= pb.sum()
    return {
        "logits_shape_original": list(a["logits"].shape),
        "logits_shape_rewritten": list(b["logits"].shape),
        "last_logits_max_abs_diff": float(np.abs(la - lb).max()),
        "last_logits_scale": float(np.abs(la).max()),
        "top1_equal": bool(la.argmax() == lb.argmax()),
        "top5_original": la[0].argsort()[-5:][::-1].tolist(),
        "top5_rewritten": lb[0].argsort()[-5:][::-1].tolist(),
        "kl_original_to_rewritten": float((pa * (np.log(pa + 1e-30) - np.log(pb + 1e-30))).sum()),
        "worst_cache_rel_err": worst_state,
        "worst_cache_name": worst_name,
        "finite": bool(all(np.isfinite(v.astype(np.float32)).all() for v in b.values())),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--original", type=Path, required=True)
    p.add_argument("--rewritten", type=Path, required=True)
    p.add_argument("--embed", type=Path, required=True)
    p.add_argument("--tokenizer", type=Path, required=True)
    # Cover one token, both sides of the 128-token chunk boundary and a multi-chunk prompt.
    p.add_argument("--lengths", default="2,127,128,129,700")
    p.add_argument("--output", type=Path)
    args = p.parse_args()

    tok = Tokenizer.from_file(str(args.tokenizer))
    ids = tok.encode(TEXT * 8).ids
    embed = session(args.embed)
    emb_in = embed.get_inputs()[0].name
    all_embeds = embed.run(None, {emb_in: np.array([ids], np.int64)})[0]
    orig = session(args.original)
    new = session(args.rewritten)
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()  # noqa: E731
    report = {
        "kind": CPU_EVIDENCE_KIND,
        "onnxruntime": f"{ort.__version__} (CPUExecutionProvider)",
        "original_graph_sha256": sha(args.original),
        "rewritten_graph_sha256": sha(args.rewritten),
        "input": "Real English text embedded with the bundle's embed_tokens graph; zero initial cache unless noted.",
        "tokens_available": len(ids),
        "fresh_prefill": [],
        "continuation_from_cache": None,
    }

    for S in [int(x) for x in args.lengths.split(",")]:
        e = all_embeds[:, :S]
        a, ta = run(orig, e, empty_cache(orig), 0)
        b, tb = run(new, e, empty_cache(new), 0)
        r = compare(a, b)
        # one greedy decode step from each cache
        nxt = int(a["logits"][0, -1].argmax())
        e1 = embed.run(None, {emb_in: np.array([[nxt]], np.int64)})[0]
        a2, _ = run(orig, e1, to_cache(a), S)
        b2, _ = run(new, e1, to_cache(b), S)
        r2 = compare(a2, b2)
        r.update({"tokens": S, "cpu_seconds_original": round(ta, 3), "cpu_seconds_rewritten": round(tb, 3),
                  "decode_step_logits_max_abs_diff": r2["last_logits_max_abs_diff"], "decode_step_top1_equal": r2["top1_equal"]})
        report["fresh_prefill"].append(r)
        print(json.dumps({k: r[k] for k in ("tokens", "last_logits_max_abs_diff", "last_logits_scale", "top1_equal", "kl_original_to_rewritten",
                                              "worst_cache_rel_err", "worst_cache_name", "decode_step_top1_equal", "cpu_seconds_original", "cpu_seconds_rewritten")}))

    # continuation: 150 tokens of cache from the original graph, then 300 more tokens through both
    head = all_embeds[:, :150]
    a0, _ = run(orig, head, empty_cache(orig), 0)
    cache = to_cache(a0)
    tail = all_embeds[:, 150:450]
    a, _ = run(orig, tail, cache, 150)
    b, _ = run(new, tail, cache, 150)
    r = compare(a, b)
    report["continuation_from_cache"] = {"cached_tokens": 150, "new_tokens": 300, **r}
    print(json.dumps({"continuation": {k: r[k] for k in ("last_logits_max_abs_diff", "top1_equal", "kl_original_to_rewritten", "worst_cache_rel_err")}}))
    if args.output:
        args.output.write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
