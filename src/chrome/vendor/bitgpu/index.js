//#region src/shaders.generated.ts
const SHADERS = {
	"add": "// Elementwise residual add: y[i] = a[i] + b[i].\nstruct Params { n: u32, _p0: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> a: array<f32>;\n@group(0) @binding(2) var<storage, read> b: array<f32>;\n@group(0) @binding(3) var<storage, read_write> y: array<f32>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.n) { return; }\n  y[i] = a[i] + b[i];\n}\n",
	"argmax": "// GPU argmax over the logits, writing one token id into a GPU buffer so the token never leaves the\n// GPU (enables the deferred-sync decode loop). Single workgroup, WG threads strided-scan the N\n// logits tracking (maxVal, maxIdx), then a shared-mem tree reduction. Tie-break = LOWEST index, to\n// match the CPU argmax (strict > keeps the first max). No subgroup ops -> all devices.\noverride WG: u32 = 256u;\nstruct Params { N: u32, outIdx: u32, _0: u32, _1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> logits: array<f32>;\n@group(0) @binding(2) var<storage, read_write> outTok: array<u32>;   // outTok[p.outIdx] = argmax\n\nvar<workgroup> sval: array<f32, 256>;\nvar<workgroup> sidx: array<u32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  var bv = -3.4e38;\n  var bi = 0u;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > bv) { bv = v; bi = i; }      // strict > keeps the lowest index within this thread's stride\n  }\n  sval[tid] = bv; sidx[tid] = bi;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) {\n      let ov = sval[tid + s]; let oi = sidx[tid + s];\n      if (ov > sval[tid] || (ov == sval[tid] && oi < sidx[tid])) { sval[tid] = ov; sidx[tid] = oi; }\n    }\n    workgroupBarrier();\n  }\n  if (tid == 0u) { outTok[p.outIdx] = sidx[0]; }\n}\n",
	"argmax_masked": "// Masked argmax: like argmax.wgsl but skips any id already chosen in a prior round, and writes BOTH\n// the winning id and its logit value. Calling it K times (roundCount = 0..K-1, all in one compute\n// pass so each round sees the prior rounds' writes) yields the exact top-K (id, logit) pairs in\n// descending order = ONNX TopK over the (penalty-filtered) logits, which is what the transformers.js\n// sampler consumes. Then only K pairs are read back (not the full vocab), and the CPU does\n// temperature + softmax + multinomial. Single workgroup, no subgroup ops -> all devices. Tie-break =\n// lowest index (strict >), matching argmax.wgsl / ORT TopK in practice.\noverride WG: u32 = 256u;\nstruct Params { N: u32, roundCount: u32, _0: u32, _1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> logits: array<f32>;\n@group(0) @binding(2) var<storage, read_write> candIds: array<u32>;   // [K]; reads 0..roundCount-1, writes [roundCount]\n@group(0) @binding(3) var<storage, read_write> candVals: array<f32>;  // [K]; writes [roundCount]\n\nvar<workgroup> sval: array<f32, 256>;\nvar<workgroup> sidx: array<u32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  var bv = -3.4e38;\n  var bi = 0u;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > bv) {\n      var skip = false;\n      for (var r = 0u; r < p.roundCount; r = r + 1u) { if (candIds[r] == i) { skip = true; break; } }\n      if (!skip) { bv = v; bi = i; }     // strict > keeps the lowest index within this thread's stride\n    }\n  }\n  sval[tid] = bv; sidx[tid] = bi;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) {\n      let ov = sval[tid + s]; let oi = sidx[tid + s];\n      if (ov > sval[tid] || (ov == sval[tid] && oi < sidx[tid])) { sval[tid] = ov; sidx[tid] = oi; }\n    }\n    workgroupBarrier();\n  }\n  if (tid == 0u) { candIds[p.roundCount] = sidx[0]; candVals[p.roundCount] = sval[0]; }\n}\n",
	"attention_online": "// Causal GQA attention with online (flash) softmax, head-dim up to the workgroup size (256) - the\n// Qwen3.5 full-attention layers use head_dim 256, past the <=128 the register-array kernels assume.\n// One workgroup per query (s,h); thread d owns output dim d. Streams keys j<=s keeping running\n// max/sum/acc, so no O(S) score storage. Output gate + RoPE + QK-norm are applied separately.\noverride WGD: u32 = 256u;                  // threads == head_dim D\nstruct Params { S: u32, H: u32, KV: u32, D: u32, scale: f32, _p0: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;    // [S, H, D]\n@group(0) @binding(2) var<storage, read> k: array<f32>;    // [S, KV, D]\n@group(0) @binding(3) var<storage, read> v: array<f32>;    // [S, KV, D]\n@group(0) @binding(4) var<storage, read_write> outp: array<f32>; // [S, H, D]\nvar<workgroup> qsh: array<f32, 256>;\nvar<workgroup> red: array<f32, 256>;\n\n@compute @workgroup_size(WGD)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let qi = wg.x;                 // query flat index = s*H + h\n  let s = qi / p.H;\n  let h = qi % p.H;\n  let hkv = h / (p.H / p.KV);    // GQA: which kv head\n  let d = lid.x;\n  let D = p.D;\n  if (d < D) { qsh[d] = q[qi * D + d]; }\n  workgroupBarrier();\n\n  var m = -1e30;\n  var l = 0.0;\n  var acc = 0.0;\n  for (var j = 0u; j <= s; j = j + 1u) {\n    red[d] = select(0.0, qsh[d] * k[(j * p.KV + hkv) * D + d], d < D);\n    workgroupBarrier();\n    for (var st = WGD / 2u; st > 0u; st = st >> 1u) {\n      if (d < st) { red[d] = red[d] + red[d + st]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * p.scale;\n    let mn = max(m, score);\n    let corr = exp(m - mn);\n    let pj = exp(score - mn);\n    l = l * corr + pj;\n    if (d < D) { acc = acc * corr + pj * v[(j * p.KV + hkv) * D + d]; }\n    m = mn;\n    workgroupBarrier();               // before next j overwrites red\n  }\n  if (d < D) { outp[qi * D + d] = acc / l; }\n}\n",
	"attention_online_cache": "// Causal GQA attention (online/flash softmax, head_dim up to 256) reading K/V from the persistent\n// f32 cache (Kc/Vc, layout [pos*KV + kv_head, D]) - the Qwen3.5 full-attention path for both prefill\n// and decode. One workgroup per query (s,h); thread d owns output dim d. The query at absolute\n// position posBase+s attends to cache positions 0 .. posBase+s (causal). Keys are cached already\n// RoPE'd, so no read-time rotation.\noverride WGD: u32 = 256u;                  // threads == head_dim D\nstruct Params { S: u32, H: u32, KV: u32, D: u32, scale: f32, posBase: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;    // [S, H, D]\n@group(0) @binding(2) var<storage, read> kc: array<f32>;   // cache [cap*KV, D]\n@group(0) @binding(3) var<storage, read> vc: array<f32>;   // cache [cap*KV, D]\n@group(0) @binding(4) var<storage, read_write> outp: array<f32>; // [S, H, D]\nvar<workgroup> qsh: array<f32, 256>;\nvar<workgroup> red: array<f32, 256>;\n\n@compute @workgroup_size(WGD)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let qi = wg.x;                 // query flat index = s*H + h\n  let s = qi / p.H;\n  let h = qi % p.H;\n  let hkv = h / (p.H / p.KV);\n  let d = lid.x;\n  let D = p.D;\n  if (d < D) { qsh[d] = q[qi * D + d]; }\n  workgroupBarrier();\n\n  var m = -1e30;\n  var l = 0.0;\n  var acc = 0.0;\n  let last = p.posBase + s;      // inclusive: attend cache positions 0..last\n  for (var j = 0u; j <= last; j = j + 1u) {\n    red[d] = select(0.0, qsh[d] * kc[(j * p.KV + hkv) * D + d], d < D);\n    workgroupBarrier();\n    for (var st = WGD / 2u; st > 0u; st = st >> 1u) {\n      if (d < st) { red[d] = red[d] + red[d + st]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * p.scale;\n    let mn = max(m, score);\n    let corr = exp(m - mn);\n    let pj = exp(score - mn);\n    l = l * corr + pj;\n    if (d < D) { acc = acc * corr + pj * vc[(j * p.KV + hkv) * D + d]; }\n    m = mn;\n    workgroupBarrier();\n  }\n  if (d < D) { outp[qi * D + d] = acc / l; }\n}\n",
	"attention_online_cache_kv8": "// q8 variant of attention_online_cache: the Qwen3.5 full-attention path reading K/V from the packed\n// snorm8 cache (kcQ/vcQ = 4 x snorm8 per u32 word, kcS/vcS = one f32 scale per 32-element block,\n// llama.cpp q8_0-style, written by copy_kv8). Each element is dequantized with one unpack4x8snorm +\n// block-scale multiply at read time; all online-softmax arithmetic stays f32, so this matches the f32\n// attention_online_cache exactly except for the single snorm8 rounding of K/V at write (nothing\n// compounds). Same structure: one workgroup per query (s,h), thread d owns output dim d. head_dim <=256.\noverride WGD: u32 = 256u;                  // threads == head_dim D\nstruct Params { S: u32, H: u32, KV: u32, D: u32, scale: f32, posBase: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;    // [S, H, D]\n@group(0) @binding(2) var<storage, read> kcQ: array<u32>;  // cache [cap*KV, D/4] packed snorm8\n@group(0) @binding(3) var<storage, read> kcS: array<f32>;  // cache [cap*KV, D/32] block scales\n@group(0) @binding(4) var<storage, read> vcQ: array<u32>;  // cache [cap*KV, D/4]\n@group(0) @binding(5) var<storage, read> vcS: array<f32>;  // cache [cap*KV, D/32]\n@group(0) @binding(6) var<storage, read_write> outp: array<f32>; // [S, H, D]\nvar<workgroup> qsh: array<f32, 256>;\nvar<workgroup> red: array<f32, 256>;\n\n@compute @workgroup_size(WGD)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let qi = wg.x;                 // query flat index = s*H + h\n  let s = qi / p.H;\n  let h = qi % p.H;\n  let hkv = h / (p.H / p.KV);\n  let d = lid.x;\n  let D = p.D;\n  let W4 = D / 4u;\n  let NB = D / 32u;\n  if (d < D) { qsh[d] = q[qi * D + d]; }\n  workgroupBarrier();\n\n  var m = -1e30;\n  var l = 0.0;\n  var acc = 0.0;\n  let last = p.posBase + s;      // inclusive: attend cache positions 0..last\n  for (var j = 0u; j <= last; j = j + 1u) {\n    let row = j * p.KV + hkv;\n    var kval = 0.0;\n    if (d < D) { kval = unpack4x8snorm(kcQ[row * W4 + (d >> 2u)])[d & 3u] * kcS[row * NB + (d >> 5u)]; }\n    red[d] = select(0.0, qsh[d] * kval, d < D);\n    workgroupBarrier();\n    for (var st = WGD / 2u; st > 0u; st = st >> 1u) {\n      if (d < st) { red[d] = red[d] + red[d + st]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * p.scale;\n    let mn = max(m, score);\n    let corr = exp(m - mn);\n    let pj = exp(score - mn);\n    l = l * corr + pj;\n    if (d < D) {\n      let vval = unpack4x8snorm(vcQ[row * W4 + (d >> 2u)])[d & 3u] * vcS[row * NB + (d >> 5u)];\n      acc = acc * corr + pj * vval;\n    }\n    m = mn;\n    workgroupBarrier();\n  }\n  if (d < D) { outp[qi * D + d] = acc / l; }\n}\n",
	"attention_sg": "// Causal GQA attention, subgroup-parallel: one subgroup (= one workgroup) per (query, head).\n// Lanes split head_dim; flash-style online softmax over the cached positions; the per-position\n// score (q.k) is reduced with subgroupAdd. Fixes the decode bottleneck where attention ran only\n// H threads. SG = device subgroup size (16/32/64, so head_dim/SG <= 8). Reads K/V from the cache.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(3) var<storage, read> Vc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let dper = p.D / SG;                         // <= 8 for SG>=16, D=128\n\n  var acc: array<f32, 8>;\n  for (var t = 0u; t < dper; t = t + 1u) { acc[t] = 0.0; }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var part = 0.0;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; part = part + q[qb + d] * Kc[kb + d]; }\n    let score = subgroupAdd(part) * inv;       // full q.k dot, broadcast to all lanes\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; acc[t] = acc[t] * corr + w * Vc[kb + d]; }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; out[ob + d] = acc[t] / l; }\n}\n",
	"attention_sg_kv16": "// attention_sg with an f16-STORAGE KV cache (kvCache: 'f16'). Keep in lockstep with\n// attention_sg.wgsl: the ONLY difference is Kc/Vc are array<f16> and each cached value is\n// widened to f32 at the read. All arithmetic (dot, softmax, accumulation) stays f32, so the\n// precision loss is exactly one rounding of K/V at cache-write time, nothing compounding.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(3) var<storage, read> Vc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let dper = p.D / SG;\n\n  var acc: array<f32, 8>;\n  for (var t = 0u; t < dper; t = t + 1u) { acc[t] = 0.0; }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var part = 0.0;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; part = part + q[qb + d] * f32(Kc[kb + d]); }\n    let score = subgroupAdd(part) * inv;\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; acc[t] = acc[t] * corr + w * f32(Vc[kb + d]); }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; out[ob + d] = acc[t] / l; }\n}\n",
	"attention_sg_kv16_roll": "// attention_sg_kv16 for the rolling-window / attention-sinks mode (see attention_sg_roll.wgsl\n// for the rope-at-read scheme). Keep in lockstep with attention_sg_kv16.wgsl: the ONLY\n// difference is the K rotation in the score loop; each cached f16 value is widened to f32 at\n// the read and rotated with the same `k*cos + rot*sin` operand order as rmsnorm_rope_sg.\n// The engine only selects this kernel when SG <= D/2 (partner dim stays in-lane).\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kc: array<f16>;       // [Ltot, KV, D] UNROPED\n@group(0) @binding(3) var<storage, read> Vc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(5) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let dper = p.D / SG;\n  let half = p.D / 2u;\n  let hs = half / SG;                          // strides from a dim to its rotate partner\n\n  var acc: array<f32, 8>;\n  for (var t = 0u; t < dper; t = t + 1u) { acc[t] = 0.0; }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var kd: array<f32, 8>;\n    for (var t = 0u; t < dper; t = t + 1u) { kd[t] = f32(Kc[kb + lane + t * SG]); }\n    var part = 0.0;\n    for (var t = 0u; t < dper; t = t + 1u) {\n      let d = lane + t * SG;\n      var rot: f32;\n      if (d < half) { rot = -kd[t + hs]; } else { rot = kd[t - hs]; }\n      let rb = j * half + (d % half);\n      part = part + q[qb + d] * (kd[t] * cosT[rb] + rot * sinT[rb]);\n    }\n    let score = subgroupAdd(part) * inv;\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; acc[t] = acc[t] * corr + w * f32(Vc[kb + d]); }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; out[ob + d] = acc[t] / l; }\n}\n",
	"attention_sg_kv8": "// attention_sg with a q8 KV cache (kvCache: 'q8'). Keep in lockstep with attention_sg.wgsl: the\n// ONLY difference is Kc/Vc are packed snorm8 words dequantized at the read with their per-block\n// f32 scales (32-element blocks, q8_0-style; see copy_kv8.wgsl). All arithmetic (dot, softmax,\n// accumulation) stays f32. Each lane owns whole packed words, so q is read in matching groups\n// of 4.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;         // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kq: array<u32>;        // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(3) var<storage, read> Vq: array<u32>;        // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(4) var<storage, read> Ks: array<f32>;        // [Ltot, KV, D/32] block scales\n@group(0) @binding(5) var<storage, read> Vs: array<f32>;        // [Ltot, KV, D/32] block scales\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let W4 = p.D / 4u;\n  let B32 = p.D / 32u;\n\n  var acc: array<vec4<f32>, 8>;      // words per lane: W4/SG <= 8 for SG >= 4\n  for (var t = 0u; t < 8u; t = t + 1u) { acc[t] = vec4<f32>(0.0); }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let rowQ = (j * p.KV + kvh) * W4;\n    let rowS = (j * p.KV + kvh) * B32;\n    var part = 0.0;\n    for (var w = lane; w < W4; w = w + SG) {\n      let kw = unpack4x8snorm(Kq[rowQ + w]) * Ks[rowS + (w >> 3u)];\n      let qv = vec4<f32>(q[qb + w * 4u], q[qb + w * 4u + 1u], q[qb + w * 4u + 2u], q[qb + w * 4u + 3u]);\n      part = part + dot(qv, kw);\n    }\n    let score = subgroupAdd(part) * inv;\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let wgt = exp(score - mnew);\n    l = l * corr + wgt;\n    var wi = 0u;\n    for (var w = lane; w < W4; w = w + SG) {\n      let vw = unpack4x8snorm(Vq[rowQ + w]) * Vs[rowS + (w >> 3u)];\n      acc[wi] = acc[wi] * corr + wgt * vw;\n      wi = wi + 1u;\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  var wi = 0u;\n  for (var w = lane; w < W4; w = w + SG) {\n    let o = acc[wi] / l;\n    out[ob + w * 4u] = o.x;\n    out[ob + w * 4u + 1u] = o.y;\n    out[ob + w * 4u + 2u] = o.z;\n    out[ob + w * 4u + 3u] = o.w;\n    wi = wi + 1u;\n  }\n}\n",
	"attention_sg_kv8_roll": "// attention_sg_kv8 for the rolling-window / attention-sinks mode (see attention_sg_roll.wgsl\n// for the rope-at-read scheme). Keep in lockstep with attention_sg_kv8.wgsl: the ONLY\n// difference is the K rotation in the score loop. The cache holds UNROPED quantized keys -\n// the whole point: the packed bytes are immutable, so eviction never requantizes (llama.cpp's\n// K-shift cannot do this on a quantized cache at all). A word's rotate partner is the word\n// D/8 away (all 4 dims of a word share one half), dequantized from global with its own scale.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kq: array<u32>;       // [Ltot, KV, D/4] packed snorm8, UNROPED\n@group(0) @binding(3) var<storage, read> Vq: array<u32>;       // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(4) var<storage, read> Ks: array<f32>;       // [Ltot, KV, D/32] block scales\n@group(0) @binding(5) var<storage, read> Vs: array<f32>;       // [Ltot, KV, D/32] block scales\n@group(0) @binding(6) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(7) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(8) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let W4 = p.D / 4u;\n  let B32 = p.D / 32u;\n  let half = p.D / 2u;\n  let hw = half / 4u;                          // words from a word to its rotate partner\n\n  var acc: array<vec4<f32>, 8>;      // words per lane: W4/SG <= 8 for SG >= 4\n  for (var t = 0u; t < 8u; t = t + 1u) { acc[t] = vec4<f32>(0.0); }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let rowQ = (j * p.KV + kvh) * W4;\n    let rowS = (j * p.KV + kvh) * B32;\n    var part = 0.0;\n    for (var w = lane; w < W4; w = w + SG) {\n      let kw = unpack4x8snorm(Kq[rowQ + w]) * Ks[rowS + (w >> 3u)];\n      let wp = select(w - hw, w + hw, w < hw);\n      let kp = unpack4x8snorm(Kq[rowQ + wp]) * Ks[rowS + (wp >> 3u)];\n      let rot = select(kp, -kp, w < hw);\n      let cb = j * half + select(w - hw, w, w < hw) * 4u;\n      let cs = vec4<f32>(cosT[cb], cosT[cb + 1u], cosT[cb + 2u], cosT[cb + 3u]);\n      let sn = vec4<f32>(sinT[cb], sinT[cb + 1u], sinT[cb + 2u], sinT[cb + 3u]);\n      let qv = vec4<f32>(q[qb + w * 4u], q[qb + w * 4u + 1u], q[qb + w * 4u + 2u], q[qb + w * 4u + 3u]);\n      part = part + dot(qv, kw * cs + rot * sn);\n    }\n    let score = subgroupAdd(part) * inv;\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let wgt = exp(score - mnew);\n    l = l * corr + wgt;\n    var wi = 0u;\n    for (var w = lane; w < W4; w = w + SG) {\n      let vw = unpack4x8snorm(Vq[rowQ + w]) * Vs[rowS + (w >> 3u)];\n      acc[wi] = acc[wi] * corr + wgt * vw;\n      wi = wi + 1u;\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  var wi = 0u;\n  for (var w = lane; w < W4; w = w + SG) {\n    let o = acc[wi] / l;\n    out[ob + w * 4u] = o.x;\n    out[ob + w * 4u + 1u] = o.y;\n    out[ob + w * 4u + 2u] = o.z;\n    out[ob + w * 4u + 3u] = o.w;\n    wi = wi + 1u;\n  }\n}\n",
	"attention_sg_roll": "// attention_sg for the rolling-window / attention-sinks mode (overflow: 'sinks'): the cache\n// holds UNROPED keys, and each cached row j is rotated AT READ by its cache-relative position\n// (StreamingLLM-style; the cache bytes are immutable, so eviction compaction never re-rotates\n// or requantizes anything). Keep in lockstep with attention_sg.wgsl: the ONLY difference is\n// the K rotation in the score loop, written as `k*cos + rot*sin` with the same operand order\n// as rmsnorm_rope_sg so the f32 path stays bit-identical to the roped-at-write kernels until\n// the first eviction. cosT/sinT are the aux rope tables, [positions, D/2].\n// Lane math: d = lane + t*SG, partner d±D/2 is (D/2)/SG strides away IN THE SAME LANE (the\n// engine only selects this kernel when SG <= D/2).\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kc: array<f32>;       // [Ltot, KV, D] UNROPED\n@group(0) @binding(3) var<storage, read> Vc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(5) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let idx = wg.x;\n  if (idx >= p.S * p.H) { return; }\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let dper = p.D / SG;\n  let half = p.D / 2u;\n  let hs = half / SG;                          // strides from a dim to its rotate partner\n\n  var acc: array<f32, 8>;\n  for (var t = 0u; t < dper; t = t + 1u) { acc[t] = 0.0; }\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var kd: array<f32, 8>;\n    for (var t = 0u; t < dper; t = t + 1u) { kd[t] = Kc[kb + lane + t * SG]; }\n    var part = 0.0;\n    for (var t = 0u; t < dper; t = t + 1u) {\n      let d = lane + t * SG;\n      var rot: f32;\n      if (d < half) { rot = -kd[t + hs]; } else { rot = kd[t - hs]; }\n      let rb = j * half + (d % half);\n      part = part + q[qb + d] * (kd[t] * cosT[rb] + rot * sinT[rb]);\n    }\n    let score = subgroupAdd(part) * inv;\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; acc[t] = acc[t] * corr + w * Vc[kb + d]; }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < dper; t = t + 1u) { let d = lane + t * SG; out[ob + d] = acc[t] / l; }\n}\n",
	"attention_wg": "// Causal GQA attention, no-subgroup fallback: one workgroup per (query, head); threads split\n// head_dim; flash-style online softmax over the cached positions; the per-position q.k score\n// is tree-reduced via shared memory. Replaces attention_cache on this path: its single thread\n// per (query, head) walked the WHOLE context serially, so fallback decode degraded linearly\n// with conversation length and prefill attention was latency-bound. Mirrors attention_sg with\n// subgroupAdd swapped for the shared-memory reduction. Fixed workgroup of 64: the per-thread\n// accumulator covers head_dim <= 128 (enforced at manifest validation) in 2 strides.\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(3) var<storage, read> Vc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                        // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let tid = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n\n  var acc: array<f32, 2>;\n  acc[0] = 0.0;\n  acc[1] = 0.0;\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var part = 0.0;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { part = part + q[qb + d] * Kc[kb + d]; }\n    }\n    red[tid] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (tid < s) { red[tid] = red[tid] + red[tid + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;            // full q.k dot, visible to all threads\n    workgroupBarrier();                  // red[0] consumed before the next position overwrites it\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { acc[t] = acc[t] * corr + w * Vc[kb + d]; }\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < 2u; t = t + 1u) {\n    let d = tid + t * 64u;\n    if (d < p.D) { out[ob + d] = acc[t] / l; }\n  }\n}\n",
	"attention_wg_kv16": "// attention_wg with an f16-STORAGE KV cache (kvCache: 'f16'). Keep in lockstep with\n// attention_wg.wgsl: the ONLY difference is Kc/Vc are array<f16>, widened to f32 at the read.\nenable f16;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(3) var<storage, read> Vc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                        // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let tid = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n\n  var acc: array<f32, 2>;\n  acc[0] = 0.0;\n  acc[1] = 0.0;\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    var part = 0.0;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { part = part + q[qb + d] * f32(Kc[kb + d]); }\n    }\n    red[tid] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (tid < s) { red[tid] = red[tid] + red[tid + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;\n    workgroupBarrier();\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { acc[t] = acc[t] * corr + w * f32(Vc[kb + d]); }\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < 2u; t = t + 1u) {\n    let d = tid + t * 64u;\n    if (d < p.D) { out[ob + d] = acc[t] / l; }\n  }\n}\n",
	"attention_wg_kv16_roll": "// attention_wg_kv16 for the rolling-window / attention-sinks mode (see attention_sg_roll.wgsl\n// for the rope-at-read scheme). Keep in lockstep with attention_wg_kv16.wgsl: the ONLY\n// differences are the shared-memory K stage (kk, widened to f32) - the rotate partner d±D/2\n// may live in another thread's stride - and the rotation in the score loop, written as\n// `k*cos + rot*sin` with the same operand order as rmsnorm_rope_sg.\nenable f16;\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kc: array<f16>;       // [Ltot, KV, D] UNROPED\n@group(0) @binding(3) var<storage, read> Vc: array<f16>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(5) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\nvar<workgroup> kk: array<f32, 128>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                        // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let tid = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let half = p.D / 2u;\n\n  var acc: array<f32, 2>;\n  acc[0] = 0.0;\n  acc[1] = 0.0;\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { kk[d] = f32(Kc[kb + d]); }\n    }\n    workgroupBarrier();\n    var part = 0.0;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) {\n        var rot: f32;\n        if (d < half) { rot = -kk[d + half]; } else { rot = kk[d - half]; }\n        let rb = j * half + (d % half);\n        part = part + q[qb + d] * (kk[d] * cosT[rb] + rot * sinT[rb]);\n      }\n    }\n    red[tid] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (tid < s) { red[tid] = red[tid] + red[tid + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;\n    workgroupBarrier();                  // red[0] + kk consumed before the next position overwrites them\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { acc[t] = acc[t] * corr + w * f32(Vc[kb + d]); }\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < 2u; t = t + 1u) {\n    let d = tid + t * 64u;\n    if (d < p.D) { out[ob + d] = acc[t] / l; }\n  }\n}\n",
	"attention_wg_kv8": "// attention_wg with a q8 KV cache (kvCache: 'q8'): the no-subgroup fallback reader for the\n// packed-snorm8 cache (see copy_kv8.wgsl for the write side). Keep in lockstep with\n// attention_wg.wgsl: same online softmax, all arithmetic f32; each thread owns one packed word\n// (D <= 128 -> at most 32 words, so threads 32..63 only carry zeros through the reduction).\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;         // [S, H, D]\n@group(0) @binding(2) var<storage, read> Kq: array<u32>;        // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(3) var<storage, read> Vq: array<u32>;        // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(4) var<storage, read> Ks: array<f32>;        // [Ltot, KV, D/32] block scales\n@group(0) @binding(5) var<storage, read> Vs: array<f32>;        // [Ltot, KV, D/32] block scales\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                    // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let t = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let W4 = p.D / 4u;\n\n  var qv = vec4<f32>(0.0);\n  if (t < W4) {\n    qv = vec4<f32>(q[qb + t * 4u], q[qb + t * 4u + 1u], q[qb + t * 4u + 2u], q[qb + t * 4u + 3u]);\n  }\n  var acc = vec4<f32>(0.0);\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let rowQ = (j * p.KV + kvh) * W4;\n    let rowS = (j * p.KV + kvh) * (p.D / 32u);\n    var part = 0.0;\n    if (t < W4) {\n      let kw = unpack4x8snorm(Kq[rowQ + t]) * Ks[rowS + (t >> 3u)];\n      part = dot(qv, kw);\n    }\n    red[t] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (t < s) { red[t] = red[t] + red[t + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;\n    workgroupBarrier();\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let wgt = exp(score - mnew);\n    l = l * corr + wgt;\n    if (t < W4) {\n      let vw = unpack4x8snorm(Vq[rowQ + t]) * Vs[rowS + (t >> 3u)];\n      acc = acc * corr + wgt * vw;\n    }\n    m = mnew;\n  }\n  if (t < W4) {\n    let ob = (qi * p.H + h) * p.D;\n    let o = acc / l;\n    out[ob + t * 4u] = o.x;\n    out[ob + t * 4u + 1u] = o.y;\n    out[ob + t * 4u + 2u] = o.z;\n    out[ob + t * 4u + 3u] = o.w;\n  }\n}\n",
	"attention_wg_kv8_roll": "// attention_wg_kv8 for the rolling-window / attention-sinks mode: the no-subgroup fallback of\n// attention_sg_kv8_roll (see there and attention_sg_roll.wgsl for the rope-at-read scheme).\n// Keep in lockstep with attention_wg_kv8.wgsl: the ONLY difference is the K rotation in the\n// score loop; each thread's word rotates against its partner word D/8 away, dequantized from\n// global with its own scale.\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kq: array<u32>;       // [Ltot, KV, D/4] packed snorm8, UNROPED\n@group(0) @binding(3) var<storage, read> Vq: array<u32>;       // [Ltot, KV, D/4] packed snorm8\n@group(0) @binding(4) var<storage, read> Ks: array<f32>;       // [Ltot, KV, D/32] block scales\n@group(0) @binding(5) var<storage, read> Vs: array<f32>;       // [Ltot, KV, D/32] block scales\n@group(0) @binding(6) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(7) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(8) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                    // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let t = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let W4 = p.D / 4u;\n  let half = p.D / 2u;\n  let hw = half / 4u;                          // words from a word to its rotate partner\n\n  var qv = vec4<f32>(0.0);\n  if (t < W4) {\n    qv = vec4<f32>(q[qb + t * 4u], q[qb + t * 4u + 1u], q[qb + t * 4u + 2u], q[qb + t * 4u + 3u]);\n  }\n  var acc = vec4<f32>(0.0);\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let rowQ = (j * p.KV + kvh) * W4;\n    let rowS = (j * p.KV + kvh) * (p.D / 32u);\n    var part = 0.0;\n    if (t < W4) {\n      let kw = unpack4x8snorm(Kq[rowQ + t]) * Ks[rowS + (t >> 3u)];\n      let wp = select(t - hw, t + hw, t < hw);\n      let kp = unpack4x8snorm(Kq[rowQ + wp]) * Ks[rowS + (wp >> 3u)];\n      let rot = select(kp, -kp, t < hw);\n      let cb = j * half + select(t - hw, t, t < hw) * 4u;\n      let cs = vec4<f32>(cosT[cb], cosT[cb + 1u], cosT[cb + 2u], cosT[cb + 3u]);\n      let sn = vec4<f32>(sinT[cb], sinT[cb + 1u], sinT[cb + 2u], sinT[cb + 3u]);\n      part = dot(qv, kw * cs + rot * sn);\n    }\n    red[t] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (t < s) { red[t] = red[t] + red[t + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;\n    workgroupBarrier();\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let wgt = exp(score - mnew);\n    l = l * corr + wgt;\n    if (t < W4) {\n      let vw = unpack4x8snorm(Vq[rowQ + t]) * Vs[rowS + (t >> 3u)];\n      acc = acc * corr + wgt * vw;\n    }\n    m = mnew;\n  }\n  if (t < W4) {\n    let ob = (qi * p.H + h) * p.D;\n    let o = acc / l;\n    out[ob + t * 4u] = o.x;\n    out[ob + t * 4u + 1u] = o.y;\n    out[ob + t * 4u + 2u] = o.z;\n    out[ob + t * 4u + 3u] = o.w;\n  }\n}\n",
	"attention_wg_roll": "// attention_wg for the rolling-window / attention-sinks mode: no-subgroup fallback of\n// attention_sg_roll (see there for the rope-at-read scheme). Keep in lockstep with\n// attention_wg.wgsl: the ONLY differences are the shared-memory K stage (kk) - the rotate\n// partner d±D/2 may live in another thread's stride - and the rotation in the score loop,\n// written as `k*cos + rot*sin` with the same operand order as rmsnorm_rope_sg.\nstruct Params { S: u32, H: u32, KV: u32, D: u32, posBase: u32, Ltot: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;        // [S, H, D] (roped, cache-relative)\n@group(0) @binding(2) var<storage, read> Kc: array<f32>;       // [Ltot, KV, D] UNROPED\n@group(0) @binding(3) var<storage, read> Vc: array<f32>;       // [Ltot, KV, D]\n@group(0) @binding(4) var<storage, read> cosT: array<f32>;     // [positions, D/2]\n@group(0) @binding(5) var<storage, read> sinT: array<f32>;     // [positions, D/2]\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S, H, D]\nvar<workgroup> red: array<f32, 64>;\nvar<workgroup> kk: array<f32, 128>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let idx = wg.x;                        // uniform across the workgroup -> early return is barrier-safe\n  if (idx >= p.S * p.H) { return; }\n  let tid = lid.x;\n  let h = idx % p.H;\n  let qi = idx / p.H;\n  let pos = p.posBase + qi;\n  let kvh = h / (p.H / p.KV);\n  let qb = (qi * p.H + h) * p.D;\n  let inv = 1.0 / sqrt(f32(p.D));\n  let half = p.D / 2u;\n\n  var acc: array<f32, 2>;\n  acc[0] = 0.0;\n  acc[1] = 0.0;\n  var m = -1e30;\n  var l = 0.0;\n  for (var j = 0u; j <= pos; j = j + 1u) {\n    let kb = (j * p.KV + kvh) * p.D;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { kk[d] = Kc[kb + d]; }\n    }\n    workgroupBarrier();\n    var part = 0.0;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) {\n        var rot: f32;\n        if (d < half) { rot = -kk[d + half]; } else { rot = kk[d - half]; }\n        let rb = j * half + (d % half);\n        part = part + q[qb + d] * (kk[d] * cosT[rb] + rot * sinT[rb]);\n      }\n    }\n    red[tid] = part;\n    workgroupBarrier();\n    for (var s = 32u; s > 0u; s = s >> 1u) {\n      if (tid < s) { red[tid] = red[tid] + red[tid + s]; }\n      workgroupBarrier();\n    }\n    let score = red[0] * inv;            // full q.k dot, visible to all threads\n    workgroupBarrier();                  // red[0] + kk consumed before the next position overwrites them\n    let mnew = max(m, score);\n    let corr = exp(m - mnew);\n    let w = exp(score - mnew);\n    l = l * corr + w;\n    for (var t = 0u; t < 2u; t = t + 1u) {\n      let d = tid + t * 64u;\n      if (d < p.D) { acc[t] = acc[t] * corr + w * Vc[kb + d]; }\n    }\n    m = mnew;\n  }\n  let ob = (qi * p.H + h) * p.D;\n  for (var t = 0u; t < 2u; t = t + 1u) {\n    let d = tid + t * 64u;\n    if (d < p.D) { out[ob + d] = acc[t] / l; }\n  }\n}\n",
	"conv1d_causal": "// Depthwise causal Conv1d (kernel width K) + SiLU, for the gated-DeltaNet q/k/v stream. x is\n// [S, C] (C = conv_dim channels), weight is [C, K] (per-channel taps, the GGUF ssm_conv1d layout).\n// Carries a persistent left-context so segmented prefill and token-by-token decode continue across\n// calls: state_in / state_out hold the last K-1 inputs ([K-1, C]); loadState!=0 uses them (else the\n// causal left pad is zero). Extended input ext = [state_in (K-1), x (S)]:\n//   y[t,c] = silu( sum_{j<K} w[c,j] * ext[t+j, c] ),   state_out[i,c] = ext[S+i, c]  (i < K-1)\nstruct Params { S: u32, C: u32, K: u32, loadState: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;          // [S, C]\n@group(0) @binding(2) var<storage, read> w: array<f32>;          // [C, K]\n@group(0) @binding(3) var<storage, read> state_in: array<f32>;   // [K-1, C]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;    // [S, C]\n@group(0) @binding(5) var<storage, read_write> state_out: array<f32>; // [K-1, C]\n\nfn ext(m: u32, c: u32) -> f32 {\n  if (m + 1u < p.K) { return select(0.0, state_in[m * p.C + c], p.loadState != 0u); }\n  return x[(m - (p.K - 1u)) * p.C + c];\n}\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  let outN = p.S * p.C;\n  if (i < outN) {\n    let c = i % p.C;\n    let t = i / p.C;\n    var acc = 0.0;\n    for (var j = 0u; j < p.K; j = j + 1u) { acc = acc + w[c * p.K + j] * ext(t + j, c); }\n    y[i] = acc / (1.0 + exp(-acc));  // SiLU\n  } else if (i < outN + (p.K - 1u) * p.C) {\n    let si = i - outN;\n    let sc = si % p.C;\n    let sk = si / p.C;                 // 0 .. K-2\n    state_out[sk * p.C + sc] = ext(p.S + sk, sc);\n  }\n}\n",
	"copy": "// Copy src[0..n) into dst[dstOff..dstOff+n). Used to append K/V into the persistent cache.\nstruct Params { n: u32, dstOff: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> src: array<f32>;\n@group(0) @binding(2) var<storage, read_write> dst: array<f32>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.n) { return; }\n  dst[p.dstOff + i] = src[i];\n}\n",
	"copy_kv16": "// copy with an f16-STORAGE destination (kvCache: 'f16'): appends f32 K/V rows into the f16\n// cache (one f32 -> f16 rounding per value). Keep in lockstep with copy.wgsl.\nenable f16;\nstruct Params { n: u32, dstOff: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> src: array<f32>;\n@group(0) @binding(2) var<storage, read_write> dst: array<f16>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.n) { return; }\n  dst[p.dstOff + i] = f16(src[i]);\n}\n",
	"copy_kv8": "// q8 cache append (kvCache: 'q8'): quantize f32 K/V rows into the packed-snorm8 cache, one f32\n// scale per 32-element block (llama.cpp q8_0-style). One 64-thread workgroup per row of D\n// elements: thread t owns packed word t (4 consecutive values), the workgroup reduces per-block\n// absolute maxima through shared memory, then packs with pack4x8snorm. Replaces copy/copy_kv16\n// at every cache-append site under q8. All attention arithmetic stays f32; the precision loss is\n// exactly one snorm8 rounding of K/V at write time, nothing compounding.\nstruct Params { rows: u32, D: u32, dstRow0: u32, _p: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> src: array<f32>;          // [rows, D]\n@group(0) @binding(2) var<storage, read_write> dstQ: array<u32>;   // packed 4 x snorm8 per word\n@group(0) @binding(3) var<storage, read_write> dstS: array<f32>;   // [.., D/32] block scales\n\nvar<workgroup> wabs: array<f32, 64>; // per-word abs max (D <= 256 -> at most 64 words)\nvar<workgroup> wblk: array<f32, 8>;  // per-block scale (D/32 <= 8 blocks)\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let row = wg.x;                    // uniform across the workgroup -> early return is barrier-safe\n  if (row >= p.rows) { return; }\n  let t = lid.x;\n  let W4 = p.D / 4u;\n  let base = row * p.D;\n  var v = vec4<f32>(0.0);\n  if (t < W4) {\n    v = vec4<f32>(src[base + t * 4u], src[base + t * 4u + 1u], src[base + t * 4u + 2u], src[base + t * 4u + 3u]);\n    wabs[t] = max(max(abs(v.x), abs(v.y)), max(abs(v.z), abs(v.w)));\n  }\n  workgroupBarrier();\n  if (t < p.D / 32u) {\n    var m = 0.0;\n    for (var i = 0u; i < 8u; i = i + 1u) { m = max(m, wabs[t * 8u + i]); }\n    let s = max(m, 1e-30);           // an all-zero block packs zeros, never NaN\n    wblk[t] = s;\n    dstS[(p.dstRow0 + row) * (p.D / 32u) + t] = s;\n  }\n  workgroupBarrier();\n  if (t < W4) {\n    dstQ[(p.dstRow0 + row) * W4 + t] = pack4x8snorm(v / wblk[t >> 3u]);\n  }\n}\n",
	"deltanet_gbeta": "// DeltaNet gate/decay compute: from the a (decay input) and b (beta input) projections,\n//   g[s,h]    = a_neg[h] * softplus(a[s,h] + dt_bias[h])     (<= 0, log-space decay)\n//   beta[s,h] = sigmoid(b[s,h])\n// per value head h. a_neg is -exp(A_log): the PrismML GGUF stores this pre-computed in the ssm_a\n// tensor (verified against the transformers A_log), so no exp() here. One invocation per (s,h);\n// output is [g (S*H) ; beta (S*H)] concatenated (engine binds two sub-ranges). Matches qwen35_numpy.\nstruct Params { S: u32, H: u32, _p0: u32, _p1: u32 };  // H = num_value_heads\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> a: array<f32>;        // [S, H]\n@group(0) @binding(2) var<storage, read> b: array<f32>;        // [S, H]\n@group(0) @binding(3) var<storage, read> a_neg: array<f32>;    // [H] = -exp(A_log)\n@group(0) @binding(4) var<storage, read> dt_bias: array<f32>;  // [H]\n@group(0) @binding(5) var<storage, read_write> out: array<f32>;// [2*S*H]: g then beta\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  let n = p.S * p.H;\n  if (i >= n) { return; }\n  let h = i % p.H;\n  let x = a[i] + dt_bias[h];\n  let sp = max(x, 0.0) + log(1.0 + exp(-abs(x)));   // softplus (stable)\n  out[i] = a_neg[h] * sp;                            // g  (a_neg already = -exp(A_log))\n  out[n + i] = 1.0 / (1.0 + exp(-b[i]));             // beta\n}\n",
	"deltanet_norm_gate": "// Gated RMSNorm for the DeltaNet output: y = gamma * rmsnorm(core) * silu(z), normalized over the\n// value head dim (one workgroup per head-vector row). Unlike the model's plain RMSNorm this uses\n// the weight directly (not 1+weight), matching tools/qwen35_numpy (Qwen3NextRMSNormGated).\noverride WG: u32 = 128u;\nstruct Params { rows: u32, DV: u32, eps: f32, _pad: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> core: array<f32>;   // [rows, DV]\n@group(0) @binding(2) var<storage, read> z: array<f32>;      // [rows, DV] gate\n@group(0) @binding(3) var<storage, read> gamma: array<f32>;  // [DV]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;// [rows, DV]\nvar<workgroup> sdata: array<f32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let row = wg.x;\n  if (row >= p.rows) { return; }\n  let tid = lid.x;\n  let base = row * p.DV;\n  var s = 0.0;\n  for (var i = tid; i < p.DV; i = i + WG) { let c = core[base + i]; s = s + c * c; }\n  sdata[tid] = s;\n  workgroupBarrier();\n  for (var st = WG / 2u; st > 0u; st = st >> 1u) {\n    if (tid < st) { sdata[tid] = sdata[tid] + sdata[tid + st]; }\n    workgroupBarrier();\n  }\n  let inv = inverseSqrt(sdata[0] / f32(p.DV) + p.eps);\n  for (var i = tid; i < p.DV; i = i + WG) {\n    let zz = z[base + i];\n    y[base + i] = gamma[i] * (core[base + i] * inv) * (zz / (1.0 + exp(-zz)));  // * silu(z)\n  }\n}\n",
	"deltanet_recur": "// Gated DeltaNet recurrent scan (the sequential O(1)/token gated delta rule; bitgpu's decode path\n// and a correctness reference for prefill). One workgroup per value head; thread `dv` owns value\n// column dv of the per-head state S[dk,dv], held in registers across the token loop. Per token:\n//   S *= exp(g);  kv = Kn·S;  delta = (v - kv)·beta;  S += Kn⊗delta;  out = Qn·S\n// with Kn = l2norm(k), Qn = l2norm(q)/sqrt(dk) (matches tools/qwen35_numpy._delta_recurrent).\n// GQA: value head h reads q/k from key head h%HK. GGUF/bitgpu store value heads grouped\n// [rep, n_key_heads] (transposed from HF's [n_key_heads, rep]), so the shared key/query head is\n// h%HK (a \"tile\"), NOT h/(H/HK) (a \"repeat-interleave\"). loadState!=0 continues from state_in\n// (persistent decode/cross-segment state); state_out always carries the final state out.\noverride WGV: u32 = 128u;                 // threads per workgroup == head_v_dim (dv)\nstruct Params { S: u32, H: u32, DK: u32, DV: u32, HK: u32, betaOff: u32, loadState: u32, tOff: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> q: array<f32>;      // [S, HK, DK]\n@group(0) @binding(2) var<storage, read> k: array<f32>;      // [S, HK, DK]\n@group(0) @binding(3) var<storage, read> v: array<f32>;      // [S, H, DV]\n@group(0) @binding(4) var<storage, read> g: array<f32>;      // [S, H]\n@group(0) @binding(5) var<storage, read> beta: array<f32>;   // [S, H]\n@group(0) @binding(6) var<storage, read> state_in: array<f32>;    // [H, DK, DV]\n@group(0) @binding(7) var<storage, read_write> core: array<f32>;  // [S, H, DV]\n@group(0) @binding(8) var<storage, read_write> state_out: array<f32>; // [H, DK, DV]\nvar<workgroup> ksh: array<f32, 128>;      // current token's raw k (>= DK)\nvar<workgroup> qsh: array<f32, 128>;      // current token's raw q\n\n@compute @workgroup_size(WGV)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let h = wg.x;                           // value head\n  let hk = h % p.HK;                      // GQA: shared key/query head (GGUF [rep,n_key] tile order)\n  let dv = lid.x;\n  let DK = p.DK;\n  let sbase = h * DK * p.DV + dv;         // state column S[:, dv] of head h, stride DV\n  let scale = inverseSqrt(f32(DK));\n  var s: array<f32, 128>;                 // state column S[:, dv], length DK\n  for (var dk = 0u; dk < DK; dk = dk + 1u) { s[dk] = select(0.0, state_in[sbase + dk * p.DV], p.loadState != 0u); }\n\n  for (var t = 0u; t < p.S; t = t + 1u) {\n    let base = (t + p.tOff) * p.H + h;    // value-head row (v, g, beta, out); tOff = this chunk's\n    let basek = (t + p.tOff) * p.HK + hk; // token offset when a long segment's scan is sub-chunked\n    for (var i = lid.x; i < DK; i = i + WGV) { ksh[i] = k[basek * DK + i]; qsh[i] = q[basek * DK + i]; }\n    workgroupBarrier();\n    var sk = 0.0;\n    var sq = 0.0;\n    for (var dk = 0u; dk < DK; dk = dk + 1u) { sk = sk + ksh[dk] * ksh[dk]; sq = sq + qsh[dk] * qsh[dk]; }\n    let ik = inverseSqrt(sk + 1e-6);              // l2norm(k)\n    let iq = inverseSqrt(sq + 1e-6) * scale;      // l2norm(q) / sqrt(dk)\n    if (dv < p.DV) {\n      let gt = exp(g[base]);\n      let bt = beta[p.betaOff + base];   // beta may share g's buffer (engine: gbeta = [g; beta])\n      for (var dk = 0u; dk < DK; dk = dk + 1u) { s[dk] = s[dk] * gt; }   // decay\n      var kv = 0.0;\n      for (var dk = 0u; dk < DK; dk = dk + 1u) { kv = kv + s[dk] * ksh[dk] * ik; }\n      let delta = (v[base * p.DV + dv] - kv) * bt;\n      var o = 0.0;\n      for (var dk = 0u; dk < DK; dk = dk + 1u) {\n        s[dk] = s[dk] + ksh[dk] * ik * delta;      // S += Kn ⊗ delta\n        o = o + s[dk] * qsh[dk] * iq;              // out = Qn · S (updated)\n      }\n      core[base * p.DV + dv] = o;\n    }\n    workgroupBarrier();\n  }\n  if (dv < p.DV) { for (var dk = 0u; dk < DK; dk = dk + 1u) { state_out[sbase + dk * p.DV] = s[dk]; } }\n}\n",
	"embed_gather": "// GPU embedding gather + 4-bit dequant: reads a token id from a GPU buffer and writes that token's\n// embedding (H f32) directly into a GPU buffer, so the decode loop never round-trips the token id to\n// the CPU. Faithful port of the CPU embedDequant (4-bit codes via the tgt4 LUT, per-128 zero-point,\n// per-block scale). uint8 source arrays are read as u32 and byte-extracted (little-endian).\noverride WG: u32 = 256u;\nstruct Params { H: u32, srcIdx: u32, _0: u32, _1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> tokenId: array<u32>;   // tokenId[p.srcIdx] = the token to embed\n@group(0) @binding(2) var<storage, read> embWq: array<u32>;     // uint8 [vocab * H/8] packed\n@group(0) @binding(3) var<storage, read> tgt4: array<u32>;      // uint8 [256*4] packed (1 src byte -> 4)\n@group(0) @binding(4) var<storage, read> embScales: array<f32>;// [vocab * H/128]\n@group(0) @binding(5) var<storage, read> embZp: array<u32>;    // uint8 [vocab * ceil(H/256)] packed\n@group(0) @binding(6) var<storage, read_write> out: array<f32>;// [H]\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let id = tokenId[p.srcIdx];\n  // Per-row strides derived from H: rowBytes source bytes, scaleRow f32 scales,\n  // zpRow packed zero-point bytes (H=2048 -> 256/16/8, H=2560 -> 320/20/10).\n  let rowBytes = p.H >> 3u;\n  let scaleRow = p.H >> 7u;\n  let zpRow = (scaleRow + 1u) >> 1u;\n  for (var k = lid.x; k < p.H; k = k + WG) {\n    let i = k >> 3u;\n    let qd = (k >> 1u) & 3u;\n    let c = k & 1u;\n    let wqIdx = id * rowBytes + i;\n    let e = (embWq[wqIdx >> 2u] >> (8u * (wqIdx & 3u))) & 0xffu;   // source byte 0..255\n    let tIdx = 4u * e + qd;\n    let t = (tgt4[tIdx >> 2u] >> (8u * (tIdx & 3u))) & 0xffu;       // expanded byte (2 codes)\n    let code = (t >> (4u * c)) & 0xfu;\n    let blk = k >> 7u;\n    let zpIdx = id * zpRow + (blk >> 1u);\n    let zpByte = (embZp[zpIdx >> 2u] >> (8u * (zpIdx & 3u))) & 0xffu;\n    let zp = (zpByte >> (4u * (blk & 1u))) & 0xfu;\n    out[k] = (f32(code) - f32(zp)) * embScales[id * scaleRow + blk];\n  }\n}\n",
	"embed_gather_batch": "// Batched GPU embedding gather + 4-bit dequant for PROMPT tokens: one invocation per output\n// element writes out[s*H + k] for tokenIds[s]. A prefill segment uploads S u32 token ids\n// instead of S*H dequantized floats, so the CPU-side embedding tables are not needed at all\n// (~50-100 MB RAM per model). Same per-row stride math and dequant as embed_gather.wgsl\n// (H=2048 -> 256/16/8 strides); uint8 sources read as u32 and byte-extracted (little-endian).\nstruct Params { S: u32, H: u32, _0: u32, _1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> tokenIds: array<u32>;   // [S]\n@group(0) @binding(2) var<storage, read> embWq: array<u32>;      // uint8 [vocab * H/8] packed\n@group(0) @binding(3) var<storage, read> tgt4: array<u32>;       // uint8 [256*4] packed (1 src byte -> 4)\n@group(0) @binding(4) var<storage, read> embScales: array<f32>; // [vocab * H/128]\n@group(0) @binding(5) var<storage, read> embZp: array<u32>;     // uint8 [vocab * ceil(H/256)] packed\n@group(0) @binding(6) var<storage, read_write> out: array<f32>; // [S * H]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let gi = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (gi >= p.S * p.H) { return; }\n  let k = gi % p.H;\n  let id = tokenIds[gi / p.H];\n  let rowBytes = p.H >> 3u;\n  let scaleRow = p.H >> 7u;\n  let zpRow = (scaleRow + 1u) >> 1u;\n  let i = k >> 3u;\n  let qd = (k >> 1u) & 3u;\n  let c = k & 1u;\n  let wqIdx = id * rowBytes + i;\n  let e = (embWq[wqIdx >> 2u] >> (8u * (wqIdx & 3u))) & 0xffu;   // source byte 0..255\n  let tIdx = 4u * e + qd;\n  let t = (tgt4[tIdx >> 2u] >> (8u * (tIdx & 3u))) & 0xffu;       // expanded byte (2 codes)\n  let code = (t >> (4u * c)) & 0xfu;\n  let blk = k >> 7u;\n  let zpIdx = id * zpRow + (blk >> 1u);\n  let zpByte = (embZp[zpIdx >> 2u] >> (8u * (zpIdx & 3u))) & 0xffu;\n  let zp = (zpByte >> (4u * (blk & 1u))) & 0xfu;\n  out[gi] = (f32(code) - f32(zp)) * embScales[id * scaleRow + blk];\n}\n",
	"gate_sigmoid": "// Output gate for Qwen3.5 gated attention: y = x * sigmoid(gate), elementwise. Applied to the\n// attention output before o_proj (the gate is the second half of the doubled q_proj).\nstruct Params { n: u32, _p0: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;\n@group(0) @binding(2) var<storage, read> gate: array<f32>;\n@group(0) @binding(3) var<storage, read_write> y: array<f32>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.n) { return; }\n  y[i] = x[i] / (1.0 + exp(-gate[i]));\n}\n",
	"logsumexp": "// log-sum-exp over the (penalty-filtered) logits, the softmax normalizer that turns a raw logit\n// into a true logprob on the CPU: logprob(id) = logit[id] - lse. Runs AFTER sampler_penalty and\n// BEFORE the argmax_masked rounds (those mask their winners in place, which would corrupt the\n// sum). Two-phase single-workgroup reduction: strided max, then strided sum of exp(x - max);\n// entries at the -inf sentinel (banned ids) contribute nothing. Only one f32 is read back.\noverride WG: u32 = 256u;\nstruct Params { N: u32, _0: u32, _1: u32, _2: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> logits: array<f32>;\n@group(0) @binding(2) var<storage, read_write> outLse: array<f32>;   // outLse[0] = max + log(sum)\n\nconst NEG_SENTINEL: f32 = -3.0e38;   // below any real logit; banned entries sit at f32 -inf\n\nvar<workgroup> sval: array<f32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  var m = -3.4e38;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > NEG_SENTINEL && v > m) { m = v; }\n  }\n  sval[tid] = m;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s && sval[tid + s] > sval[tid]) { sval[tid] = sval[tid + s]; }\n    workgroupBarrier();\n  }\n  let gmax = sval[0];\n  workgroupBarrier();\n  var acc = 0.0;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > NEG_SENTINEL) { acc = acc + exp(v - gmax); }\n  }\n  sval[tid] = acc;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) { sval[tid] = sval[tid] + sval[tid + s]; }\n    workgroupBarrier();\n  }\n  if (tid == 0u) { outLse[0] = gmax + log(sval[0]); }\n}\n",
	"matmul_binary_vec4": "// Binary matmul, vectorized: y[M,N] = x[M,K] @ W[N,K]^T, W = (+/-1) * per-block scale.\n// One thread per output; the K loop processes a 32-bit sign word at a time and the\n// activations as vec4 via dot() (4 weights per FMA instead of 1 scalar op). M-agnostic\n// (works for prefill M=S and decode M=1). x is bound as vec4 (K must be a multiple of 4).\nstruct Params { M: u32, N: u32, K: u32, nb: u32, block: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;   // [M, N]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.M * p.N) { return; }\n  let m = idx / p.N;\n  let n = idx % p.N;\n  let xRow = m * (p.K / 4u);\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let wordsPerBlock = p.block / 32u;   // 4 for block=128\n\n  var acc = 0.0;\n  for (var b = 0u; b < p.nb; b = b + 1u) {\n    var bsum = 0.0;\n    for (var w = 0u; w < wordsPerBlock; w = w + 1u) {\n      let word = signbits[wRow + b * wordsPerBlock + w];\n      let xb = xRow + b * (p.block / 4u) + w * 8u;   // vec4 base for this word (32 weights = 8 vec4)\n      for (var g = 0u; g < 8u; g = g + 1u) {\n        let bits4 = (word >> (g * 4u)) & 0xfu;\n        let sv = vec4<f32>(\n          select(-1.0, 1.0, (bits4 & 1u) != 0u),\n          select(-1.0, 1.0, (bits4 & 2u) != 0u),\n          select(-1.0, 1.0, (bits4 & 4u) != 0u),\n          select(-1.0, 1.0, (bits4 & 8u) != 0u),\n        );\n        bsum = bsum + dot(x[xb + g], sv);\n      }\n    }\n    acc = acc + bsum * scales[sbase + b];\n  }\n  y[idx] = acc;\n}\n",
	"matmul_q2": "// 2-bit dequant matmul (lm_head): y[M,N] = x[M,K] @ W[N,K]^T, W[n,k] = (code - zp) * scale[n, k/block].\n// codes are 2-bit, 4 per byte, packed into u32 words. Correctness-first (one thread per output, fp32).\nstruct Params { M: u32, N: u32, K: u32, nb: u32, block: u32, zp: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;       // [M, K]\n@group(0) @binding(2) var<storage, read> codes: array<u32>;   // [N, K/4] bytes packed as u32\n@group(0) @binding(3) var<storage, read> scales: array<f32>;  // [N, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>; // [M, N]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.M * p.N) { return; }\n  let m = idx / p.N;\n  let n = idx % p.N;\n  let xbase = m * p.K;\n  let cbyteBase = n * (p.K / 4u);   // byte offset of row n in the codes stream\n  let sbase = n * p.nb;\n  let zpf = f32(p.zp);\n\n  var acc = 0.0;\n  for (var b = 0u; b < p.nb; b = b + 1u) {\n    var bsum = 0.0;\n    let k0 = b * p.block;\n    for (var j = 0u; j < p.block; j = j + 1u) {\n      let k = k0 + j;\n      let byteIdx = cbyteBase + (k >> 2u);\n      let word = codes[byteIdx >> 2u];\n      let byte = (word >> (8u * (byteIdx & 3u))) & 0xffu;\n      let code = (byte >> (2u * (k & 3u))) & 3u;\n      bsum = bsum + (f32(code) - zpf) * x[xbase + k];\n    }\n    acc = acc + bsum * scales[sbase + b];\n  }\n  y[idx] = acc;\n}\n",
	"matmul_q2_sg": "// Subgroup split-K GEMV for the 2-bit lm_head (M=1 decode). One subgroup per output column,\n// lanes split K (vec4), reduce with subgroupAdd. value = (code - zp) * per-block scale.\n// 2D dispatch since N (vocab) > 65535.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { N: u32, K: u32, nb: u32, zp: u32, gridX: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> codes: array<u32>;     // [N, K/4] bytes packed as u32\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;   // [N]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= p.N) { return; }\n  let cbase = n * (p.K / 4u);     // byte offset of row n in the codes stream\n  let sbase = n * p.nb;\n  let zpf = f32(p.zp);\n  let Kvec = p.K / 4u;\n\n  var acc = 0.0;\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let byteIdx = cbase + gi;\n    let word = codes[byteIdx >> 2u];\n    let byte = (word >> (8u * (byteIdx & 3u))) & 0xffu;\n    let cv = vec4<f32>(f32(byte & 3u) - zpf, f32((byte >> 2u) & 3u) - zpf,\n                       f32((byte >> 4u) & 3u) - zpf, f32((byte >> 6u) & 3u) - zpf);\n    acc = acc + dot(x[gi], cv) * scales[sbase + (gi >> 5u)];   // block = (gi*4)/128 = gi/32\n  }\n  let total = subgroupAdd(acc);\n  if (lane == 0u) { y[n] = total; }\n}\n",
	"matmul_q2_sm": "// Small-batch (M = 2..9) subgroup split-K GEMV for the 2-bit lm_head: the speculative-decode\n// verify pass needs logits for every drafted row, and the scalar M-row kernel re-reads the\n// ~77 MB code stream per output thread. Here each code word is loaded once per (column,\n// k-chunk) and dotted with all M rows. Per row the loop stride and accumulation expression\n// match matmul_q2_sg, so each row is bit-identical to the M=1 decode path.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { N: u32, K: u32, nb: u32, zp: u32, gridX: u32, M: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4] row-major\n@group(0) @binding(2) var<storage, read> codes: array<u32>;     // [N, K/4] bytes packed as u32\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;   // [M, N]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= p.N) { return; }\n  let cbase = n * (p.K / 4u);\n  let sbase = n * p.nb;\n  let zpf = f32(p.zp);\n  let Kvec = p.K / 4u;\n\n  var acc: array<f32, 9>; // M <= 9\n  for (var m = 0u; m < p.M; m = m + 1u) { acc[m] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let byteIdx = cbase + gi;\n    let word = codes[byteIdx >> 2u];\n    let byte = (word >> (8u * (byteIdx & 3u))) & 0xffu;\n    let cv = vec4<f32>(f32(byte & 3u) - zpf, f32((byte >> 2u) & 3u) - zpf,\n                       f32((byte >> 4u) & 3u) - zpf, f32((byte >> 6u) & 3u) - zpf);\n    let s = scales[sbase + (gi >> 5u)]; // block = (gi*4)/128 = gi/32\n    for (var m = 0u; m < p.M; m = m + 1u) {\n      acc[m] = acc[m] + dot(x[m * Kvec + gi], cv) * s;\n    }\n  }\n  for (var m = 0u; m < p.M; m = m + 1u) {\n    let total = subgroupAdd(acc[m]);\n    if (lane == 0u) { y[m * p.N + n] = total; }\n  }\n}\n",
	"matmul_q2_wg": "// No-subgroup fallback: 2-bit lm_head GEMV for decode (M=1), workgroup-shared-memory reduction.\n// One workgroup per output column; WG threads split K and tree-reduce. value = (code - zp) * scale.\n// 2D dispatch since N (vocab) > 65535. This is the v1 path's biggest cost (scalar was ~48ms/token).\noverride WG: u32 = 64u;\nstruct Params { N: u32, K: u32, nb: u32, zp: u32, gridX: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> codes: array<u32>;     // [N, K/4] bytes packed as u32\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;   // [N]\nvar<workgroup> sdata: array<f32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= p.N) { return; }\n  let tid = lid.x;\n  let cbase = n * (p.K / 4u);\n  let sbase = n * p.nb;\n  let zpf = f32(p.zp);\n  let Kvec = p.K / 4u;\n  var acc = 0.0;\n  for (var gi = tid; gi < Kvec; gi = gi + WG) {\n    let byteIdx = cbase + gi;\n    let word = codes[byteIdx >> 2u];\n    let byte = (word >> (8u * (byteIdx & 3u))) & 0xffu;\n    let cv = vec4<f32>(f32(byte & 3u) - zpf, f32((byte >> 2u) & 3u) - zpf,\n                       f32((byte >> 4u) & 3u) - zpf, f32((byte >> 6u) & 3u) - zpf);\n    acc = acc + dot(x[gi], cv) * scales[sbase + (gi >> 5u)];\n  }\n  sdata[tid] = acc;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) { sdata[tid] = sdata[tid] + sdata[tid + s]; }\n    workgroupBarrier();\n  }\n  if (tid == 0u) { y[n] = sdata[0]; }\n}\n",
	"matmul_resid": "// Binary matmul with a fused residual add: y[M,N] = x[M,K] @ W[N,K]^T + resid[M,N].\n// Folds the residual add into o_proj / down_proj so it's not a separate dispatch.\nstruct Params { M: u32, N: u32, K: u32, nb: u32, block: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;     // [M, N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;   // [M, N]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.M * p.N) { return; }\n  let n = idx % p.N;\n  let xRow = (idx / p.N) * (p.K / 4u);\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n\n  var acc = 0.0;\n  for (var b = 0u; b < p.nb; b = b + 1u) {\n    var bsum = 0.0;\n    for (var w = 0u; w < 4u; w = w + 1u) {\n      let word = signbits[wRow + b * 4u + w];\n      let xb = xRow + b * 32u + w * 8u;\n      for (var g = 0u; g < 8u; g = g + 1u) {\n        let bits4 = (word >> (g * 4u)) & 0xfu;\n        let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                           select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n        bsum = bsum + dot(x[xb + g], sv);\n      }\n    }\n    acc = acc + bsum * scales[sbase + b];\n  }\n  y[idx] = acc + resid[idx];\n}\n",
	"matmul_resid_mr_sg": "// Multi-row subgroup GEMV for decode (M=1) with fused residual. Same as matmul_resid_sg but each\n// workgroup computes ROWS output columns at once: per K-step it issues ROWS independent weight\n// loads before the dots, giving the memory system more in-flight requests (memory-level\n// parallelism) to hide latency on the bandwidth-bound decode GEMV. One subgroup per workgroup;\n// lanes split K; ROWS accumulators reduced with subgroupAdd. value = sign * per-block scale.\nenable subgroups;\noverride SG: u32 = 32u;\noverride ROWS: u32 = 4u;\nstruct Params { N: u32, K: u32, nb: u32, gridX: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;     // [N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;   // [N]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let rowBase = (wg.y * p.gridX + wg.x) * ROWS;\n  let Kvec = p.K / 4u;\n  let wStride = p.K / 32u;\n\n  var acc: array<f32, 8>;                         // ROWS <= 8\n  for (var r = 0u; r < ROWS; r = r + 1u) { acc[r] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let xv = x[gi];\n    let widx = k >> 5u;\n    let sh = k & 31u;\n    let sc = k / 128u;\n    for (var r = 0u; r < ROWS; r = r + 1u) {\n      let n = rowBase + r;\n      if (n < p.N) {\n        let w = (signbits[n * wStride + widx] >> sh) & 0xfu;\n        let sv = vec4<f32>(select(-1.0, 1.0, (w & 1u) != 0u), select(-1.0, 1.0, (w & 2u) != 0u),\n                           select(-1.0, 1.0, (w & 4u) != 0u), select(-1.0, 1.0, (w & 8u) != 0u));\n        acc[r] = acc[r] + dot(xv, sv) * scales[n * p.nb + sc];\n      }\n    }\n  }\n  for (var r = 0u; r < ROWS; r = r + 1u) {\n    let n = rowBase + r;\n    let total = subgroupAdd(acc[r]);             // collective: called for every r by all lanes\n    if (lane == 0u && n < p.N) { y[n] = total + resid[n]; }\n  }\n}\n",
	"matmul_resid_mr_sg_af16": "// f16-activation variant of matmul_resid_mr_sg (multi-row decode GEMV + fused residual, M=1),\n// used for down_proj (its input is the f16 SwiGLU intermediate). Reads f16 x, dots in f16,\n// accumulates in f32; the residual add and the output stay f32. Weights unchanged.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\noverride ROWS: u32 = 4u;\nstruct Params { N: u32, K: u32, nb: u32, gridX: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f16>>;   // [K/4] f16 activations\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;     // [N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;   // [N]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let rowBase = (wg.y * p.gridX + wg.x) * ROWS;\n  let Kvec = p.K / 4u;\n  let wStride = p.K / 32u;\n\n  var acc: array<f32, 8>;                         // ROWS <= 8\n  for (var r = 0u; r < ROWS; r = r + 1u) { acc[r] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let xv = x[gi];\n    let widx = k >> 5u;\n    let sh = k & 31u;\n    let sc = k / 128u;\n    for (var r = 0u; r < ROWS; r = r + 1u) {\n      let n = rowBase + r;\n      if (n < p.N) {\n        let w = (signbits[n * wStride + widx] >> sh) & 0xfu;\n        let sv = vec4<f16>(select(-1.0h, 1.0h, (w & 1u) != 0u), select(-1.0h, 1.0h, (w & 2u) != 0u),\n                           select(-1.0h, 1.0h, (w & 4u) != 0u), select(-1.0h, 1.0h, (w & 8u) != 0u));\n        acc[r] = acc[r] + f32(dot(xv, sv)) * scales[n * p.nb + sc];\n      }\n    }\n  }\n  for (var r = 0u; r < ROWS; r = r + 1u) {\n    let n = rowBase + r;\n    let total = subgroupAdd(acc[r]);\n    if (lane == 0u && n < p.N) { y[n] = total + resid[n]; }\n  }\n}\n",
	"matmul_resid_sm": "// Small-batch (M = 2..9) subgroup split-K GEMV with fused residual add (o_proj / down_proj in\n// the speculative-decode verify pass). One workgroup per output column; each weight word is\n// loaded once and dotted with all M activation rows. Per row the loop stride and accumulation\n// expression match the validated M=1 kernels, so results are row-wise bit-identical to them.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { N: u32, K: u32, nb: u32, gridX: u32, M: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4] row-major\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;     // [M, N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;   // [M, N]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= p.N) { return; }\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n\n  var acc: array<f32, 9>; // M <= 9\n  for (var m = 0u; m < p.M; m = m + 1u) { acc[m] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                       select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n    let s = scales[sbase + (k / 128u)];\n    for (var m = 0u; m < p.M; m = m + 1u) {\n      acc[m] = acc[m] + dot(x[m * Kvec + gi], sv) * s;\n    }\n  }\n  for (var m = 0u; m < p.M; m = m + 1u) {\n    let total = subgroupAdd(acc[m]);\n    if (lane == 0u) { y[m * p.N + n] = total + resid[m * p.N + n]; }\n  }\n}\n",
	"matmul_resid_tiled": "// Tiled register-blocked binary GEMM with fused residual, for PREFILL (M>1), vec4 K-accumulation:\n//   y[M,N] = x[M,K] @ W[N,K]^T + resid[M,N],  W binary {-1,+1} sign-packed, per-128-block fp32 scale.\n// 64x64 output tile per workgroup, 16x16 threads each computing a 4x4 register tile, BK=16 K-step.\n// Activation + decoded/scaled weight tiles are staged in shared memory as vec4 (4 K per element);\n// each inner step is a dot() of vec4s, and one weight load decodes a whole nibble (4 signs) at once.\n// No subgroup ops -> all devices. Near-bit-exact (f32 accum; tiled K-order differs in last ULPs).\nconst BM: u32 = 64u;\nconst BN: u32 = 64u;\nconst BKV: u32 = 4u;          // BK / 4  (BK = 16)\nstruct Params { M: u32, N: u32, K: u32, nb: u32, _0: u32, _1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;  // [M, K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>; // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;   // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;    // [M, N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;  // [M, N]\n\nvar<workgroup> xs: array<vec4<f32>, 256>;   // BM*BKV\nvar<workgroup> ws: array<vec4<f32>, 256>;   // BN*BKV\n\n@compute @workgroup_size(256)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  let tileM = wg.y * BM;\n  let tileN = wg.x * BN;\n  let tr = (tid / 16u) * 4u;\n  let tc = (tid % 16u) * 4u;\n  let Kv = p.K / 4u;\n  var acc: array<f32, 16>;\n  for (var i = 0u; i < 16u; i = i + 1u) { acc[i] = 0.0; }\n\n  let Ksteps = Kv / BKV;\n  for (var ks = 0u; ks < Ksteps; ks = ks + 1u) {\n    let k0v = ks * BKV;\n    for (var e = tid; e < BM * BKV; e = e + 256u) {           // stage activation tile (vec4)\n      let m = e / BKV; let kv = e % BKV; let gm = tileM + m;\n      xs[e] = select(vec4<f32>(0.0), x[gm * Kv + (k0v + kv)], gm < p.M);\n    }\n    for (var e = tid; e < BN * BKV; e = e + 256u) {           // stage decoded+scaled weight tile (vec4)\n      let n = e / BKV; let kv = e % BKV; let gn = tileN + n; let k = (k0v + kv) * 4u;\n      var wv = vec4<f32>(0.0);\n      if (gn < p.N) {\n        let bits4 = (signbits[gn * (p.K / 32u) + (k >> 5u)] >> (k & 31u)) & 0xfu;\n        let s = scales[gn * p.nb + (k / 128u)];\n        wv = vec4<f32>(select(-s, s, (bits4 & 1u) != 0u), select(-s, s, (bits4 & 2u) != 0u),\n                       select(-s, s, (bits4 & 4u) != 0u), select(-s, s, (bits4 & 8u) != 0u));\n      }\n      ws[e] = wv;\n    }\n    workgroupBarrier();\n    for (var kv = 0u; kv < BKV; kv = kv + 1u) {\n      var xr: array<vec4<f32>, 4>;\n      for (var tm = 0u; tm < 4u; tm = tm + 1u) { xr[tm] = xs[(tr + tm) * BKV + kv]; }\n      for (var tn = 0u; tn < 4u; tn = tn + 1u) {\n        let w = ws[(tc + tn) * BKV + kv];\n        for (var tm = 0u; tm < 4u; tm = tm + 1u) { acc[tm * 4u + tn] = acc[tm * 4u + tn] + dot(xr[tm], w); }\n      }\n    }\n    workgroupBarrier();\n  }\n\n  for (var tm = 0u; tm < 4u; tm = tm + 1u) {\n    let gm = tileM + tr + tm;\n    if (gm < p.M) {\n      for (var tn = 0u; tn < 4u; tn = tn + 1u) {\n        let gn = tileN + tc + tn;\n        if (gn < p.N) { let idx = gm * p.N + gn; y[idx] = acc[tm * 4u + tn] + resid[idx]; }\n      }\n    }\n  }\n}\n",
	"matmul_resid_wg": "// No-subgroup fallback: split-K GEMV for decode (M=1) with fused residual, workgroup-shared-memory\n// reduction. One workgroup per output column; WG threads split K and tree-reduce. Used for o_proj/down.\noverride WG: u32 = 64u;\nstruct Params { N: u32, K: u32, nb: u32, gridX: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N, nb]\n@group(0) @binding(4) var<storage, read> resid: array<f32>;     // [N]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;   // [N]\nvar<workgroup> sdata: array<f32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= p.N) { return; }\n  let tid = lid.x;\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n  var acc = 0.0;\n  for (var gi = tid; gi < Kvec; gi = gi + WG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                       select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n    acc = acc + dot(x[gi], sv) * scales[sbase + (k / 128u)];\n  }\n  sdata[tid] = acc;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) { sdata[tid] = sdata[tid] + sdata[tid + s]; }\n    workgroupBarrier();\n  }\n  if (tid == 0u) { y[n] = sdata[0] + resid[n]; }\n}\n",
	"matmul_split": "// Fused binary matmul writing to up to 3 output buffers (qkv or gate/up in one dispatch).\n// Weights for the outputs are concatenated along N (rows N0 | N1 | N2). One thread per\n// output column n routes its result to out0/out1/out2 by range. Vectorized like matmul_binary_vec4.\nstruct Params { M: u32, K: u32, nb: u32, N0: u32, N1: u32, N2: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>;\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>;\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.M * Ntot) { return; }\n  let row = idx / Ntot;\n  let n = idx % Ntot;\n  let xRow = row * (p.K / 4u);\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n\n  var acc = 0.0;\n  for (var b = 0u; b < p.nb; b = b + 1u) {\n    var bsum = 0.0;\n    for (var w = 0u; w < 4u; w = w + 1u) {\n      let word = signbits[wRow + b * 4u + w];\n      let xb = xRow + b * 32u + w * 8u;\n      for (var g = 0u; g < 8u; g = g + 1u) {\n        let bits4 = (word >> (g * 4u)) & 0xfu;\n        let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                           select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n        bsum = bsum + dot(x[xb + g], sv);\n      }\n    }\n    acc = acc + bsum * scales[sbase + b];\n  }\n\n  if (n < p.N0) { out0[row * p.N0 + n] = acc; }\n  else if (n < p.N0 + p.N1) { out1[row * p.N1 + (n - p.N0)] = acc; }\n  else { out2[row * p.N2 + (n - p.N0 - p.N1)] = acc; }\n}\n",
	"matmul_split_sg": "// Subgroup split-K GEMV for decode (M=1), fused: one subgroup (= one workgroup) per output\n// column; lanes split the K dimension and reduce with subgroupAdd (register-only, no barriers).\n// Cuts each matmul's latency ~SG-fold vs one-thread-per-output (the real decode bottleneck:\n// kernels run at full latency in the dependent chain). Routes to out0/out1/out2 by range (qkv / gate-up).\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { K: u32, nb: u32, N0: u32, N1: u32, N2: u32, gridX: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>;\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>;\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>;\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= Ntot) { return; }\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n\n  var acc = 0.0;\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                       select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n    acc = acc + dot(x[gi], sv) * scales[sbase + (k / 128u)];\n  }\n  let total = subgroupAdd(acc);\n  if (lane == 0u) {\n    if (n < p.N0) { out0[n] = total; }\n    else if (n < p.N0 + p.N1) { out1[n - p.N0] = total; }\n    else { out2[n - p.N0 - p.N1] = total; }\n  }\n}\n",
	"matmul_split_sg_af16": "// f16-activation variant of matmul_split_sg (fused QKV decode GEMV, M=1). The activation x is\n// read as f16 and the per-group dot runs in f16 (2x ALU rate on Apple/AMD/recent NVIDIA); the\n// per-block accumulation stays f32 (dot promoted before x scale, acc in f32) so accuracy tracks\n// f32 to ~f16 rounding. Weights (sign bits + f32 block scales) are unchanged. Outputs f32.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\nstruct Params { K: u32, nb: u32, N0: u32, N1: u32, N2: u32, gridX: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f16>>;   // [K/4] f16 activations\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>;\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>;\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>;\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= Ntot) { return; }\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n\n  var acc = 0.0;\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f16>(select(-1.0h, 1.0h, (bits4 & 1u) != 0u), select(-1.0h, 1.0h, (bits4 & 2u) != 0u),\n                       select(-1.0h, 1.0h, (bits4 & 4u) != 0u), select(-1.0h, 1.0h, (bits4 & 8u) != 0u));\n    acc = acc + f32(dot(x[gi], sv)) * scales[sbase + (k / 128u)];\n  }\n  let total = subgroupAdd(acc);\n  if (lane == 0u) {\n    if (n < p.N0) { out0[n] = total; }\n    else if (n < p.N0 + p.N1) { out1[n - p.N0] = total; }\n    else { out2[n - p.N0 - p.N1] = total; }\n  }\n}\n",
	"matmul_split_sm": "// Small-batch (M = 2..9) subgroup split-K GEMV, fused qkv / gate-up. The speculative-decode\n// verify pass computes M drafted rows in one forward; the scalar prefill kernels re-read the\n// weights per output thread, so a k-row pass cost ~k GEMVs. Here each weight word is loaded\n// ONCE per (column, k-chunk) and dotted with all M activation rows (activations are ~8 KB/row,\n// cache-resident). Per row the loop stride and accumulation expression are IDENTICAL to\n// matmul_split_sg, so each row's partials - and therefore the subgroupAdd result - match the\n// M=1 decode path bit-for-bit.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { K: u32, nb: u32, N0: u32, N1: u32, N2: u32, gridX: u32, M: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [M, K/4] row-major\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>; // [M, N0]\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>; // [M, N1]\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>; // [M, N2]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let n = wg.y * p.gridX + wg.x;\n  if (n >= Ntot) { return; } // uniform per workgroup: the whole subgroup exits together\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n\n  var acc: array<f32, 9>; // M <= 9\n  for (var m = 0u; m < p.M; m = m + 1u) { acc[m] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                       select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n    let s = scales[sbase + (k / 128u)];\n    for (var m = 0u; m < p.M; m = m + 1u) {\n      acc[m] = acc[m] + dot(x[m * Kvec + gi], sv) * s;\n    }\n  }\n  for (var m = 0u; m < p.M; m = m + 1u) { // p.M is uniform: collective calls stay uniform\n    let total = subgroupAdd(acc[m]);\n    if (lane == 0u) {\n      if (n < p.N0) { out0[m * p.N0 + n] = total; }\n      else if (n < p.N0 + p.N1) { out1[m * p.N1 + (n - p.N0)] = total; }\n      else { out2[m * p.N2 + (n - p.N0 - p.N1)] = total; }\n    }\n  }\n}\n",
	"matmul_split_tiled": "// Tiled register-blocked binary GEMM to 3 outputs (qkv or gate/up), PREFILL (M>1), vec4 K-accum.\n// Weights concatenated along N (N0|N1|N2); each output element routes individually to\n// out0/out1/out2 by its global column, so N0/N1/N2 need no alignment. Same vec4 design as\n// matmul_resid_tiled.\nconst BM: u32 = 64u;\nconst BN: u32 = 64u;\nconst BKV: u32 = 4u;          // BK / 4  (BK = 16)\nstruct Params { M: u32, K: u32, nb: u32, N0: u32, N1: u32, N2: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;  // [M, K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>; // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;   // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>;\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>;\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>;\n\nvar<workgroup> xs: array<vec4<f32>, 256>;\nvar<workgroup> ws: array<vec4<f32>, 256>;\n\n@compute @workgroup_size(256)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let tid = lid.x;\n  let tileM = wg.y * BM;\n  let tileN = wg.x * BN;\n  let tr = (tid / 16u) * 4u;\n  let tc = (tid % 16u) * 4u;\n  let Kv = p.K / 4u;\n  var acc: array<f32, 16>;\n  for (var i = 0u; i < 16u; i = i + 1u) { acc[i] = 0.0; }\n\n  let Ksteps = Kv / BKV;\n  for (var ks = 0u; ks < Ksteps; ks = ks + 1u) {\n    let k0v = ks * BKV;\n    for (var e = tid; e < BM * BKV; e = e + 256u) {\n      let m = e / BKV; let kv = e % BKV; let gm = tileM + m;\n      xs[e] = select(vec4<f32>(0.0), x[gm * Kv + (k0v + kv)], gm < p.M);\n    }\n    for (var e = tid; e < BN * BKV; e = e + 256u) {\n      let n = e / BKV; let kv = e % BKV; let gn = tileN + n; let k = (k0v + kv) * 4u;\n      var wv = vec4<f32>(0.0);\n      if (gn < Ntot) {\n        let bits4 = (signbits[gn * (p.K / 32u) + (k >> 5u)] >> (k & 31u)) & 0xfu;\n        let s = scales[gn * p.nb + (k / 128u)];\n        wv = vec4<f32>(select(-s, s, (bits4 & 1u) != 0u), select(-s, s, (bits4 & 2u) != 0u),\n                       select(-s, s, (bits4 & 4u) != 0u), select(-s, s, (bits4 & 8u) != 0u));\n      }\n      ws[e] = wv;\n    }\n    workgroupBarrier();\n    for (var kv = 0u; kv < BKV; kv = kv + 1u) {\n      var xr: array<vec4<f32>, 4>;\n      for (var tm = 0u; tm < 4u; tm = tm + 1u) { xr[tm] = xs[(tr + tm) * BKV + kv]; }\n      for (var tn = 0u; tn < 4u; tn = tn + 1u) {\n        let w = ws[(tc + tn) * BKV + kv];\n        for (var tm = 0u; tm < 4u; tm = tm + 1u) { acc[tm * 4u + tn] = acc[tm * 4u + tn] + dot(xr[tm], w); }\n      }\n    }\n    workgroupBarrier();\n  }\n\n  for (var tm = 0u; tm < 4u; tm = tm + 1u) {\n    let gm = tileM + tr + tm;\n    if (gm >= p.M) { continue; }\n    for (var tn = 0u; tn < 4u; tn = tn + 1u) {\n      let gn = tileN + tc + tn;\n      if (gn >= Ntot) { continue; }\n      let v = acc[tm * 4u + tn];\n      if (gn < p.N0) { out0[gm * p.N0 + gn] = v; }\n      else if (gn < p.N0 + p.N1) { out1[gm * p.N1 + (gn - p.N0)] = v; }\n      else { out2[gm * p.N2 + (gn - p.N0 - p.N1)] = v; }\n    }\n  }\n}\n",
	"matmul_split_wg": "// No-subgroup fallback: split-K GEMV for decode (M=1), workgroup-shared-memory reduction instead\n// of subgroupAdd. One workgroup per output column; WG threads split K and tree-reduce via shared\n// memory + barriers. ~WG-fold faster than one-thread-per-output (the v1 path). Routes qkv / gate-up.\noverride WG: u32 = 64u;\nstruct Params { K: u32, nb: u32, N0: u32, N1: u32, N2: u32, gridX: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [N0+N1+N2, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [N0+N1+N2, nb]\n@group(0) @binding(4) var<storage, read_write> out0: array<f32>;\n@group(0) @binding(5) var<storage, read_write> out1: array<f32>;\n@group(0) @binding(6) var<storage, read_write> out2: array<f32>;\nvar<workgroup> sdata: array<f32, 256>;                          // >= max WG\n\n@compute @workgroup_size(WG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let Ntot = p.N0 + p.N1 + p.N2;\n  let n = wg.y * p.gridX + wg.x;          // uniform across the workgroup -> early return is barrier-safe\n  if (n >= Ntot) { return; }\n  let tid = lid.x;\n  let wRow = n * (p.K / 32u);\n  let sbase = n * p.nb;\n  let Kvec = p.K / 4u;\n  var acc = 0.0;\n  for (var gi = tid; gi < Kvec; gi = gi + WG) {\n    let k = gi * 4u;\n    let word = signbits[wRow + (k >> 5u)];\n    let bits4 = (word >> (k & 31u)) & 0xfu;\n    let sv = vec4<f32>(select(-1.0, 1.0, (bits4 & 1u) != 0u), select(-1.0, 1.0, (bits4 & 2u) != 0u),\n                       select(-1.0, 1.0, (bits4 & 4u) != 0u), select(-1.0, 1.0, (bits4 & 8u) != 0u));\n    acc = acc + dot(x[gi], sv) * scales[sbase + (k / 128u)];\n  }\n  sdata[tid] = acc;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) { sdata[tid] = sdata[tid] + sdata[tid + s]; }\n    workgroupBarrier();\n  }\n  if (tid == 0u) {\n    let total = sdata[0];\n    if (n < p.N0) { out0[n] = total; }\n    else if (n < p.N0 + p.N1) { out1[n - p.N0] = total; }\n    else { out2[n - p.N0 - p.N1] = total; }\n  }\n}\n",
	"matmul_swiglu_mr_sg": "// Multi-row fused gate/up GEMV + SwiGLU for decode (M=1). Each workgroup computes ROWS\n// intermediate indices; per K-step it issues 2*ROWS independent weight loads (gate row n and up\n// row F+n for each of the ROWS) before the dots, giving the bandwidth-bound decode GEMV more\n// in-flight memory requests. One subgroup per workgroup; lanes split K; reduced with subgroupAdd.\nenable subgroups;\noverride SG: u32 = 32u;\noverride ROWS: u32 = 4u;\nstruct Params { K: u32, nb: u32, F: u32, gridX: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f32>>;   // [K/4]\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [2F, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [2F, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;   // [F]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let nBase = (wg.y * p.gridX + wg.x) * ROWS;\n  let Kvec = p.K / 4u;\n  let wStride = p.K / 32u;\n\n  var g: array<f32, 8>;                            // ROWS <= 8\n  var u: array<f32, 8>;\n  for (var r = 0u; r < ROWS; r = r + 1u) { g[r] = 0.0; u[r] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let xv = x[gi];\n    let widx = k >> 5u;\n    let sh = k & 31u;\n    let sc = k / 128u;\n    for (var r = 0u; r < ROWS; r = r + 1u) {\n      let n = nBase + r;\n      if (n < p.F) {\n        let gw = (signbits[n * wStride + widx] >> sh) & 0xfu;\n        let gv = vec4<f32>(select(-1.0, 1.0, (gw & 1u) != 0u), select(-1.0, 1.0, (gw & 2u) != 0u),\n                           select(-1.0, 1.0, (gw & 4u) != 0u), select(-1.0, 1.0, (gw & 8u) != 0u));\n        g[r] = g[r] + dot(xv, gv) * scales[n * p.nb + sc];\n        let uw = (signbits[(p.F + n) * wStride + widx] >> sh) & 0xfu;\n        let uv = vec4<f32>(select(-1.0, 1.0, (uw & 1u) != 0u), select(-1.0, 1.0, (uw & 2u) != 0u),\n                           select(-1.0, 1.0, (uw & 4u) != 0u), select(-1.0, 1.0, (uw & 8u) != 0u));\n        u[r] = u[r] + dot(xv, uv) * scales[(p.F + n) * p.nb + sc];\n      }\n    }\n  }\n  for (var r = 0u; r < ROWS; r = r + 1u) {\n    let n = nBase + r;\n    let gt = subgroupAdd(g[r]);\n    let ut = subgroupAdd(u[r]);\n    if (lane == 0u && n < p.F) { y[n] = (gt / (1.0 + exp(-gt))) * ut; }\n  }\n}\n",
	"matmul_swiglu_mr_sg_af16": "// f16-activation variant of matmul_swiglu_mr_sg (fused gate/up GEMV + SwiGLU, M=1). Reads the\n// f16 activation x, dots in f16, accumulates each of gate/up in f32, applies SwiGLU in f32, and\n// writes the intermediate as f16 (the input side of the f16 down_proj). Weights unchanged.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\noverride ROWS: u32 = 4u;\nstruct Params { K: u32, nb: u32, F: u32, gridX: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<vec4<f16>>;   // [K/4] f16 activations\n@group(0) @binding(2) var<storage, read> signbits: array<u32>;  // [2F, K/32]\n@group(0) @binding(3) var<storage, read> scales: array<f32>;    // [2F, nb]\n@group(0) @binding(4) var<storage, read_write> y: array<f16>;   // [F] f16 intermediate\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let nBase = (wg.y * p.gridX + wg.x) * ROWS;\n  let Kvec = p.K / 4u;\n  let wStride = p.K / 32u;\n\n  var g: array<f32, 8>;                            // ROWS <= 8\n  var u: array<f32, 8>;\n  for (var r = 0u; r < ROWS; r = r + 1u) { g[r] = 0.0; u[r] = 0.0; }\n  for (var gi = lane; gi < Kvec; gi = gi + SG) {\n    let k = gi * 4u;\n    let xv = x[gi];\n    let widx = k >> 5u;\n    let sh = k & 31u;\n    let sc = k / 128u;\n    for (var r = 0u; r < ROWS; r = r + 1u) {\n      let n = nBase + r;\n      if (n < p.F) {\n        let gw = (signbits[n * wStride + widx] >> sh) & 0xfu;\n        let gv = vec4<f16>(select(-1.0h, 1.0h, (gw & 1u) != 0u), select(-1.0h, 1.0h, (gw & 2u) != 0u),\n                           select(-1.0h, 1.0h, (gw & 4u) != 0u), select(-1.0h, 1.0h, (gw & 8u) != 0u));\n        g[r] = g[r] + f32(dot(xv, gv)) * scales[n * p.nb + sc];\n        let uw = (signbits[(p.F + n) * wStride + widx] >> sh) & 0xfu;\n        let uv = vec4<f16>(select(-1.0h, 1.0h, (uw & 1u) != 0u), select(-1.0h, 1.0h, (uw & 2u) != 0u),\n                           select(-1.0h, 1.0h, (uw & 4u) != 0u), select(-1.0h, 1.0h, (uw & 8u) != 0u));\n        u[r] = u[r] + f32(dot(xv, uv)) * scales[(p.F + n) * p.nb + sc];\n      }\n    }\n  }\n  for (var r = 0u; r < ROWS; r = r + 1u) {\n    let n = nBase + r;\n    let gt = subgroupAdd(g[r]);\n    let ut = subgroupAdd(u[r]);\n    if (lane == 0u && n < p.F) { y[n] = f16((gt / (1.0 + exp(-gt))) * ut); }\n  }\n}\n",
	"rmsnorm_rope_sg": "// Fused per-head RMSNorm + RoPE for decode (S=1). One subgroup (= one workgroup) per head row;\n// lanes split head_dim, reduce sum-of-squares with subgroupAdd, then apply rope. rotate_half\n// pairs (d, d+-D/2): with SG>=32 and D=128 a lane owns d in {lane, lane+32, lane+64, lane+96},\n// so every (d, d+-64) pair is held by the same lane (no cross-lane reads for the rotate).\n// outOff/outStride let the K result write straight into the KV cache at its position.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { R: u32, D: u32, eps: f32, outOff: u32, outStride: u32, _p: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;        // [R, D]\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;    // [D]\n@group(0) @binding(3) var<storage, read> cos: array<f32>;      // [D]\n@group(0) @binding(4) var<storage, read> sin: array<f32>;      // [D]\n@group(0) @binding(5) var<storage, read_write> y: array<f32>;  // [outOff + R*outStride]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let row = wg.x;\n  if (row >= p.R) { return; }\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = lane; i < p.D; i = i + SG) { let v = x[base + i]; s = s + v * v; }\n  let inv = inverseSqrt(subgroupAdd(s) / f32(p.D) + p.eps);\n  let half = p.D / 2u;\n  let ob = p.outOff + row * p.outStride;\n  for (var i = lane; i < p.D; i = i + SG) {\n    let nd = x[base + i] * inv * gamma[i];\n    var pd: u32; var sgn: f32;\n    if (i < half) { pd = i + half; sgn = -1.0; } else { pd = i - half; sgn = 1.0; }\n    let rot = sgn * (x[base + pd] * inv * gamma[pd]);\n    y[ob + i] = nd * cos[i] + rot * sin[i];\n  }\n}\n",
	"rmsnorm_rope_sg_kv16": "// rmsnorm_rope_sg writing into an f16-STORAGE KV cache (kvCache: 'f16'): used ONLY for the K\n// projection on the fused decode path, where the normed+roped K is written straight into the\n// cache. Keep in lockstep with rmsnorm_rope_sg.wgsl: the ONLY difference is y is array<f16>\n// (one f32 -> f16 rounding at the write). The q call keeps the f32 kernel.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\nstruct Params { R: u32, D: u32, eps: f32, outOff: u32, outStride: u32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;        // [R, D]\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;    // [D]\n@group(0) @binding(3) var<storage, read> cos: array<f32>;      // [D]\n@group(0) @binding(4) var<storage, read> sin: array<f32>;      // [D]\n@group(0) @binding(5) var<storage, read_write> y: array<f16>;  // [outOff + R*outStride]\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let row = wg.x;\n  if (row >= p.R) { return; }\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = lane; i < p.D; i = i + SG) { let v = x[base + i]; s = s + v * v; }\n  let inv = inverseSqrt(subgroupAdd(s) / f32(p.D) + p.eps);\n  let half = p.D / 2u;\n  let ob = p.outOff + row * p.outStride;\n  for (var i = lane; i < p.D; i = i + SG) {\n    let nd = x[base + i] * inv * gamma[i];\n    var pd: u32; var sgn: f32;\n    if (i < half) { pd = i + half; sgn = -1.0; } else { pd = i - half; sgn = 1.0; }\n    let rot = sgn * (x[base + pd] * inv * gamma[pd]);\n    y[ob + i] = f16(nd * cos[i] + rot * sin[i]);\n  }\n}\n",
	"rmsnorm_rope_sg_kv8": "// rmsnorm_rope_sg writing into the q8 cache (kvCache: 'q8'): used ONLY for the K projection on\n// the fused decode path, where the normed+roped K quantizes straight into the cache. Keep the\n// math in lockstep with rmsnorm_rope_sg.wgsl; the write side mirrors copy_kv8.wgsl (packed\n// snorm8 words + one f32 scale per 32-element block). The q call keeps the f32 kernel.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { R: u32, D: u32, eps: f32, outRow0: u32, _p0: u32, _p1: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;            // [R, D]\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;        // [D]\n@group(0) @binding(3) var<storage, read> cos: array<f32>;          // [D]\n@group(0) @binding(4) var<storage, read> sin: array<f32>;          // [D]\n@group(0) @binding(5) var<storage, read_write> dstQ: array<u32>;   // packed 4 x snorm8 per word\n@group(0) @binding(6) var<storage, read_write> dstS: array<f32>;   // [.., D/32] block scales\n\nvar<workgroup> wabs: array<f32, 32>; // per-word abs max (D <= 128 -> at most 32 words)\nvar<workgroup> wblk: array<f32, 4>;  // per-block scale (D/32 <= 4 blocks)\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let row = wg.x;                    // uniform: the barrier pattern below stays safe\n  if (row >= p.R) { return; }\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = lane; i < p.D; i = i + SG) { let v = x[base + i]; s = s + v * v; }\n  let inv = inverseSqrt(subgroupAdd(s) / f32(p.D) + p.eps);\n  let half = p.D / 2u;\n  let W4 = p.D / 4u;\n\n  var vals: array<vec4<f32>, 8>;     // words per lane: W4/SG <= 8 for SG >= 4\n  var wi = 0u;\n  for (var w = lane; w < W4; w = w + SG) {\n    var vv = vec4<f32>(0.0);\n    for (var e = 0u; e < 4u; e = e + 1u) {\n      let i = w * 4u + e;\n      let nd = x[base + i] * inv * gamma[i];\n      var pd: u32; var sgn: f32;\n      if (i < half) { pd = i + half; sgn = -1.0; } else { pd = i - half; sgn = 1.0; }\n      let rot = sgn * (x[base + pd] * inv * gamma[pd]);\n      vv[e] = nd * cos[i] + rot * sin[i];\n    }\n    vals[wi] = vv;\n    wi = wi + 1u;\n    wabs[w] = max(max(abs(vv.x), abs(vv.y)), max(abs(vv.z), abs(vv.w)));\n  }\n  workgroupBarrier();\n  if (lane < p.D / 32u) {\n    var m = 0.0;\n    for (var i = 0u; i < 8u; i = i + 1u) { m = max(m, wabs[lane * 8u + i]); }\n    let sc = max(m, 1e-30);\n    wblk[lane] = sc;\n    dstS[(p.outRow0 + row) * (p.D / 32u) + lane] = sc;\n  }\n  workgroupBarrier();\n  wi = 0u;\n  for (var w = lane; w < W4; w = w + SG) {\n    dstQ[(p.outRow0 + row) * W4 + w] = pack4x8snorm(vals[wi] / wblk[w >> 3u]);\n    wi = wi + 1u;\n  }\n}\n",
	"rmsnorm_sg": "// RMSNorm, subgroup-parallel: one subgroup (= one workgroup) per row; lanes split D and\n// reduce the sum-of-squares with subgroupAdd (register-only, no barriers/shared memory).\n// Fixes the decode bottleneck where R=1 ran on a single thread. SG is set from the device's\n// subgroup size at pipeline creation; requires workgroup_size == subgroup size.\nenable subgroups;\noverride SG: u32 = 32u;\nstruct Params { R: u32, D: u32, eps: f32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;\n@group(0) @binding(3) var<storage, read_write> y: array<f32>;\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let row = wg.x;\n  if (row >= p.R) { return; }\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = lane; i < p.D; i = i + SG) { let v = x[base + i]; s = s + v * v; }\n  let total = subgroupAdd(s);                 // sum across the subgroup, broadcast to all lanes\n  let inv = inverseSqrt(total / f32(p.D) + p.eps);\n  for (var i = lane; i < p.D; i = i + SG) { y[base + i] = x[base + i] * inv * gamma[i]; }\n}\n",
	"rmsnorm_sg_af16": "// RMSNorm (subgroup) that writes the normalized activation as f16 - the input side of the\n// f16-activation decode matmuls (activation: 'f16'). Reads the f32 residual stream; the\n// sum-of-squares reduction stays f32 (accuracy); only the stored output is rounded to f16.\n// Identical reduction to rmsnorm_sg, so it is bit-comparable up to the final f16 rounding.\nenable subgroups;\nenable f16;\noverride SG: u32 = 32u;\nstruct Params { R: u32, D: u32, eps: f32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;\n@group(0) @binding(3) var<storage, read_write> y: array<f16>;\n\n@compute @workgroup_size(SG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(subgroup_invocation_id) lane: u32) {\n  let row = wg.x;\n  if (row >= p.R) { return; }\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = lane; i < p.D; i = i + SG) { let v = x[base + i]; s = s + v * v; }\n  let total = subgroupAdd(s);\n  let inv = inverseSqrt(total / f32(p.D) + p.eps);\n  for (var i = lane; i < p.D; i = i + SG) { y[base + i] = f16(x[base + i] * inv * gamma[i]); }\n}\n",
	"rmsnorm_wg": "// RMSNorm, no-subgroup fallback: one workgroup per row; threads split D and tree-reduce the\n// sum of squares via shared memory. Replaces the one-thread-per-row kernel on this path: at\n// decode (R=1) that kernel walked 2xD elements serially on a single thread, latency-bound,\n// and it ran twice per layer - the dominant cost of the whole fallback decode step.\n// Mirrors rmsnorm_sg exactly, with subgroupAdd swapped for the shared-memory reduction.\noverride WG: u32 = 64u;\nstruct Params { R: u32, D: u32, eps: f32, _pad: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;       // [R, D]\n@group(0) @binding(2) var<storage, read> gamma: array<f32>;   // [D]\n@group(0) @binding(3) var<storage, read_write> y: array<f32>; // [R, D]\nvar<workgroup> sdata: array<f32, 256>;                        // >= max WG\n\n@compute @workgroup_size(WG)\nfn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {\n  let row = wg.x;                        // uniform across the workgroup -> early return is barrier-safe\n  if (row >= p.R) { return; }\n  let tid = lid.x;\n  let base = row * p.D;\n  var s = 0.0;\n  for (var i = tid; i < p.D; i = i + WG) { let v = x[base + i]; s = s + v * v; }\n  sdata[tid] = s;\n  workgroupBarrier();\n  for (var st = WG / 2u; st > 0u; st = st >> 1u) {\n    if (tid < st) { sdata[tid] = sdata[tid] + sdata[tid + st]; }\n    workgroupBarrier();\n  }\n  let inv = inverseSqrt(sdata[0] / f32(p.D) + p.eps);\n  for (var i = tid; i < p.D; i = i + WG) { y[base + i] = x[base + i] * inv * gamma[i]; }\n}\n",
	"rope": "// RoPE (rotate_half) with precomputed full cos/sin [S, D]. x is [S, H, D]. One invocation per element.\nstruct Params { S: u32, H: u32, D: u32, _pad: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;       // [S, H, D]\n@group(0) @binding(2) var<storage, read> cos: array<f32>;     // [S, D]\n@group(0) @binding(3) var<storage, read> sin: array<f32>;     // [S, D]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>; // [S, H, D]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.S * p.H * p.D) { return; }\n  let d = idx % p.D;\n  let sh = idx / p.D;\n  let s = sh / p.H;\n  let half = p.D / 2u;\n  let row = sh * p.D;  // s*H*D + h*D\n  var rot: f32;\n  if (d < half) {\n    rot = -x[row + d + half];\n  } else {\n    rot = x[row + d - half];\n  }\n  y[idx] = x[idx] * cos[s * p.D + d] + rot * sin[s * p.D + d];\n}\n",
	"rope_partial": "// Partial RoPE: rotate only the first ROT dims of each head (rotate_half within [0,ROT)); the\n// remaining head_dim-ROT dims pass through unrotated. cos/sin are [S, ROT]. x/y are [S, H, D].\n// Matches tools/qwen35_numpy._rope_partial (Qwen3.5 full-attention layers, partial_rotary_factor).\nstruct Params { S: u32, H: u32, D: u32, ROT: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> x: array<f32>;        // [S, H, D]\n@group(0) @binding(2) var<storage, read> cosb: array<f32>;     // [S, ROT]\n@group(0) @binding(3) var<storage, read> sinb: array<f32>;     // [S, ROT]\n@group(0) @binding(4) var<storage, read_write> y: array<f32>;  // [S, H, D]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let idx = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (idx >= p.S * p.H * p.D) { return; }\n  let d = idx % p.D;\n  if (d >= p.ROT) { y[idx] = x[idx]; return; }   // passthrough tail\n  let sh = idx / p.D;\n  let s = sh / p.H;\n  let half = p.ROT / 2u;\n  var rot: f32;\n  if (d < half) { rot = -x[idx + half]; } else { rot = x[idx - half]; }\n  y[idx] = x[idx] * cosb[s * p.ROT + d] + rot * sinb[s * p.ROT + d];\n}\n",
	"sampler_penalty": "// GPU logits pre-filter for sampling: applies repetition_penalty + presence_penalty, then\n// no_repeat_ngram bans, in place on the full vocab logit buffer, so only a tiny top-K candidate set\n// has to be read back (not all ~151k logits). rep_penalty matches transformers.js over the DEDUPED\n// prompt+generated id set (logit<0 ? *penalty : /penalty); presence_penalty then SUBTRACTS a flat\n// amount from every seen token (the additive anti-repetition knob the Qwen3.5 family recommends,\n// applied after the multiplicative rep_penalty like vLLM); then ngram-banned next-tokens go to\n// -Infinity. Both id lists are computed on the CPU each step (exact, since at syncN=1 the full\n// history is known) and uploaded. presence is 0 unless requested, so `v*penalty - 0.0 == v*penalty`\n// keeps the rep-penalty-only path bit-identical. Temperature is NOT applied here: top-k is invariant\n// under the monotonic divide, so temperature is applied on the CPU to just the K candidate values\n// before softmax (bit-identical, one less pass). Single workgroup, no subgroup ops -> all devices.\n// The storageBarrier guarantees every penalty write lands before any ban write, so a token that is\n// both repeated and ngram-banned ends at -inf (ban wins, matching the reference order penalties -> ngram).\noverride WG: u32 = 256u;\n// negInf carries the -Infinity bit pattern (0xff800000) from the host: bitcasting it at RUNTIME yields\n// -inf, whereas bitcast<f32>(0xff800000u) is a const-expression evaluating to inf, which is a WGSL\n// shader-creation error. (Runtime inf is fine; only const/override inf/nan is rejected.)\nstruct Params { affectedLen: u32, banLen: u32, penalty: f32, negInf: u32, presence: f32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> affectedIds: array<u32>;   // deduped prompt+generated ids\n@group(0) @binding(2) var<storage, read> banIds: array<u32>;        // ngram-banned next-token ids\n@group(0) @binding(3) var<storage, read_write> logits: array<f32>;  // [vocab], modified in place\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  for (var i = tid; i < p.affectedLen; i = i + WG) {\n    let t = affectedIds[i];\n    let v = logits[t];\n    let rp = select(v / p.penalty, v * p.penalty, v < 0.0);   // repetition_penalty (multiplicative)\n    logits[t] = rp - p.presence;                              // presence_penalty (subtractive; 0 = no-op)\n  }\n  storageBarrier();                                  // all penalty writes before any ban write\n  for (var i = tid; i < p.banLen; i = i + WG) {\n    logits[banIds[i]] = bitcast<f32>(p.negInf);      // -Infinity (runtime bitcast)\n  }\n}\n",
	"sampler_sigma": "// Mean/variance statistics of the (penalty-filtered) logits for the top-n-sigma warper\n// (arXiv 2411.07641): the CPU keeps candidates with logit >= max - n * sigma, where sigma is the\n// standard deviation of the FULL logit vector (the paper's statistic - a top-K-only estimate is\n// biased). Runs AFTER sampler_penalty and BEFORE the argmax_masked rounds (those mask winners in\n// place, which would corrupt the moments). Banned entries (-inf sentinel) are excluded; numerical\n// stability comes from centering on the global max before accumulating (logits are O(10), so\n// sum-of-squares around the max stays well inside f32). Three f32s are read back:\n// out = [sum(x - max), sum((x - max)^2), count] -> CPU: var = q/c - (s/c)^2.\noverride WG: u32 = 256u;\nstruct Params { N: u32, _0: u32, _1: u32, _2: u32 };\n\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> logits: array<f32>;\n@group(0) @binding(2) var<storage, read_write> outStats: array<f32>; // [sum, sumsq, count] centered on max\n\nconst NEG_SENTINEL: f32 = -3.0e38; // below any real logit; banned entries sit at f32 -inf\n\nvar<workgroup> sa: array<f32, 256>;\nvar<workgroup> sb: array<f32, 256>;\nvar<workgroup> sc: array<f32, 256>;\n\n@compute @workgroup_size(WG)\nfn main(@builtin(local_invocation_id) lid: vec3<u32>) {\n  let tid = lid.x;\n  var m = -3.4e38;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > NEG_SENTINEL && v > m) { m = v; }\n  }\n  sa[tid] = m;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s && sa[tid + s] > sa[tid]) { sa[tid] = sa[tid + s]; }\n    workgroupBarrier();\n  }\n  let gmax = sa[0];\n  workgroupBarrier();\n  var acc = 0.0;\n  var accq = 0.0;\n  var cnt = 0.0;\n  for (var i = tid; i < p.N; i = i + WG) {\n    let v = logits[i];\n    if (v > NEG_SENTINEL) {\n      let d = v - gmax;\n      acc = acc + d;\n      accq = accq + d * d;\n      cnt = cnt + 1.0;\n    }\n  }\n  sa[tid] = acc;\n  sb[tid] = accq;\n  sc[tid] = cnt;\n  workgroupBarrier();\n  for (var s = WG / 2u; s > 0u; s = s >> 1u) {\n    if (tid < s) {\n      sa[tid] = sa[tid] + sa[tid + s];\n      sb[tid] = sb[tid] + sb[tid + s];\n      sc[tid] = sc[tid] + sc[tid + s];\n    }\n    workgroupBarrier();\n  }\n  if (tid == 0u) {\n    outStats[0] = sa[0];\n    outStats[1] = sb[0];\n    outStats[2] = sc[0];\n  }\n}\n",
	"slice_cols": "// Extract a contiguous column range [off, off+w) from each row of a [rows, stride] buffer into a\n// packed [rows, w] buffer. Splits the DeltaNet conv output (q|k|v concatenated per token) into the\n// separate q/k/v activation buffers the scan reads.\nstruct Params { rows: u32, w: u32, stride: u32, off: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> src: array<f32>;      // [rows, stride]\n@group(0) @binding(2) var<storage, read_write> dst: array<f32>;// [rows, w]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.rows * p.w) { return; }\n  let r = i / p.w;\n  let c = i % p.w;\n  dst[i] = src[r * p.stride + p.off + c];\n}\n",
	"split_head": "// De-interleave a per-head doubled projection [S, H, 2*Dh] into [S, H, Dh], taking the half at\n// `off` (0 = query, Dh = gate). The Qwen3.5 gated-attention q_proj packs query and output-gate\n// interleaved per head; this pulls one out into a packed buffer.\nstruct Params { S: u32, H: u32, Dh: u32, off: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> src: array<f32>;      // [S, H, 2*Dh]\n@group(0) @binding(2) var<storage, read_write> dst: array<f32>;// [S, H, Dh]\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.S * p.H * p.Dh) { return; }\n  let d = i % p.Dh;\n  let sh = i / p.Dh;          // s*H + h\n  dst[i] = src[sh * (2u * p.Dh) + p.off + d];\n}\n",
	"swiglu": "// SwiGLU gate: y[i] = silu(gate[i]) * up[i], silu(g) = g * sigmoid(g). One invocation per element.\nstruct Params { n: u32, _p0: u32, _p1: u32, _p2: u32 };\n@group(0) @binding(0) var<uniform> p: Params;\n@group(0) @binding(1) var<storage, read> gate: array<f32>;\n@group(0) @binding(2) var<storage, read> up: array<f32>;\n@group(0) @binding(3) var<storage, read_write> y: array<f32>;\n\n@compute @workgroup_size(64)\nfn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {\n  let i = (wid.y * nwg.x + wid.x) * 64u + lid.x;\n  if (i >= p.n) { return; }\n  let g = gate[i];\n  y[i] = (g / (1.0 + exp(-g))) * up[i];\n}\n"
};
//#endregion
//#region src/errors.ts
/** Thrown when WebGPU is unavailable: no `navigator.gpu` (unsupported browser, or a
*  non-secure context) or no adapter could be acquired. Catch this to render a
*  "your browser doesn't support WebGPU yet" fallback instead of crashing. */
var WebGPUUnavailableError = class extends Error {
	name = "WebGPUUnavailableError";
	constructor(message) {
		super(message);
	}
};
/** Thrown when the GPU reports out-of-memory while the engine allocates weights or grows the
*  KV cache. Without this check the allocation "succeeds" with invalid buffers and every later
*  generate() returns garbage. Catch it to fall back (smaller maxSeqLen, or a no-LLM mode). */
var GpuOutOfMemoryError = class extends Error {
	name = "GpuOutOfMemoryError";
	constructor(message) {
		super(message);
	}
};
//#endregion
//#region src/pld.ts
/** Return up to `maxDraft` draft tokens: the continuation after the most recent prior occurrence
*  of the trailing g-gram, trying g = ngramSize down to 2 (1-grams draft too noisily to pay off).
*  Empty when nothing matches. */
function draftNgram(seq, ngramSize, maxDraft) {
	if (maxDraft <= 0) return [];
	for (let g = Math.min(ngramSize, seq.length - 1); g >= 2; g--) {
		const start = seq.length - g;
		outer: for (let i = start - 1; i >= 0; i--) {
			for (let j = 0; j < g; j++) if (seq[i + j] !== seq[start + j]) continue outer;
			const from = i + g;
			return seq.slice(from, Math.min(from + maxDraft, seq.length));
		}
	}
	return [];
}
/** The auto-bail decision after the probation window: keep speculating only when the measured
*  tokens-per-verify-step clears the break-even against PLAIN decoding, which differs by mode.
*  Each PLD step costs one batched verify forward plus a per-step CPU sync; plain GREEDY chains
*  several steps per sync (GPU-resident argmax), so its break-even is high (~2.0 tokens/step,
*  measured), while plain SAMPLED syncs every token anyway (~1.5). Below the bar, the rest of
*  the turn runs the plain path - output is identical either way, only speed changes. */
function pldWorthIt(emitted, steps, sampled) {
	if (steps <= 0) return false;
	return emitted / steps >= (sampled ? 1.5 : 2);
}
//#endregion
//#region src/sampler.ts
/** Mersenne Twister 19937, matching transformers.js utils/random.js (= Python's random.Random). */
var MT19937 = class {
	mt = /* @__PURE__ */ new Uint32Array(624);
	idx = 625;
	constructor(seed) {
		this.seed(seed);
	}
	seed(n) {
		if (n === void 0 || n === null) {
			const buf = /* @__PURE__ */ new Uint32Array(1);
			crypto.getRandomValues(buf);
			n = buf[0];
		}
		const mt = this.mt;
		const u = (a, b) => Math.imul(a, b) >>> 0;
		const key = [];
		for (let v = n || 0; v > 0; v = Math.floor(v / 4294967296)) key.push(v & 4294967295);
		if (!key.length) key.push(0);
		mt[0] = 19650218;
		for (let k = 1; k < 624; ++k) mt[k] = u(1812433253, mt[k - 1] ^ mt[k - 1] >>> 30) + k >>> 0;
		let i = 1;
		let j = 0;
		for (let k = Math.max(624, key.length); k > 0; --k, ++i, ++j) {
			if (i >= 624) {
				mt[0] = mt[623];
				i = 1;
			}
			if (j >= key.length) j = 0;
			mt[i] = (mt[i] ^ u(mt[i - 1] ^ mt[i - 1] >>> 30, 1664525)) + key[j] + j >>> 0;
		}
		for (let k = 623; k > 0; --k, ++i) {
			if (i >= 624) {
				mt[0] = mt[623];
				i = 1;
			}
			mt[i] = (mt[i] ^ u(mt[i - 1] ^ mt[i - 1] >>> 30, 1566083941)) - i >>> 0;
		}
		mt[0] = 2147483648;
		this.idx = 624;
	}
	int32() {
		const mt = this.mt;
		if (this.idx >= 624) {
			for (let k = 0; k < 624; ++k) {
				const y = mt[k] & 2147483648 | mt[(k + 1) % 624] & 2147483647;
				mt[k] = (mt[(k + 397) % 624] ^ y >>> 1 ^ (y & 1 ? 2567483615 : 0)) >>> 0;
			}
			this.idx = 0;
		}
		let y = mt[this.idx++];
		y ^= y >>> 11;
		y ^= y << 7 & 2636928640;
		y ^= y << 15 & 4022730752;
		y ^= y >>> 18;
		return y >>> 0;
	}
	/** Uniform float in [0, 1), matching Python's random.random(). */
	random() {
		return ((this.int32() >>> 5) * 67108864 + (this.int32() >>> 6)) / 9007199254740992;
	}
};
/** Deduped set of token ids that repetition_penalty applies to (the full prompt+generated history). */
function affectedIds(history) {
	return Uint32Array.from(new Set(history));
}
/** no_repeat_ngram banned next-tokens for the current step. Faithful port of
*  NoRepeatNGramLogitsProcessor.calcBannedNgramTokens (transformers.js v4.2.0). */
function ngramBans(history, n) {
	if (history.length + 1 < n) return [];
	const generated = /* @__PURE__ */ new Map();
	for (let j = 0; j < history.length + 1 - n; ++j) {
		const ngram = [];
		for (let k = 0; k < n; ++k) ngram.push(history[j + k]);
		const key = JSON.stringify(ngram.slice(0, n - 1));
		const arr = generated.get(key) ?? [];
		arr.push(ngram[n - 1]);
		generated.set(key, arr);
	}
	const idx = history.slice(history.length + 1 - n, history.length);
	return generated.get(JSON.stringify(idx)) ?? [];
}
/** DRY repetition penalty (Kingbri/llama.cpp lineage), applied over the top-K candidates on the
*  CPU. For each candidate c: find the longest L such that the last L history tokens followed by c
*  reproduce an earlier stretch of the history (i.e. picking c would EXTEND an L-token repeat).
*  If L >= allowedLength the candidate's logit drops by multiplier * base^(L - allowedLength).
*  Matching never crosses a breaker token on either side, and breaker candidates are never
*  penalized (structural tokens - newlines, quotes - legitimately repeat). Operating on the
*  candidates (not the full vocab) mirrors how topP/minP are scoped in this engine. Returns the
*  adjusted pairs re-sorted descending (stable), leaving the inputs untouched. */
function applyDry(candIds, candVals, history, o) {
	const n = history.length;
	const lo = o.range > 0 ? Math.max(0, n - o.range) : 0;
	const MAXL = o.allowedLength + 32;
	const vals = Array.from(candVals);
	const ids = Array.from(candIds);
	if (n > lo && o.multiplier > 0) for (let ci = 0; ci < ids.length; ci++) {
		const c = ids[ci];
		if (o.breakers.has(c)) continue;
		let maxL = 0;
		for (let i = lo; i < n; i++) {
			if (history[i] !== c) continue;
			let l = 0;
			while (l < MAXL && i - 1 - l >= lo && !o.breakers.has(history[i - 1 - l]) && !o.breakers.has(history[n - 1 - l]) && history[i - 1 - l] === history[n - 1 - l]) l++;
			if (l > maxL) maxL = l;
			if (maxL >= MAXL) break;
		}
		if (maxL >= o.allowedLength) vals[ci] -= o.multiplier * Math.pow(o.base, maxL - o.allowedLength);
	}
	const order = Array.from(ids.keys()).sort((a, b) => vals[b] - vals[a] || a - b);
	return {
		ids: order.map((i) => ids[i]),
		vals: order.map((i) => vals[i])
	};
}
/** Stable softmax (max-subtract), matching transformers.js utils/maths.js softmax. */
function softmax(arr) {
	let maxVal = arr[0];
	for (let i = 1; i < arr.length; ++i) if (arr[i] > maxVal) maxVal = arr[i];
	const exps = Array.from(arr, (x) => Math.exp(x - maxVal));
	let sum = 0;
	for (const e of exps) sum += e;
	return exps.map((x) => x / sum);
}
/** Final sampling tail. `candVals` are the K largest PENALTY-FILTERED logits (descending), `candIds`
*  their token ids. Applies temperature to the K values, softmaxes, optionally trims the pool with
*  top-p (nucleus) and/or min-p, then draws via the exact transformers.js inverse-CDF weighted pick
*  (x = random()*sum; subtract until <0). `topP` (default 1 = off) keeps the shortest leading run
*  whose cumulative probability reaches topP; `minP` (default 0 = off) keeps tokens with probability
*  >= minP*maxProb - both operate on the already-descending candidates, so each keeps a prefix and
*  the kept set is their shorter prefix. With both off the draw is bit-identical to the plain path
*  (m == k, sum over all K). Returns a token id. */
function sampleFromCandidates(candIds, candVals, temperature, rng, topP = 1, minP = 0) {
	const k = candVals.length;
	const tv = new Float32Array(k);
	for (let i = 0; i < k; ++i) tv[i] = candVals[i] / temperature;
	const probs = softmax(tv);
	let m = k;
	if (minP > 0) {
		const thresh = minP * probs[0];
		let c = 1;
		while (c < k && probs[c] >= thresh) c++;
		if (c < m) m = c;
	}
	if (topP < 1) {
		let cum = 0;
		let c = 0;
		while (c < k) {
			cum += probs[c];
			c++;
			if (cum >= topP) break;
		}
		if (c < m) m = c;
	}
	if (m < 1) m = 1;
	let sum = 0;
	for (let i = 0; i < m; ++i) sum += probs[i];
	let x = rng.random() * sum;
	for (let i = 0; i < m; ++i) {
		x -= probs[i];
		if (x < 0) return candIds[i];
	}
	return candIds[m - 1];
}
//#endregion
//#region src/engine.ts
const VIEW = {
	FLOAT: Float32Array,
	UINT8: Uint8Array,
	FLOAT16: Uint16Array
};
const WGSLS = [
	"matmul_split",
	"matmul_resid",
	"matmul_q2",
	"rope",
	"swiglu",
	"copy"
];
const DEFAULT_MAX_SEQ = 2048;
const PREFILL_SEG = 256;
const RECUR_FLUSH = 16;
const PARAM_AB = /* @__PURE__ */ new ArrayBuffer(64);
const PARAM_DV = new DataView(PARAM_AB);
const PARAM_U8 = new Uint8Array(PARAM_AB);
function makeParams(fields) {
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		if (f[0] === "f") PARAM_DV.setFloat32(i * 4, f[1], true);
		else PARAM_DV.setUint32(i * 4, f[1] >>> 0, true);
	}
	return PARAM_U8.subarray(0, Math.ceil(fields.length / 4) * 16);
}
const eqBytes = (a, b) => {
	for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
	return true;
};
/** Synthesize f32 rope tables ([positions, head_dim/2]) from arch.rope for manifests without
*  baked caches (v2/GGUF). Plain rope or YaRN (transformers formula: beta_fast 32, beta_slow 1,
*  mscale = 0.1*ln(factor)+1). Angles accumulate in f64 and round once to f32 per entry -
*  tools/reference.py implements the identical recipe for fixture generation. */
function synthRope(A, positions, rotaryDim = A.head_dim) {
	const half = rotaryDim / 2;
	const rope = A.rope;
	const base = rope.rope_theta;
	const factor = rope.rope_type === "yarn" ? rope.factor ?? 1 : 1;
	const inv = new Float64Array(half);
	const orig = rope.original_max_position_embeddings ?? 0;
	const lo = factor === 1 ? 0 : Math.max(0, Math.floor(rotaryDim * Math.log(orig / (64 * Math.PI)) / (2 * Math.log(base))));
	const hi = factor === 1 ? 0 : Math.min(half - 1, Math.ceil(rotaryDim * Math.log(orig / (2 * Math.PI)) / (2 * Math.log(base))));
	for (let j = 0; j < half; j++) {
		const pf = base ** (2 * j / rotaryDim);
		if (factor === 1) {
			inv[j] = 1 / pf;
			continue;
		}
		const ramp = Math.min(1, Math.max(0, (j - lo) / (hi - lo)));
		inv[j] = 1 / (factor * pf) * ramp + 1 / pf * (1 - ramp);
	}
	const mscale = factor === 1 ? 1 : Math.fround(.1 * Math.log(factor) + 1);
	const cos = new Float32Array(positions * half);
	const sin = new Float32Array(positions * half);
	for (let p = 0; p < positions; p++) for (let j = 0; j < half; j++) {
		const a = p * inv[j];
		cos[p * half + j] = Math.fround(Math.cos(a) * mscale);
		sin[p * half + j] = Math.fround(Math.sin(a) * mscale);
	}
	return [cos, sin];
}
/** Load a 1-bit model and return an {@link Engine}. Pass a model URL string for defaults. */
async function createEngine(options) {
	const holder = {};
	try {
		return await createEngineInner(options, holder);
	} catch (e) {
		holder.device?.destroy();
		throw e;
	}
}
async function createEngineInner(options, holder) {
	const opts = typeof options === "string" ? { modelUrl: options } : options;
	const modelDir = opts.modelUrl ? opts.modelUrl.replace(/\/$/, "") : null;
	if (!modelDir && !opts.manifestUrl && !opts.manifest) throw new Error("createEngine: provide modelUrl, manifestUrl, or an in-memory manifest");
	if (opts.manifest && !modelDir && !opts.dataUrl) throw new Error("createEngine: an in-memory manifest needs dataUrl (or modelUrl) for the weights file");
	const powerPreference = opts.powerPreference ?? "high-performance";
	const fetchJson = opts.fetchJson ?? (async (url) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`bitgpu: fetch ${url} failed: HTTP ${res.status}`);
		if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`bitgpu: ${url} returned HTML, not JSON (a SPA fallback is probably serving index.html for missing model files)`);
		return res.json();
	});
	const fetchBytes = opts.fetchArrayBuffer ?? (async (url) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`bitgpu: fetch ${url} failed: HTTP ${res.status}`);
		const total = Number(res.headers.get("content-length") ?? 0);
		if (!res.body || !total) return res.arrayBuffer();
		const reader = res.body.getReader();
		const chunks = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.byteLength;
			opts.onProgress?.({
				phase: "weights",
				loaded,
				total
			});
		}
		const out = new Uint8Array(loaded);
		let p = 0;
		for (const c of chunks) {
			out.set(c, p);
			p += c.byteLength;
		}
		return out.buffer;
	});
	if (typeof navigator === "undefined" || !navigator.gpu) throw new WebGPUUnavailableError("WebGPU is not available (no navigator.gpu). Use a WebGPU-capable browser over a secure context.");
	opts.onProgress?.({ phase: "manifest" });
	const manifest = opts.manifest ?? await fetchJson(opts.manifestUrl ?? `${modelDir}/manifest.json`);
	opts.onProgress?.({ phase: "weights" });
	const dataUrl = opts.dataUrl ?? `${modelDir}/${manifest.data_file}`;
	let aux;
	if (opts.aux) aux = opts.aux instanceof Uint8Array ? new Uint8Array(opts.aux).buffer : opts.aux;
	else aux = await fetchBytes(opts.auxUrl ?? `${modelDir}/${manifest.aux_file}`);
	const A = manifest.arch;
	const T = manifest.tensors;
	const FINAL_NORM = `layers.${A.layers}.final_norm_layernorm`;
	if (A.act !== "silu") throw new Error(`bitgpu: unsupported activation '${A.act}' (kernels implement silu/SwiGLU)`);
	if (A.head_dim > (A.hybrid ? 256 : 128)) throw new Error(`bitgpu: unsupported head_dim ${A.head_dim}`);
	const ROPE_D = A.hybrid?.rotary_dim ?? A.head_dim;
	if (A.heads % A.kv_heads !== 0) throw new Error(`bitgpu: heads ${A.heads} not divisible by kv_heads ${A.kv_heads} (GQA kernels assume an integer group size)`);
	if (!T[FINAL_NORM]) throw new Error(`bitgpu: manifest is missing the final norm tensor '${FINAL_NORM}'`);
	if (manifest.version !== void 0 && manifest.version !== 1 && manifest.version !== 2) throw new Error(`bitgpu: unsupported manifest version ${manifest.version} (this engine reads versions 1 and 2)`);
	if (!T.cos_cache !== !T.sin_cache) throw new Error("bitgpu: manifest has only one of cos_cache/sin_cache");
	if (!T.cos_cache && !(A.rope && A.rope.rope_theta)) throw new Error("bitgpu: manifest has neither baked cos_cache/sin_cache RoPE tensors nor arch.rope parameters");
	for (const [name, t] of Object.entries(T)) {
		if (t.block !== void 0 && t.block !== 128) throw new Error(`bitgpu: tensor ${name} has block ${t.block} (kernels assume 128)`);
		if (t.container === void 0) continue;
		if (t.container !== "q1_0") throw new Error(`bitgpu: tensor ${name} has unknown container '${t.container}'`);
		const N = t.N ?? t.rows;
		const K = t.K ?? t.cols;
		if (!N || !K || K % 128 !== 0) throw new Error(`bitgpu: tensor ${name}: q1_0 container needs N/K (or rows/cols) with K a multiple of 128`);
		const r = t.weight;
		if (!r || r.src !== "data" || r.len !== N * (K / 128) * 18) throw new Error(`bitgpu: tensor ${name}: q1_0 region is ${r?.len} bytes in '${r?.src}', expected ${N * (K / 128) * 18} in the data file`);
		t.q1_0 = r;
		t.weight = {
			dtype: "UINT8",
			src: r.src,
			off: r.off,
			len: N * (K / 8)
		};
		t.scales = {
			dtype: "FLOAT",
			src: r.src,
			off: r.off,
			len: N * (K / 128) * 4
		};
		t.zp = void 0;
	}
	const readRef = (ref) => {
		if (ref.src !== "aux") throw new Error("bitgpu: internal - readRef reads aux-file refs; data-file tensors stream through routes");
		if (ref.off + ref.len > aux.byteLength) throw new Error(`bitgpu: tensor range ${ref.off}+${ref.len} exceeds the aux file (${aux.byteLength} bytes); the download is truncated or the manifest does not match it`);
		const V = VIEW[ref.dtype];
		if (V === Uint8Array) return new Uint8Array(aux, ref.off, ref.len);
		const bpe = V.BYTES_PER_ELEMENT;
		if (ref.off % bpe === 0) return new V(aux, ref.off, ref.len / bpe);
		return new V(aux.slice(ref.off, ref.off + ref.len));
	};
	const readU8 = (ref) => readRef(ref);
	const adapter = await navigator.gpu.requestAdapter({ powerPreference });
	if (!adapter) throw new WebGPUUnavailableError("No suitable WebGPU adapter was found.");
	const hasSG = adapter.features.has("subgroups");
	const info = adapter.info ?? {};
	const sgMax = info.subgroupMaxSize ?? 32;
	const sgMin = info.subgroupMinSize ?? sgMax;
	const forceNoSG = opts.forceNoSubgroups ?? false;
	const WG_NS = Math.min(256, Math.max(32, 1 << Math.round(Math.log2(opts.noSubgroupWorkgroupSize ?? 64))));
	const NOTILE = opts.prefillTiling === "never";
	const FORCETILE = opts.prefillTiling === "always";
	const tiledPrefill = (S) => FORCETILE || !NOTILE && S >= 64;
	const SYNC_N = Math.max(1, opts.syncSteps ?? 4);
	const maxSeqLen = Math.max(1, opts.maxSeqLen ?? DEFAULT_MAX_SEQ);
	const useSG = hasSG && sgMin === sgMax && (sgMax === 16 || sgMax === 32 || sgMax === 64) && A.head_dim % sgMax === 0 && !forceNoSG;
	const kv16 = opts.kvCache === "f16" && !A.hybrid && adapter.features.has("shader-f16");
	const kv8 = opts.kvCache === "q8";
	const roll = opts.overflow === "sinks";
	const SINKS = roll ? Math.max(1, Math.floor(opts.sinkTokens ?? 4)) : 0;
	if (roll && A.hybrid) throw new Error("bitgpu: overflow 'sinks' is not yet supported for the qwen3_5 hybrid backbone (the full-attention read path has no sink/roll K-rotation, and windowing only the full layers while the linear layers keep full-history state is unvalidated)");
	if (roll && maxSeqLen < SINKS + 64) throw new Error(`bitgpu: overflow 'sinks' needs maxSeqLen >= sinkTokens + 64 (got ${maxSeqLen} with ${SINKS} sinks)`);
	const KVB = kv16 ? 2 : kv8 ? 1 : 4;
	const actF16 = opts.activation === "f16" && useSG && adapter.features.has("shader-f16");
	const features = [];
	if (useSG) features.push("subgroups");
	if (kv16 || actF16) features.push("shader-f16");
	const hasTS = adapter.features.has("timestamp-query");
	if (hasTS) features.push("timestamp-query");
	const DEFAULT_BINDING = 134217728;
	const DEFAULT_BUFFER = 268435456;
	let needBind = 0;
	let weightBytes = 0;
	const track = (bytes) => {
		const b = bytes + 3 & -4;
		needBind = Math.max(needBind, b);
		weightBytes += b;
	};
	for (const t of Object.values(T)) if (t.kind === "q2") {
		track(t.weight.len * 2);
		track(t.scales.len);
	} else if (t.kind === "f32" && t.weight) track(t.weight.len);
	const fusedLen = (names, f) => names.reduce((n, nm) => n + T[nm][f].len, 0);
	for (let li = 0; li < A.layers; li++) {
		let groups;
		if (A.hybrid) groups = [
			...A.hybrid.layer_types[li] === "full" ? [
				"attn.q_proj",
				"attn.k_proj",
				"attn.v_proj",
				"attn.o_proj"
			] : [
				"linear.in_qkv",
				"linear.z",
				"linear.a",
				"linear.b",
				"linear.out_proj"
			],
			"mlp.gate_proj",
			"mlp.up_proj",
			"mlp.down_proj"
		].map((s) => [`layers.${li}.${s}`]);
		else groups = [
			[
				`layers.${li}.attn.q_proj`,
				`layers.${li}.attn.k_proj`,
				`layers.${li}.attn.v_proj`
			],
			[`layers.${li}.mlp.gate_proj`, `layers.${li}.mlp.up_proj`],
			[`layers.${li}.attn.o_proj`],
			[`layers.${li}.mlp.down_proj`]
		];
		for (const g of groups) {
			track(fusedLen(g, "weight"));
			track(fusedLen(g, "scales"));
		}
	}
	const embZpLen = T.embed_tokens.zp?.len ?? T.embed_tokens.rows * (T.embed_tokens.cols / 128) / 2;
	for (const r of [
		T.embed_tokens.weight,
		T.embed_tokens.scales,
		manifest.luts.tgt4
	]) track(r.len);
	track(embZpLen);
	if (kv8 && A.head_dim % 32 !== 0) throw new Error(`bitgpu: kvCache 'q8' needs head_dim divisible by 32 (got ${A.head_dim}); use 'f16' or 'f32' for this model`);
	const kvLayerBytes = maxSeqLen * A.kv_heads * A.head_dim * KVB;
	needBind = Math.max(needBind, kvLayerBytes, PREFILL_SEG * Math.max(A.heads * A.head_dim, A.intermediate) * 4, 32 * A.vocab * 4);
	const requiredLimits = {};
	if (needBind > DEFAULT_BINDING) {
		if (needBind > adapter.limits.maxStorageBufferBindingSize) throw new GpuOutOfMemoryError(`this model needs a ${Math.ceil(needBind / 1048576)} MiB storage binding but the adapter's maxStorageBufferBindingSize is ${Math.floor(adapter.limits.maxStorageBufferBindingSize / 1048576)} MiB`);
		requiredLimits.maxStorageBufferBindingSize = needBind;
	}
	if (needBind > DEFAULT_BUFFER) {
		if (needBind > adapter.limits.maxBufferSize) throw new GpuOutOfMemoryError(`this model needs a ${Math.ceil(needBind / 1048576)} MiB buffer but the adapter's maxBufferSize is ${Math.floor(adapter.limits.maxBufferSize / 1048576)} MiB`);
		requiredLimits.maxBufferSize = needBind;
	}
	const device = await adapter.requestDevice({
		requiredFeatures: features,
		requiredLimits: Object.keys(requiredLimits).length ? requiredLimits : void 0
	});
	holder.device = device;
	const lost = device.lost.then((info) => {
		const li = {
			reason: String(info.reason ?? "unknown"),
			message: info.message
		};
		if (li.reason !== "destroyed") opts.onDeviceLost?.(li);
		return li;
	});
	device.addEventListener("uncapturederror", (ev) => {
		console.error(`[bitgpu] uncaptured WebGPU error: ${ev.error.message}`);
	});
	opts.onProgress?.({ phase: "pipelines" });
	const pipelines = {};
	const mkPipe = async (name, constants) => {
		const code = SHADERS[name];
		if (code === void 0) throw new Error(`shader not found: ${name}`);
		const module = device.createShaderModule({
			code,
			label: name
		});
		const err = (await module.getCompilationInfo()).messages.find((m) => m.type === "error");
		if (err) throw new Error(`WGSL compile error in ${name} (L${err.lineNum}:${err.linePos}): ${err.message}`);
		pipelines[name] = await device.createComputePipelineAsync({
			layout: "auto",
			compute: {
				module,
				entryPoint: "main",
				constants
			}
		});
	};
	const ROWS_MR = 4;
	const specs = [
		...WGSLS.map((n) => [n]),
		["matmul_split_tiled"],
		["matmul_resid_tiled"],
		["argmax"],
		["embed_gather"],
		["embed_gather_batch"],
		["sampler_penalty"],
		["argmax_masked"],
		["logsumexp"],
		["sampler_sigma"]
	];
	if (useSG) {
		for (const n of [
			"rmsnorm_sg",
			"attention_sg",
			"matmul_split_sg",
			"matmul_q2_sg",
			"rmsnorm_rope_sg"
		]) specs.push([n, { SG: sgMax }]);
		for (const n of [
			"matmul_split_sm",
			"matmul_resid_sm",
			"matmul_q2_sm"
		]) specs.push([n, { SG: sgMax }]);
		for (const n of ["matmul_resid_mr_sg", "matmul_swiglu_mr_sg"]) specs.push([n, {
			SG: sgMax,
			ROWS: ROWS_MR
		}]);
	} else {
		for (const n of [
			"matmul_split_wg",
			"matmul_resid_wg",
			"matmul_q2_wg",
			"rmsnorm_wg"
		]) specs.push([n, { WG: WG_NS }]);
		specs.push(["attention_wg"]);
	}
	if (kv16) {
		specs.push(["copy_kv16"]);
		if (useSG) for (const n of ["attention_sg_kv16", "rmsnorm_rope_sg_kv16"]) specs.push([n, { SG: sgMax }]);
		else specs.push(["attention_wg_kv16"]);
	}
	if (kv8) {
		specs.push(["copy_kv8"]);
		if (useSG) for (const n of ["attention_sg_kv8", "rmsnorm_rope_sg_kv8"]) specs.push([n, { SG: sgMax }]);
		else specs.push(["attention_wg_kv8"]);
	}
	if (actF16) {
		for (const n of ["rmsnorm_sg_af16", "matmul_split_sg_af16"]) specs.push([n, { SG: sgMax }]);
		for (const n of ["matmul_swiglu_mr_sg_af16", "matmul_resid_mr_sg_af16"]) specs.push([n, {
			SG: sgMax,
			ROWS: ROWS_MR
		}]);
	}
	const rollSG = useSG && sgMax <= A.head_dim / 2;
	if (roll) {
		const rollAtt = kv16 ? "attention_sg_kv16_roll" : kv8 ? "attention_sg_kv8_roll" : "attention_sg_roll";
		const rollAttWg = kv16 ? "attention_wg_kv16_roll" : kv8 ? "attention_wg_kv8_roll" : "attention_wg_roll";
		if (rollSG) specs.push([rollAtt, { SG: sgMax }]);
		else specs.push([rollAttWg]);
	}
	const ATT = roll ? kv16 ? rollSG ? "attention_sg_kv16_roll" : "attention_wg_kv16_roll" : kv8 ? rollSG ? "attention_sg_kv8_roll" : "attention_wg_kv8_roll" : rollSG ? "attention_sg_roll" : "attention_wg_roll" : kv16 ? useSG ? "attention_sg_kv16" : "attention_wg_kv16" : kv8 ? useSG ? "attention_sg_kv8" : "attention_wg_kv8" : useSG ? "attention_sg" : "attention_wg";
	const ROPE_K = kv16 ? "rmsnorm_rope_sg_kv16" : "rmsnorm_rope_sg";
	const COPY_KV = kv16 ? "copy_kv16" : "copy";
	if (A.hybrid) {
		for (const n of [
			"conv1d_causal",
			"deltanet_gbeta",
			"rope_partial",
			"slice_cols",
			"split_head",
			"gate_sigmoid"
		]) specs.push([n]);
		specs.push(["deltanet_recur", { WGV: A.hybrid.linear_head_dim }]);
		specs.push(["deltanet_norm_gate", { WG: 64 }]);
		specs.push(["attention_online", { WGD: A.head_dim }]);
		specs.push([kv8 ? "attention_online_cache_kv8" : "attention_online_cache", { WGD: A.head_dim }]);
	}
	await Promise.all(specs.map(([n, c]) => mkPipe(n, c)));
	const S_ = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC, U = GPUBufferUsage.UNIFORM;
	let transients = null;
	const flushTransients = () => {
		if (!transients) return;
		for (const b of transients) b.destroy();
		transients = [];
		arena = null;
	};
	let arena = null;
	let arenaCur = null;
	const arenaFree = (b) => {
		if (!arena) return;
		const list = arena.get(b.size);
		if (list) list.push(b);
		else arena.set(b.size, [b]);
	};
	const upload = (typed, usage = S_ | CD) => {
		const b = device.createBuffer({
			size: typed.byteLength,
			usage
		});
		device.queue.writeBuffer(b, 0, typed);
		transients?.push(b);
		return b;
	};
	const pools = {};
	let pool = null;
	let bufIdx = 0;
	let dispIdx = 0;
	let poolRoundFrom = 0;
	let poolRoundTo = 0;
	const poolUse = (name, roundFrom = 0, roundTo = 0) => {
		pool = name ? pools[name] ??= {
			buf: [],
			disp: []
		} : null;
		poolRoundFrom = roundFrom;
		poolRoundTo = roundTo;
		bufIdx = 0;
		dispIdx = 0;
	};
	const poolInvalidate = () => {
		for (const p of Object.values(pools)) for (const s of p.disp) {
			s.bg = null;
			s.last = null;
		}
	};
	const actBuf = (n) => {
		if (!pool) {
			const hit = arena?.get(n * 4)?.pop();
			if (hit) {
				arenaCur?.push(hit);
				return hit;
			}
			const b = device.createBuffer({
				size: n * 4,
				usage: S_ | CS | CD
			});
			transients?.push(b);
			arenaCur?.push(b);
			return b;
		}
		const alloc = poolRoundFrom > 0 ? n / poolRoundFrom * poolRoundTo : n;
		let b = pool.buf[bufIdx];
		if (!b || b.size !== alloc * 4) {
			b = device.createBuffer({
				size: alloc * 4,
				usage: S_ | CS | CD
			});
			pool.buf[bufIdx] = b;
		}
		bufIdx++;
		return b;
	};
	const actBuf16 = (n) => {
		const bytes = n * 2;
		if (!pool) {
			const b = device.createBuffer({
				size: bytes,
				usage: S_ | CS | CD
			});
			transients?.push(b);
			return b;
		}
		let b = pool.buf[bufIdx];
		if (!b || b.size !== bytes) {
			b = device.createBuffer({
				size: bytes,
				usage: S_ | CS | CD
			});
			pool.buf[bufIdx] = b;
		}
		bufIdx++;
		return b;
	};
	const dummy = device.createBuffer({
		size: 16,
		usage: S_
	});
	const dummy2 = device.createBuffer({
		size: 16,
		usage: S_
	});
	let fullHistory = [];
	let cacheLen = 0;
	const resetCache = () => {
		fullHistory = [];
		cacheLen = 0;
	};
	if (manifest.luts.tgt2.src !== "aux") throw new Error("bitgpu: luts.tgt2 must live in the aux file (the streaming loader needs it before the weights arrive)");
	const tgt2 = readU8(manifest.luts.tgt2);
	const signTable = /* @__PURE__ */ new Uint8Array(256);
	for (let b = 0; b < 256; b++) {
		let bits = 0;
		for (let j = 0; j < 8; j++) bits |= ((tgt2[2 * b + (j >> 2)] >> 2 * (j & 3) & 3) >> 1 & 1) << j;
		signTable[b] = bits;
	}
	const routes = [];
	const gbuf = (len) => device.createBuffer({
		size: len + 3 & -4,
		usage: S_ | CD
	});
	const gpuSink = (buf, base) => {
		let written = 0;
		let carry = /* @__PURE__ */ new Uint8Array(0);
		return {
			push(bytes) {
				let all = bytes;
				if (carry.length) {
					all = new Uint8Array(carry.length + bytes.length);
					all.set(carry);
					all.set(bytes, carry.length);
				}
				const n = all.length & -4;
				if (n) device.queue.writeBuffer(buf, base + written, all, 0, n);
				carry = all.subarray(n).slice();
				written += n;
			},
			finish() {
				if (!carry.length) return;
				const pad = /* @__PURE__ */ new Uint8Array(4);
				pad.set(carry);
				device.queue.writeBuffer(buf, base + written, pad);
				written += 4;
				carry = /* @__PURE__ */ new Uint8Array(0);
			}
		};
	};
	const wire = (ref, push, finish) => {
		if (ref.src === "aux") {
			push(new Uint8Array(readRef(ref).buffer, ref.off, ref.len));
			finish();
		} else routes.push({
			off: ref.off,
			len: ref.len,
			push,
			finish
		});
	};
	const wireRaw = (ref, buf, base = 0) => {
		const s = gpuSink(buf, base);
		wire(ref, s.push, s.finish);
	};
	const xfSign = (push) => (b) => {
		const o = new Uint8Array(b.length);
		for (let i = 0; i < b.length; i++) o[i] = signTable[b[i]];
		push(o);
	};
	const xfQ2 = (push) => (b) => {
		const o = new Uint8Array(b.length * 2);
		for (let i = 0; i < b.length; i++) {
			o[2 * i] = tgt2[2 * b[i]];
			o[2 * i + 1] = tgt2[2 * b[i] + 1];
		}
		push(o);
	};
	const wireSign = (ref, buf, base = 0) => {
		const s = gpuSink(buf, base);
		wire(ref, xfSign(s.push), s.finish);
	};
	const wireQ2 = (ref, buf) => {
		const s = gpuSink(buf, 0);
		wire(ref, xfQ2(s.push), s.finish);
	};
	const f16f32 = (h) => {
		const s = h & 32768 ? -1 : 1;
		const e = h >> 10 & 31;
		const m = h & 1023;
		if (e === 0) return s * m * 2 ** -24;
		if (e === 31) return m ? NaN : s * Infinity;
		return s * (1024 + m) * 2 ** (e - 25);
	};
	const wireQ10 = (region, signPush, signFinish, scalePush, scaleFinish) => {
		let phase = 0;
		let scaleLo = 0;
		const push = (b) => {
			const signs = new Uint8Array(b.length);
			const scales = new Float32Array((b.length >> 4) + 2);
			let sn = 0;
			let cn = 0;
			for (let i = 0; i < b.length; i++) if (phase === 0) {
				scaleLo = b[i];
				phase = 1;
			} else if (phase === 1) {
				scales[cn++] = f16f32(scaleLo | b[i] << 8);
				phase = 2;
			} else {
				signs[sn++] = b[i];
				phase = phase === 17 ? 0 : phase + 1;
			}
			if (sn) signPush(signs.subarray(0, sn));
			if (cn) scalePush(new Uint8Array(scales.buffer, 0, cn * 4));
		};
		routes.push({
			off: region.off,
			len: region.len,
			push,
			finish: () => {
				signFinish();
				scaleFinish();
			}
		});
	};
	const wireCpu = (ref) => {
		const dst = new Uint8Array(ref.len);
		let w = 0;
		wire(ref, (b) => {
			dst.set(b, w);
			w += b.length;
		}, () => void 0);
		return dst;
	};
	device.pushErrorScope("validation");
	device.pushErrorScope("out-of-memory");
	const W = {};
	const zpChecks = [];
	for (const [name, t] of Object.entries(T)) if (t.kind === "q2") {
		const codes = gbuf(t.weight.len * 2);
		const scales = gbuf(t.scales.len);
		if (t.q1_0) {
			const cs = gpuSink(codes, 0);
			const ss = gpuSink(scales, 0);
			wireQ10(t.q1_0, xfQ2(cs.push), cs.finish, ss.push, ss.finish);
		} else {
			wireQ2(t.weight, codes);
			wireRaw(t.scales, scales);
		}
		const w = {
			N: t.N,
			K: t.K,
			nb: t.K / 128,
			zp: 2,
			codes,
			scales
		};
		if (t.zp) {
			const zpBytes = wireCpu(t.zp);
			zpChecks.push(() => {
				const b0 = zpBytes[0];
				for (let i = 1; i < zpBytes.length; i++) if (zpBytes[i] !== b0) throw new Error(`bitgpu: tensor ${name} has non-uniform 2-bit zero-points (the q2 kernels assume one zp for the whole tensor)`);
				const zp = b0 & 3;
				if (b0 !== zp * 85) throw new Error(`bitgpu: tensor ${name} has non-uniform 2-bit zero-points within a byte (the q2 kernels assume one zp for the whole tensor)`);
				w.zp = zp;
			});
		}
		W[name] = w;
	} else if (t.kind === "f32" && t.weight) {
		const buf = gbuf(t.weight.len);
		wireRaw(t.weight, buf);
		W[name] = { buf };
	}
	const fuse = (parts) => {
		const sign = gbuf(parts.reduce((n, p) => n + p.weight.len, 0));
		const scales = gbuf(parts.reduce((n, p) => n + p.scales.len, 0));
		let so = 0;
		let co = 0;
		for (const p of parts) {
			if (p.q1_0) {
				const ws = gpuSink(sign, so);
				const ss = gpuSink(scales, co);
				wireQ10(p.q1_0, xfSign(ws.push), ws.finish, ss.push, ss.finish);
			} else {
				wireSign(p.weight, sign, so);
				wireRaw(p.scales, scales, co);
			}
			so += p.weight.len;
			co += p.scales.len;
		}
		return {
			sign,
			scales
		};
	};
	if (manifest.arch.hybrid) {
		const bin = (nm) => {
			const r = T[nm];
			W[nm] = {
				N: r.N,
				K: r.K,
				nb: r.K / 128,
				N0: r.N,
				N1: 0,
				N2: 0,
				...fuse([r])
			};
		};
		for (let li = 0; li < A.layers; li++) {
			for (const s of [
				"mlp.gate_proj",
				"mlp.up_proj",
				"mlp.down_proj"
			]) bin(`layers.${li}.${s}`);
			if (manifest.arch.hybrid.layer_types[li] === "full") for (const s of [
				"attn.q_proj",
				"attn.k_proj",
				"attn.v_proj",
				"attn.o_proj"
			]) bin(`layers.${li}.${s}`);
			else for (const s of [
				"linear.in_qkv",
				"linear.z",
				"linear.a",
				"linear.b",
				"linear.out_proj"
			]) bin(`layers.${li}.${s}`);
		}
	} else for (let li = 0; li < A.layers; li++) {
		const q = T[`layers.${li}.attn.q_proj`], k = T[`layers.${li}.attn.k_proj`], v = T[`layers.${li}.attn.v_proj`];
		W[`layers.${li}.attn.qkv`] = {
			K: q.K,
			nb: q.K / 128,
			N0: q.N,
			N1: k.N,
			N2: v.N,
			...fuse([
				q,
				k,
				v
			])
		};
		const g = T[`layers.${li}.mlp.gate_proj`], u = T[`layers.${li}.mlp.up_proj`];
		W[`layers.${li}.mlp.gateup`] = {
			K: g.K,
			nb: g.K / 128,
			N0: g.N,
			N1: u.N,
			N2: 0,
			...fuse([g, u])
		};
		for (const nm of [`layers.${li}.attn.o_proj`, `layers.${li}.mlp.down_proj`]) {
			const r = T[nm];
			W[nm] = {
				N: r.N,
				K: r.K,
				nb: r.K / 128,
				...fuse([r])
			};
		}
	}
	const wireGpu = (ref) => {
		const buf = gbuf(ref.len);
		wireRaw(ref, buf);
		return buf;
	};
	let embWqG;
	let embScalesG;
	let embZpG;
	if (T.embed_tokens.q1_0) {
		embWqG = gbuf(T.embed_tokens.weight.len);
		embScalesG = gbuf(T.embed_tokens.scales.len);
		const ws = gpuSink(embWqG, 0);
		const ss = gpuSink(embScalesG, 0);
		wireQ10(T.embed_tokens.q1_0, ws.push, ws.finish, ss.push, ss.finish);
		embZpG = gbuf(embZpLen);
		device.queue.writeBuffer(embZpG, 0, new Uint8Array(embZpLen + 3 & -4).fill(136));
	} else {
		embWqG = wireGpu(T.embed_tokens.weight);
		embScalesG = wireGpu(T.embed_tokens.scales);
		embZpG = wireGpu(T.embed_tokens.zp);
	}
	const tgt4G = wireGpu(manifest.luts.tgt4);
	let cosCache;
	let sinCache;
	if (T.cos_cache) {
		const cosBytes = wireCpu(T.cos_cache);
		const sinBytes = wireCpu(T.sin_cache);
		cosCache = new Float32Array(cosBytes.buffer);
		sinCache = new Float32Array(sinBytes.buffer);
		const ropePositions = cosCache.length / (ROPE_D / 2);
		if (maxSeqLen > ropePositions) throw new Error(`bitgpu: maxSeqLen ${maxSeqLen} exceeds the model's baked RoPE cache (${ropePositions} positions); lower maxSeqLen or re-export with a longer cache`);
	} else {
		const cap = A.max_positions ?? 40960;
		if (maxSeqLen > cap) throw new Error(`bitgpu: maxSeqLen ${maxSeqLen} exceeds the model's max_positions (${cap})`);
		[cosCache, sinCache] = synthRope(A, maxSeqLen, ROPE_D);
	}
	routes.sort((a, b) => a.off - b.off || a.len - b.len);
	const merged = [];
	for (const r of routes) {
		const last = merged[merged.length - 1];
		if (last && last.off === r.off && last.len === r.len) {
			const lp = last.push, lf = last.finish;
			last.push = (b) => {
				lp(b);
				r.push(b);
			};
			last.finish = () => {
				lf();
				r.finish();
			};
		} else if (last && r.off < last.off + last.len) throw new Error("bitgpu: partially overlapping data-file tensor ranges (unsupported by the streaming loader)");
		else merged.push(r);
	}
	const needed = merged.length ? merged[merged.length - 1].off + merged[merged.length - 1].len : 0;
	const reader = (opts.fetchStream ? await opts.fetchStream(dataUrl) : opts.fetchArrayBuffer ? new Response(await opts.fetchArrayBuffer(dataUrl)).body : await (async () => {
		const res = await fetch(dataUrl);
		if (!res.ok) throw new Error(`bitgpu: fetch ${dataUrl} failed: HTTP ${res.status}`);
		return res.body ?? new Response(await res.arrayBuffer()).body;
	})()).getReader();
	let cursor = 0;
	let ri = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		let bo = 0;
		while (bo < value.byteLength && ri < merged.length) {
			const r = merged[ri];
			if (cursor >= r.off + r.len) {
				ri++;
				continue;
			}
			if (cursor < r.off) {
				const skip = Math.min(r.off - cursor, value.byteLength - bo);
				cursor += skip;
				bo += skip;
				continue;
			}
			const n = Math.min(r.off + r.len - cursor, value.byteLength - bo);
			r.push(value.subarray(bo, bo + n));
			cursor += n;
			bo += n;
			if (cursor === r.off + r.len) {
				r.finish();
				ri++;
			}
		}
		cursor += value.byteLength - bo;
		opts.onProgress?.({
			phase: "weights",
			loaded: Math.min(cursor, needed),
			total: needed
		});
	}
	if (cursor < needed) throw new Error(`bitgpu: the data file ended at ${cursor} bytes but tensors extend to ${needed}; the download is truncated or the manifest does not match it`);
	for (const check of zpChecks) check();
	zpChecks.length = 0;
	aux = null;
	function embedBatch(enc, ids) {
		const idBuf = upload(new Uint32Array(ids));
		const out = actBuf(ids.length * Hd);
		const pass = enc.beginComputePass();
		run(pass, "embed_gather_batch", [
			["u", ids.length],
			["u", Hd],
			["u", 0],
			["u", 0]
		], [
			idBuf,
			embWqG,
			tgt4G,
			embScalesG,
			embZpG
		], out, ids.length * Hd);
		pass.end();
		return out;
	}
	function ropeBufs(posBase, S) {
		const D = ROPE_D, R = D / 2, cos = new Float32Array(S * D), sin = new Float32Array(S * D);
		for (let s = 0; s < S; s++) for (let d = 0; d < D; d++) {
			cos[s * D + d] = cosCache[(posBase + s) * R + d % R];
			sin[s * D + d] = sinCache[(posBase + s) * R + d % R];
		}
		const cb = actBuf(S * D), sb = actBuf(S * D);
		device.queue.writeBuffer(cb, 0, cos);
		device.queue.writeBuffer(sb, 0, sin);
		return {
			cos: cb,
			sin: sb
		};
	}
	const KV = A.kv_heads, Dh = A.head_dim, Hd = A.hidden, H = A.heads, F = A.intermediate;
	const NK = A.hybrid?.linear_key_heads ?? 0, NV = A.hybrid?.linear_value_heads ?? 0, DKV = A.hybrid?.linear_head_dim ?? 0, CONVK = A.hybrid?.conv_kernel ?? 0, KEYDIM = NK * DKV, VALDIM = NV * DKV, CONVDIM = KEYDIM * 2 + VALDIM;
	const HYBRID_SCRATCH_BUDGET = 1.25 * (1 << 30);
	const hybridScratchPerTok = (() => {
		if (!A.hybrid) return 0;
		const shared = 3 * Hd + 3 * F;
		const linear = 2 * CONVDIM + 2 * KEYDIM + 4 * VALDIM + 4 * NV + Hd;
		const full = 8 * H * Dh + 4 * KV * Dh + Hd;
		return 3 * (shared + Math.max(linear, full)) * 4;
	})();
	const PREFILL_SEG_HY = A.hybrid ? Math.max(RECUR_FLUSH, Math.min(PREFILL_SEG, Math.floor(HYBRID_SCRATCH_BUDGET / hybridScratchPerTok / RECUR_FLUSH) * RECUR_FLUSH)) : PREFILL_SEG;
	let kvCapacity = Math.min(maxSeqLen, 512);
	const Kc = [], Vc = [];
	const Ksc = [], Vsc = [];
	const kvScaleBytes = (cap) => cap * KV * (Dh / 32) * 4;
	const kvLayers = [];
	for (let li = 0; li < A.layers; li++) if (!A.hybrid || A.hybrid.layer_types[li] === "full") kvLayers.push(li);
	const linearLayers = [];
	for (let li = 0; li < A.layers; li++) if (A.hybrid && A.hybrid.layer_types[li] === "linear") linearLayers.push(li);
	const rsSz = A.hybrid ? NV * DKV * DKV * 4 : 0;
	const csSz = A.hybrid ? (CONVK - 1) * CONVDIM * 4 : 0;
	for (const li of kvLayers) {
		Kc[li] = device.createBuffer({
			size: kvCapacity * KV * Dh * KVB,
			usage: S_ | CS | CD
		});
		Vc[li] = device.createBuffer({
			size: kvCapacity * KV * Dh * KVB,
			usage: S_ | CS | CD
		});
		if (kv8) {
			Ksc[li] = device.createBuffer({
				size: kvScaleBytes(kvCapacity),
				usage: S_ | CS | CD
			});
			Vsc[li] = device.createBuffer({
				size: kvScaleBytes(kvCapacity),
				usage: S_ | CS | CD
			});
		}
	}
	const hyRS = [], hyCS = [];
	let hyPar = 0;
	if (A.hybrid) for (const li of linearLayers) {
		hyRS[li] = [device.createBuffer({
			size: rsSz,
			usage: S_ | CS | CD
		}), device.createBuffer({
			size: rsSz,
			usage: S_ | CS | CD
		})];
		hyCS[li] = [device.createBuffer({
			size: csSz,
			usage: S_ | CS | CD
		}), device.createBuffer({
			size: csSz,
			usage: S_ | CS | CD
		})];
	}
	let rollCosT = null, rollSinT = null, rollOnes = null, rollZeros = null;
	if (roll) {
		const R2 = Dh / 2;
		rollCosT = device.createBuffer({
			size: maxSeqLen * R2 * 4,
			usage: S_ | CD
		});
		rollSinT = device.createBuffer({
			size: maxSeqLen * R2 * 4,
			usage: S_ | CD
		});
		device.queue.writeBuffer(rollCosT, 0, cosCache.buffer, cosCache.byteOffset, maxSeqLen * R2 * 4);
		device.queue.writeBuffer(rollSinT, 0, sinCache.buffer, sinCache.byteOffset, maxSeqLen * R2 * 4);
		rollOnes = device.createBuffer({
			size: Dh * 4,
			usage: S_ | CD
		});
		rollZeros = device.createBuffer({
			size: Dh * 4,
			usage: S_ | CD
		});
		device.queue.writeBuffer(rollOnes, 0, new Float32Array(Dh).fill(1));
		device.queue.writeBuffer(rollZeros, 0, new Float32Array(Dh));
	}
	const loadOom = await device.popErrorScope();
	const loadVal = await device.popErrorScope();
	if (loadOom) throw new GpuOutOfMemoryError(`GPU allocation failed while loading weights (~${Math.round(weightBytes / 1048576)} MB VRAM needed): ${loadOom.message}`);
	if (loadVal) throw new Error(`bitgpu: WebGPU validation error while loading weights: ${loadVal.message}`);
	async function ensureKvCapacity(needed) {
		needed = Math.min(needed, maxSeqLen);
		if (needed <= kvCapacity) return;
		const newCap = Math.min(maxSeqLen, Math.max(needed, kvCapacity * 2));
		const copyBytes = kvCapacity * KV * Dh * KVB;
		const copyScales = kvScaleBytes(kvCapacity);
		device.pushErrorScope("out-of-memory");
		const enc = device.createCommandEncoder();
		const olds = [];
		for (const li of kvLayers) {
			const nk = device.createBuffer({
				size: newCap * KV * Dh * KVB,
				usage: S_ | CS | CD
			});
			const nv = device.createBuffer({
				size: newCap * KV * Dh * KVB,
				usage: S_ | CS | CD
			});
			enc.copyBufferToBuffer(Kc[li], 0, nk, 0, copyBytes);
			enc.copyBufferToBuffer(Vc[li], 0, nv, 0, copyBytes);
			const grp = [Kc[li], Vc[li]];
			Kc[li] = nk;
			Vc[li] = nv;
			if (kv8) {
				const nks = device.createBuffer({
					size: kvScaleBytes(newCap),
					usage: S_ | CS | CD
				});
				const nvs = device.createBuffer({
					size: kvScaleBytes(newCap),
					usage: S_ | CS | CD
				});
				enc.copyBufferToBuffer(Ksc[li], 0, nks, 0, copyScales);
				enc.copyBufferToBuffer(Vsc[li], 0, nvs, 0, copyScales);
				grp.push(Ksc[li], Vsc[li]);
				Ksc[li] = nks;
				Vsc[li] = nvs;
			}
			olds[li] = grp;
		}
		device.queue.submit([enc.finish()]);
		await device.queue.onSubmittedWorkDone();
		const oom = await device.popErrorScope();
		if (oom) {
			for (const li of kvLayers) {
				Kc[li].destroy();
				Vc[li].destroy();
				Kc[li] = olds[li][0];
				Vc[li] = olds[li][1];
				if (kv8) {
					Ksc[li].destroy();
					Vsc[li].destroy();
					Ksc[li] = olds[li][2];
					Vsc[li] = olds[li][3];
				}
			}
			poolInvalidate();
			throw new GpuOutOfMemoryError(`KV cache growth to ${newCap} positions failed: ${oom.message}`);
		}
		for (const li of kvLayers) for (const b of olds[li]) b.destroy();
		kvCapacity = newCap;
		poolInvalidate();
	}
	let evictScratch = null;
	function evict(fill, need) {
		const recent = fill - SINKS;
		const batch = Math.min(recent, Math.max(need, Math.ceil((maxSeqLen - SINKS) / 4)));
		const keep = recent - batch;
		if (keep <= 0) return SINKS;
		const rowK = KV * Dh * KVB;
		const rowS = kv8 ? KV * (Dh / 32) * 4 : 0;
		if (!evictScratch || evictScratch.size < keep * rowK) {
			evictScratch?.destroy();
			evictScratch = device.createBuffer({
				size: keep * rowK,
				usage: CS | CD
			});
		}
		const enc = device.createCommandEncoder();
		const groups = [];
		for (const li of kvLayers) {
			groups.push([Kc[li], rowK], [Vc[li], rowK]);
			if (kv8) groups.push([Ksc[li], rowS], [Vsc[li], rowS]);
		}
		for (const [buf, row] of groups) {
			enc.copyBufferToBuffer(buf, (SINKS + batch) * row, evictScratch, 0, keep * row);
			enc.copyBufferToBuffer(evictScratch, 0, buf, SINKS * row, keep * row);
		}
		device.queue.submit([enc.finish()]);
		return SINKS + keep;
	}
	const evictFor = (fill, n) => roll && fill + n > maxSeqLen ? evict(fill, fill + n - maxSeqLen) : fill;
	async function readback(buf, n) {
		const rb = device.createBuffer({
			size: n * 4,
			usage: GPUBufferUsage.MAP_READ | CD
		});
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(buf, 0, rb, 0, n * 4);
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const out = new Float32Array(rb.getMappedRange().slice(0));
		rb.unmap();
		rb.destroy();
		return out;
	}
	async function readbackU32(buf, n) {
		const rb = device.createBuffer({
			size: n * 4,
			usage: GPUBufferUsage.MAP_READ | CD
		});
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(buf, 0, rb, 0, n * 4);
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const out = new Uint32Array(rb.getMappedRange().slice(0));
		rb.unmap();
		rb.destroy();
		return out;
	}
	let FULL = null;
	let TS_PROFILE = false;
	let _tsQ = null;
	let _tsResolve = null;
	let _tsRead = null;
	const tsQ = () => _tsQ ??= device.createQuerySet({
		type: "timestamp",
		count: 2
	});
	const tsResolveBuf = () => _tsResolve ??= device.createBuffer({
		size: 16,
		usage: GPUBufferUsage.QUERY_RESOLVE | CS
	});
	const tsReadBuf = () => _tsRead ??= device.createBuffer({
		size: 16,
		usage: GPUBufferUsage.MAP_READ | CD
	});
	const isFull = (name) => FULL === null || FULL.has(name) || name === "embed_gather_batch";
	let FORCE_SLOW = false;
	let SMALLM = 0;
	let DBG0 = null;
	const cap = (li, name, buf) => {
		if (li === 0 && DBG0) DBG0[name] = buf;
	};
	function setup(pass, name, fields, ins, outs) {
		pass.setPipeline(pipelines[name]);
		if (pool) {
			let slot = pool.disp[dispIdx];
			if (!slot) {
				slot = {
					uni: device.createBuffer({
						size: 64,
						usage: U | CD
					}),
					bg: null,
					last: null,
					bufs: null
				};
				pool.disp[dispIdx] = slot;
			}
			const data2 = makeParams(fields);
			if (!slot.last || !eqBytes(slot.last, data2)) {
				device.queue.writeBuffer(slot.uni, 0, data2);
				slot.last = data2.slice();
			}
			if (slot.bg && slot.bufs) {
				const nb = ins.length + outs.length;
				if (slot.bufs.length !== nb) slot.bg = null;
				else {
					for (let i = 0; i < ins.length; i++) if (slot.bufs[i] !== ins[i]) {
						slot.bg = null;
						break;
					}
					if (slot.bg) {
						for (let i = 0; i < outs.length; i++) if (slot.bufs[ins.length + i] !== outs[i]) {
							slot.bg = null;
							break;
						}
					}
				}
			}
			if (!slot.bg) {
				const entries = [{
					binding: 0,
					resource: { buffer: slot.uni }
				}];
				ins.forEach((b, i) => entries.push({
					binding: i + 1,
					resource: { buffer: b }
				}));
				outs.forEach((b, i) => entries.push({
					binding: 1 + ins.length + i,
					resource: { buffer: b }
				}));
				slot.bg = device.createBindGroup({
					layout: pipelines[name].getBindGroupLayout(0),
					entries
				});
				slot.bufs = [...ins, ...outs];
			}
			pass.setBindGroup(0, slot.bg);
			dispIdx++;
		} else {
			const entries = [{
				binding: 0,
				resource: { buffer: upload(makeParams(fields), U | CD) }
			}];
			ins.forEach((b, i) => entries.push({
				binding: i + 1,
				resource: { buffer: b }
			}));
			outs.forEach((b, i) => entries.push({
				binding: 1 + ins.length + i,
				resource: { buffer: b }
			}));
			pass.setBindGroup(0, device.createBindGroup({
				layout: pipelines[name].getBindGroupLayout(0),
				entries
			}));
		}
	}
	const grid2d = (wg) => {
		const y = Math.ceil(wg / 65535);
		return [Math.ceil(wg / y), y];
	};
	function runIO(pass, name, fields, ins, outs, threads) {
		setup(pass, name, fields, ins, outs);
		if (!isFull(name)) return void pass.dispatchWorkgroups(1);
		const [x, y] = grid2d(Math.ceil(threads / 64));
		pass.dispatchWorkgroups(x, y, 1);
	}
	const run = (pass, name, fields, ins, out, threads) => runIO(pass, name, fields, ins, [out], threads);
	function runN(pass, name, fields, ins, out, nWG) {
		setup(pass, name, fields, ins, [out]);
		pass.dispatchWorkgroups(isFull(name) ? nWG : 1);
	}
	function runWG(pass, name, fields, ins, outs, wgX, wgY) {
		setup(pass, name, fields, ins, outs);
		const f = isFull(name);
		pass.dispatchWorkgroups(f ? wgX : 1, f ? wgY : 1, 1);
	}
	const rms = (pass, x, g, R, Dn, out, out16 = false) => out16 ? runN(pass, "rmsnorm_sg_af16", [
		["u", R],
		["u", Dn],
		["f", A.rms_eps],
		["u", 0]
	], [x, W[g].buf], out, R) : useSG ? runN(pass, "rmsnorm_sg", [
		["u", R],
		["u", Dn],
		["f", A.rms_eps],
		["u", 0]
	], [x, W[g].buf], out, R) : runN(pass, "rmsnorm_wg", [
		["u", R],
		["u", Dn],
		["f", A.rms_eps],
		["u", 0]
	], [x, W[g].buf], out, R);
	function fusedMM(pass, w, inBuf, S, outs, af = false) {
		const Ntot = w.N0 + w.N1 + w.N2;
		if (useSG && S === 1) {
			const gx = Math.min(Ntot, 65535);
			runWG(pass, af ? "matmul_split_sg_af16" : "matmul_split_sg", [
				["u", w.K],
				["u", w.nb],
				["u", w.N0],
				["u", w.N1],
				["u", w.N2],
				["u", gx]
			], [
				inBuf,
				w.sign,
				w.scales
			], outs, gx, Math.ceil(Ntot / gx));
		} else if (S === 1) {
			const gx = Math.min(Ntot, 65535);
			runWG(pass, "matmul_split_wg", [
				["u", w.K],
				["u", w.nb],
				["u", w.N0],
				["u", w.N1],
				["u", w.N2],
				["u", gx]
			], [
				inBuf,
				w.sign,
				w.scales
			], outs, gx, Math.ceil(Ntot / gx));
		} else if (useSG && S === SMALLM) {
			const gx = Math.min(Ntot, 65535);
			runWG(pass, "matmul_split_sm", [
				["u", w.K],
				["u", w.nb],
				["u", w.N0],
				["u", w.N1],
				["u", w.N2],
				["u", gx],
				["u", S]
			], [
				inBuf,
				w.sign,
				w.scales
			], outs, gx, Math.ceil(Ntot / gx));
		} else if (tiledPrefill(S)) runWG(pass, "matmul_split_tiled", [
			["u", S],
			["u", w.K],
			["u", w.nb],
			["u", w.N0],
			["u", w.N1],
			["u", w.N2]
		], [
			inBuf,
			w.sign,
			w.scales
		], outs, Math.ceil(Ntot / 64), Math.ceil(S / 64));
		else runIO(pass, "matmul_split", [
			["u", S],
			["u", w.K],
			["u", w.nb],
			["u", w.N0],
			["u", w.N1],
			["u", w.N2]
		], [
			inBuf,
			w.sign,
			w.scales
		], outs, S * Ntot);
	}
	function residMM(pass, w, inBuf, resid, S, out, in16 = false) {
		if (useSG && S === 1) {
			const nwg = Math.ceil(w.N / ROWS_MR);
			const gx = Math.min(nwg, 65535);
			runWG(pass, in16 ? "matmul_resid_mr_sg_af16" : "matmul_resid_mr_sg", [
				["u", w.N],
				["u", w.K],
				["u", w.nb],
				["u", gx],
				["u", 0],
				["u", 0]
			], [
				inBuf,
				w.sign,
				w.scales,
				resid
			], [out], gx, Math.ceil(nwg / gx));
		} else if (S === 1) {
			const gx = Math.min(w.N, 65535);
			runWG(pass, "matmul_resid_wg", [
				["u", w.N],
				["u", w.K],
				["u", w.nb],
				["u", gx],
				["u", 0],
				["u", 0]
			], [
				inBuf,
				w.sign,
				w.scales,
				resid
			], [out], gx, Math.ceil(w.N / gx));
		} else if (useSG && S === SMALLM) {
			const gx = Math.min(w.N, 65535);
			runWG(pass, "matmul_resid_sm", [
				["u", w.N],
				["u", w.K],
				["u", w.nb],
				["u", gx],
				["u", S],
				["u", 0]
			], [
				inBuf,
				w.sign,
				w.scales,
				resid
			], [out], gx, Math.ceil(w.N / gx));
		} else if (tiledPrefill(S)) runWG(pass, "matmul_resid_tiled", [
			["u", S],
			["u", w.N],
			["u", w.K],
			["u", w.nb],
			["u", 0],
			["u", 0]
		], [
			inBuf,
			w.sign,
			w.scales,
			resid
		], [out], Math.ceil(w.N / 64), Math.ceil(S / 64));
		else runIO(pass, "matmul_resid", [
			["u", S],
			["u", w.N],
			["u", w.K],
			["u", w.nb],
			["u", 128],
			["u", 0]
		], [
			inBuf,
			w.sign,
			w.scales,
			resid
		], [out], S * w.N);
	}
	function appendKV(pass, src, which, li, rows, dstRow0) {
		const data = which === 0 ? Kc[li] : Vc[li];
		if (kv8) {
			setup(pass, "copy_kv8", [
				["u", rows],
				["u", Dh],
				["u", dstRow0],
				["u", 0]
			], [src], [data, which === 0 ? Ksc[li] : Vsc[li]]);
			pass.dispatchWorkgroups(isFull("copy_kv8") ? rows : 1);
		} else run(pass, COPY_KV, [
			["u", rows * Dh],
			["u", dstRow0 * Dh],
			["u", 0],
			["u", 0]
		], [src], data, rows * Dh);
	}
	const attIns = (qr, li) => {
		const ins = kv8 ? [
			qr,
			Kc[li],
			Vc[li],
			Ksc[li],
			Vsc[li]
		] : [
			qr,
			Kc[li],
			Vc[li]
		];
		if (roll) ins.push(rollCosT, rollSinT);
		return ins;
	};
	function hybridLayer(pass, li, h, S, posBase, cos, sin) {
		const hy = manifest.arch.hybrid;
		const w = (r) => W[`layers.${li}.${r}`];
		const ls = posBase > 0 ? 1 : 0;
		const par = hyPar;
		const af = actF16 && S === 1 && !FORCE_SLOW;
		const n1 = af ? actBuf16(S * Hd) : actBuf(S * Hd);
		rms(pass, h, `layers.${li}.input_layernorm`, S, Hd, n1, af);
		let h2;
		if (hy.layer_types[li] === "linear") {
			const mixed = actBuf(S * CONVDIM);
			fusedMM(pass, w("linear.in_qkv"), n1, S, [
				mixed,
				dummy,
				dummy2
			], af);
			const convd = actBuf(S * CONVDIM);
			const cvSt = (CONVK - 1) * CONVDIM;
			setup(pass, "conv1d_causal", [
				["u", S],
				["u", CONVDIM],
				["u", CONVK],
				["u", ls]
			], [
				mixed,
				w("linear.conv1d").buf,
				hyCS[li][par]
			], [convd, hyCS[li][par ^ 1]]);
			{
				const [gx, gy] = grid2d(Math.ceil((S * CONVDIM + cvSt) / 64));
				pass.dispatchWorkgroups(gx, gy, 1);
			}
			const q = actBuf(S * KEYDIM), k = actBuf(S * KEYDIM), v = actBuf(S * VALDIM);
			run(pass, "slice_cols", [
				["u", S],
				["u", KEYDIM],
				["u", CONVDIM],
				["u", 0]
			], [convd], q, S * KEYDIM);
			run(pass, "slice_cols", [
				["u", S],
				["u", KEYDIM],
				["u", CONVDIM],
				["u", KEYDIM]
			], [convd], k, S * KEYDIM);
			run(pass, "slice_cols", [
				["u", S],
				["u", VALDIM],
				["u", CONVDIM],
				["u", 2 * KEYDIM]
			], [convd], v, S * VALDIM);
			const a = actBuf(S * NV), b = actBuf(S * NV);
			fusedMM(pass, w("linear.a"), n1, S, [
				a,
				dummy,
				dummy2
			], af);
			fusedMM(pass, w("linear.b"), n1, S, [
				b,
				dummy,
				dummy2
			], af);
			const gb = actBuf(2 * S * NV);
			run(pass, "deltanet_gbeta", [
				["u", S],
				["u", NV],
				["u", 0],
				["u", 0]
			], [
				a,
				b,
				w("linear.A_log").buf,
				w("linear.dt_bias").buf
			], gb, S * NV);
			const core = actBuf(S * VALDIM);
			{
				const sizes = [];
				if (Math.ceil(S / RECUR_FLUSH) % 2 === 0) sizes.push(RECUR_FLUSH / 2, RECUR_FLUSH / 2);
				for (let r = S - sizes.reduce((a, b) => a + b, 0); r > 0; r -= RECUR_FLUSH) sizes.push(Math.min(r, RECUR_FLUSH));
				let off = 0;
				for (let c = 0; c < sizes.length; c++) {
					const cin = hyRS[li][par ^ c & 1];
					const cout = hyRS[li][par ^ (c & 1 ^ 1)];
					setup(pass, "deltanet_recur", [
						["u", sizes[c]],
						["u", NV],
						["u", DKV],
						["u", DKV],
						["u", NK],
						["u", S * NV],
						["u", c === 0 ? ls : 1],
						["u", off]
					], [
						q,
						k,
						v,
						gb,
						gb,
						cin
					], [core, cout]);
					pass.dispatchWorkgroups(NV);
					off += sizes[c];
				}
			}
			const z = actBuf(S * VALDIM);
			fusedMM(pass, w("linear.z"), n1, S, [
				z,
				dummy,
				dummy2
			], af);
			const normed = actBuf(S * VALDIM);
			runN(pass, "deltanet_norm_gate", [
				["u", S * NV],
				["u", DKV],
				["f", A.rms_eps],
				["u", 0]
			], [
				core,
				z,
				w("linear.norm").buf
			], normed, S * NV);
			h2 = actBuf(S * Hd);
			residMM(pass, w("linear.out_proj"), normed, h, S, h2);
		} else {
			const qg = actBuf(S * H * Dh * 2);
			fusedMM(pass, w("attn.q_proj"), n1, S, [
				qg,
				dummy,
				dummy2
			], af);
			const query = actBuf(S * H * Dh), gate = actBuf(S * H * Dh);
			run(pass, "split_head", [
				["u", S],
				["u", H],
				["u", Dh],
				["u", 0]
			], [qg], query, S * H * Dh);
			run(pass, "split_head", [
				["u", S],
				["u", H],
				["u", Dh],
				["u", Dh]
			], [qg], gate, S * H * Dh);
			const qn = actBuf(S * H * Dh), qr = actBuf(S * H * Dh);
			rms(pass, query, `layers.${li}.attn.q_norm`, S * H, Dh, qn);
			run(pass, "rope_partial", [
				["u", S],
				["u", H],
				["u", Dh],
				["u", ROPE_D]
			], [
				qn,
				cos,
				sin
			], qr, S * H * Dh);
			const kk = actBuf(S * KV * Dh);
			fusedMM(pass, w("attn.k_proj"), n1, S, [
				kk,
				dummy,
				dummy2
			], af);
			const kn = actBuf(S * KV * Dh), kr = actBuf(S * KV * Dh);
			rms(pass, kk, `layers.${li}.attn.k_norm`, S * KV, Dh, kn);
			run(pass, "rope_partial", [
				["u", S],
				["u", KV],
				["u", Dh],
				["u", ROPE_D]
			], [
				kn,
				cos,
				sin
			], kr, S * KV * Dh);
			const vv = actBuf(S * KV * Dh);
			fusedMM(pass, w("attn.v_proj"), n1, S, [
				vv,
				dummy,
				dummy2
			], af);
			appendKV(pass, kr, 0, li, S * KV, posBase * KV);
			appendKV(pass, vv, 1, li, S * KV, posBase * KV);
			const att = actBuf(S * H * Dh);
			const aP = [
				["u", S],
				["u", H],
				["u", KV],
				["u", Dh],
				["f", 1 / Math.sqrt(Dh)],
				["u", posBase],
				["u", 0],
				["u", 0]
			];
			if (kv8) runN(pass, "attention_online_cache_kv8", aP, [
				qr,
				Kc[li],
				Ksc[li],
				Vc[li],
				Vsc[li]
			], att, S * H);
			else runN(pass, "attention_online_cache", aP, [
				qr,
				Kc[li],
				Vc[li]
			], att, S * H);
			const gated = actBuf(S * H * Dh);
			run(pass, "gate_sigmoid", [
				["u", S * H * Dh],
				["u", 0],
				["u", 0],
				["u", 0]
			], [att, gate], gated, S * H * Dh);
			h2 = actBuf(S * Hd);
			residMM(pass, w("attn.o_proj"), gated, h, S, h2);
		}
		const n2 = af ? actBuf16(S * Hd) : actBuf(S * Hd);
		rms(pass, h2, `layers.${li}.post_attention_layernorm`, S, Hd, n2, af);
		const g = actBuf(S * F), u = actBuf(S * F);
		fusedMM(pass, w("mlp.gate_proj"), n2, S, [
			g,
			dummy,
			dummy2
		], af);
		fusedMM(pass, w("mlp.up_proj"), n2, S, [
			u,
			dummy,
			dummy2
		], af);
		const sw = actBuf(S * F);
		run(pass, "swiglu", [
			["u", S * F],
			["u", 0],
			["u", 0],
			["u", 0]
		], [g, u], sw, S * F);
		const hn = actBuf(S * Hd);
		residMM(pass, w("mlp.down_proj"), sw, h2, S, hn);
		return hn;
	}
	function layer(pass, li, h, S, posBase, cos, sin) {
		const Ltot = posBase + S;
		if (manifest.arch.hybrid) return hybridLayer(pass, li, h, S, posBase, cos, sin);
		const af = actF16 && S === 1 && !FORCE_SLOW;
		const n1 = af ? actBuf16(Hd) : actBuf(S * Hd);
		rms(pass, h, `layers.${li}.input_layernorm`, S, Hd, n1, af);
		const qkv = W[`layers.${li}.attn.qkv`];
		if (useSG && S === 1 && !FORCE_SLOW) {
			const q = actBuf(H * Dh), k = actBuf(KV * Dh), v = actBuf(KV * Dh);
			const Ntot = qkv.N0 + qkv.N1 + qkv.N2, gx = Math.min(Ntot, 65535);
			runWG(pass, af ? "matmul_split_sg_af16" : "matmul_split_sg", [
				["u", qkv.K],
				["u", qkv.nb],
				["u", qkv.N0],
				["u", qkv.N1],
				["u", qkv.N2],
				["u", gx]
			], [
				n1,
				qkv.sign,
				qkv.scales
			], [
				q,
				k,
				v
			], gx, Math.ceil(Ntot / gx));
			appendKV(pass, v, 1, li, KV, posBase * KV);
			const qr = actBuf(H * Dh);
			runN(pass, "rmsnorm_rope_sg", [
				["u", H],
				["u", Dh],
				["f", A.rms_eps],
				["u", 0],
				["u", Dh],
				["u", 0]
			], [
				q,
				W[`layers.${li}.attn.q_norm`].buf,
				cos,
				sin
			], qr, H);
			const kcos = roll ? rollOnes : cos, ksin = roll ? rollZeros : sin;
			if (kv8) {
				setup(pass, "rmsnorm_rope_sg_kv8", [
					["u", KV],
					["u", Dh],
					["f", A.rms_eps],
					["u", posBase * KV],
					["u", 0],
					["u", 0]
				], [
					k,
					W[`layers.${li}.attn.k_norm`].buf,
					kcos,
					ksin
				], [Kc[li], Ksc[li]]);
				pass.dispatchWorkgroups(isFull("rmsnorm_rope_sg_kv8") ? KV : 1);
			} else runN(pass, ROPE_K, [
				["u", KV],
				["u", Dh],
				["f", A.rms_eps],
				["u", posBase * KV * Dh],
				["u", Dh],
				["u", 0]
			], [
				k,
				W[`layers.${li}.attn.k_norm`].buf,
				kcos,
				ksin
			], Kc[li], KV);
			cap(li, "qr", qr);
			const att = actBuf(H * Dh);
			runN(pass, ATT, [
				["u", 1],
				["u", H],
				["u", KV],
				["u", Dh],
				["u", posBase],
				["u", Ltot]
			], attIns(qr, li), att, H);
			cap(li, "att", att);
			const o = W[`layers.${li}.attn.o_proj`], h2 = actBuf(Hd);
			residMM(pass, o, att, h, 1, h2);
			const n2 = af ? actBuf16(Hd) : actBuf(Hd);
			rms(pass, h2, `layers.${li}.post_attention_layernorm`, 1, Hd, n2, af);
			const gu = W[`layers.${li}.mlp.gateup`], sw = af ? actBuf16(F) : actBuf(F), nwgF = Math.ceil(F / ROWS_MR), gxF = Math.min(nwgF, 65535);
			runWG(pass, af ? "matmul_swiglu_mr_sg_af16" : "matmul_swiglu_mr_sg", [
				["u", gu.K],
				["u", gu.nb],
				["u", F],
				["u", gxF],
				["u", 0],
				["u", 0]
			], [
				n2,
				gu.sign,
				gu.scales
			], [sw], gxF, Math.ceil(nwgF / gxF));
			cap(li, "sw", sw);
			const d = W[`layers.${li}.mlp.down_proj`], hn = actBuf(Hd);
			residMM(pass, d, sw, h2, 1, hn, af);
			return hn;
		}
		const q = actBuf(S * H * Dh), k = actBuf(S * KV * Dh), v = actBuf(S * KV * Dh);
		fusedMM(pass, qkv, n1, S, [
			q,
			k,
			v
		]);
		const qn = actBuf(S * H * Dh), kn = actBuf(S * KV * Dh);
		rms(pass, q, `layers.${li}.attn.q_norm`, S * H, Dh, qn);
		rms(pass, k, `layers.${li}.attn.k_norm`, S * KV, Dh, kn);
		const qr = actBuf(S * H * Dh), kr = actBuf(S * KV * Dh);
		run(pass, "rope", [
			["u", S],
			["u", H],
			["u", Dh],
			["u", 0]
		], [
			qn,
			cos,
			sin
		], qr, S * H * Dh);
		if (!roll) run(pass, "rope", [
			["u", S],
			["u", KV],
			["u", Dh],
			["u", 0]
		], [
			kn,
			cos,
			sin
		], kr, S * KV * Dh);
		appendKV(pass, roll ? kn : kr, 0, li, S * KV, posBase * KV);
		appendKV(pass, v, 1, li, S * KV, posBase * KV);
		cap(li, "qr", qr);
		const att = actBuf(S * H * Dh);
		runN(pass, ATT, [
			["u", S],
			["u", H],
			["u", KV],
			["u", Dh],
			["u", posBase],
			["u", Ltot]
		], attIns(qr, li), att, S * H);
		cap(li, "att", att);
		const o = W[`layers.${li}.attn.o_proj`], h2 = actBuf(S * Hd);
		residMM(pass, o, att, h, S, h2);
		const n2 = actBuf(S * Hd);
		rms(pass, h2, `layers.${li}.post_attention_layernorm`, S, Hd, n2);
		const gu = W[`layers.${li}.mlp.gateup`], g = actBuf(S * F), u = actBuf(S * F);
		fusedMM(pass, gu, n2, S, [
			g,
			u,
			dummy
		]);
		const sw = actBuf(S * F);
		run(pass, "swiglu", [
			["u", S * F],
			["u", 0],
			["u", 0],
			["u", 0]
		], [g, u], sw, S * F);
		cap(li, "sw", sw);
		const d = W[`layers.${li}.mlp.down_proj`], hn = actBuf(S * Hd);
		residMM(pass, d, sw, h2, S, hn);
		return hn;
	}
	function lmHead(pass, fn, M, out) {
		const lm = W.lm_head;
		if (useSG && M === 1) {
			const gx = Math.min(lm.N, 65535);
			runWG(pass, "matmul_q2_sg", [
				["u", lm.N],
				["u", lm.K],
				["u", lm.nb],
				["u", lm.zp],
				["u", gx],
				["u", 0]
			], [
				fn,
				lm.codes,
				lm.scales
			], [out], gx, Math.ceil(lm.N / gx));
		} else if (M === 1) {
			const gx = Math.min(lm.N, 65535);
			runWG(pass, "matmul_q2_wg", [
				["u", lm.N],
				["u", lm.K],
				["u", lm.nb],
				["u", lm.zp],
				["u", gx],
				["u", 0]
			], [
				fn,
				lm.codes,
				lm.scales
			], [out], gx, Math.ceil(lm.N / gx));
		} else if (useSG && M === SMALLM) {
			const gx = Math.min(lm.N, 65535);
			runWG(pass, "matmul_q2_sm", [
				["u", lm.N],
				["u", lm.K],
				["u", lm.nb],
				["u", lm.zp],
				["u", gx],
				["u", M]
			], [
				fn,
				lm.codes,
				lm.scales
			], [out], gx, Math.ceil(lm.N / gx));
		} else run(pass, "matmul_q2", [
			["u", M],
			["u", lm.N],
			["u", lm.K],
			["u", lm.nb],
			["u", 128],
			["u", lm.zp]
		], [
			fn,
			lm.codes,
			lm.scales
		], out, M * lm.N);
	}
	function stack(enc, h, S, posBase) {
		const { cos, sin } = ropeBufs(posBase, S);
		const pass = enc.beginComputePass();
		const useArena = !pool && !DBG0;
		let layer0 = null;
		let cur = h;
		if (useArena) arena = arena ?? /* @__PURE__ */ new Map();
		for (let li = 0; li < A.layers; li++) {
			const mine = [];
			if (useArena) arenaCur = mine;
			const inH = cur;
			cur = layer(pass, li, inH, S, posBase, cos, sin);
			if (li === 0) layer0 = cur;
			if (useArena) {
				arenaCur = null;
				for (const b of mine) if (b !== cur) arenaFree(b);
				if (inH !== h && inH !== layer0) arenaFree(inH);
			}
		}
		if (A.hybrid) hyPar ^= 1;
		const fn = actBuf(S * Hd);
		rms(pass, cur, FINAL_NORM, S, Hd, fn);
		pass.end();
		arena = null;
		return {
			fn,
			layer0
		};
	}
	async function forward(ids) {
		const S = ids.length;
		if (S === 0) throw new Error("forward: no tokens to process");
		if (S > maxSeqLen) throw new Error(`forward: sequence length ${S} exceeds maxSeqLen ${maxSeqLen}`);
		fullHistory = [];
		cacheLen = 0;
		await ensureKvCapacity(S);
		const vocab = W.lm_head.N;
		const embed = new Float32Array(S * Hd), layer0 = new Float32Array(S * Hd), finalnorm = new Float32Array(S * Hd), logits = new Float32Array(S * vocab);
		transients = [];
		const prefillSeg = Math.min((globalThis.__SEG ?? 0) || PREFILL_SEG_HY, 32);
		try {
			for (let off = 0; off < S; off += prefillSeg) {
				const seg = ids.slice(off, off + prefillSeg);
				const enc = device.createCommandEncoder();
				const embedOut = embedBatch(enc, seg);
				const { fn, layer0: l0 } = stack(enc, embedOut, seg.length, off);
				const lg = device.createBuffer({
					size: seg.length * vocab * 4,
					usage: S_ | CS
				});
				transients.push(lg);
				const pass = enc.beginComputePass();
				lmHead(pass, fn, seg.length, lg);
				pass.end();
				device.queue.submit([enc.finish()]);
				await device.queue.onSubmittedWorkDone();
				embed.set(await readback(embedOut, seg.length * Hd), off * Hd);
				layer0.set(await readback(l0, seg.length * Hd), off * Hd);
				finalnorm.set(await readback(fn, seg.length * Hd), off * Hd);
				logits.set(await readback(lg, seg.length * vocab), off * vocab);
				flushTransients();
			}
			return {
				embed,
				layer0,
				finalnorm,
				logits,
				vocab,
				sequenceLength: S
			};
		} finally {
			flushTransients();
			transients = null;
		}
	}
	async function runPrefill(ids, posBase, signal) {
		let fn = null;
		let lastRow = 0;
		const prefillSeg = (globalThis.__SEG ?? 0) || PREFILL_SEG_HY;
		for (let off = 0; off < ids.length; off += prefillSeg) {
			if (off > 0 && signal?.aborted) {
				fullHistory = [];
				cacheLen = 0;
				return null;
			}
			const seg = ids.slice(off, off + prefillSeg);
			device.pushErrorScope("out-of-memory");
			const enc = device.createCommandEncoder();
			fn = stack(enc, embedBatch(enc, seg), seg.length, posBase + off).fn;
			lastRow = seg.length - 1;
			device.queue.submit([enc.finish()]);
			if (await device.popErrorScope()) throw new Error(`bitgpu: GPU out of memory during prefill (segment of ${seg.length} tokens at position ${posBase + off}) - the output would have been silently corrupted. Lower maxSeqLen, use kvCache: 'q8', or free GPU memory.`);
			if (off + prefillSeg < ids.length) {
				await device.queue.onSubmittedWorkDone();
				flushTransients();
			}
		}
		return {
			fn,
			lastRow
		};
	}
	async function generateImpl(ids, posBase, nTokens, full = null, syncN = SYNC_N, ctl) {
		await ensureKvCapacity(posBase + ids.length + nTokens);
		FULL = full;
		const vocab = W.lm_head.N;
		const tokBuf = device.createBuffer({
			size: Math.max(1, nTokens) * 4,
			usage: S_ | CS
		});
		const embG = device.createBuffer({
			size: Hd * 4,
			usage: S_ | CS | CD
		});
		const lg = device.createBuffer({
			size: vocab * 4,
			usage: S_ | CS
		});
		transients = [];
		try {
			const t0 = performance.now();
			const pfx = await runPrefill(ids, posBase, ctl?.signal);
			if (!pfx) return {
				prefillMs: performance.now() - t0,
				decodeMs: 0,
				tokPerSec: 0,
				tokens: [],
				firstArgmax: -1,
				recMs: 0,
				gpuMs: 0,
				rbMs: 0
			};
			const encP = device.createCommandEncoder();
			const lastP = actBuf(Hd);
			encP.copyBufferToBuffer(pfx.fn, pfx.lastRow * Hd * 4, lastP, 0, Hd * 4);
			let pp = encP.beginComputePass();
			lmHead(pp, lastP, 1, lg);
			pp.end();
			pp = encP.beginComputePass();
			runN(pp, "argmax", [
				["u", vocab],
				["u", 0],
				["u", 0],
				["u", 0]
			], [lg], tokBuf, 1);
			pp.end();
			device.queue.submit([encP.finish()]);
			await device.queue.onSubmittedWorkDone();
			const firstTok = (await readbackU32(tokBuf, 1))[0];
			flushTransients();
			const prefillMs = performance.now() - t0;
			const gen = [];
			let recMs = 0, gpuMs = 0, rbMs = 0, tsNs = 0;
			const tsOn = TS_PROFILE && hasTS;
			const t1 = performance.now();
			let total = 1;
			const stopSet = ctl?.stopTokens ? new Set(ctl.stopTokens) : null;
			let stopped = stopSet?.has(firstTok) ?? false;
			if (!stopped) {
				gen.push(firstTok);
				ctl?.onToken?.(firstTok);
			}
			poolInvalidate();
			let slot = posBase + ids.length;
			while (total < nTokens && !stopped) {
				if (ctl?.signal?.aborted) break;
				const batch = Math.min(syncN, nTokens - total);
				slot = evictFor(slot, batch);
				poolUse("decode");
				let t = performance.now();
				const enc = device.createCommandEncoder();
				for (let j = 0; j < batch; j++) {
					const idxOut = total + j, pos = slot + j;
					let pass = enc.beginComputePass(tsOn && j === 0 ? { timestampWrites: {
						querySet: tsQ(),
						beginningOfPassWriteIndex: 0
					} } : void 0);
					runN(pass, "embed_gather", [
						["u", Hd],
						["u", idxOut - 1],
						["u", 0],
						["u", 0]
					], [
						tokBuf,
						embWqG,
						tgt4G,
						embScalesG,
						embZpG
					], embG, 1);
					pass.end();
					const r = stack(enc, embG, 1, pos);
					const last = actBuf(Hd);
					enc.copyBufferToBuffer(r.fn, 0, last, 0, Hd * 4);
					pass = enc.beginComputePass(tsOn && j === batch - 1 ? { timestampWrites: {
						querySet: tsQ(),
						endOfPassWriteIndex: 1
					} } : void 0);
					lmHead(pass, last, 1, lg);
					runN(pass, "argmax", [
						["u", vocab],
						["u", idxOut],
						["u", 0],
						["u", 0]
					], [lg], tokBuf, 1);
					pass.end();
				}
				if (tsOn) {
					enc.resolveQuerySet(tsQ(), 0, 2, tsResolveBuf(), 0);
					enc.copyBufferToBuffer(tsResolveBuf(), 0, tsReadBuf(), 0, 16);
				}
				device.queue.submit([enc.finish()]);
				recMs += performance.now() - t;
				t = performance.now();
				await device.queue.onSubmittedWorkDone();
				gpuMs += performance.now() - t;
				if (tsOn) {
					await tsReadBuf().mapAsync(GPUMapMode.READ);
					const ticks = new BigUint64Array(tsReadBuf().getMappedRange());
					tsNs += Number(ticks[1] - ticks[0]);
					tsReadBuf().unmap();
				}
				t = performance.now();
				const toks = await readbackU32(tokBuf, total + batch);
				rbMs += performance.now() - t;
				let fed = batch;
				for (let j = 0; j < batch; j++) {
					const tk = toks[total + j];
					if (stopSet?.has(tk)) {
						stopped = true;
						fed = j;
						break;
					}
					gen.push(tk);
					ctl?.onToken?.(tk);
				}
				total += batch;
				slot += fed;
			}
			cacheLen = slot;
			const decodeMs = performance.now() - t1, nd = Math.max(1, gen.length - 1);
			return {
				prefillMs,
				decodeMs,
				tokPerSec: nd / (decodeMs / 1e3),
				tokens: gen,
				firstArgmax: firstTok,
				recMs: recMs / nd,
				gpuMs: gpuMs / nd,
				rbMs: rbMs / nd,
				tsMs: tsOn ? tsNs / 1e6 / nd : 0
			};
		} finally {
			poolUse(null);
			FULL = null;
			flushTransients();
			transients = null;
			tokBuf.destroy();
			embG.destroy();
			lg.destroy();
		}
	}
	async function generateSampledImpl(ids, posBase, nTokens, genOpts, history, rngIn) {
		await ensureKvCapacity(posBase + ids.length + nTokens);
		const sampled = genOpts.temperature != null && genOpts.temperature > 0 && genOpts.temperature !== 1;
		const vocab = W.lm_head.N;
		const K = Math.max(1, Math.min(genOpts.topK ?? 20, vocab));
		const lpN = Math.max(0, Math.min(Math.floor(genOpts.logprobs ?? 0), 32, vocab));
		const KT = Math.max(K, lpN);
		const temperature = genOpts.temperature ?? 1;
		const penalty = genOpts.repetitionPenalty ?? 1;
		const presence = genOpts.presencePenalty ?? 0;
		const topP = genOpts.topP ?? 1;
		const minP = genOpts.minP ?? 0;
		const ngramN = genOpts.noRepeatNgramSize ?? 0;
		const dryO = (genOpts.dryMultiplier ?? 0) > 0 ? {
			multiplier: genOpts.dryMultiplier,
			base: genOpts.dryBase ?? 1.75,
			allowedLength: genOpts.dryAllowedLength ?? 2,
			range: genOpts.dryRange ?? 0,
			breakers: new Set(genOpts.dryBreakers ?? [])
		} : null;
		const topNS = genOpts.topNSigma ?? 0;
		const stopSet = genOpts.stopTokens ? new Set(genOpts.stopTokens) : null;
		const onToken = genOpts.onToken;
		const signal = genOpts.signal;
		const rng = rngIn ?? new MT19937(genOpts.seed);
		const tokBuf = device.createBuffer({
			size: Math.max(1, nTokens) * 4,
			usage: S_ | CS | CD
		});
		const lg = device.createBuffer({
			size: vocab * 4,
			usage: S_ | CS
		});
		const candIds = device.createBuffer({
			size: KT * 4,
			usage: S_ | CS
		});
		const candVals = device.createBuffer({
			size: KT * 4,
			usage: S_ | CS
		});
		const lseBuf = device.createBuffer({
			size: 4,
			usage: S_ | CS
		});
		const sigBuf = device.createBuffer({
			size: 12,
			usage: S_ | CS
		});
		const sigOff = KT * 8 + (lpN ? 4 : 0);
		let affBuf = device.createBuffer({
			size: maxSeqLen * 4,
			usage: S_ | CD
		});
		let banBuf = device.createBuffer({
			size: maxSeqLen * 4,
			usage: S_ | CD
		});
		const grow = (b, bytes) => {
			if (bytes <= b.size) return b;
			b.destroy();
			return device.createBuffer({
				size: 1 << 32 - Math.clz32(bytes - 1),
				usage: S_ | CD
			});
		};
		const rbBuf = device.createBuffer({
			size: sigOff + (topNS > 0 ? 12 : 0),
			usage: GPUBufferUsage.MAP_READ | CD
		});
		const embG = device.createBuffer({
			size: Hd * 4,
			usage: S_ | CS | CD
		});
		const writeAffBan = (history) => {
			const aff = penalty !== 1 || presence !== 0 ? affectedIds(history) : /* @__PURE__ */ new Uint32Array(0);
			if (aff.length) device.queue.writeBuffer(affBuf = grow(affBuf, aff.byteLength), 0, aff);
			const ban = ngramN > 0 ? ngramBans(history, ngramN) : [];
			if (ban.length) device.queue.writeBuffer(banBuf = grow(banBuf, ban.length * 4), 0, Uint32Array.from(ban));
			return {
				affLen: aff.length,
				banLen: ban.length
			};
		};
		const samplerChain = (pass, affLen, banLen) => {
			setup(pass, "sampler_penalty", [
				["u", affLen],
				["u", banLen],
				["f", penalty],
				["u", 4286578688],
				["f", presence]
			], [affBuf, banBuf], [lg]);
			pass.dispatchWorkgroups(1);
			if (lpN) {
				setup(pass, "logsumexp", [
					["u", vocab],
					["u", 0],
					["u", 0],
					["u", 0]
				], [lg], [lseBuf]);
				pass.dispatchWorkgroups(1);
			}
			if (topNS > 0) {
				setup(pass, "sampler_sigma", [
					["u", vocab],
					["u", 0],
					["u", 0],
					["u", 0]
				], [lg], [sigBuf]);
				pass.dispatchWorkgroups(1);
			}
			for (let r = 0; r < KT; r++) {
				setup(pass, "argmax_masked", [
					["u", vocab],
					["u", r],
					["u", 0],
					["u", 0]
				], [lg], [candIds, candVals]);
				pass.dispatchWorkgroups(1);
			}
		};
		const copyCands = (enc) => {
			enc.copyBufferToBuffer(candIds, 0, rbBuf, 0, KT * 4);
			enc.copyBufferToBuffer(candVals, 0, rbBuf, KT * 4, KT * 4);
			if (lpN) enc.copyBufferToBuffer(lseBuf, 0, rbBuf, KT * 8, 4);
			if (topNS > 0) enc.copyBufferToBuffer(sigBuf, 0, rbBuf, sigOff, 12);
		};
		let sigma = 0;
		const readCands = async () => {
			await rbBuf.mapAsync(GPUMapMode.READ);
			const mapped = rbBuf.getMappedRange();
			const ci = new Uint32Array(mapped.slice(0, KT * 4));
			const cv = new Float32Array(mapped.slice(KT * 4, KT * 8));
			const lse = lpN ? new Float32Array(mapped.slice(KT * 8, KT * 8 + 4))[0] : 0;
			if (topNS > 0) {
				const [sm, sq, c] = new Float32Array(mapped.slice(sigOff, sigOff + 12));
				sigma = c > 0 ? Math.sqrt(Math.max(0, sq / c - (sm / c) ** 2)) : 0;
			}
			rbBuf.unmap();
			return {
				ci,
				cv,
				lse
			};
		};
		const sigTrim = (ids, vals) => {
			if (!(topNS > 0) || vals.length === 0) return null;
			const cut = vals[0] - topNS * sigma;
			let m = 1;
			while (m < vals.length && vals[m] >= cut) m++;
			return {
				ids: Array.prototype.slice.call(ids, 0, m),
				vals: Array.prototype.slice.call(vals, 0, m)
			};
		};
		let chosenLogit = 0;
		const lpOut = lpN ? [] : null;
		const recordLp = (ci, cv, lse) => {
			if (!lpOut) return;
			const top = [];
			for (let i = 0; i < lpN; i++) top.push({
				id: ci[i],
				logprob: cv[i] - lse
			});
			lpOut.push({
				logprob: chosenLogit - lse,
				top
			});
		};
		const pick = (ciAll, cvAll) => {
			const ci = ciAll.subarray(0, K);
			const cv = cvAll.subarray(0, K);
			let ids = ci, vals = cv;
			const st = sigTrim(ci, cv);
			if (st) {
				ids = st.ids;
				vals = st.vals;
			}
			if (dryO) {
				const a = applyDry(ids, vals, history, dryO);
				ids = a.ids;
				vals = a.vals;
			}
			const tk = sampled ? sampleFromCandidates(ids, vals, temperature, rng, topP, minP) : ids[0];
			chosenLogit = cv[ci.indexOf(tk)];
			return tk;
		};
		const filter = genOpts.candidateFilter;
		const chooseToken = async (ciAll, cvAll) => {
			if (!filter) return pick(ciAll, cvAll);
			const ci = ciAll.subarray(0, K);
			const cv = cvAll.subarray(0, K);
			const perm = new Set(filter(ci, cv));
			{
				const pIds = [];
				const pVals = [];
				for (let i = 0; i < ci.length; i++) if (perm.has(ci[i])) {
					pIds.push(ci[i]);
					pVals.push(cv[i]);
				}
				if (pIds.length === 0) return chooseTokenSlow(ciAll, cvAll);
				let ids = pIds, vals = pVals;
				const st = sigTrim(pIds, pVals);
				if (st) {
					ids = st.ids;
					vals = st.vals;
				}
				if (dryO) {
					const a = applyDry(ids, vals, history, dryO);
					ids = a.ids;
					vals = a.vals;
				}
				const tk = sampled ? sampleFromCandidates(ids, vals, temperature, rng, topP, minP) : ids[0];
				chosenLogit = pVals[pIds.indexOf(tk)];
				return tk;
			}
		};
		const chooseTokenSlow = async (ciAll, cvAll) => {
			const all = await readback(lg, vocab);
			for (let i = 0; i < ciAll.length; i++) all[ciAll[i]] = cvAll[i];
			const order = Array.from(all.keys()).sort((a, b) => all[b] - all[a] || a - b);
			const pIds = [];
			const pVals = [];
			const B = 512;
			for (let i = 0; i < order.length && pIds.length < K; i += B) {
				if (all[order[i]] === -Infinity && pIds.length > 0) break;
				const batch = order.slice(i, i + B);
				const ok = new Set(filter(Uint32Array.from(batch), Float32Array.from(batch.map((id) => all[id]))));
				for (const id of batch) if (ok.has(id)) {
					pIds.push(id);
					pVals.push(all[id]);
					if (pIds.length >= K) break;
				}
				if (pVals[0] === -Infinity) {
					pIds.length = 1;
					pVals.length = 1;
					break;
				}
			}
			if (pIds.length === 0) throw new Error("bitgpu: candidateFilter permitted no token in the entire vocabulary");
			let ids = pIds, vals = pVals;
			const st = sigTrim(pIds, pVals);
			if (st) {
				ids = st.ids;
				vals = st.vals;
			}
			if (dryO) {
				const a = applyDry(ids, vals, history, dryO);
				ids = a.ids;
				vals = a.vals;
			}
			const tk = sampled ? sampleFromCandidates(ids, vals, temperature, rng, topP, minP) : ids[0];
			chosenLogit = pVals[pIds.indexOf(tk)];
			return tk;
		};
		transients = [];
		try {
			const t0 = performance.now();
			const pfx = await runPrefill(ids, posBase, signal);
			if (!pfx) return {
				prefillMs: performance.now() - t0,
				decodeMs: 0,
				tokPerSec: 0,
				tokens: [],
				firstArgmax: -1,
				recMs: 0,
				gpuMs: 0,
				rbMs: 0,
				rng
			};
			const encP = device.createCommandEncoder();
			const lastP = actBuf(Hd);
			encP.copyBufferToBuffer(pfx.fn, pfx.lastRow * Hd * 4, lastP, 0, Hd * 4);
			const pf = writeAffBan(history);
			let pass = encP.beginComputePass();
			lmHead(pass, lastP, 1, lg);
			samplerChain(pass, pf.affLen, pf.banLen);
			pass.end();
			copyCands(encP);
			device.queue.submit([encP.finish()]);
			const first = await readCands();
			const firstTok = await chooseToken(first.ci, first.cv);
			flushTransients();
			const prefillMs = performance.now() - t0;
			const gen = [];
			let stopped = stopSet?.has(firstTok) ?? false;
			if (!stopped) {
				gen.push(firstTok);
				history.push(firstTok);
				recordLp(first.ci, first.cv, first.lse);
				onToken?.(firstTok);
				device.queue.writeBuffer(tokBuf, 0, new Uint32Array([firstTok]));
			}
			let recMs = 0, gpuMs = 0, rbMs = 0;
			const t1 = performance.now();
			let total = 1;
			poolInvalidate();
			let slot = posBase + ids.length;
			while (total < nTokens && !stopped) {
				if (signal?.aborted) break;
				poolUse("decode");
				slot = evictFor(slot, 1);
				const idxOut = total, pos = slot;
				let t = performance.now();
				const { affLen, banLen } = writeAffBan(history);
				const enc = device.createCommandEncoder();
				let p2 = enc.beginComputePass();
				runN(p2, "embed_gather", [
					["u", Hd],
					["u", idxOut - 1],
					["u", 0],
					["u", 0]
				], [
					tokBuf,
					embWqG,
					tgt4G,
					embScalesG,
					embZpG
				], embG, 1);
				p2.end();
				const r = stack(enc, embG, 1, pos);
				const last = actBuf(Hd);
				enc.copyBufferToBuffer(r.fn, 0, last, 0, Hd * 4);
				p2 = enc.beginComputePass();
				lmHead(p2, last, 1, lg);
				samplerChain(p2, affLen, banLen);
				p2.end();
				copyCands(enc);
				device.queue.submit([enc.finish()]);
				recMs += performance.now() - t;
				t = performance.now();
				const { ci, cv, lse } = await readCands();
				gpuMs += performance.now() - t;
				t = performance.now();
				const tk = await chooseToken(ci, cv);
				rbMs += performance.now() - t;
				total += 1;
				if (stopSet?.has(tk)) {
					stopped = true;
					break;
				}
				gen.push(tk);
				history.push(tk);
				recordLp(ci, cv, lse);
				onToken?.(tk);
				device.queue.writeBuffer(tokBuf, idxOut * 4, new Uint32Array([tk]));
				slot += 1;
			}
			cacheLen = slot;
			const decodeMs = performance.now() - t1;
			const nd = Math.max(1, gen.length - 1);
			return {
				prefillMs,
				decodeMs,
				tokPerSec: nd / (decodeMs / 1e3),
				tokens: gen,
				firstArgmax: firstTok,
				recMs: recMs / nd,
				gpuMs: gpuMs / nd,
				rbMs: rbMs / nd,
				rng,
				...lpOut ? { lp: lpOut } : {}
			};
		} finally {
			poolUse(null);
			flushTransients();
			transients = null;
			for (const b of [
				tokBuf,
				lg,
				candIds,
				candVals,
				lseBuf,
				sigBuf,
				affBuf,
				banBuf,
				rbBuf,
				embG
			]) b.destroy();
		}
	}
	async function generatePldImpl(ids, posBase, nTokens, genOpts, history, rngIn) {
		await ensureKvCapacity(posBase + ids.length + nTokens);
		const sampled = genOpts.temperature != null && genOpts.temperature > 0 && genOpts.temperature !== 1;
		const vocab = W.lm_head.N;
		const K = Math.max(1, Math.min(genOpts.topK ?? 20, vocab));
		const temperature = genOpts.temperature ?? 1;
		const penalty = genOpts.repetitionPenalty ?? 1;
		const presence = genOpts.presencePenalty ?? 0;
		const topP = genOpts.topP ?? 1;
		const minP = genOpts.minP ?? 0;
		const ngramN = genOpts.noRepeatNgramSize ?? 0;
		const pl = typeof genOpts.promptLookup === "object" && genOpts.promptLookup !== null ? genOpts.promptLookup : {};
		const ngramSize = Math.max(2, pl.ngramSize ?? 3);
		const maxDraft = Math.max(1, Math.min(pl.maxDraft ?? 8, 31));
		const stopSet = genOpts.stopTokens ? new Set(genOpts.stopTokens) : null;
		const onToken = genOpts.onToken;
		const signal = genOpts.signal;
		const rng = rngIn ?? new MT19937(genOpts.seed);
		const useChain = sampled || penalty !== 1 || presence !== 0 || ngramN > 0;
		const lg = device.createBuffer({
			size: vocab * 4,
			usage: S_ | CS | CD
		});
		const lgAll = device.createBuffer({
			size: (maxDraft + 1) * vocab * 4,
			usage: S_ | CS
		});
		const idsOut = device.createBuffer({
			size: (maxDraft + 1) * 4,
			usage: S_ | CS
		});
		const candIds = device.createBuffer({
			size: K * 4,
			usage: S_ | CS
		});
		const candVals = device.createBuffer({
			size: K * 4,
			usage: S_ | CS
		});
		let affBuf = device.createBuffer({
			size: (maxSeqLen + maxDraft + 1) * 4,
			usage: S_ | CD
		});
		let banBuf = device.createBuffer({
			size: (maxSeqLen + maxDraft + 1) * 4,
			usage: S_ | CD
		});
		const grow = (b, bytes) => {
			if (bytes <= b.size) return b;
			b.destroy();
			return device.createBuffer({
				size: 1 << 32 - Math.clz32(bytes - 1),
				usage: S_ | CD
			});
		};
		const rbAll = device.createBuffer({
			size: (maxDraft + 1) * K * 8,
			usage: GPUBufferUsage.MAP_READ | CD
		});
		const pldIds = device.createBuffer({
			size: (maxDraft + 1) * 4,
			usage: S_ | CD
		});
		const embIn = device.createBuffer({
			size: (maxDraft + 1) * Hd * 4,
			usage: S_ | CD
		});
		const writeAffBan = (h) => {
			const aff = penalty !== 1 || presence !== 0 ? affectedIds(h) : /* @__PURE__ */ new Uint32Array(0);
			if (aff.length) device.queue.writeBuffer(affBuf = grow(affBuf, aff.byteLength), 0, aff);
			const ban = ngramN > 0 ? ngramBans(h, ngramN) : [];
			if (ban.length) device.queue.writeBuffer(banBuf = grow(banBuf, ban.length * 4), 0, Uint32Array.from(ban));
			return {
				affLen: aff.length,
				banLen: ban.length
			};
		};
		const samplerChain = (pass, affLen, banLen) => {
			setup(pass, "sampler_penalty", [
				["u", affLen],
				["u", banLen],
				["f", penalty],
				["u", 4286578688],
				["f", presence]
			], [affBuf, banBuf], [lg]);
			pass.dispatchWorkgroups(1);
			for (let r = 0; r < K; r++) {
				setup(pass, "argmax_masked", [
					["u", vocab],
					["u", r],
					["u", 0],
					["u", 0]
				], [lg], [candIds, candVals]);
				pass.dispatchWorkgroups(1);
			}
		};
		const rowDraw = (m, j) => sampled ? sampleFromCandidates(new Uint32Array(m, j * K * 8, K), new Float32Array(m, j * K * 8 + K * 4, K), temperature, rng, topP, minP) : new Uint32Array(m, j * K * 8, 1)[0];
		transients = [];
		try {
			const t0 = performance.now();
			const pfx = await runPrefill(ids, posBase, signal);
			if (!pfx) return {
				prefillMs: performance.now() - t0,
				decodeMs: 0,
				tokPerSec: 0,
				tokens: [],
				firstArgmax: -1,
				recMs: 0,
				gpuMs: 0,
				rbMs: 0,
				spec: {
					steps: 0,
					drafted: 0,
					accepted: 0
				},
				rng
			};
			const encP = device.createCommandEncoder();
			const lastP = actBuf(Hd);
			encP.copyBufferToBuffer(pfx.fn, pfx.lastRow * Hd * 4, lastP, 0, Hd * 4);
			const pf = useChain ? writeAffBan(history) : null;
			let pass = encP.beginComputePass();
			lmHead(pass, lastP, 1, lg);
			if (pf) samplerChain(pass, pf.affLen, pf.banLen);
			else runN(pass, "argmax", [
				["u", vocab],
				["u", 0],
				["u", 0],
				["u", 0]
			], [lg], idsOut, 1);
			pass.end();
			if (pf) {
				encP.copyBufferToBuffer(candIds, 0, rbAll, 0, K * 4);
				encP.copyBufferToBuffer(candVals, 0, rbAll, K * 4, K * 4);
			}
			device.queue.submit([encP.finish()]);
			await device.queue.onSubmittedWorkDone();
			let firstTok;
			if (pf) {
				await rbAll.mapAsync(GPUMapMode.READ);
				const m = rbAll.getMappedRange().slice(0);
				rbAll.unmap();
				firstTok = rowDraw(m, 0);
			} else firstTok = (await readbackU32(idsOut, 1))[0];
			flushTransients();
			const prefillMs = performance.now() - t0;
			const gen = [];
			let stopped = stopSet?.has(firstTok) ?? false;
			if (!stopped) {
				gen.push(firstTok);
				history.push(firstTok);
				onToken?.(firstTok);
			}
			poolInvalidate();
			let total = 1;
			let tLast = firstTok;
			let pos = posBase + ids.length;
			let specSteps = 0, drafted = 0, accepted = 0;
			let recMs = 0, gpuMs = 0, rbMs = 0;
			const t1 = performance.now();
			while (total < nTokens && !stopped) {
				if (signal?.aborted) break;
				pos = evictFor(pos, maxDraft + 1);
				const kMax = Math.min(maxDraft, nTokens - total - 1, maxSeqLen - 1 - pos);
				const drafts = kMax > 0 ? draftNgram(history, ngramSize, kMax) : [];
				const S = drafts.length + 1;
				await ensureKvCapacity(pos + S);
				let t = performance.now();
				if (S === 1) poolUse("pld1");
				else if (useSG && S <= 9) poolUse("pldm", S, 9);
				else poolUse(null);
				device.queue.writeBuffer(pldIds, 0, new Uint32Array([tLast, ...drafts]));
				SMALLM = useSG && S >= 2 && S <= 9 ? S : 0;
				const enc = device.createCommandEncoder();
				const gp = enc.beginComputePass();
				run(gp, "embed_gather_batch", [
					["u", S],
					["u", Hd],
					["u", 0],
					["u", 0]
				], [
					pldIds,
					embWqG,
					tgt4G,
					embScalesG,
					embZpG
				], embIn, S * Hd);
				gp.end();
				const r = stack(enc, embIn, S, pos);
				pass = enc.beginComputePass();
				lmHead(pass, r.fn, S, lgAll);
				pass.end();
				SMALLM = 0;
				if (!useChain) {
					for (let j = 0; j < S; j++) {
						enc.copyBufferToBuffer(lgAll, j * vocab * 4, lg, 0, vocab * 4);
						const p = enc.beginComputePass();
						runN(p, "argmax", [
							["u", vocab],
							["u", j],
							["u", 0],
							["u", 0]
						], [lg], idsOut, 1);
						p.end();
					}
					device.queue.submit([enc.finish()]);
				} else {
					device.queue.submit([enc.finish()]);
					for (let j = 0; j < S; j++) {
						const { affLen, banLen } = writeAffBan(j === 0 ? history : [...history, ...drafts.slice(0, j)]);
						const e2 = device.createCommandEncoder();
						e2.copyBufferToBuffer(lgAll, j * vocab * 4, lg, 0, vocab * 4);
						const p = e2.beginComputePass();
						samplerChain(p, affLen, banLen);
						p.end();
						e2.copyBufferToBuffer(candIds, 0, rbAll, j * K * 8, K * 4);
						e2.copyBufferToBuffer(candVals, 0, rbAll, j * K * 8 + K * 4, K * 4);
						device.queue.submit([e2.finish()]);
					}
				}
				recMs += performance.now() - t;
				t = performance.now();
				await device.queue.onSubmittedWorkDone();
				gpuMs += performance.now() - t;
				t = performance.now();
				const emitted = [];
				if (!useChain) {
					const outs = await readbackU32(idsOut, S);
					for (let j = 0; j < S; j++) {
						const tk = outs[j];
						if (stopSet?.has(tk)) {
							stopped = true;
							break;
						}
						emitted.push(tk);
						if (j < drafts.length && tk !== drafts[j]) break;
					}
				} else {
					await rbAll.mapAsync(GPUMapMode.READ);
					const m = rbAll.getMappedRange().slice(0);
					rbAll.unmap();
					for (let j = 0; j < S; j++) {
						const tk = rowDraw(m, j);
						if (stopSet?.has(tk)) {
							stopped = true;
							break;
						}
						emitted.push(tk);
						if (j < drafts.length && tk !== drafts[j]) break;
					}
				}
				rbMs += performance.now() - t;
				specSteps++;
				drafted += drafts.length;
				accepted += Math.max(0, emitted.length - 1);
				for (const tk of emitted) {
					gen.push(tk);
					history.push(tk);
					onToken?.(tk);
				}
				total += emitted.length;
				flushTransients();
				if (emitted.length === 0) break;
				pos += emitted.length;
				tLast = emitted[emitted.length - 1];
			}
			cacheLen = pos;
			const decodeMs = performance.now() - t1;
			const nd = Math.max(1, gen.length - 1);
			return {
				prefillMs,
				decodeMs,
				tokPerSec: nd / (decodeMs / 1e3),
				tokens: gen,
				firstArgmax: firstTok,
				recMs: recMs / nd,
				gpuMs: gpuMs / nd,
				rbMs: rbMs / nd,
				spec: {
					steps: specSteps,
					drafted,
					accepted
				},
				rng
			};
		} finally {
			SMALLM = 0;
			poolUse(null);
			flushTransients();
			transients = null;
			for (const b of [
				lg,
				lgAll,
				idsOut,
				candIds,
				candVals,
				affBuf,
				banBuf,
				rbAll,
				embIn,
				pldIds
			]) b.destroy();
		}
	}
	async function debugDecode(prefillIds) {
		fullHistory = [];
		cacheLen = 0;
		await ensureKvCapacity(prefillIds.length + 1);
		transients = [];
		const encP = device.createCommandEncoder();
		stack(encP, embedBatch(encP, prefillIds), prefillIds.length, 0);
		device.queue.submit([encP.finish()]);
		await device.queue.onSubmittedWorkDone();
		const pos = prefillIds.length, tok = prefillIds[prefillIds.length - 1];
		const runStep = async (forceSlow) => {
			FORCE_SLOW = forceSlow;
			DBG0 = {};
			const enc = device.createCommandEncoder();
			const r = stack(enc, embedBatch(enc, [tok]), 1, pos);
			const lg = device.createBuffer({
				size: W.lm_head.N * 4,
				usage: S_ | CS
			});
			transients?.push(lg);
			const pass = enc.beginComputePass();
			lmHead(pass, r.fn, 1, lg);
			pass.end();
			device.queue.submit([enc.finish()]);
			await device.queue.onSubmittedWorkDone();
			const ck = {};
			for (const [name, b] of Object.entries(DBG0)) ck[name] = await readback(b, b.size / 4);
			const off = pos * KV * Dh;
			if (!kv16 && !kv8 && kvLayers.length) {
				const dl = kvLayers[0];
				ck.kc = (await readback(Kc[dl], kvCapacity * KV * Dh)).slice(off, off + KV * Dh);
				ck.vc = (await readback(Vc[dl], kvCapacity * KV * Dh)).slice(off, off + KV * Dh);
			}
			ck.fn = await readback(r.fn, Hd);
			ck.logits = await readback(lg, W.lm_head.N);
			FORCE_SLOW = false;
			DBG0 = null;
			return ck;
		};
		try {
			return {
				fast: await runStep(false),
				slow: await runStep(true)
			};
		} finally {
			FORCE_SLOW = false;
			DBG0 = null;
			flushTransients();
			transients = null;
		}
	}
	async function debugSampler(ids, genOpts) {
		fullHistory = [];
		cacheLen = 0;
		transients = [];
		const vocab = W.lm_head.N;
		const K = Math.max(1, Math.min(genOpts.topK ?? 20, vocab));
		const penalty = genOpts.repetitionPenalty ?? 1;
		const presence = genOpts.presencePenalty ?? 0;
		const ngramN = genOpts.noRepeatNgramSize ?? 0;
		const lg = device.createBuffer({
			size: vocab * 4,
			usage: S_ | CS
		});
		const candIds = device.createBuffer({
			size: K * 4,
			usage: S_ | CS
		});
		const candVals = device.createBuffer({
			size: K * 4,
			usage: S_ | CS
		});
		transients?.push(lg, candIds, candVals);
		const aff = penalty !== 1 || presence !== 0 ? affectedIds(ids) : /* @__PURE__ */ new Uint32Array(0);
		const ban = ngramN > 0 ? ngramBans(ids, ngramN) : [];
		const affBuf = upload(aff.length ? aff : /* @__PURE__ */ new Uint32Array(1), S_ | CD);
		const banBuf = upload(ban.length ? Uint32Array.from(ban) : /* @__PURE__ */ new Uint32Array(1), S_ | CD);
		const enc1 = device.createCommandEncoder();
		const { fn } = stack(enc1, embedBatch(enc1, ids), ids.length, 0);
		const lastP = device.createBuffer({
			size: Hd * 4,
			usage: S_ | CS | CD
		});
		transients?.push(lastP);
		enc1.copyBufferToBuffer(fn, (ids.length - 1) * Hd * 4, lastP, 0, Hd * 4);
		let pass = enc1.beginComputePass();
		lmHead(pass, lastP, 1, lg);
		pass.end();
		device.queue.submit([enc1.finish()]);
		await device.queue.onSubmittedWorkDone();
		const base = await readback(lg, vocab);
		const enc2 = device.createCommandEncoder();
		pass = enc2.beginComputePass();
		setup(pass, "sampler_penalty", [
			["u", aff.length],
			["u", ban.length],
			["f", penalty],
			["u", 4286578688],
			["f", presence]
		], [affBuf, banBuf], [lg]);
		pass.dispatchWorkgroups(1);
		for (let r = 0; r < K; r++) {
			setup(pass, "argmax_masked", [
				["u", vocab],
				["u", r],
				["u", 0],
				["u", 0]
			], [lg], [candIds, candVals]);
			pass.dispatchWorkgroups(1);
		}
		pass.end();
		device.queue.submit([enc2.finish()]);
		await device.queue.onSubmittedWorkDone();
		try {
			return {
				base,
				penalized: await readback(lg, vocab),
				candIds: await readbackU32(candIds, K),
				candVals: await readback(candVals, K)
			};
		} finally {
			flushTransients();
			transients = null;
		}
	}
	const capabilities = {
		useSubgroups: useSG,
		subgroupSize: sgMax,
		kvCache: kv16 ? "f16" : kv8 ? "q8" : "f32",
		activation: actF16 ? "f16" : "f32",
		overflow: roll ? "sinks" : "error",
		maxSeqLen,
		adapter: {
			vendor: info.vendor,
			architecture: info.architecture,
			device: info.device,
			description: info.description
		},
		limits: {
			maxStorageBufferBindingSize: Number(device.limits.maxStorageBufferBindingSize),
			maxComputeWorkgroupStorageSize: device.limits.maxComputeWorkgroupStorageSize
		},
		timestampQuery: hasTS
	};
	async function generate(promptTokenIds, genOpts = {}) {
		const sampled = genOpts.temperature != null && genOpts.temperature > 0 && genOpts.temperature !== 1;
		const hasProcessors = (genOpts.repetitionPenalty ?? 1) !== 1 || (genOpts.noRepeatNgramSize ?? 0) > 0 || (genOpts.presencePenalty ?? 0) !== 0 || (genOpts.dryMultiplier ?? 0) > 0;
		if (((genOpts.dryMultiplier ?? 0) > 0 || (genOpts.topNSigma ?? 0) > 0) && genOpts.promptLookup && genOpts.promptLookup !== "auto") throw new Error("bitgpu: dryMultiplier/topNSigma are not supported with promptLookup (they need per-position statistics; auto simply disables lookup)");
		if (A.hybrid && genOpts.promptLookup && genOpts.promptLookup !== "auto") throw new Error("bitgpu: promptLookup is not supported on the qwen3_5 hybrid backbone (rejected drafts would corrupt the linear-attention recurrent state); use promptLookup: 'auto' or omit it");
		const reuse = (genOpts.reuseCache ?? false) && fullHistory.length > 0;
		if (genOpts.signal?.aborted) return {
			tokens: [],
			prefillMs: 0,
			decodeMs: 0,
			tokensPerSecond: 0,
			timing: {
				recordMs: 0,
				gpuMs: 0,
				readbackMs: 0
			}
		};
		let posBase = reuse ? roll ? cacheLen : fullHistory.length - 1 : 0;
		const prefillTokens = reuse ? [fullHistory[fullHistory.length - 1], ...promptTokenIds] : promptTokenIds;
		const hist = reuse ? fullHistory : [...promptTokenIds];
		if (prefillTokens.length === 0) throw new Error("generate: no tokens to process");
		if (roll && posBase + prefillTokens.length + 1 > maxSeqLen) {
			if (SINKS + prefillTokens.length + 1 > maxSeqLen) throw new Error(`generate: prompt length ${prefillTokens.length} exceeds the rolling window (maxSeqLen ${maxSeqLen} minus ${SINKS} sinks); trim the prompt`);
			await ensureKvCapacity(Math.min(maxSeqLen, posBase + prefillTokens.length));
			posBase = evict(posBase, posBase + prefillTokens.length + 1 - maxSeqLen);
			cacheLen = posBase;
		}
		const room = maxSeqLen - posBase - prefillTokens.length;
		if (room < 1) throw new Error(`generate: prompt length ${posBase + prefillTokens.length} exceeds maxSeqLen ${maxSeqLen}; trim history or raise maxSeqLen`);
		const maxTokens = roll ? genOpts.maxTokens ?? 256 : Math.min(genOpts.maxTokens ?? 256, room);
		if (reuse) hist.push(...promptTokenIds);
		else fullHistory = hist;
		try {
			if (maxTokens < 1) {
				await ensureKvCapacity(posBase + prefillTokens.length);
				transients = [];
				try {
					const t0 = performance.now();
					if (prefillTokens.length > 1) {
						await runPrefill(prefillTokens.slice(0, -1), posBase, genOpts.signal);
						await device.queue.onSubmittedWorkDone();
					}
					cacheLen = posBase + prefillTokens.length - 1;
					return {
						tokens: [],
						prefillMs: performance.now() - t0,
						decodeMs: 0,
						tokensPerSecond: 0,
						timing: {
							recordMs: 0,
							gpuMs: 0,
							readbackMs: 0
						}
					};
				} finally {
					flushTransients();
					transients = null;
				}
			}
			const hasFilter = !!genOpts.candidateFilter || (genOpts.logprobs ?? 0) > 0;
			let r;
			if (!hasFilter && !A.hybrid && (genOpts.dryMultiplier ?? 0) === 0 && (genOpts.topNSigma ?? 0) === 0 && genOpts.promptLookup === "auto" && maxTokens > 24) {
				const r1 = await generatePldImpl(prefillTokens, posBase, 24, genOpts, hist);
				const E = r1.tokens.length;
				if (E < 24) r = r1;
				else {
					const keep = pldWorthIt(E, r1.spec?.steps ?? 0, sampled || hasProcessors);
					const ids2 = [r1.tokens[E - 1]];
					const pos2 = posBase + prefillTokens.length + E - 1;
					const n2 = maxTokens - E;
					let r2;
					if (keep) r2 = await generatePldImpl(ids2, pos2, n2, genOpts, hist, r1.rng);
					else if (sampled || hasProcessors) r2 = await generateSampledImpl(ids2, pos2, n2, genOpts, hist, r1.rng);
					else {
						r2 = await generateImpl(ids2, pos2, n2, null, SYNC_N, {
							stopTokens: genOpts.stopTokens,
							onToken: genOpts.onToken,
							signal: genOpts.signal
						});
						hist.push(...r2.tokens);
					}
					const total = E + r2.tokens.length;
					const decodeMs = r1.decodeMs + r2.prefillMs + r2.decodeMs;
					const w1 = Math.max(1, E - 1);
					const w2 = Math.max(0, r2.tokens.length);
					r = {
						prefillMs: r1.prefillMs,
						decodeMs,
						tokPerSec: Math.max(1, total - 1) / (decodeMs / 1e3),
						tokens: [...r1.tokens, ...r2.tokens],
						firstArgmax: r1.firstArgmax,
						recMs: (r1.recMs * w1 + r2.recMs * w2) / (w1 + w2),
						gpuMs: (r1.gpuMs * w1 + r2.gpuMs * w2) / (w1 + w2),
						rbMs: (r1.rbMs * w1 + r2.rbMs * w2) / (w1 + w2),
						spec: {
							steps: (r1.spec?.steps ?? 0) + (r2.spec?.steps ?? 0),
							drafted: (r1.spec?.drafted ?? 0) + (r2.spec?.drafted ?? 0),
							accepted: (r1.spec?.accepted ?? 0) + (r2.spec?.accepted ?? 0),
							bailed: !keep
						}
					};
				}
			} else if (!hasFilter && !A.hybrid && (genOpts.dryMultiplier ?? 0) === 0 && (genOpts.topNSigma ?? 0) === 0 && genOpts.promptLookup) r = await generatePldImpl(prefillTokens, posBase, maxTokens, genOpts, hist);
			else if (sampled || hasProcessors || hasFilter) r = await generateSampledImpl(prefillTokens, posBase, maxTokens, genOpts, hist);
			else {
				r = await generateImpl(prefillTokens, posBase, maxTokens, null, SYNC_N, {
					stopTokens: genOpts.stopTokens,
					onToken: genOpts.onToken,
					signal: genOpts.signal
				});
				hist.push(...r.tokens);
			}
			return {
				tokens: r.tokens,
				prefillMs: r.prefillMs,
				decodeMs: r.decodeMs,
				tokensPerSecond: r.tokPerSec,
				timing: {
					recordMs: r.recMs,
					gpuMs: r.gpuMs,
					readbackMs: r.rbMs
				},
				...r.spec ? { speculation: r.spec } : {},
				...r.lp ? { logprobs: r.lp } : {}
			};
		} catch (e) {
			fullHistory = [];
			cacheLen = 0;
			throw e;
		}
	}
	async function prefill(ids) {
		if (ids.length === 0) throw new Error("prefill: no tokens to process");
		if (ids.length > maxSeqLen) throw new Error(`prefill: sequence length ${ids.length} exceeds maxSeqLen ${maxSeqLen}`);
		fullHistory = [];
		cacheLen = 0;
		await ensureKvCapacity(ids.length);
		transients = [];
		try {
			const t0 = performance.now();
			if (ids.length > 1) {
				await runPrefill(ids.slice(0, -1), 0);
				await device.queue.onSubmittedWorkDone();
			}
			fullHistory = [...ids];
			cacheLen = ids.length - 1;
			return { prefillMs: performance.now() - t0 };
		} finally {
			flushTransients();
			transients = null;
		}
	}
	const kvRowBytes = KV * Dh * KVB;
	const scRowBytes = kv8 ? KV * (Dh / 32) * 4 : 0;
	const snapshotBytes = (len) => (A.hybrid ? kvLayers.length : A.layers) * 2 * len * (kvRowBytes + scRowBytes) + linearLayers.length * (rsSz + csSz);
	async function saveCache(opts) {
		if (fullHistory.length === 0) return null;
		const len = roll ? cacheLen : fullHistory.length - 1;
		const base = Math.max(0, Math.min(Math.floor(opts?.from ?? 0), len));
		if (base > 0 && roll) throw new Error("saveCache: delta snapshots ({ from }) are not supported under overflow 'sinks'");
		if (base > 0 && A.hybrid) throw new Error("saveCache: delta snapshots ({ from }) are not supported for the qwen3_5 hybrid backbone");
		const count = len - base;
		const bytes = snapshotBytes(count);
		const data = new ArrayBuffer(bytes);
		if (bytes > 0) {
			const cap = Math.max(4, Math.min((globalThis.__RBCAP ?? 0) || 128 << 20, device.limits.maxBufferSize) & -4);
			const pieces = [];
			if (count > 0) for (const li of kvLayers) {
				pieces.push({
					src: Kc[li],
					off: base * kvRowBytes,
					size: count * kvRowBytes
				});
				pieces.push({
					src: Vc[li],
					off: base * kvRowBytes,
					size: count * kvRowBytes
				});
				if (kv8) {
					pieces.push({
						src: Ksc[li],
						off: base * scRowBytes,
						size: count * scRowBytes
					});
					pieces.push({
						src: Vsc[li],
						off: base * scRowBytes,
						size: count * scRowBytes
					});
				}
			}
			for (const li of linearLayers) {
				pieces.push({
					src: hyRS[li][hyPar],
					off: 0,
					size: rsSz
				});
				pieces.push({
					src: hyCS[li][hyPar],
					off: 0,
					size: csSz
				});
			}
			const rb = device.createBuffer({
				size: Math.min(bytes, cap),
				usage: GPUBufferUsage.MAP_READ | CD
			});
			let pi = 0;
			let pOff = 0;
			for (let dst = 0; dst < bytes;) {
				const sz = Math.min(cap, bytes - dst);
				const enc = device.createCommandEncoder();
				for (let fill = 0; fill < sz;) {
					const p = pieces[pi];
					const take = Math.min(p.size - pOff, sz - fill);
					enc.copyBufferToBuffer(p.src, p.off + pOff, rb, fill, take);
					fill += take;
					pOff += take;
					if (pOff === p.size) {
						pi++;
						pOff = 0;
					}
				}
				device.queue.submit([enc.finish()]);
				await rb.mapAsync(GPUMapMode.READ, 0, sz);
				new Uint8Array(data, dst, sz).set(new Uint8Array(rb.getMappedRange(0, sz)));
				rb.unmap();
				dst += sz;
			}
			rb.destroy();
		}
		return {
			version: roll ? 2 : 1,
			kvCache: capabilities.kvCache,
			model: {
				layers: A.layers,
				kvHeads: KV,
				headDim: Dh,
				hidden: Hd,
				vocab: A.vocab
			},
			ids: [...fullHistory],
			...base > 0 ? { base } : {},
			...roll ? { roll: {
				sinkTokens: SINKS,
				cacheLen
			} } : {},
			data
		};
	}
	async function restoreCache(snap) {
		if (!snap || snap.version !== 1 && snap.version !== 2) throw new Error(`restoreCache: unsupported snapshot version ${snap?.version}`);
		if (snap.version === 2 !== roll) throw new Error(snap.version === 2 ? "restoreCache: snapshot was saved under overflow 'sinks' (unroped keys); this engine runs overflow 'error'" : "restoreCache: snapshot was saved under overflow 'error' (roped keys); this engine runs overflow 'sinks'");
		if (snap.version === 2 && snap.roll?.sinkTokens !== SINKS) throw new Error(`restoreCache: snapshot uses ${snap.roll?.sinkTokens} sink tokens but this engine uses ${SINKS}`);
		if (snap.kvCache !== capabilities.kvCache) throw new Error(`restoreCache: snapshot was saved under kvCache '${snap.kvCache}' but this engine runs '${capabilities.kvCache}' - snapshots do not convert across modes`);
		const m = snap.model;
		if (!m || m.layers !== A.layers || m.kvHeads !== KV || m.headDim !== Dh || m.hidden !== Hd || m.vocab !== A.vocab) throw new Error("restoreCache: snapshot is from a different model (architecture mismatch)");
		if (!Array.isArray(snap.ids) || snap.ids.length === 0) throw new Error("restoreCache: snapshot holds no tokens");
		const len = snap.version === 2 ? snap.roll.cacheLen : snap.ids.length - 1;
		const base = Math.max(0, Math.floor(snap.base ?? 0));
		if (base > 0 && A.hybrid) throw new Error("restoreCache: delta snapshots are not supported for the qwen3_5 hybrid backbone");
		const count = len - base;
		if (len + (snap.version === 2 ? 0 : 1) > maxSeqLen) throw new Error(`restoreCache: snapshot needs ${len + (snap.version === 2 ? 0 : 1)} cache slots but maxSeqLen is ${maxSeqLen}`);
		if (snap.data.byteLength !== snapshotBytes(count)) throw new Error(`restoreCache: snapshot data is ${snap.data.byteLength} bytes, expected ${snapshotBytes(count)}`);
		if (base > 0) {
			if (cacheLen !== base) throw new Error(`restoreCache: delta snapshot expects the cache at position ${base} (prewarm the shared prefix first); it is at ${cacheLen}`);
			for (let i = 0; i < base; i++) if (fullHistory[i] !== snap.ids[i]) throw new Error(`restoreCache: delta snapshot prefix does not match the current prewarm (token ${i})`);
		}
		await ensureKvCapacity(len);
		let off = 0;
		if (count > 0) for (const li of kvLayers) {
			device.queue.writeBuffer(Kc[li], base * kvRowBytes, snap.data, off, count * kvRowBytes);
			off += count * kvRowBytes;
			device.queue.writeBuffer(Vc[li], base * kvRowBytes, snap.data, off, count * kvRowBytes);
			off += count * kvRowBytes;
			if (kv8) {
				device.queue.writeBuffer(Ksc[li], base * scRowBytes, snap.data, off, count * scRowBytes);
				off += count * scRowBytes;
				device.queue.writeBuffer(Vsc[li], base * scRowBytes, snap.data, off, count * scRowBytes);
				off += count * scRowBytes;
			}
		}
		for (const li of linearLayers) {
			device.queue.writeBuffer(hyRS[li][0], 0, snap.data, off, rsSz);
			off += rsSz;
			device.queue.writeBuffer(hyCS[li][0], 0, snap.data, off, csSz);
			off += csSz;
		}
		if (A.hybrid) hyPar = 0;
		fullHistory = [...snap.ids];
		cacheLen = len;
	}
	let opChain = Promise.resolve();
	const serialize = (fn) => {
		return (...args) => {
			const run = opChain.then(() => fn(...args), () => fn(...args));
			opChain = run.catch(() => void 0);
			return run;
		};
	};
	return {
		generate: serialize(generate),
		prefill: serialize(prefill),
		forward: serialize(forward),
		saveCache: serialize(saveCache),
		restoreCache: serialize(restoreCache),
		resetCache,
		capabilities,
		lost,
		dispose: () => device.destroy(),
		device,
		adapter,
		profileDecode: serialize(async (ids, nTokens, full = null, syncN = SYNC_N) => {
			fullHistory = [];
			cacheLen = 0;
			TS_PROFILE = hasTS;
			try {
				return await generateImpl(ids, 0, nTokens, full, syncN);
			} finally {
				TS_PROFILE = false;
			}
		}),
		debugDecode: serialize(debugDecode),
		debugSampler: serialize(debugSampler)
	};
}
//#endregion
export { GpuOutOfMemoryError, WebGPUUnavailableError, createEngine };

