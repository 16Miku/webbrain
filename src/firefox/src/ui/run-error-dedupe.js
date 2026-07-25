/**
 * Normalize an error message for display (collapse whitespace, fallback to 'unknown error').
 * @param {*} message - Raw error message.
 * @returns {string} Normalized message.
 */
export function normalizeRunErrorMessage(message) {
  return String(message || '').replace(/\s+/g, ' ').trim() || 'unknown error';
}

/**
 * Create a unique identity key for a run error.
 * @param {number|string} tabId - Tab ID.
 * @param {string} requestId - Request ID.
 * @param {string} messageKey - Normalized error message key.
 * @returns {string} JSON-encoded identity string.
 */
export function runErrorIdentity(tabId, requestId, messageKey) {
  return JSON.stringify([
    String(tabId ?? ''),
    String(requestId || ''),
    String(messageKey || ''),
  ]);
}

/**
 * Check if a run error has already been seen, and mark it as seen.
 * @param {Object} params - { seenErrors, renderedErrors, tabId, requestId, message }.
 * @returns {boolean} True if this error should be rendered (first occurrence).
 */
export function claimRunError({
  seenErrors = null,
  renderedErrors = [],
  tabId,
  requestId,
  message,
} = {}) {
  const scopedTabId = String(tabId ?? '');
  const scopedRequestId = String(requestId || '');
  const key = normalizeRunErrorMessage(message);
  const identity = runErrorIdentity(scopedTabId, scopedRequestId, key);
  const duplicate = !!scopedRequestId && (
    seenErrors?.has(identity)
    || renderedErrors.some(rendered => (
      String(rendered?.tabId ?? '') === scopedTabId
      && String(rendered?.requestId || '') === scopedRequestId
      && String(rendered?.key || '') === key
    ))
  );
  if (!duplicate && scopedRequestId) seenErrors?.add(identity);
  return { duplicate, identity, key, tabId: scopedTabId, requestId: scopedRequestId };
}
