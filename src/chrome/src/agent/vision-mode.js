// Vision mode setting and per-run resolution (browser-free).
// Shared verbatim by the Chrome and Firefox builds (test/vision-mode.mjs).
//
// Settings → Advanced → "Vision mode" (storage key `visionMode`):
//   'auto' — Act runs see the page as screenshots and act with coordinates
//            whenever the run's model accepts images. This is the default.
//            The option was called On before, so a stored 'on' (or true)
//            reads as 'auto'.
//   'off'  — the accessibility-tree path.
// A run reads the setting once, when it starts, and keeps it to the end.
// Whether vision applies is decided again before every step: a step that
// needs the element inventory (below) runs on the tree path, and the run
// returns to vision, on a fresh full frame, when that need has passed.

import { detectVisionProfile, normalizeVisionQuality } from './vision-budget.js';

export const VISION_MODE_SETTINGS = Object.freeze(['auto', 'off']);
export const DEFAULT_VISION_MODE_SETTING = 'auto';

export function normalizeVisionModeSetting(value, fallback = DEFAULT_VISION_MODE_SETTING) {
  if (value === true) return 'auto';
  if (value === false) return 'off';
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'on') return 'auto';
  if (VISION_MODE_SETTINGS.includes(normalized)) return normalized;
  return VISION_MODE_SETTINGS.includes(fallback) ? fallback : DEFAULT_VISION_MODE_SETTING;
}

/**
 * Whether a run uses vision mode, and why. `provider` is the run's text
 * provider; `rawImage` says whether it receives screenshots directly (a
 * separate describe-only vision model cannot aim clicks, so it does not
 * qualify).
 */
export function resolveVisionMode(setting, {
  mode = 'act',
  provider = null,
  rawImage = null,
  standalone = false,
  selectionOnly = false,
  quality = 'balanced',
  ledgerWorkflow = false,
  completeThreadRead = false,
  nativeChatPage = false,
  uploadHandoff = false,
} = {}) {
  const normalized = normalizeVisionModeSetting(setting);
  const base = { active: false, setting: normalized };
  if (normalized !== 'auto') return { ...base, reason: 'setting_off' };
  if (mode !== 'act') return { ...base, reason: 'not_act_mode' };
  if (standalone) return { ...base, reason: 'standalone_chat' };
  if (selectionOnly) return { ...base, reason: 'selection_scope' };
  // A site workflow whose completion is proved against the app-owned element
  // inventory (adapter-workflow.js requiresLedger) cannot be certified from
  // screenshots: that run keeps the accessibility-tree path.
  if (ledgerWorkflow) return { ...base, reason: 'workflow_needs_element_inventory' };
  // A request for a whole conversation is answered only after trusted
  // coverage through its last page with every message expanded
  // (read-completeness.js), which the accessibility tree proves and
  // screenshots cannot: that run keeps the tree path too.
  if (completeThreadRead) return { ...base, reason: 'complete_thread_read' };
  // WhatsApp Web and Telegram confirm who an open chat is with, and bind the
  // chat they read and send in, through the element inventory (a contact
  // check made with click_ax, chat reads and sends bound to refs): a run on
  // their pages keeps the tree path.
  if (nativeChatPage) return { ...base, reason: 'native_chat_needs_element_inventory' };
  // A vision click opened a native file chooser, which screenshots cannot
  // show or operate: the next steps attach the file with upload_file, which
  // names the input through the element inventory (vision-runtime.js
  // _visionNoteUploadHandoff). The run returns to vision after the upload.
  if (uploadHandoff) return { ...base, reason: 'file_upload_needs_element_inventory' };
  if (!provider) return { ...base, reason: 'no_provider' };
  const canSee = rawImage == null ? provider.supportsVision === true : rawImage === true;
  if (!canSee) return { ...base, reason: 'model_without_images' };
  const profile = detectVisionProfile(provider);
  return {
    active: true,
    setting: normalized,
    reason: 'vision_capable_model',
    profileId: profile.id,
    coordinates: profile.coordinates,
    quality: normalizeVisionQuality(quality),
  };
}
