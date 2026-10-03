// Passive, task-bound signup progress. Never stores field values, credentials,
// CAPTCHA answers or selectors, and never dispatches a browser action.
const FIELDS = new Set(['email', 'password', 'username', 'fullname', 'twitter', 'github', 'linkedin', 'homepage', 'details']);
const ACTIVE_GATES = new Set(['solve_required', 'manual_required', 'verification_pending']);
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function huggingFaceSignupUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port
      && ['huggingface.co', 'www.huggingface.co'].includes(url.hostname)
      && /^\/join\/?$/.test(url.pathname) ? `${url.origin}/join` : '';
  } catch { return ''; }
}

function avatarHandle(value) {
  if (Number.isSafeInteger(value?.downloadId) && value.downloadId > 0) return { downloadId: value.downloadId };
  if (typeof value?.attachmentId === 'string' && /^[\w:-]{1,120}$/.test(value.attachmentId)) return { attachmentId: value.attachmentId };
  return null;
}

export function normalizeHuggingFaceSignupRecovery(value, now = Date.now()) {
  if (!value || !huggingFaceSignupUrl(value.url) || typeof value.taskKey !== 'string'
      || !value.taskKey || value.taskKey.length > 120 || !Number.isFinite(value.updatedAt)
      || now - value.updatedAt > MAX_AGE_MS || value.updatedAt > now + 60_000) return null;
  return {
    url: huggingFaceSignupUrl(value.url), taskKey: value.taskKey, updatedAt: value.updatedAt,
    stage: ['credentials', 'profile'].includes(value.stage) ? value.stage : 'unknown',
    sawProfile: value.sawProfile === true,
    fields: [...new Set((Array.isArray(value.fields) ? value.fields : []).filter(field => FIELDS.has(field)))],
    avatar: avatarHandle(value.avatar),
    interrupted: value.interrupted === true, challengeActive: value.challengeActive === true,
    recovering: value.recovering === true, submitted: value.submitted === true,
  };
}

function rootFormStage(name, args, result) {
  // A scoped subtree or an unrelated tool's prose cannot prove a signup reset.
  if (name !== 'get_accessibility_tree' || !['visible', 'interactive'].includes(args.filter || 'all')
      || args.ref_id || Number(args.page || 1) !== 1
      || args.frameId || args.framePath || args.selector || result?.success === false || result?.error) return '';
  const text = typeof result?.pageContent === 'string' ? result.pageContent : '';
  const field = name => new RegExp(`^\\s*textbox[^\\n]*field_name="${name}"`, 'm').test(text);
  if (field('username') && field('fullname')) return 'profile';
  if (field('email') && field('password')) return 'credentials';
  return '';
}

export function advanceHuggingFaceSignupRecovery(previous, {
  url, taskKey, name, args = {}, result = {}, gate = null, submitted = false, now = Date.now(),
}) {
  const signupUrl = huggingFaceSignupUrl(url);
  if (!signupUrl || !taskKey) return null;
  let state = normalizeHuggingFaceSignupRecovery(previous, now);
  if (state?.url !== signupUrl || state?.taskKey !== taskKey) state = null;
  const stage = rootFormStage(name, args, result);
  if (!state && !stage) return null;
  state ||= { url: signupUrl, taskKey, stage, sawProfile: false, fields: [], avatar: null,
    interrupted: false, challengeActive: false, recovering: false, submitted: false };
  state.updatedAt = now;
  if (ACTIVE_GATES.has(gate?.status)) {
    state.interrupted = true;
    state.challengeActive = true;
  } else if (gate?.status === 'cleared') {
    state.challengeActive = false;
  }
  if (stage && !state.challengeActive) {
    if (state.interrupted && state.sawProfile && stage === 'credentials') state.recovering = true;
    state.stage = stage;
    state.sawProfile ||= stage === 'profile';
  }
  if (!state.challengeActive && result?.success === true && result.dispatched !== false && !result.noDispatch) {
    if (['set_field', 'type_ax'].includes(name) && result.verified === true && FIELDS.has(result.fieldMeta?.name)) {
      state.fields = [...new Set([...state.fields, result.fieldMeta.name])];
    }
    if (name === 'upload_file' && state.stage === 'profile'
        && ['input_attached', 'page_consumed'].includes(result.attachmentState)) {
      state.avatar = avatarHandle(args) || state.avatar;
    }
  }
  if (submitted && state.stage === 'profile' && result?.success === true
      && result.dispatched !== false && !result.noDispatch) state.submitted = true;
  return normalizeHuggingFaceSignupRecovery(state, now);
}

export function huggingFaceSignupRecoveryNote(value) {
  const state = normalizeHuggingFaceSignupRecovery(value);
  if (!state?.interrupted) return '';
  const checkpoint = `Previously filled fields: ${state.fields.join(', ') || 'none recorded'}.`
    + (state.avatar ? ` Previously attached avatar handle: ${JSON.stringify(state.avatar)}.` : '');
  if (state.challengeActive) {
    return `\n[HUGGING FACE SIGNUP RECOVERY: An observed CAPTCHA interrupted this signup. ${checkpoint} Follow the runtime CAPTCHA gate; do not refill, resubmit, or navigate while it blocks those actions. Only perform a recovery reload when the runtime explicitly requests it, then read the current root form. A cookie or solved challenge is not proof of account creation.]`;
  }
  if (!state.recovering) {
    return '\n[HUGGING FACE SIGNUP RECOVERY: The CAPTCHA gate cleared. Inspect the current stage and continue the existing form or email-verification flow. Do not restart signup or reload merely because a challenge occurred; account creation still requires site evidence.]';
  }
  return `\n[HUGGING FACE SIGNUP RECOVERY: A fresh root form shows signup returned to the credentials step after a CAPTCHA interruption. ${checkpoint} Resume the visible stage using only values from the original user request; preserve fields already filled and use fresh refs. At the profile step, restore only missing requested details and reattach the original avatar only if absent (reuse the recorded handle if still available; otherwise use the user-provided source). ${state.submitted ? 'The earlier Create Account submission is unconfirmed. ' : ''}Before repeating Create Account, reconcile any signed-in, verification-pending, or already-registered evidence; continue verification/sign-in for the same account when established, and stop if the outcome remains uncertain. Never create a different account, blindly replay a submission, or buy another solve outside the runtime gate.]`;
}
