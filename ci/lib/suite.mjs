export function resolveCloudRunId(started = {}) {
  return started.run_id || started.runId || started.id || '';
}

export function suiteShouldFail(totals = {}) {
  return Number(totals.failed || 0) > 0 || Number(totals.skipped || 0) > 0;
}

export function successfulToolResults(trace, toolName) {
  const pending = [];
  const results = [];
  for (const update of trace?.run?.updates || []) {
    const name = update.data?.name || update.data?.tool || '';
    if (update.type === 'tool_call' && name === toolName) {
      pending.push(true);
    } else if (update.type === 'tool_result' && name === toolName && pending.length) {
      pending.shift();
      const result = update.data?.result;
      if (result?.success === true) results.push(result);
    }
  }
  return results;
}

const CONFIG_REJECTED_LIST_KEYS = [
  'ignoredKeys', 'ignored_keys', 'ignored',
  'rejected', 'rejectedKeys', 'rejected_keys',
  'unsupported', 'unsupportedKeys', 'unsupported_keys',
  'failed', 'failedKeys', 'failed_keys',
  'invalid', 'invalidKeys', 'invalid_keys',
];
const CONFIG_APPLIED_LIST_KEYS = ['accepted', 'applied', 'appliedKeys', 'applied_keys'];
const CONFIG_OK_STATUSES = new Set(['ok', 'applied', 'success', 'succeeded', 'complete', 'completed']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function settingName(entry) {
  const value = isPlainObject(entry)
    ? String(entry.key ?? entry.name ?? entry.setting ?? entry.field ?? '')
    : String(entry ?? '');
  return value.replace(/^settings\./, '');
}

/**
 * A scenario's `session_settings` are load-bearing, not cosmetic:
 * `strictSecretMode` is the only thing keeping a password, mailbox token, and
 * OTP out of the updates that get published back to the cloud. Provisioning
 * reports what it applied, and ignoring that report means a rejected setting
 * silently downgrades the run to its default. Returns '' when every required
 * setting is confirmed applied, or the reason it could not be confirmed.
 */
export function unappliedSessionSettings(configResult, requiredSettings = {}) {
  const required = Object.keys(requiredSettings || {});
  if (!required.length) return '';
  if (!isPlainObject(configResult)) {
    return 'provisioning returned no webbrain_config_result to confirm them';
  }
  if (configResult.ok === false || configResult.success === false) {
    return 'provisioning reported the configuration as not applied';
  }
  const status = String(configResult.status || '').toLowerCase();
  if (status && !CONFIG_OK_STATUSES.has(status)) {
    return `provisioning reported configuration status "${configResult.status}"`;
  }

  // webbrain.cloud keeps security properties platform-managed. It therefore
  // reports the requested field as ignored, but separately attests the value
  // that the managed runtime forces on every launch. An attested value is
  // stronger evidence than an echoed import list; a conflicting value must
  // still fail closed.
  const enforced = isPlainObject(configResult.enforced) ? configResult.enforced : null;
  const enforcedNames = new Set();
  if (enforced) {
    const mismatched = required.filter((name) => (
      Object.hasOwn(enforced, name)
      && JSON.stringify(enforced[name]) !== JSON.stringify(requiredSettings[name])
    ));
    if (mismatched.length) return `provisioning enforced the wrong value for ${mismatched.join(', ')}`;
    for (const name of required) {
      if (Object.hasOwn(enforced, name)) enforcedNames.add(name);
    }
  }
  const pending = required.filter((name) => !enforcedNames.has(name));
  if (!pending.length) return '';

  const rejected = new Set();
  for (const key of CONFIG_REJECTED_LIST_KEYS) {
    if (Array.isArray(configResult[key])) {
      for (const entry of configResult[key]) rejected.add(settingName(entry));
    }
  }
  const refused = pending.filter((name) => rejected.has(name));
  if (refused.length) return `provisioning did not apply ${refused.join(', ')}`;

  // An echoed settings object confirms the value, not just the key — prefer it.
  const echoed = [configResult.settings, configResult.applied, configResult.appliedSettings]
    .find(isPlainObject);
  if (echoed) {
    const mismatched = pending.filter((name) => (
      !Object.hasOwn(echoed, name)
      || JSON.stringify(echoed[name]) !== JSON.stringify(requiredSettings[name])
    ));
    return mismatched.length ? `provisioning did not apply ${mismatched.join(', ')}` : '';
  }
  const appliedList = CONFIG_APPLIED_LIST_KEYS
    .map((key) => configResult[key])
    .find(Array.isArray);
  if (appliedList) {
    const names = new Set(appliedList.map(settingName));
    const missing = pending.filter((name) => !names.has(name));
    return missing.length ? `provisioning did not confirm ${missing.join(', ')}` : '';
  }
  return 'provisioning did not report which settings were applied';
}

export function buildSessionSettings(capsolverApiKey = '', overrides = {}) {
  return {
    wbLocale: 'en',
    useSiteAdapters: true,
    autoScreenshot: 'state_change',
    maxAgentSteps: 195,
    requestTimeoutMs: 180_000,
    verboseMode: true,
    enableAllPackagedSkills: true,
    askBeforeConsequentialActions: false,
    captchaSolverEnabled: Boolean(capsolverApiKey),
    ...(capsolverApiKey ? { capsolverApiKey } : {}),
    ...overrides,
  };
}
