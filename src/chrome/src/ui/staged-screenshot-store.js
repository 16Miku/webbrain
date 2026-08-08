export const STAGED_SCREENSHOT_STORAGE_PREFIX = 'stagedScreenshotAttachments:';

function storageKey(tabId) {
  const numericTabId = Number(tabId);
  return Number.isFinite(numericTabId)
    ? `${STAGED_SCREENSHOT_STORAGE_PREFIX}${numericTabId}`
    : '';
}

function normalizeRecord(attachment) {
  const stagedAttachmentId = String(attachment?.stagedAttachmentId || '');
  const dataUrl = String(attachment?.dataUrl || '');
  const size = Number(attachment?.size);
  if (!/^screenshot-[A-Za-z0-9-]{8,160}$/.test(stagedAttachmentId)
      || !/^data:image\/(?:png|jpeg);base64,/i.test(dataUrl)
      || !(Number.isFinite(size) && size > 0)) return null;
  return {
    version: 1,
    stagedAttachmentId,
    dataUrl,
    name: String(attachment?.name || 'webbrain-screenshot.png').slice(0, 240),
    mimeType: String(attachment?.mimeType || '').startsWith('image/jpeg') ? 'image/jpeg' : 'image/png',
    size,
    capturedAt: Number(attachment?.capturedAt) || Date.now(),
    fullPage: attachment?.fullPage === true,
    redactionSnapshotReady: attachment?.redactionSnapshotReady === true,
    ...(attachment?.redactionSnapshot ? { redactionSnapshot: attachment.redactionSnapshot } : {}),
    ...(attachment?.fullPage === true && attachment?.captureBounds
      ? { captureBounds: attachment.captureBounds }
      : {}),
  };
}

export async function loadStagedScreenshots(storageArea, tabId) {
  const key = storageKey(tabId);
  if (!key) return [];
  const stored = await storageArea.get(key);
  return (Array.isArray(stored?.[key]) ? stored[key] : [])
    .map(normalizeRecord)
    .filter(Boolean);
}

export async function saveStagedScreenshot(storageArea, tabId, attachment) {
  const key = storageKey(tabId);
  const record = normalizeRecord(attachment);
  if (!key || !record) return false;
  const existing = await loadStagedScreenshots(storageArea, tabId);
  const next = existing.filter(item => item.stagedAttachmentId !== record.stagedAttachmentId);
  next.push(record);
  await storageArea.set({ [key]: next });

  // A resolved set is not enough evidence for the UI claim: verify that the
  // exact pixels can be read back before calling the screenshot staged.
  const verified = await loadStagedScreenshots(storageArea, tabId);
  return verified.some(item => (
    item.stagedAttachmentId === record.stagedAttachmentId
    && item.size === record.size
    && item.dataUrl === record.dataUrl
  ));
}

export async function removeStagedScreenshot(storageArea, tabId, stagedAttachmentId) {
  const key = storageKey(tabId);
  if (!key) return;
  const existing = await loadStagedScreenshots(storageArea, tabId);
  const next = existing.filter(item => item.stagedAttachmentId !== String(stagedAttachmentId || ''));
  if (next.length) await storageArea.set({ [key]: next });
  else await storageArea.remove(key);
}

export async function replaceStagedScreenshots(storageArea, tabId, attachments) {
  const key = storageKey(tabId);
  if (!key) return;
  const next = (Array.isArray(attachments) ? attachments : [])
    .map(normalizeRecord)
    .filter(Boolean);
  if (next.length) await storageArea.set({ [key]: next });
  else await storageArea.remove(key);
}

export async function clearStagedScreenshots(storageArea, tabId) {
  const key = storageKey(tabId);
  if (key) await storageArea.remove(key);
}
