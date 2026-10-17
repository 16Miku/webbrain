import { WebGPUProvider, WEBGPU_DECISION_MODEL_ID } from './webgpu.js';

// Decisions on the in-browser chat model (Ternary Bonsai 2 2B Vision and its
// trained probe). Runs in the offscreen WebGPU worker; nothing leaves the browser.
export async function evaluateWebgpuDecision({ state, images, questions, config, signal } = {}) {
  if (config?.model !== WEBGPU_DECISION_MODEL_ID) throw new Error('Only Ternary Bonsai 2 2B Vision answers in-browser decisions.');
  if (signal?.aborted) throw signal.reason;
  const provider = new WebGPUProvider({ model: WEBGPU_DECISION_MODEL_ID });
  const result = await provider.decide({ state, images, questions });
  if (signal?.aborted) throw signal.reason;
  return { model: result.model, provider: 'webgpu_chat', answers: result.answers, usage: result.usage };
}
