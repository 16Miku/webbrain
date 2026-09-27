export const STAGED_SCREENSHOT_STORAGE_PREFIX = 'stagedScreenshotAttachments:';

function storagePrefix(tabId) {
  const numericTabId = Number(tabId);
  return Number.isFinite(numericTabId)
    ? `${STAGED_SCREENSHOT_STORAGE_PREFIX}${numericTabId}:`
    : '';
}

function storageKey(tabId, stagedAttachmentId) {
  const prefix = storagePrefix(tabId);
  const id = String(stagedAttachmentId || '');
  return prefix && /^screenshot-[A-Za-z0-9-]{8,160}$/.test(id)
    ? `${prefix}${id}`
    : '';
}

function normalizeRecord(attachment) {
  const stagedAttachmentId = String(attachment?.stagedAttachmentId || '');
  const dataUrl = String(attachment?.dataUrl || '');
  const modelDataUrl = String(attachment?.modelDataUrl || '');
  const size = Number(attachment?.size);
  if (!/^screenshot-[A-Za-z0-9-]{8,160}$/.test(stagedAttachmentId)
      || !/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)
      || (modelDataUrl && !/^data:image\/(?:png|jpeg);base64,/i.test(modelDataUrl))
      || !(Number.isFinite(size) && size > 0)) return null;
  const deliveryState = attachment?.deliveryState === 'sending' ? 'sending' : 'pending';
  return {
    version: 1,
    kind: 'image',
    source: 'slash_screenshot',
    stagedAttachmentId,
    dataUrl,
    name: String(attachment?.name || 'webbrain-screenshot.png').slice(0, 240),
    mimeType: String(attachment?.mimeType || '').startsWith('image/jpeg') ? 'image/jpeg' : 'image/png',
    size,
    capturedAt: Number(attachment?.capturedAt) || Date.now(),
    fullPage: attachment?.fullPage === true,
    redactionSnapshotReady: attachment?.redactionSnapshotReady === true,
    modelRedactionReady: attachment?.modelRedactionReady === true,
    deliveryState,
    ...(deliveryState === 'sending' && attachment?.requestId
      ? { requestId: String(attachment.requestId).slice(0, 200) }
      : {}),
    ...(attachment?.redactionSnapshot ? { redactionSnapshot: attachment.redactionSnapshot } : {}),
    ...(attachment?.modelRedactionReady === true && modelDataUrl ? { modelDataUrl } : {}),
    ...(attachment?.fullPage === true && attachment?.captureBounds
      ? { captureBounds: attachment.captureBounds }
      : {}),
  };
}

// Enumerate this tab's record keys without deserializing the whole area: every
// staged record carries multi-megabyte screenshot pixels for every tab, and
// these reads run on tab switch and on every reconnect probe. getKeys() returns
// names only; older engines without it fall back to the full enumeration.
async function stagedScreenshotKeys(storageArea, prefix) {
  if (typeof storageArea.getKeys === 'function') {
    try {
      const keys = await storageArea.getKeys();
      if (Array.isArray(keys)) return keys.filter(key => key.startsWith(prefix));
    } catch { /* fall through to the full enumeration */ }
  }
  const stored = await storageArea.get(null);
  return Object.keys(stored || {}).filter(key => key.startsWith(prefix));
}

export async function loadStagedScreenshots(storageArea, tabId) {
  const prefix = storagePrefix(tabId);
  if (!prefix) return [];
  const keys = await stagedScreenshotKeys(storageArea, prefix);
  if (!keys.length) return [];
  const stored = await storageArea.get(keys);
  return Object.entries(stored || {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => {
      const record = normalizeRecord(value);
      return record && key === storageKey(tabId, record.stagedAttachmentId) ? record : null;
    })
    .filter(Boolean);
}

export async function saveStagedScreenshot(storageArea, tabId, attachment) {
  const record = normalizeRecord({ ...attachment, deliveryState: 'pending' });
  const key = storageKey(tabId, record?.stagedAttachmentId);
  if (!key || !record) return false;
  await storageArea.set({ [key]: record });

  // A resolved set is not enough evidence for the UI claim: verify that the
  // exact pixels can be read back before calling the screenshot staged.
  const stored = await storageArea.get(key);
  const verified = normalizeRecord(stored?.[key]);
  return !!verified
    && verified.stagedAttachmentId === record.stagedAttachmentId
    && verified.size === record.size
    && verified.dataUrl === record.dataUrl
    && verified.modelRedactionReady === record.modelRedactionReady
    && String(verified.modelDataUrl || '') === String(record.modelDataUrl || '')
    && verified.deliveryState === 'pending';
}

export async function markStagedScreenshots(storageArea, tabId, attachments, {
  deliveryState = 'pending',
  requestId = '',
} = {}) {
  const screenshotAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter(attachment => attachment?.source === 'slash_screenshot');
  if (!screenshotAttachments.length) return true;
  const existing = new Map(
    (await loadStagedScreenshots(storageArea, tabId))
      .map(record => [record.stagedAttachmentId, record]),
  );
  const update = {};
  for (const attachment of screenshotAttachments) {
    const id = String(attachment?.stagedAttachmentId || '');
    const current = existing.get(id);
    const key = storageKey(tabId, id);
    if (!current || !key) return false;
    update[key] = normalizeRecord({
      ...current,
      deliveryState,
      requestId: deliveryState === 'sending' ? requestId : '',
    });
  }
  await storageArea.set(update);
  const verified = await storageArea.get(Object.keys(update));
  return Object.entries(update).every(([key, expected]) => {
    const actual = normalizeRecord(verified?.[key]);
    return !!actual
      && actual.stagedAttachmentId === expected.stagedAttachmentId
      && actual.dataUrl === expected.dataUrl
      && actual.modelRedactionReady === expected.modelRedactionReady
      && String(actual.modelDataUrl || '') === String(expected.modelDataUrl || '')
      && actual.deliveryState === expected.deliveryState
      && String(actual.requestId || '') === String(expected.requestId || '');
  });
}

export async function removeStagedScreenshot(storageArea, tabId, stagedAttachmentId) {
  const key = storageKey(tabId, stagedAttachmentId);
  if (key) await storageArea.remove(key);
}

export async function removeStagedScreenshots(storageArea, tabId, attachments) {
  const keys = (Array.isArray(attachments) ? attachments : [])
    .map(attachment => storageKey(tabId, attachment?.stagedAttachmentId))
    .filter(Boolean);
  if (keys.length) await storageArea.remove(keys);
}

export async function clearStagedScreenshots(storageArea, tabId) {
  const prefix = storagePrefix(tabId);
  if (!prefix) return;
  const keys = await stagedScreenshotKeys(storageArea, prefix);
  if (keys.length) await storageArea.remove(keys);
}
