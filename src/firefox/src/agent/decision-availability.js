import { resolveDecisionConfig } from './decision-config.js';

// The decision configuration that applies right now. Firefox has no
// in-browser model runtime, so Auto never finds a local decision model here.
export async function resolveCurrentDecisionConfig(stored = {}, compass = null) {
  return resolveDecisionConfig(stored, compass);
}
