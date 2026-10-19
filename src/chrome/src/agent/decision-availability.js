import { resolveDecisionConfig } from './decision-config.js';

// Decision availability is independent of the downloaded chat/vision model.
export async function resolveCurrentDecisionConfig(stored = {}, compass = null) {
  return resolveDecisionConfig(stored, compass);
}
