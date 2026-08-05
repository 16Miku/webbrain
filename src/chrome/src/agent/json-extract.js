// An opener that never closes must not abandon the candidate: a stray brace
// in prose ahead of the real object is as common as the illustrative-object
// case, and the object after it still has to be found. Each unbalanced opener
// costs one extra scan, so the restarts are capped to keep a pathological
// "{{{{…" response from going quadratic.
const MAX_UNBALANCED_RESTARTS = 16;

/**
 * Extract the first balanced JSON object from model output (fence-aware).
 * Shared by the agent's classifier sub-calls and the planner so the parsing
 * stays robust in exactly one place instead of drifting across copies.
 */
export function extractFirstJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);

  for (const candidate of candidates) {
    let searchFrom = 0;
    let restarts = 0;
    while (searchFrom < candidate.length) {
      const start = candidate.indexOf('{', searchFrom);
      if (start < 0) break;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) {
        if (++restarts > MAX_UNBALANCED_RESTARTS) break;
        searchFrom = start + 1;
        continue;
      }
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (_) {
        searchFrom = end + 1;
      }
    }
  }
  return null;
}
