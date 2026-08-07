import {
  compileSuccessfulWorkflowByRunId,
  normalizeSavedWorkflow,
} from './agent/workflows.js';

const DEFAULT_CLOUD_BRIDGE_URL = 'ws://127.0.0.1:17373/extension';
const CLOUD_RUN_STORAGE_KEY = 'webbrainCloudRunSnapshots';
const CLOUD_UPDATE_LIMIT = 200;
const CLOUD_RUN_LIMIT = 50;
const CLOUD_STRING_LIMIT = 16 * 1024;
const CLOUD_RUN_PERSIST_BYTES_LIMIT = 256 * 1024;
const CLOUD_PERSIST_BYTES_LIMIT = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
// Suffix match on normalized keys (non-alnum stripped). Avoid bare `pin` as a
// suffix — it over-matches `spin`, `mapPin`, etc. Short exact keys live in the set.
const SENSITIVE_CLOUD_KEY = /(?:authorization|cookie|password|passwd|passphrase|passcode|pincode|secret|credential|privatekey|apikey|token|accesskeyid|secretaccesskey)$/i;
const SENSITIVE_CLOUD_KEY_EXACT = new Set(['pin', 'otp', 'cvv', 'cvc', 'ssn']);
const LARGE_IMAGE_KEY = /(?:attachimage|screenshot|image|imagedata|dataurl)$/i;
const CLOUD_TEXT_ENTRY_TOOLS = new Set(['set_field', 'type_ax', 'type_text', 'iframe_type']);
const VERIFY_FORM_VALUE_KEYS = new Set(['value', 'controlvalue', 'valueprefix', 'valuesuffix']);
// Strict-secret mode is deny-by-default: an update leaves the browser carrying
// only the evidence a cloud caller needs to score the run. A per-tool allowlist
// is the wrong shape here — a secret typed into a visible field comes straight
// back out of the next page read, and model prose repeats it in plain text.
// These are the narrow carve-outs that survive, keyed by what grading reads.
const CLOUD_STRICT_MODEL_TEXT_TYPES = new Set(['text', 'text_delta']);
// `error` and `run_status` carry the model's final response as `message`.
const CLOUD_STRICT_DROPPED_MESSAGE_TYPES = new Set(['error', 'run_status']);
// done_json and verify_form keep their shape through dedicated value-level
// redactors below; every other tool result is reduced to a bare envelope.
const CLOUD_STRICT_STRUCTURED_RESULT_TOOLS = new Set(['done_json', 'verify_form']);
// Scalar, non-page-derived argument keys. `fetch_url` is handled separately so
// its URL is reduced to origin + path root rather than dropped.
const CLOUD_STRICT_ARG_EVIDENCE_KEYS = new Set(['skill_id', 'method', 'url_origin', 'url_path_root']);
// A caller has to read a clarification to answer it, so `clarify` cannot be
// blanked the way model prose is. Prompt instructions are not a redaction
// boundary either, so strict runs additionally redact by *value*: every secret
// this run typed into a page is remembered and struck from the text of every
// later update, clarifications included. That leaves a usable question while
// removing the literal the key-based scrubber cannot recognize.
const CLOUD_STRICT_SECRET_VALUE_LIMIT = 256;
// Short values would mangle ordinary prose on a coincidental substring match.
// Numeric PIN/CVV fragments are still security-sensitive, so they are tracked
// with boundary-aware replacement below.
const CLOUD_STRICT_SECRET_MIN_LENGTH = 4;
const WORKFLOW_PARAMETER_VALUE_LIMIT = 10_000;

function cloudRunError(message, status) {
  return Object.assign(new Error(message), { status });
}

export function normalizeCloudRunMode(value, fallback = 'act') {
  const mode = String(value ?? '').trim().toLowerCase();
  if (!mode) return fallback;
  if (!['ask', 'act'].includes(mode)) {
    throw cloudRunError('Cloud run `mode` must be `ask` or `act`.', 400);
  }
  return mode;
}

function normalizedCloudKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '');
}

export function normalizeCloudBridgeUrl(value = DEFAULT_CLOUD_BRIDGE_URL) {
  const url = new URL(String(value || DEFAULT_CLOUD_BRIDGE_URL));
  const host = url.hostname.toLowerCase();
  // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
  // hostname "[::1]", so both spellings must be allowlisted (same as
  // LOCAL_OLLAMA_HOSTS in ollama-handoff.js).
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('WebBrain cloud bridge URL must use ws:// on localhost.');
  }
  return url.href;
}

function isSensitiveCloudKey(key) {
  const normalizedKey = normalizedCloudKey(key);
  if (!normalizedKey) return false;
  return SENSITIVE_CLOUD_KEY.test(normalizedKey) || SENSITIVE_CLOUD_KEY_EXACT.has(normalizedKey);
}

function scrubCloudValue(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      const normalizedKey = normalizedCloudKey(key);
      if (normalizedKey && isSensitiveCloudKey(key)) {
        return '[redacted]';
      }
      if (typeof item === 'string' && /^data:image\//i.test(item)) {
        return `[image omitted: ${item.length} chars]`;
      }
      if (LARGE_IMAGE_KEY.test(normalizedKey) && typeof item === 'string' && item.length > 500) {
        return `[large payload omitted: ${item.length} chars]`;
      }
      if (typeof item === 'string' && item.length > CLOUD_STRING_LIMIT) {
        return `${item.slice(0, CLOUD_STRING_LIMIT)}\n[truncated ${item.length - CLOUD_STRING_LIMIT} chars for cloud persistence]`;
      }
      return item;
    }));
  } catch {
    return { unserializable: true };
  }
}

