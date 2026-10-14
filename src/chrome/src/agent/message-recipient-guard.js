// Browser-free normalization and comparison helpers for the direct-message
// recipient guard. This file is mirrored in the Firefox tree; keep both copies
// byte-identical.
//
// Who may receive a message is compared here only as page identities against
// the task's structured target. Consent for anyone else comes from WebBrain's
// own confirmation card with fixed choices, never from reading the words of a
// question or an answer.

export const MESSAGE_TARGET_KINDS = new Set(['named', 'active_conversation']);
export const MESSAGE_RECIPIENT_ROLES = new Set(['to', 'cc', 'bcc']);

// Protected attachments bind one explicit source as well as the conversation.
// Do not authorize the ordinary upload handler's path/id fallback here: a
// failed lookup must not silently attach a different file to a private chat.
export function messageRecipientUploadSourceKey(args = {}) {
  const attachment = typeof args.attachmentId === 'string' ? args.attachmentId.trim() : '';
  const path = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  const hasDownload = args.downloadId != null && args.downloadId !== '';
  if (Number(!!attachment) + Number(!!path) + Number(hasDownload) !== 1) return '';
  if (attachment) return `attachment:${attachment}`;
  if (hasDownload) {
    const id = Number(args.downloadId);
    return Number.isSafeInteger(id) && id >= 0 ? `download:${id}` : '';
  }
  const absolutePath = path.startsWith('/')
    || /^[a-z]:[\\/]/i.test(path)
    || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path);
  return absolutePath && !/[\u0000-\u001f\u007f]/.test(path) ? `path:${path}` : '';
}

function compact(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
// Each identity and role once, at most 16, in the order given.
function normalizedRecipientList(rawRecipients) {
  const recipients = new Map();
  for (const value of (Array.isArray(rawRecipients) ? rawRecipients : []).slice(0, 16)) {
    const legacy = typeof value === 'string' || typeof value === 'number';
    const identity = compact(legacy ? value : (value?.identity ?? value?.recipient), 240);
    const role = compact(legacy ? 'to' : value?.role, 12).toLowerCase();
    const normalized = normalizeRecipientIdentity(identity);
    const key = `${role}:${normalized}`;
    if (identity && normalized && MESSAGE_RECIPIENT_ROLES.has(role) && !recipients.has(key)) {
      recipients.set(key, { identity, role });
    }
  }
  return [...recipients.values()];
}

export function normalizeMessageTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const targetKind = String(value.target_kind || '').trim();
  if (!MESSAGE_TARGET_KINDS.has(targetKind)) return null;
  const recipients = normalizedRecipientList(Array.isArray(value.recipients)
    ? value.recipients
    : [value.recipient]);
  // The open conversation itself has no name here: it is pinned to the
  // identity its page shows before anything is sent. Recipients listed with
  // it are only the people the same request also named.
  if (targetKind === 'active_conversation') {
    return { target_kind: targetKind, recipients };
  }
  return recipients.length
    ? { target_kind: targetKind, recipients }
    : null;
}

// The open conversation, pinned to its verified recipients, together with the
// people the same request also named: one exact set, each identity and role
// once, at most 16.
export function pinnedActiveConversationTarget(activeRecipients, target) {
  const named = normalizeMessageTarget(target);
  const recipients = normalizedRecipientList([
    ...(Array.isArray(activeRecipients) ? activeRecipients : []),
    ...(named?.target_kind === 'active_conversation' ? named.recipients : []),
  ]);
  return recipients.length ? { target_kind: 'named', recipients } : null;
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
  const recipients = new Map();
  for (const value of (Array.isArray(candidates) ? candidates : []).slice(0, 16)) {
    const legacy = typeof value === 'string' || typeof value === 'number';
    const identity = compact(legacy ? value : (value?.identity ?? value?.recipient), 240);
    const role = compact(legacy ? 'to' : value?.role, 12).toLowerCase();
    const normalized = normalizeRecipientIdentity(identity);
    const key = `${role}:${normalized}`;
    if (identity && normalized && MESSAGE_RECIPIENT_ROLES.has(role) && !recipients.has(key)) {
      recipients.set(key, { identity, role });
    }
  }
  if (!normalizedTarget) return false;
  // active_conversation is planner intent, not a dispatch-time identity. A
  // protected adapter must pin it to a concrete named identity before tools
  // run; accepting any later conversation would authorize retargeting.
  if (normalizedTarget.target_kind === 'active_conversation') return false;
  const expected = new Set(normalizedTarget.recipients.map(recipient => (
    `${recipient.role}:${normalizeRecipientIdentity(recipient.identity)}`
  )));
  return expected.size === recipients.size
    && [...expected].every(key => recipients.has(key));
}
