const STAGE_MESSAGES = {
  publication_audit: 'Failed while checking permission to publish. Your draft is still ready.',
  plan_alignment: 'Failed while checking the plan against your task. No actions were started.',
  inference: 'Failed while communicating with the AI service. Your completed steps were saved.',
  verification: 'Failed while checking the result. The action may already be complete.',
  planning: 'Failed while preparing the plan. No actions were started.',
};

export function failureRecoveryMessage(data = {}) {
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  // Provider JSON belongs in diagnostics, rather than the main recovery copy.
  if (message && !/webbrain-cloud error|\{"error"|Error communicating with LLM/i.test(message)) {
    return message.slice(0, 2000);
  }
  return STAGE_MESSAGES[data.stage] || 'The task stopped before it could finish. You can retry from the saved progress.';
}

export function syncFailureRecoveryMessages(assistantEl) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const textEl = assistantEl?.querySelector('.message-text');
  const assistantText = normalize(textEl?.innerText || textEl?.textContent);
  for (const card of assistantEl?.querySelectorAll('.failure-recovery-card') || []) {
    const message = card.querySelector('.failure-recovery-message');
    // Keep transcript text for Copy and history; only hide repeated offer copy.
    if (message) message.hidden = !!assistantText && assistantText === normalize(message.textContent);
  }
}

export function createFailureRecoveryCard(data, { document = globalThis.document, retryLabel = 'Retry' } = {}) {
  if (!data?.recoveryId) return null;
  const card = document.createElement('div');
  card.className = 'failure-recovery-card';
  card.dataset.recoveryId = String(data.recoveryId);
  card.dataset.recoveryStage = String(data.stage || 'inference');
  card.dataset.retryMode = ['publication_without_audit', 'action_monitoring_relaxed'].includes(data.retryMode)
    ? data.retryMode : 'resume';
  card.setAttribute('role', 'alert');

  const message = document.createElement('div');
  message.className = 'failure-recovery-message';
  message.textContent = failureRecoveryMessage(data);
  card.appendChild(message);

  if (['publication_without_audit', 'action_monitoring_relaxed'].includes(card.dataset.retryMode)) {
    const note = document.createElement('div');
    note.className = 'failure-recovery-note';
    note.textContent = card.dataset.retryMode === 'action_monitoring_relaxed'
      ? 'Retry relaxes page-change monitoring once for this task.'
      : 'Retry skips the publication audit once for this unchanged draft.';
    card.appendChild(note);
  }
  if (typeof data.diagnostics === 'string' && data.diagnostics.trim()) {
    const details = document.createElement('details');
    details.className = 'failure-recovery-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Technical details';
    const body = document.createElement('pre');
    body.textContent = data.diagnostics.slice(0, 10000);
    details.append(summary, body);
    card.appendChild(details);
  }

  const actions = document.createElement('div');
  actions.className = 'failure-recovery-actions';
  for (const [choice, label] of [['give_up', 'Give up'], ['retry', retryLabel]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `failure-recovery-action${choice === 'retry' ? ' primary' : ''}`;
    button.dataset.recoveryChoice = choice;
    button.textContent = label;
    actions.appendChild(button);
  }
  const status = document.createElement('div');
  status.className = 'failure-recovery-status';
  status.setAttribute('role', 'status');
  card.append(actions, status);
  return card;
}
