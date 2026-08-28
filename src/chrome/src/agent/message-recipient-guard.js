// Browser-free normalization and comparison helpers for the direct-message
// recipient guard. This file is mirrored in the Firefox tree; keep both copies
// byte-identical.

export const MESSAGE_TARGET_KINDS = new Set(['named', 'active_conversation']);

function compact(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeMessageTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const targetKind = String(value.target_kind || '').trim();
  if (!MESSAGE_TARGET_KINDS.has(targetKind)) return null;
  if (targetKind === 'active_conversation') {
    return { target_kind: targetKind, recipients: [] };
  }
  const recipients = new Map();
  const rawRecipients = Array.isArray(value.recipients)
    ? value.recipients
    : [value.recipient];
  for (const value of rawRecipients.slice(0, 16)) {
    const recipient = compact(value, 240);
    const normalized = normalizeRecipientIdentity(recipient);
    if (recipient && normalized && !recipients.has(normalized)) recipients.set(normalized, recipient);
  }
  return recipients.size
    ? { target_kind: targetKind, recipients: [...recipients.values()] }
    : null;
}

export function normalizeRecipientIdentity(value) {
  const text = compact(value, 240);
  if (!text) return '';
  try {
    return text.normalize('NFKC').toLocaleLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

export function recipientMatchesObservedIdentity(recipient, observedIdentity) {
  const expected = normalizeRecipientIdentity(recipient);
  const observed = normalizeRecipientIdentity(observedIdentity);
  return !!expected && observed === expected;
}

export function messageTargetMatchesObservedIdentities(target, candidates) {
  const normalizedTarget = normalizeMessageTarget(target);
  const identities = new Map();
  for (const value of (Array.isArray(candidates) ? candidates : []).slice(0, 16)) {
    const identity = compact(value, 240);
    const normalized = normalizeRecipientIdentity(identity);
    if (identity && normalized && !identities.has(normalized)) identities.set(normalized, identity);
  }
  if (!normalizedTarget) return false;
  // active_conversation is planner intent, not a dispatch-time identity. A
  // protected adapter must pin it to a concrete named identity before tools
  // run; accepting any later conversation would authorize retargeting.
  if (normalizedTarget.target_kind === 'active_conversation') return false;
  const expected = new Set(normalizedTarget.recipients.map(normalizeRecipientIdentity));
  return expected.size === identities.size
    && [...expected].every(identity => identities.has(identity));
}
