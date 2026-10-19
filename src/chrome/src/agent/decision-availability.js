import { decisionNeedsLocalAssist, resolveDecisionConfig } from './decision-config.js';
import { isLocalAssistModelReady } from '../providers/webgpu-model-cache.js';

// The decision configuration that applies right now. Auto looks for the
// downloaded in-browser model only when it could use it (no Compass), and the
// lookup is one Cache Storage read, so per-check callers can afford it.
export async function resolveCurrentDecisionConfig(stored = {}, compass = null) {
  const localAssistReady = decisionNeedsLocalAssist(stored, compass) && await isLocalAssistModelReady();
  return resolveDecisionConfig(stored, compass, { localAssistReady });
}
