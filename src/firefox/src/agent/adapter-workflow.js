/**
 * Optional machine-readable workflow metadata for site adapters.
 *
 * This module is deliberately browser-free so the schema can be validated in
 * Node and kept identical across Chrome and Firefox. Adapter notes remain the
 * model-facing guidance; workflow profiles are an additive contract for future
 * state-aware consumers.
 */

export const ADAPTER_WORKFLOW_SCHEMA = 'webbrain-adapter-workflow/1';

export const ADAPTER_WORKFLOW_STATES = Object.freeze([
  'access_gate',
  'search',
  'selection',
  'review',
  'commit',
  'payment',
  'fulfillment',
  'after_sales',
]);

const WORKFLOW_STATE_SET = new Set(ADAPTER_WORKFLOW_STATES);
const WORKFLOW_FIELDS = new Set(['schema', 'states']);
const STATE_FIELDS = new Set([
  'evidence',
  'readOnly',
  'requiresConfirmation',
  'terminalFor',
]);
const MAX_PROFILE_ITEMS = 16;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_LENGTH = 240;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(error) {
  return { ok: false, error };
}

function validateTokenList(value, field, pattern) {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid(`\`${field}\` must be a non-empty array.`);
  }
  if (value.length > MAX_PROFILE_ITEMS) {
    return invalid(`\`${field}\` must contain at most ${MAX_PROFILE_ITEMS} items.`);
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item !== item.trim() || !pattern.test(item)) {
      return invalid(`\`${field}\` entries must be stable, trimmed identifiers.`);
    }
    const key = item.toLowerCase();
    if (seen.has(key)) return invalid(`\`${field}\` must not contain duplicate entries.`);
    seen.add(key);
  }
  return { ok: true };
}

function validateEvidence(stateName, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return invalid(`Workflow state \`${stateName}\` evidence must be a non-empty array.`);
  }
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    return invalid(`Workflow state \`${stateName}\` evidence must contain at most ${MAX_EVIDENCE_ITEMS} items.`);
  }
  const seen = new Set();
  for (const item of evidence) {
    if (typeof item !== 'string' || item !== item.trim() || !item || item.length > MAX_EVIDENCE_LENGTH) {
      return invalid(`Workflow state \`${stateName}\` evidence entries must be trimmed strings of 1-${MAX_EVIDENCE_LENGTH} characters.`);
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return invalid(`Workflow state \`${stateName}\` evidence must not contain duplicate entries.`);
    }
    seen.add(key);
  }
  return { ok: true };
}

/**
 * Validate the optional structured portion of an adapter record.
 *
 * Existing adapters without workflow metadata remain valid. Once any of the
 * profile fields is present, regions, jobs, and workflow are all required so a
 * consumer never receives a partial profile.
 */
export function validateAdapterWorkflowProfile(adapter) {
  if (!isPlainObject(adapter)) return invalid('Adapter workflow profile must be an object.');

  const hasProfile = adapter.regions !== undefined
    || adapter.jobs !== undefined
    || adapter.workflow !== undefined;
  if (!hasProfile) return { ok: true };

  const regions = validateTokenList(adapter.regions, 'regions', /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/);
  if (!regions.ok) return regions;
  const jobs = validateTokenList(adapter.jobs, 'jobs', /^[a-z][a-z0-9-]{0,63}$/);
  if (!jobs.ok) return jobs;

  const workflow = adapter.workflow;
  if (!isPlainObject(workflow)) return invalid('`workflow` must be an object.');
  if (workflow.schema !== ADAPTER_WORKFLOW_SCHEMA) {
    return invalid(`\`workflow.schema\` must be \`${ADAPTER_WORKFLOW_SCHEMA}\`.`);
  }
  for (const field of Object.keys(workflow)) {
    if (!WORKFLOW_FIELDS.has(field)) return invalid(`\`workflow\` has unknown field \`${field}\`.`);
  }
  if (!isPlainObject(workflow.states) || Object.keys(workflow.states).length === 0) {
    return invalid('`workflow.states` must be a non-empty object.');
  }

  const knownJobs = new Set(adapter.jobs);
  const jobsWithTerminalState = new Set();
  for (const [stateName, state] of Object.entries(workflow.states)) {
    if (!WORKFLOW_STATE_SET.has(stateName)) {
      return invalid(`Unknown workflow state \`${stateName}\`.`);
    }
    if (!isPlainObject(state)) return invalid(`Workflow state \`${stateName}\` must be an object.`);

    for (const field of Object.keys(state)) {
      if (!STATE_FIELDS.has(field)) {
        return invalid(`Workflow state \`${stateName}\` has unknown field \`${field}\`.`);
      }
    }

    const evidence = validateEvidence(stateName, state.evidence);
    if (!evidence.ok) return evidence;

    for (const field of ['readOnly', 'requiresConfirmation']) {
      if (state[field] !== undefined && typeof state[field] !== 'boolean') {
        return invalid(`Workflow state \`${stateName}\` field \`${field}\` must be boolean.`);
      }
    }
    if (state.readOnly === true && state.requiresConfirmation === true) {
      return invalid(`Workflow state \`${stateName}\` cannot be read-only and require confirmation.`);
    }
    if ((stateName === 'commit' || stateName === 'payment') && state.requiresConfirmation !== true) {
      return invalid(`Workflow state \`${stateName}\` must set requiresConfirmation to true.`);
    }

    if (state.terminalFor !== undefined) {
      if (!Array.isArray(state.terminalFor) || state.terminalFor.length === 0) {
        return invalid(`Workflow state \`${stateName}\` terminalFor must be a non-empty array.`);
      }
      const seenTerminalJobs = new Set();
      for (const job of state.terminalFor) {
        if (typeof job !== 'string' || !knownJobs.has(job)) {
          return invalid(`Workflow state \`${stateName}\` terminalFor references unknown job \`${String(job)}\`.`);
        }
        if (seenTerminalJobs.has(job)) {
          return invalid(`Workflow state \`${stateName}\` terminalFor must not contain duplicate jobs.`);
        }
        seenTerminalJobs.add(job);
        jobsWithTerminalState.add(job);
      }
    }
  }

  for (const job of adapter.jobs) {
    if (!jobsWithTerminalState.has(job)) {
      return invalid(`Workflow job \`${job}\` must have a successful terminal state with evidence.`);
    }
  }
  return { ok: true };
}
