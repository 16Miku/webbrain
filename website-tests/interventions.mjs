import { HarnessError } from './config.mjs';

export const interventionKinds = ['click', 'type', 'scroll', 'select', 'selection', 'navigate', 'draft-change', 'steer', 'narrow', 'cancel', 'stop-continue', 'upload-interrupt', 'passive-update'];

export async function applyIntervention(backend, handle, spec, record = () => {}) {
  if (!interventionKinds.includes(spec.kind)) throw new HarnessError('unknown_intervention');
  if (!spec.checkpoint?.selector) throw new HarnessError('intervention_checkpoint_missing', 'Configure a visible lifecycle checkpoint instead of a delay.');
  if (backend.capabilities?.checkpoints !== true || backend.capabilities?.interventions !== true)
    throw new HarnessError('active_intervention_unavailable', 'Use a supported local controller or manual checkpoint.', 'unsupported');
  const checkpoint = await backend.checkpoint({ handle, ...spec.checkpoint, requireActiveRun: true });
  record({ type: 'checkpoint', kind: spec.kind, timestamp: new Date().toISOString(), observed: true });
  if (['steer', 'narrow'].includes(spec.kind)) {
    if (!spec.text) throw new HarnessError('intervention_text_missing');
    await backend.steer({ handle, task: spec.text });
  } else if (spec.kind === 'cancel' || spec.kind === 'stop-continue') {
    await backend.stop(handle);
  } else {
    if (spec.kind === 'passive-update') {
      if (!spec.updateCheckpoint?.selector) throw new HarnessError('passive_update_checkpoint_missing');
      await backend.checkpoint({ handle, ...spec.updateCheckpoint });
    } else await backend.intervene({ handle, ...spec, kind: spec.kind === 'draft-change' ? 'type' : spec.kind === 'upload-interrupt' ? 'click' : spec.kind });
  }
  record({ type: 'intervention', kind: spec.kind, timestamp: new Date().toISOString(), observed: true });
  return { checkpoint, kind: spec.kind, delivered: true };
}
