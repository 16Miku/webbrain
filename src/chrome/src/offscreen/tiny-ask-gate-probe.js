// Screenshot gate probe for tiny Ask on Ternary Bonsai 2 2B Vision (see
// src/chrome/src/agent/tiny-ask.js, tinyAskScreenshotGate). The backbone is
// frozen: the gate question's readout continuation gives a Yes-minus-No logit
// margin and the decoder's last-position state (decision_hidden), and
//   p(needs a screenshot) = sigmoid(margin * margin_weight + bias + hidden . weights)
// with standardization folded into the weights and bias. Trained by
// scripts/models/bonsai/train_gate_probe.py; empty weights fall back to the
// untrained readout, sigmoid(margin).
export const TINY_ASK_GATE_PROBE = Object.freeze({
  model: 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision',
  hiddenSize: 2048,
  margin: 0,
  bias: 0,
  weightsBase64: '',
});

let weights;
function probeWeights() {
  if (weights === undefined) {
    if (!TINY_ASK_GATE_PROBE.weightsBase64) {
      weights = null;
    } else {
      const binary = atob(TINY_ASK_GATE_PROBE.weightsBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      weights = new Float32Array(bytes.buffer);
    }
  }
  return weights;
}

const sigmoid = value => 1 / (1 + Math.exp(-value));

/** p(the question needs a screenshot of the current page). */
export function tinyAskGateProbability(modelId, margin, hidden) {
  const w = modelId === TINY_ASK_GATE_PROBE.model ? probeWeights() : null;
  if (!w || !hidden || hidden.length !== w.length) return sigmoid(margin);
  let dot = 0;
  for (let i = 0; i < w.length; i++) dot += w[i] * hidden[i];
  return sigmoid(margin * TINY_ASK_GATE_PROBE.margin + TINY_ASK_GATE_PROBE.bias + dot);
}
