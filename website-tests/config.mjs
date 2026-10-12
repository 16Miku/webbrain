import fs from 'node:fs/promises';
import path from 'node:path';
import { suiteRoot, repositoryRoot, sessionLockDirectory } from './paths.mjs';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export class HarnessError extends Error {
  constructor(code, message = code, status = 'blocked') { super(message); this.name = 'HarnessError'; this.code = code; this.status = status; }
}
export const fail = (code, message, status) => { throw new HarnessError(code, message, status); };
export async function requirePrivateLocation(filename, cwd) {
  let gitRoot;
  try { gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return; }
  const relative = path.relative(gitRoot, path.resolve(filename));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
  try { execFileSync('git', ['check-ignore', '--quiet', '--', relative || '.'], { cwd: gitRoot, stdio: 'ignore', windowsHide: true }); }
  catch { fail('private_path_not_ignored', 'Place profiles, configuration and private artifacts outside the repository or under an ignored path.'); }
}
const integer = (value, fallback, min, max, name) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid_configuration', `${name} must be an integer from ${min} to ${max}.`);
  return n;
};
const list = value => Array.isArray(value) ? value : String(value || '').split(',').map(v => v.trim()).filter(Boolean);
export const placeholder = value => !String(value || '').trim() || /^(?:replace|your_|example|changeme|<)/i.test(String(value));
function resolveReferences(value, env) {
  if (typeof value === 'string' && value.startsWith('env:')) return env[value.slice(4)] || '';
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, env)]));
  return value;
}
function roleFromEnv(env, role) {
  const prefix = role === 'A' ? 'WBTEST_ACTOR_' : 'WBTEST_OBSERVER_';
  return { name: role === 'A' ? 'actor' : 'observer', backend: env[`${prefix}BACKEND`] || (role === 'A' ? 'local' : ''),
    profile: env[`${prefix}PROFILE`], cdpUrl: env[`${prefix}CDP_URL`], executablePath: env[`${prefix}EXECUTABLE`],
    extensionPath: env[`${prefix}EXTENSION_PATH`], extensionId: env[`${prefix}EXTENSION_ID`],
    headless: env[`${prefix}HEADLESS`] === 'true', provider: env[`${prefix}PROVIDER`], model: env[`${prefix}MODEL`],
    sessionId: env[`${prefix}SESSION_ID`], apiKey: env[role === 'A' ? 'WEBBRAIN_API_KEY' : 'WEBBRAIN_OBSERVER_API_KEY'],
    baseUrl: env[role === 'A' ? 'WEBBRAIN_BASE_URL' : 'WEBBRAIN_OBSERVER_BASE_URL'] || 'https://webbrain.cloud',
    expectedVersion: env[`${prefix}EXPECTED_VERSION`], expectedBuild: env[`${prefix}EXPECTED_BUILD`] };
}
export async function loadConfig({ envFile = '.env', configFile, env = process.env, overrides = {}, cwd = suiteRoot } = {}) {
  let fileEnv = {};
  try { fileEnv = parseEnv(await fs.readFile(path.resolve(cwd, envFile), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || envFile !== '.env') fail('environment_file_unavailable', 'The selected environment file could not be read.'); }
  // Explicit process secrets take precedence over a private file.
  const merged = { ...fileEnv, ...env };
  const selected = configFile || merged.WBTEST_CONFIG;
  let raw = {};
  if (selected) {
    try { raw = JSON.parse(await fs.readFile(path.resolve(cwd, selected), 'utf8')); }
    catch { fail('configuration_file_unavailable', 'The selected private JSON configuration could not be read.'); }
  }
  if (raw.schema && raw.schema !== 'authenticated-tests/1') fail('invalid_configuration', 'Unsupported configuration schema.');
  for (const actor of Object.values(raw.actors || {})) {
    if (actor.apiKey && !String(actor.apiKey).startsWith('env:')) fail('credential_reference_required', 'JSON credentials must reference an environment variable.');
  }
  raw = resolveReferences(raw, merged);
  const target = overrides.target || merged.WBTEST_TARGET || raw.target || 'fixtures';
  if (!['fixtures', 'live'].includes(target)) fail('invalid_configuration', 'Target must be fixtures or live.');
  const actors = Object.fromEntries(['A', 'B'].map(role => [role, { ...roleFromEnv(merged, role), ...raw.actors?.[role], name: role === 'A' ? 'actor' : 'observer' }]));
  if (overrides.backend) actors[overrides.role || 'A'].backend = overrides.backend;
  const root = path.resolve(cwd);
  for (const actor of Object.values(actors)) {
    if (actor.backend && !['local', 'cloud'].includes(actor.backend)) fail('invalid_configuration', 'Backend must be local or cloud.');
    if (actor.profile) actor.profile = path.resolve(root, actor.profile);
    if (actor.extensionPath) actor.extensionPath = path.resolve(root, actor.extensionPath);
  }
  const limits = raw.limits || {};
  const config = { schema: 'authenticated-tests/1', target, cwd: root, repositoryRoot, actors, sites: raw.sites || {},
    selectedSites: list(overrides.sites || merged.WBTEST_SITES || raw.selectedSites),
    selectedScenarios: list(overrides.scenarios || merged.WBTEST_SCENARIOS || raw.selectedScenarios),
    allowedActions: list(merged.WBTEST_ALLOWED_ACTIONS ?? raw.allowedActions),
    allowedRecipients: list(raw.allowedRecipients), allowedDestinations: list(raw.allowedDestinations),
    liveMutations: merged.WBTEST_LIVE_MUTATIONS !== undefined ? merged.WBTEST_LIVE_MUTATIONS === 'true' : raw.liveMutations === true,
    artifacts: path.resolve(root, merged.WBTEST_ARTIFACTS || raw.artifacts || 'artifacts'),
    maxRuns: integer(merged.WBTEST_MAX_RUNS || limits.maxRuns, 30, 1, 500, 'maxRuns'),
    timeoutMs: integer(merged.WBTEST_TIMEOUT_MS || limits.timeoutMs, 180000, 1000, 900000, 'timeoutMs'),
    totalTimeoutMs: integer(limits.totalTimeoutMs, 1800000, 1000, 14400000, 'totalTimeoutMs'),
    pollMs: integer(limits.pollMs, 3000, 250, 60000, 'pollMs'),
    repetitions: integer(merged.WBTEST_REPETITIONS || limits.repetitions, 1, 1, 20, 'repetitions'),
    interventions: raw.interventions || {}, manualEvidenceFile: raw.manualEvidenceFile ? path.resolve(root, raw.manualEvidenceFile) : null,
    privateArtifacts: raw.privateArtifacts === true,
    secrets: Object.entries(merged).filter(([key]) => /KEY|TOKEN|PASSWORD|SECRET|COOKIE/i.test(key)).map(([, value]) => value).filter(Boolean) };
  // Endpoint credentials are also private even if their environment key has an innocuous name.
  for (const actor of Object.values(actors)) if (actor.apiKey) config.secrets.push(actor.apiKey);
  await requirePrivateLocation(config.artifacts, root);
  if (target === 'live' && selected) await requirePrivateLocation(path.resolve(root, selected), root);
  if (config.manualEvidenceFile) await requirePrivateLocation(config.manualEvidenceFile, root);
  return config;
}

export function executionLockDigests(config) {
  return [...new Set(Object.values(config.actors).flatMap(actor => {
    let local;
    if (actor.cdpUrl) { const endpoint = new URL(actor.cdpUrl); local = { protocol: ['https:', 'wss:'].includes(endpoint.protocol) ? 'tls' : 'plain',
      host: ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase()) ? 'loopback' : endpoint.hostname.toLowerCase(), port: endpoint.port || (['https:', 'wss:'].includes(endpoint.protocol) ? '443' : '80') }; }
    else if (actor.profile) local = process.platform === 'win32' ? path.resolve(actor.profile).toLowerCase() : path.resolve(actor.profile);
    const selection = actor.backend === 'cloud' && actor.sessionId ? { backend: 'cloud', baseUrl: new URL(actor.baseUrl || 'https://webbrain.cloud').origin, sessionId: actor.sessionId }
      : actor.backend === 'local' && local ? { backend: 'local', selection: local } : null;
    return selection ? ['session-' + createHash('sha256').update(JSON.stringify(selection)).digest('hex')] : [];
  }))].sort();
}
export function lockFiles(config) {
  return [path.join(config.artifacts, scopeDigest(config) + '.lock.private.json'), ...executionLockDigests(config).map(key => path.join(sessionLockDirectory(), key + '.lock.private.json'))].sort();
}
export function scopeDigest(config) {
  return createHash('sha256').update(JSON.stringify({ target: config.target,
    actors: Object.fromEntries(Object.entries(config.actors).map(([key, a]) => [key, { backend: a.backend, profile: a.profile, cdpUrl: a.cdpUrl, sessionId: a.sessionId, baseUrl: a.baseUrl }])),
    sites: config.sites, allowedActions: config.allowedActions, allowedRecipients: config.allowedRecipients,
    allowedDestinations: config.allowedDestinations, liveMutations: config.liveMutations })).digest('hex');
}
export function authorize(config, scenario, binding) {
  if (config.target !== 'live') return;
  if (!binding || placeholder(binding.expectedIdentity)) fail('account_identity_missing', 'Configure the exact actor identity for this site.');
  if ((scenario.actions || []).length && !config.liveMutations) fail('live_mutations_disabled', 'Enable the explicitly scoped live mutation configuration.');
  for (const action of scenario.actions || []) if (!config.allowedActions.includes(action)) fail('action_not_authorized', `Action ${action} is outside the configured scope.`);
  if (scenario.requiresObserver && (placeholder(binding.recipient) || placeholder(binding.recipientIdentity) || !config.allowedRecipients.includes(binding.recipientIdentity)))
    fail('recipient_not_authorized', 'Allowlist the actual recipient identity used for delivery, not its display label.');
  if (binding.folderUrl && !config.allowedDestinations.includes(binding.folderUrl)) fail('destination_not_authorized', 'The exact test folder must be allowlisted.');
  if (binding.destination && !config.allowedDestinations.includes(binding.destination)) fail('destination_not_authorized', 'The exact test destination must be allowlisted.');
}

// Summaries use an allowlist, not redaction of arbitrary provider/page objects.
export function safeError(error) {
  const code = String(error?.code || 'unexpected_error').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return { code, status: error?.status === 'ambiguous' ? 'blocked' : ['blocked', 'unsupported', 'failed', 'needs_user_input'].includes(error?.status) ? error.status : 'failed' };
}
export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /password|cookie|authorization|apikey|api_key|token|raw|content|body|task/i.test(k) ? '[redacted]' : redact(v, secrets)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/([?&](?:token|key|auth|code|password)=)[^&#\s]*/gi, '$1[redacted]');
}