function cloudUrlEvidence(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return {};
    const firstSegment = url.pathname.split('/').filter(Boolean)[0] || '';
    return {
      url_origin: url.origin,
      url_path_root: firstSegment ? `/${firstSegment}` : '/',
    };
  } catch {
    return {};
  }
}

function redactVerifyFormValues(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => (
      VERIFY_FORM_VALUE_KEYS.has(normalizedCloudKey(key).toLowerCase())
        ? '[redacted form value]'
        : item
    )));
  } catch {
    return { success: false, sensitivePayloadRedacted: true };
  }
}

// Every leaf a secret can be encoded in goes, not just strings: a six-digit OTP
// serialized as `verification_code: 481920` is a number, and no key pattern
// recognizes that field name. Booleans and null survive because neither can
// carry a credential — which is also what makes a strict structured run
// gradable, since a `true` outcome flag comes through intact. A strict run's
// structured output is therefore assertable on booleans only.
function redactStrictStructuredValues(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string') return '[redacted strict value]';
      if (typeof item === 'number' || typeof item === 'bigint') return '[redacted strict number]';
      return item;
    }));
  } catch {
    return { sensitivePayloadRedacted: true };
  }
}

function cloudSafeUpdateData(type, data, { strictSecretMode = false } = {}) {
  if (!data || typeof data !== 'object') return data;
  const name = String(data.name || data.tool || '');
  if (strictSecretMode && CLOUD_STRICT_MODEL_TEXT_TYPES.has(type)) {
    return {
      ...data,
      ...(Object.hasOwn(data, 'content') ? { content: '[redacted strict text]' } : {}),
    };
  }
  if (strictSecretMode && CLOUD_STRICT_DROPPED_MESSAGE_TYPES.has(type)) {
    // Dropped rather than replaced so the run-level fallbacks below still pick
    // their own descriptive constant instead of storing a placeholder.
    const { message: _message, ...rest } = data;
    return rest;
  }
  if (!strictSecretMode && type === 'tool_call' && CLOUD_TEXT_ENTRY_TOOLS.has(name)) {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    return {
      ...data,
      args: {
        ...args,
        ...(Object.hasOwn(args, 'text') ? { text: '[redacted typed text]' } : {}),
        ...(Object.hasOwn(args, 'value') ? { value: '[redacted typed text]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_call' && name === 'fetch_url') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    const method = String(args.method || '').toUpperCase();
    return {
      ...data,
      args: {
        ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? { method } : {}),
        ...cloudUrlEvidence(args.url),
        ...(Object.hasOwn(args, 'body') ? { body: '[redacted request body]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'fetch_url') {
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        success: result.success === true,
        ...(Number.isFinite(Number(result.status)) ? { status: Number(result.status) } : {}),
        sensitivePayloadRedacted: true,
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'verify_form') {
    return {
      ...data,
      result: redactVerifyFormValues(data.result),
    };
  }
  if (strictSecretMode && type === 'tool_call' && name === 'done_json') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    return {
      ...data,
      args: {
        ...args,
        ...(Object.hasOwn(args, 'result') ? { result: redactStrictStructuredValues(args.result) } : {}),
        ...(Object.hasOwn(args, 'summary') ? { summary: '[redacted strict summary]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'done_json') {
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        ...result,
        ...(Object.hasOwn(result, 'result') ? { result: redactStrictStructuredValues(result.result) } : {}),
        ...(Object.hasOwn(result, 'cloudResult') ? { cloudResult: redactStrictStructuredValues(result.cloudResult) } : {}),
        ...(Object.hasOwn(result, 'invalidResult') ? { invalidResult: redactStrictStructuredValues(result.invalidResult) } : {}),
        ...(Object.hasOwn(result, 'summary') ? { summary: '[redacted strict summary]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_call') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    const evidence = Object.fromEntries(Object.entries(args).filter(([key, value]) => (
      CLOUD_STRICT_ARG_EVIDENCE_KEYS.has(key) && (typeof value !== 'object' || value === null)
    )));
    return {
      ...data,
      args: { ...evidence, sensitiveArgsRedacted: true },
    };
  }
  if (strictSecretMode && type === 'tool_result' && !CLOUD_STRICT_STRUCTURED_RESULT_TOOLS.has(name)) {
    // Any read tool echoes back whatever was typed into the page, so success
    // and HTTP status are all a result may carry out of a strict run.
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        success: result.success === true,
        ...(Number.isFinite(Number(result.status)) ? { status: Number(result.status) } : {}),
        sensitivePayloadRedacted: true,
      },
    };
  }
  return data;
}

// Walks a raw tool result for string or numeric values sitting under a key the
// scrubber already treats as sensitive. Depth-bounded: a page read can be
// enormous, and this runs on every update.
function collectSensitiveStrings(value, into, depth = 0, sensitiveParent = false) {
  if (depth > 6 || into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  if (typeof value === 'string') {
    if (sensitiveParent) into.push(value);
    return;
  }
  if (typeof value === 'number') {
    if (sensitiveParent && Number.isFinite(value)) into.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, into, depth + 1, sensitiveParent);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    collectSensitiveStrings(
      item,
      into,
      depth + 1,
      sensitiveParent || isSensitiveCloudKey(key),
    );
    if (into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  }
}

// A request body is a string argument, so the key-walk above cannot see into
// it. Both encodings a mutating call realistically uses are cheap to parse.
function collectRequestBodySecrets(body, into) {
  if (typeof body !== 'string' || !body || body.length > WORKFLOW_PARAMETER_VALUE_LIMIT) return;
  try {
    collectSensitiveStrings(JSON.parse(body), into);
    return;
  } catch {
    // Not JSON — fall through to the form encoding.
  }
  try {
    for (const [key, value] of new URLSearchParams(body)) {
      if (isSensitiveCloudKey(key)) into.push(value);
    }
  } catch {
    // Undecodable body: nothing to register, and the argument is dropped anyway.
  }
}

function redactWorkflowRuntimeValues(value, runtimeValues = [], label = '[workflow parameter]') {
  if (value == null) return value;
  const variants = new Set();
  for (const parameterValue of runtimeValues) {
    if (typeof parameterValue !== 'string' || !parameterValue.length) continue;
    variants.add(parameterValue);
    try {
      const componentEncoded = encodeURIComponent(parameterValue);
      variants.add(componentEncoded);
      variants.add(componentEncoded.replace(/%20/g, '+'));
      variants.add(encodeURI(parameterValue));
      const formEncoded = new URLSearchParams([['value', parameterValue]])
        .toString()
        .slice('value='.length);
      variants.add(formEncoded);
    } catch {
      // Raw replacement above still protects malformed strings that URI
      // encoders cannot represent (for example, lone UTF-16 surrogates).
    }
  }
  const values = [...variants]
    .sort((a, b) => b.length - a.length);
  if (!values.length) return value;
  const normalizePercentEscapes = input => input.replace(
    /%[0-9a-f]{2}/gi,
    match => match.toUpperCase(),
  );
  const redactString = (input) => values.reduce((text, parameterValue) => {
    const normalizedText = normalizePercentEscapes(text);
    const normalizedValue = normalizePercentEscapes(parameterValue);
    if (!normalizedText.includes(normalizedValue)) return text;
    let result = '';
    let offset = 0;
    let index = normalizedText.indexOf(normalizedValue, offset);
    while (index !== -1) {
      const boundaryMatch = parameterValue.length >= CLOUD_STRICT_SECRET_MIN_LENGTH
        || (
          (index === 0 || !/[A-Za-z0-9]/.test(normalizedText[index - 1]))
          && (
            index + normalizedValue.length === normalizedText.length
            || !/[A-Za-z0-9]/.test(normalizedText[index + normalizedValue.length])
          )
        );
      if (!boundaryMatch) {
        const nextOffset = index + normalizedValue.length;
        result += text.slice(offset, nextOffset);
        offset = nextOffset;
        index = normalizedText.indexOf(normalizedValue, offset);
        continue;
      }
      result += `${text.slice(offset, index)}${label}`;
      offset = index + parameterValue.length;
      index = normalizedText.indexOf(normalizedValue, offset);
    }
    return result + text.slice(offset);
  }, input);
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      // A secret typed as text can come back as a JSON number — a six-digit OTP
      // is the obvious case. Match on the number's exact string form: a
      // substring rule would strike an unrelated `3` out of `481920`.
      typeof item === 'number' && values.includes(String(item))
        ? label
        : (typeof item === 'string' ? redactString(item) : item)
    )));
  } catch {
    return { unserializable: true };
  }
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function compactCloudRunForPersistence(run) {
  const row = scrubCloudValue(run);
  row.structured = row.structured ?? !!run?.outputSchema;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  const omittedUpdates = Array.isArray(row.updates) ? row.updates.length : 0;
  row.updates = [];
  row.persistenceTruncated = { omittedUpdates };
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  row.content = '';
  row.outputSchema = null;
  row.persistenceTruncated.omittedContent = true;
  row.persistenceTruncated.omittedSchema = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  delete row.result;
  row.persistenceTruncated.omittedResult = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  return scrubCloudValue({
    runId: run?.runId,
    status: run?.status,
    workflowId: run?.workflowId || null,
    traceRunId: run?.traceRunId || null,
    parentRunId: run?.parentRunId || null,
    mode: run?.mode || 'act',
    captchaDiagnostics: run?.captchaDiagnostics || null,
    tabId: run?.tabId,
    task: run?.task,
    structured: !!run?.outputSchema || run?.structured === true,
    pendingInput: run?.pendingInput || null,
    summary: run?.summary,
    content: '',
    finalUrl: run?.finalUrl,
    error: run?.error,
    createdAt: run?.createdAt,
    updatedAt: run?.updatedAt,
    completedAt: run?.completedAt,
    updates: [],
    persistenceTruncated: { omittedUpdates, omittedResult: true, omittedSchema: true },
  });
}

/**
 * Scheduled jobs answer a cloud query over the same bridge as run updates, so
 * they need the same strict-secret treatment: a summarized job otherwise ships
 * `lastResult`, `lastError`, `pendingClarify`, `target.url`, and
 * `watch.lastObservation` — a child task's raw prompt and output — straight past
 * every redaction applied to the parent run. Strict mode keeps only structural
 * and enumerated fields; free text and URLs are dropped.
 */
export function cloudSafeScheduledJob(job, { strictSecretMode = false } = {}) {
  if (!job || !strictSecretMode) return job;
  return {
    id: job.id,
    kind: job.kind,
    source: job.source || null,
    status: job.status,
    scheduledAt: job.scheduledAt,
    nextRunAt: job.nextRunAt || job.scheduledAt,
    lastOutcome: job.lastOutcome || null,
    needsUserInput: job.needsUserInput === true,
    clarificationRequired: job.clarificationRequired === true,
    completedAt: job.completedAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    sensitiveFieldsRedacted: true,
  };
}

export function buildCloudPersistenceRows(runs) {
  const values = Array.isArray(runs) ? [...runs] : [...(runs?.values?.() || [])];
  const candidates = values
    .sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')))
    .slice(0, CLOUD_RUN_LIMIT)
    .map(compactCloudRunForPersistence);
  const rows = [];
  let totalBytes = 2;
  for (const row of candidates) {
    const rowBytes = serializedBytes(row) + (rows.length ? 1 : 0);
    if (totalBytes + rowBytes > CLOUD_PERSIST_BYTES_LIMIT) continue;
    rows.push(row);
    totalBytes += rowBytes;
  }
  return rows;
}

function cloudSnapshot(run, { includeUpdates = true } = {}) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    workflowId: run.workflowId || null,
    parentRunId: run.parentRunId || null,
    mode: run.mode || 'act',
    tabId: run.tabId,
    task: run.task,
    structured: run.structured ?? !!run.outputSchema,
    pendingInput: run.pendingInput || null,
    ...(run.captchaDiagnostics ? { captchaDiagnostics: run.captchaDiagnostics } : {}),
    result: run.result,
    persistenceTruncated: run.persistenceTruncated,
    summary: run.summary,
    content: run.content,
    finalUrl: run.finalUrl,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    updates: includeUpdates ? run.updates : undefined,
  };
}

function isUsableCloudTab(tab) {
  if (tab?.id == null) return false;
  try {
    // Chrome can leave an unpacked-extension startup tab's `url` empty while
    // exposing the loaded page through `pendingUrl`, even with status=complete.
    const url = new URL(tab.url || tab.pendingUrl || '');
    return ['http:', 'https:', 'file:'].includes(url.protocol) || url.href === 'about:blank';
  } catch {
    return false;
  }
}

export function createCloudRunController({
  chromeApi,
  agent,
  ensureOffscreen,
  sendIndicator = () => {},
  startRecording = null,
  stopRecording = null,
  workflowTrace = null,
  now = () => new Date(),
  makeRunId = () => `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  const api = chromeApi;
  const runs = new Map();
  let hydratePromise = null;
  let persistQueue = Promise.resolve();
  let persistTimer = null;

  const isoNow = () => now().toISOString();

  async function persist() {
    if (!api.storage?.session?.set) return;
    const rows = buildCloudPersistenceRows(runs);
    persistQueue = persistQueue
      .catch(() => {})
      .then(() => api.storage.session.set({ [CLOUD_RUN_STORAGE_KEY]: rows }));
    await persistQueue;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch(() => {});
    }, 100);
  }

  async function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      if (!api.storage?.session?.get) return;
      const stored = await api.storage.session.get(CLOUD_RUN_STORAGE_KEY).catch(() => ({}));
      const rows = Array.isArray(stored?.[CLOUD_RUN_STORAGE_KEY]) ? stored[CLOUD_RUN_STORAGE_KEY] : [];
      let changed = false;
      for (const row of rows) {
        if (!row?.runId) continue;
        const rawUpdates = Array.isArray(row.updates) ? row.updates : [];
        let nextUpdateSeq = 0;
        const updates = rawUpdates.map((update) => {
          const candidate = Number(update?.seq);
          const seq = Number.isSafeInteger(candidate) && candidate > nextUpdateSeq
            ? candidate
            : nextUpdateSeq + 1;
          if (seq !== candidate) changed = true;
          nextUpdateSeq = seq;
          return { ...update, seq };
        });
        const restored = { ...row, updates, nextUpdateSeq };
        if (!TERMINAL_STATUSES.has(restored.status)) {
          const at = isoNow();
          restored.status = restored.status === 'aborting' ? 'aborted' : 'failed';
          restored.pendingInput = null;
          restored.error = restored.status === 'aborted'
            ? 'Run aborted when the WebBrain service worker restarted.'
            : 'Run interrupted when the WebBrain service worker restarted.';
          restored.updatedAt = at;
          restored.completedAt = at;
          changed = true;
        }
        runs.set(restored.runId, restored);
      }
      if (changed) await persist();
    })();
    return hydratePromise;
  }

  async function activateTab(tab) {
    if (!tab?.id) return tab;
    await api.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null && api.windows?.update) {
      await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return tab;
  }

  async function resolveTabId(requestedTabId) {
    if (requestedTabId != null && requestedTabId !== '') {
      const tab = await api.tabs.get(Number(requestedTabId));
      if (!isUsableCloudTab(tab)) throw new Error(`Tab ${requestedTabId} is not a controllable webpage.`);
      await activateTab(tab);
      return tab.id;
    }

    const active = await api.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = active.find(isUsableCloudTab);
    if (activeTab) return activeTab.id;

    const allTabs = await api.tabs.query({});
    const fallback = allTabs.find(isUsableCloudTab);
    if (fallback) {
      await activateTab(fallback);
      return fallback.id;
    }

    const created = await api.tabs.create({ url: 'about:blank', active: true });
    if (created?.id == null) throw new Error('Could not create a browser tab for the cloud run.');
    return created.id;
  }

  async function getTabUrl(tabId) {
    try {
      return (await api.tabs.get(tabId))?.url || '';
    } catch {
      return '';
    }
  }

  // Kept out of the run object so a literal secret can never reach session
  // storage or a persistence row. Dropped when the run leaves the map.
  const strictSecretValues = new Map();
  const strictSecretOverflowRuns = new Set();

  // Whatever a strict run types into a page is a value the caller must never
  // read back, wherever it later resurfaces — a clarification question, a
  // warning, a captcha diagnostic. Remember it here, before the redactors drop
  // the argument that carried it.
  function rememberStrictSecrets(run, type, data) {
    const name = String(data?.name || data?.tool || '');
    const candidates = [];
    if (type === 'tool_call') {
      const args = data?.args && typeof data.args === 'object' ? data.args : {};
      if (CLOUD_TEXT_ENTRY_TOOLS.has(name)) candidates.push(args.text, args.value);
      // A credential does not have to be typed into a page to exist. The
      // disposable-signup scenario mints its account password inside the JSON
      // body of `POST /accounts` and never types it, so registering only
      // text-entry arguments left it unknown to the value redactor.
      collectSensitiveStrings(args, candidates);
      collectRequestBodySecrets(args.body, candidates);
    } else if (type === 'tool_result') {
      // The value under a sensitive key is already known to be a secret; the
      // key-based scrubber only masks it in place, so register the literal and
      // strike it from later prose as well.
      //
      // Known limit: a secret the model only ever *reads* out of an
      // unremarkable field — an OTP in the body text of an inbox message — is
      // never seen here in a form this can recognize, so a clarification that
      // quotes it is covered by the strict system prompt alone. Closing that
      // would mean either blanking clarification text, which makes a strict run
      // unanswerable, or entropy guessing at prose.
      collectSensitiveStrings(data?.result, candidates);
    }
    if (!candidates.length) return;
    const known = strictSecretValues.get(run.runId) || [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const shortNumericSecret = /^\d{1,3}$/.test(candidate);
      if (candidate.length < CLOUD_STRICT_SECRET_MIN_LENGTH && !shortNumericSecret) continue;
      if (candidate.length > WORKFLOW_PARAMETER_VALUE_LIMIT) continue;
      if (known.includes(candidate)) continue;
      if (known.length >= CLOUD_STRICT_SECRET_VALUE_LIMIT) {
        // Never evict an earlier credential and silently expose it later. This
        // is extremely rare, so losing free-text utility is preferable to
        // publishing an unknown secret after the bounded registry fills.
        strictSecretOverflowRuns.add(run.runId);
        break;
      }
      known.push(candidate);
    }
    if (known.length) {
      strictSecretValues.set(run.runId, known);
    }
  }

  function redactStrictSecretValues(run, value, strictSecretMode) {
    if (!strictSecretMode) return value;
    if (strictSecretOverflowRuns.has(run.runId)) return redactStrictStructuredValues(value);
    const known = strictSecretValues.get(run.runId);
    if (!known?.length) return value;
    return redactWorkflowRuntimeValues(value, known, '[redacted strict value]');
  }

  // run.content / run.result / run.finalUrl / run.error reach the caller by the
  // same two routes as an update row, so they cannot rely on the update-path
  // redaction having run.
  function redactStrictTerminal(run, value, strictSecretMode) {
    return redactStrictSecretValues(run, value, strictSecretMode);
  }

  function pushUpdate(run, type, data, runtimeValues = []) {
    run.updatedAt = isoNow();
    const previous = run.updates.at(-1);
    const strictSecretMode = agent.strictSecretMode === true;
    if (strictSecretMode) rememberStrictSecrets(run, type, data);
    // Consecutive text_delta events upsert the same seq: content grows in place
    // and ts advances. Full-array pollers are fine; append-only / seq-cursor
    // clients must re-read that row (or take a full snapshot) rather than
    // assuming each seq is immutable.
    if (type === 'text_delta' && previous?.type === 'text_delta') {
      // Deltas must pass through the same redaction as any other update: this
      // branch used to append raw model output straight onto the stored row.
      const safeDelta = cloudSafeUpdateData(type, data, { strictSecretMode });
      previous.data = scrubCloudValue(redactStrictSecretValues(run, redactWorkflowRuntimeValues({
        ...previous.data,
        content: strictSecretMode
          ? (safeDelta?.content || '')
          : `${previous.data?.content || ''}${safeDelta?.content || ''}`,
      }, runtimeValues), strictSecretMode));
      previous.ts = run.updatedAt;
      schedulePersist();
      return;
    }
    run.nextUpdateSeq = (Number(run.nextUpdateSeq) || 0) + 1;
    const safeData = cloudSafeUpdateData(type, data, { strictSecretMode });
    const scrubbedData = scrubCloudValue(
      redactStrictSecretValues(run, redactWorkflowRuntimeValues(safeData, runtimeValues), strictSecretMode),
    );
    run.updates.push({ seq: run.nextUpdateSeq, type, data: scrubbedData, ts: run.updatedAt });
    if (run.updates.length > CLOUD_UPDATE_LIMIT) {
      run.updates.splice(0, run.updates.length - CLOUD_UPDATE_LIMIT);
    }
    if (type === 'tool_result' && scrubbedData?.name === 'done_json') {
      const result = data.result || {};
      const safeResult = scrubbedData.result || {};
      // Two different jobs, so two different redactors. The update row above is
      // trace and persistence with no contract to honour, and takes the blunt
      // leaf-type redaction. `run.result` and `run.summary` are the caller's
      // answer — the schema they asked for — so they take value redaction:
      // registered credentials are struck and everything else the contract
      // declares survives. Redacting those by leaf type returned `completed`
      // with every string and number replaced by a placeholder, which satisfies
      // strict mode by making the run useless.
      const publicSummary = strictSecretMode
        ? redactStrictSecretValues(run, result.summary, true)
        : safeResult.summary;
      if (result.cloudFailed) {
        run.status = 'failed';
        run.error = safeResult.error || 'done_json failed';
        run.summary = publicSummary || run.summary;
      } else if (Object.prototype.hasOwnProperty.call(result, 'cloudResult')) {
        run.result = strictSecretMode
          ? redactStrictSecretValues(run, result.cloudResult, true)
          : result.cloudResult;
        run.summary = publicSummary || run.summary;
      }
    }
    if (type === 'captcha_gate') {
      // Keep the latest sanitized frame/vendor snapshot at run level so it
      // survives the rolling 200-update window in exported cloud traces.
      run.captchaDiagnostics = { ...scrubbedData, observedAt: run.updatedAt };
    }
    if (type === 'clarify' && scrubbedData?.clarifyId && !TERMINAL_STATUSES.has(run.status)) {
      run.status = 'needs_user_input';
      run.pendingInput = scrubbedData;
    }
    if (type === 'run_status'
        && ['clarification_required', 'captcha_manual_required'].includes(scrubbedData?.status)
        && run.status !== 'aborting'
        && run.status !== 'aborted') {
      run.status = 'failed';
      run.error = scrubbedData.message
        || (scrubbedData.status === 'captcha_manual_required'
          ? 'Cloud run stopped because manual CAPTCHA completion is required.'
          : 'Cloud run stopped because explicit clarification authorization is required.');
      run.pendingInput = null;
    }
    if (type === 'plan_review' && run.status === 'running') {
      run.status = 'failed';
      run.error = 'Managed cloud runs cannot wait for interactive plan review.';
      agent.abort(run.tabId);
    }
    schedulePersist();
  }

  function validateWorkflowParameters(workflow, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw cloudRunError('`parameters` must be an object.', 400);
    }
    const descriptors = new Map((workflow.parameters || []).map(parameter => [parameter.id, parameter]));
    const parameters = Object.create(null);
    for (const [id, value] of Object.entries(input)) {
      if (!descriptors.has(id)) throw cloudRunError(`Unknown workflow parameter: ${id}`, 400);
      if (typeof value !== 'string') throw cloudRunError(`Workflow parameter ${id} must be a string.`, 400);
      if (value.length > WORKFLOW_PARAMETER_VALUE_LIMIT) {
        throw cloudRunError(`Workflow parameter ${id} exceeds ${WORKFLOW_PARAMETER_VALUE_LIMIT} characters.`, 400);
      }
      parameters[id] = value;
    }
    for (const descriptor of descriptors.values()) {
      if (descriptor.required !== false && !Object.hasOwn(parameters, descriptor.id)) {
        throw cloudRunError(`Missing workflow parameter: ${descriptor.id}`, 400);
      }
    }
    return parameters;
  }

  async function startRun(msg = {}) {
    await hydrate();
    const parentRunId = String(msg.parentRunId || msg.parent_run_id || '').trim() || null;
    let parentRun = null;
    let requestedTabId = msg.tabId ?? msg.tab_id;
    if (parentRunId) {
      parentRun = runs.get(parentRunId) || null;
      if (parentRun) {
        if (!TERMINAL_STATUSES.has(parentRun.status)) {
          throw cloudRunError('Parent cloud run must be finished before it can be continued.', 409);
        }
        const existingChild = [...runs.values()].find(candidate => candidate.parentRunId === parentRunId);
        if (existingChild) {
          throw cloudRunError(`Cloud run has already been continued as ${existingChild.runId}.`, 409);
        }
        requestedTabId = parentRun.tabId;
      } else if (requestedTabId == null || requestedTabId === '') {
        throw cloudRunError('Parent cloud run is no longer available and has no saved tab.', 409);
      }
    }
    const tabId = await resolveTabId(requestedTabId);
    const workflow = msg._workflow || null;
    const mode = workflow ? 'act' : normalizeCloudRunMode(msg.mode, parentRun?.mode || 'act');
    const workflowParameters = msg._workflowParameters || {};
    const workflowParameterValues = workflow ? Object.values(workflowParameters) : [];
    const redactWorkflowValue = value => redactWorkflowRuntimeValues(value, workflowParameterValues);
    const task = workflow
      ? `Run saved workflow: ${workflow.name}`
      : String(msg.task || msg.text || '').trim();
    if (!task) throw new Error('cloud_run requires `task`.');
    if (agent.isRunning(tabId)) throw new Error(`Tab ${tabId} already has an active WebBrain run.`);

    const apiMutationsAllowed = msg.apiMutationsAllowed === true || msg.api_mutations_allowed === true;
    const outputSchema = workflow
      ? null
      : msg.outputSchema || msg.output_schema || msg.responseFormat?.schema || msg.response_format?.schema || null;
    const createdAt = isoNow();
    const run = {
      runId: msg.runId || msg.run_id || makeRunId(),
      status: 'running',
      workflowId: workflow?.id || null,
      traceRunId: null,
      parentRunId,
      mode,
      tabId,
      task,
      outputSchema,
      capture: msg.capture === 'video' ? 'video' : 'none',
      result: undefined,
      summary: '',
      content: '',
      finalUrl: '',
      error: '',
      pendingInput: null,
      updates: [],
      nextUpdateSeq: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    runs.set(run.runId, run);
    await persist();

    (async () => {
      let recordingId = null;
      const strictSecretMode = agent.strictSecretMode === true;
      try {
        if (run.capture === 'video') {
          try {
            if (!startRecording || !stopRecording) throw new Error('Cloud run video capture is unavailable.');
            const recording = await startRecording(tabId, {
              video: true,
              mic: false,
              showBanner: false,
              filename: `webbrain-ci-${run.runId}.webm`,
            });
            if (!recording?.ok) throw new Error(recording?.error || 'Cloud run video capture could not start.');
            recordingId = recording.state?.recordingId || null;
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
            throw captureError;
          }
          pushUpdate(run, 'artifact_started', {
            kind: 'video',
            filename: `webbrain-ci-${run.runId}.webm`,
          });
        }
        if (apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);
        sendIndicator(tabId, 'WB_SHOW_AGENT_INDICATORS');
        const publishUpdate = (type, data) => pushUpdate(
          run,
          type,
          workflow && type === 'text_delta'
            ? { ...(data || {}), content: '[workflow output redacted]' }
            : data,
          workflowParameterValues,
        );
        let content;
        if (workflow) {
          const replay = await agent.replaySavedWorkflow(
            tabId,
            workflow,
            workflowParameters,
            publishUpdate,
            { cloudRun: true, independentRun: true },
          );
          content = redactWorkflowValue(replay.summary || '');
          run.summary = redactWorkflowValue(replay.summary || run.summary);
          if (replay.status === 'fallback') {
            pushUpdate(run, 'workflow_fallback', {
              workflowId: workflow.id,
              stepIndex: replay.stepIndex,
              reason: replay.reason,
            });
            content = redactWorkflowValue(await agent.processMessage(
              tabId, replay.prompt, publishUpdate, 'act', [], {
                cloudRun: true,
                independentRun: true,
                preserveRichTextToolbarAudit: true,
              },
            ));
          } else if (replay.status === 'stopped') {
            run.status = 'failed';
            run.error = redactWorkflowValue(
              replay.summary || replay.reason || 'Saved workflow stopped safely.'
            );
          }
        } else {
          content = await agent.processMessage(tabId, task, publishUpdate, mode, [], {
            cloudRun: true,
            independentRun: true,
            outputSchema,
            onTraceStarted(traceRunId) {
              run.traceRunId = traceRunId;
              schedulePersist();
            },
          });
        }
        run.pendingInput = null;
        // Terminal fields are published over the bridge and persisted just like
        // update rows, so they get the same strict treatment — structured or
        // not. An unstructured strict run used to return its final answer raw,
        // which is where a model is most likely to repeat the credential it was
        // told not to. Value redaction rather than blanking, because for an
        // unstructured run this text *is* the result: the answer survives with
        // the literal struck.
        run.content = strictSecretMode && outputSchema
          ? (run.summary || '[redacted strict structured completion]')
          : redactStrictTerminal(run, redactWorkflowValue(content), strictSecretMode);
        run.finalUrl = redactStrictTerminal(
          run, redactWorkflowValue(await getTabUrl(tabId)), strictSecretMode,
        );
        if (run.status === 'aborting') {
          run.status = 'aborted';
          run.error = run.error || 'Aborted by cloud_abort.';
        } else if (run.status !== 'failed') {
          if (outputSchema && run.result === undefined) {
            run.status = 'failed';
            run.error = 'Structured cloud run finished without a valid done_json result.';
          } else {
            run.status = 'completed';
            if (!outputSchema) {
              run.result = redactStrictTerminal(run, redactWorkflowValue(content), strictSecretMode);
            }
          }
        }
      } catch (error) {
        run.pendingInput = null;
        run.status = run.status === 'aborting' ? 'aborted' : 'failed';
        run.error = redactStrictTerminal(
          run, redactWorkflowValue(error?.message || String(error)), strictSecretMode,
        );
        run.finalUrl = redactStrictTerminal(
          run, redactWorkflowValue(await getTabUrl(tabId)), strictSecretMode,
        );
      } finally {
        // Do not expose a terminal status until the requested recording has
        // finished flushing to Downloads; pollers use terminality as the cue
        // that traces and artifacts are complete.
        const terminalStatus = recordingId && TERMINAL_STATUSES.has(run.status)
          ? run.status
          : null;
        if (terminalStatus) run.status = 'running';
        if (recordingId) {
          try {
            const capture = await stopRecording({ expectedRecordingId: recordingId });
            if (!capture?.ok) throw new Error(capture?.error || 'Cloud run video capture could not stop.');
            pushUpdate(run, 'artifact', {
              kind: 'video',
              filename: capture.filename || `webbrain-ci-${run.runId}.webm`,
            });
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
          }
        }
        if (terminalStatus) run.status = terminalStatus;
        run.completedAt = isoNow();
        run.updatedAt = run.completedAt;
        // The run is over, so nothing more can quote these; do not hold the
        // literals in memory any longer than the run that typed them.
        strictSecretValues.delete(run.runId);
        strictSecretOverflowRuns.delete(run.runId);
        sendIndicator(tabId, 'WB_HIDE_AGENT_INDICATORS');
        await persist().catch(() => {});
      }
    })();

    return cloudSnapshot(run, { includeUpdates: false });
  }

  async function startWorkflowRun(msg = {}) {
    const workflow = normalizeSavedWorkflow(msg.workflow);
    if (!workflow) throw cloudRunError('Saved workflow is missing or invalid.', 400);
    if (msg.parentRunId || msg.parent_run_id) {
      throw cloudRunError('Saved workflow runs cannot be continuations.', 400);
    }
    const parameters = validateWorkflowParameters(
      workflow,
      msg.parameters ?? {},
    );
    return startRun({
      ...msg,
      task: '',
      text: '',
      outputSchema: null,
      output_schema: null,
      _workflow: workflow,
      _workflowParameters: parameters,
    });
  }

  async function compileWorkflow(msg = {}) {
    await hydrate();
    const runId = String(msg.runId || msg.run_id || '').trim();
    const name = String(msg.name || '').trim();
    if (!runId) return { ok: false, status: 400, reason: 'run_required', warnings: [] };
    if (!name) return { ok: false, status: 400, reason: 'name_required', warnings: [] };
    const run = runs.get(runId);
    if (!run) return { ok: false, status: 404, reason: 'run_not_found', warnings: [] };
    if (run.workflowId) {
      return { ok: false, status: 422, reason: 'workflow_run_not_compilable', warnings: [] };
    }
    if (run.status !== 'completed') {
      return { ok: false, status: 409, reason: 'successful_run_required', warnings: [] };
    }
    if (!run.traceRunId || !workflowTrace) {
      return { ok: false, status: 409, reason: 'trace_unavailable', warnings: [] };
    }
    let compiled = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      compiled = await compileSuccessfulWorkflowByRunId(workflowTrace, {
        runId: run.traceRunId,
        name,
      });
      if (compiled.workflow || compiled.reason !== 'successful_run_required') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!compiled?.workflow) {
      return {
        ok: false,
        status: compiled?.reason === 'no_replayable_steps' ? 422 : 409,
        reason: compiled?.reason || 'workflow_compilation_failed',
        warnings: compiled?.warnings || [],
      };
    }
    return { ok: true, workflow: compiled.workflow, warnings: compiled.warnings || [] };
  }

  async function status(msg = {}) {
    await hydrate();
    const runId = msg.runId || msg.run_id;
    if (!runId) return { runs: [...runs.values()].map(run => cloudSnapshot(run, { includeUpdates: false })) };
    const run = runs.get(runId);
    if (!run) throw new Error('Unknown cloud run.');
    return cloudSnapshot(run);
  }

  async function abort(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw new Error('Unknown cloud run.');
    if (run.status === 'running' || run.status === 'needs_user_input') {
      run.status = 'aborting';
      run.pendingInput = null;
      run.error = 'Abort requested.';
      run.updatedAt = isoNow();
      agent.abort(run.tabId);
      await persist();
    }
    return cloudSnapshot(run);
  }

  async function respond(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw cloudRunError('Unknown cloud run.', 404);
    if (run.status !== 'needs_user_input') {
      throw cloudRunError('Cloud run is not waiting for user input.', 409);
    }
    const clarifyId = String(msg.clarifyId || msg.clarify_id || '').trim();
    if (!clarifyId) throw cloudRunError('cloud_respond requires `clarify_id`.', 400);
    const pendingClarifyId = String(run.pendingInput?.clarifyId || run.pendingInput?.clarify_id || '').trim();
    if (!pendingClarifyId || clarifyId !== pendingClarifyId) {
      throw cloudRunError('Clarification is no longer pending for this cloud run.', 409);
    }
    const answer = String(msg.answer ?? '').trim();
    if (!answer) throw cloudRunError('cloud_respond requires `answer`.', 400);
    if (!agent.submitClarifyResponse(run.tabId, clarifyId, answer, 'cloud_api')) {
      throw cloudRunError('Clarification is no longer available in the active WebBrain run.', 409);
    }
    run.status = 'running';
    run.pendingInput = null;
    run.error = '';
    pushUpdate(run, 'clarify_response', { clarifyId, source: 'cloud_api' });
    await persist();
    return cloudSnapshot(run);
  }

  async function startBridge(url = DEFAULT_CLOUD_BRIDGE_URL) {
    await ensureOffscreen();
    return api.runtime.sendMessage({ type: 'cloud-bridge-start', url: normalizeCloudBridgeUrl(url) });
  }

  async function stopBridge() {
    return api.runtime.sendMessage({ type: 'cloud-bridge-stop' });
  }

  async function bridgeStatus() {
    await ensureOffscreen();
    return api.runtime.sendMessage({ type: 'cloud-bridge-status' });
  }

  async function syncBridge() {
    const stored = await api.storage.local.get(['webbrainCloudBridgeEnabled', 'webbrainCloudBridgeUrl']);
    if (!stored.webbrainCloudBridgeEnabled) return stopBridge().catch(() => ({ enabled: false, connected: false }));
    return startBridge(stored.webbrainCloudBridgeUrl || DEFAULT_CLOUD_BRIDGE_URL);
  }

  return {
    runs,
    startRun,
    startWorkflowRun,
    compileWorkflow,
    status,
    respond,
    abort,
    startBridge,
    stopBridge,
    bridgeStatus,
    syncBridge,
    hydrate,
  };
}
