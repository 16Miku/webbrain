import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'cancelled', 'clarification_required']);
const profileOwners = new Set();
const runtimeFiles = ['manifest.json', 'src/background.js', 'src/agent/agent.js', 'src/providers/manager.js'];
const capabilities = Object.freeze({ domObservation: true, activeSteering: true, checkpoints: true,
  interventions: true, files: true, continuation: true });

export class LocalBackendError extends Error {
  constructor(message, status = 'failed', code = 'local_backend_error') {
    super(safeError(message));
    this.name = 'LocalBackendError';
    this.status = status;
    this.code = code;
  }
}

function safeError(error, limit = 2000) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(sk-[a-z0-9_-]{8,})\b/gi, '[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[=:]\s*)(["']?)[^\s&,"']+\2/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .slice(0, limit);
}

function safeUpdate(event) {
  const source = event?.data || {};
  const nested = source.result || source;
  const data = {};
  for (const key of ['name', 'status', 'code', 'outcome', 'attachmentDeliveryState', 'reason']) {
    const value = source[key] ?? nested[key];
    if (typeof value === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(value)) data[key] = value;
  }
  for (const key of ['success', 'done', 'blockedDone', 'noDispatch', 'dispatched', 'deliveryVerified', 'runSucceeded', 'successfulDone', 'eventsMissing']) {
    const value = source[key] ?? nested[key];
    if (typeof value === 'boolean') data[key] = value;
  }
  return { seq: event.seq, type: event.type, ts: event.ts, data };
}

function assertConfiguration(role) {
  if (!role.profile && !role.cdpUrl) throw new Error('Local backend requires an explicit dedicated profile or CDP URL.');
  if (role.profile && role.cdpUrl) throw new Error('Choose a dedicated profile or CDP attachment, not both.');
  if (role.profile) {
    if (!path.isAbsolute(role.profile)) throw new Error('Dedicated profile must be an absolute path.');
    if (/[\\/](?:Google[\\/]Chrome|Microsoft[\\/]Edge|Chromium)[\\/]User Data(?:[\\/]|$)/i.test(role.profile)) {
      throw new Error('A normal browser user-data directory cannot be launched by this harness. Use a dedicated profile or CDP attachment.');
    }
  }
  if (role.cdpUrl) {
    let url;
    try { url = new URL(role.cdpUrl); } catch { throw new Error('Invalid CDP URL.'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Unsupported CDP URL protocol.');
    if (url.username || url.password) throw new Error('Credentials must not be embedded in the CDP URL.');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) && role.trustRemoteCdp !== true) {
      throw new Error('Non-loopback CDP attachment requires explicit trustRemoteCdp: true.');
    }
  }
  if (role.extensionId && !/^[a-p]{32}$/.test(role.extensionId)) throw new Error('Invalid Chrome extension ID.');
}

async function discoverWebBrain(context, explicitId, timeoutMs) {
  if (explicitId) return explicitId;
  const find = async () => {
    const matches = new Set();
    const candidates = [...context.serviceWorkers(), ...context.pages()];
    for (const candidate of candidates) {
      if (!candidate.url().startsWith('chrome-extension://')) continue;
      try {
        const manifest = await candidate.evaluate(() => chrome.runtime.getManifest());
        if (manifest.name === 'WebBrain' && manifest.background?.service_worker === 'src/background.js') {
          matches.add(new URL(candidate.url()).hostname);
        }
      } catch { /* Dormant or unrelated extension pages do not identify WebBrain. */ }
    }
    if (matches.size > 1) throw new Error('Multiple WebBrain installations found. Set extensionId explicitly.');
    return [...matches][0];
  };
  let id = await find();
  if (!id) {
    await context.waitForEvent('serviceworker', { timeout: Math.min(timeoutMs, 15000) }).catch(() => {});
    id = await find();
  }
  if (!id) throw new Error('No installed WebBrain extension found. Set its exact extensionId or load extensionPath in a dedicated profile.');
  return id;
}

async function createRuntimeTransport(context, role, timeoutMs) {
  const extensionId = await discoverWebBrain(context, role.extensionId, timeoutMs);
  const page = await context.newPage();
  try {
    // Steering intentionally requires the real chat-panel sender. This opens
    // the packaged page and uses its ordinary runtime bus; no Agent is exposed.
    await page.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`, { timeout: timeoutMs });
    const manifest = await page.evaluate(() => {
      const value = chrome.runtime.getManifest();
      return { name: value.name, version: value.version, worker: value.background?.service_worker };
    });
    if (manifest.name !== 'WebBrain' || manifest.worker !== 'src/background.js') {
      throw new Error('Selected extension is not the WebBrain MV3 installation.');
    }
    await page.evaluate(() => {
      // Observe the same public messages the packaged panel receives. Its
      // journal acknowledgments must not erase events before a poll sees them.
      window.__webbrainAuthenticatedEvents = [];
      chrome.runtime.onMessage.addListener(event => {
        if (event.target === 'sidepanel' && event.action === 'agent_update') {
          window.__webbrainAuthenticatedEvents.push(event);
          if (window.__webbrainAuthenticatedEvents.length > 2048) window.__webbrainAuthenticatedEvents.shift();
        }
      });
    });
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
  const send = (action, data = {}) => page.evaluate(async ({ action, data }) => {
    const response = await chrome.runtime.sendMessage({ target: 'background', action, ...data });
    if (action !== 'agent_run_state') return response;
    if (!response) return null;
    const journal = response.runUi;
    // Only final content is returned for private scoring. Event logs retain
    // structural evidence, never page contents, prompts, tool args or tokens.
    const projectEvent = event => {
      const input = event.data || {};
      const result = input.result || {};
      const data = {};
      for (const key of ['name', 'status', 'code', 'outcome', 'attachmentDeliveryState']) {
        if (typeof input[key] === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(input[key])) data[key] = input[key];
      }
      for (const key of ['success', 'done', 'blockedDone', 'noDispatch', 'dispatched', 'deliveryVerified']) {
        if (typeof result[key] === 'boolean') data[key] = result[key];
      }
      if (typeof result.reason === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(result.reason)) data.reason = result.reason;
      if (result.outcome === 'success' || result.outcome === 'failure') data.outcome = result.outcome;
      for (const key of ['runSucceeded', 'successfulDone']) if (typeof input[key] === 'boolean') data[key] = input[key];
      return { seq: event.seq, type: event.type, ts: event.ts, data };
    };
    const live = (window.__webbrainAuthenticatedEvents || []).filter(event => event.tabId === data.tabId && event.requestId === data.requestId);
    const other = (window.__webbrainAuthenticatedEvents || []).filter(event => event.tabId !== data.tabId || event.requestId !== data.requestId);
    window.__webbrainAuthenticatedEvents = other;
    const events = new Map((journal?.events || []).map(event => [Number(event.seq), projectEvent(event)]));
    for (const event of live) if (Number.isFinite(Number(event.seq))) events.set(Number(event.seq), projectEvent(event));
    return { ok: response.ok, error: response.error, running: response.running, starting: response.starting,
      startingRequestId: response.startingRequestId, runId: response.runId, persistenceDegraded: response.persistenceDegraded,
      detachedError: response.detachedError,
      runUi: journal ? { requestId: journal.requestId, runId: journal.runId, status: journal.status,
        seq: journal.seq, discardedBeforeSeq: journal.discardedBeforeSeq || journal.truncatedBeforeSeq || 0,
        finalContent: journal.finalContent, lastError: journal.lastError, runSucceeded: journal.runSucceeded,
        attachmentDeliveryState: journal.attachmentDeliveryState, events: [...events.values()].sort((a, b) => a.seq - b.seq) } : null };
  }, { action, data });
  return { extensionId, page, send,
    async metadata() {
      // get_providers includes credentials. Project the active configuration
      // inside the extension context before any value crosses into Node.
      return page.evaluate(async files => {
        const manifest = chrome.runtime.getManifest();
        const state = await chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' });
        const config = state?.providers?.[state.active];
        const strings = [];
        for (const file of files) {
          const response = await fetch(chrome.runtime.getURL(file));
          if (!response.ok) throw new Error('Installed extension source is unavailable.');
          strings.push(`${file}\n${await response.text()}`);
        }
        const bytes = new TextEncoder().encode(strings.join('\n'));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sourceHash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        return { extensionId: chrome.runtime.id, extensionVersion: manifest.version,
          sourceHash, sourceHashFiles: files, provider: state?.active || null,
          model: typeof config?.model === 'string' ? config.model : null,
          providerConfigured: !!config && (config.configured === true || config.category === 'cloud' && state.active === 'webbrain_cloud'),
          providerCapabilities: { vision: typeof config?.supportsVision === 'boolean' ? config.supportsVision : null,
            askStreaming: typeof config?.supportsAskStreaming === 'boolean' ? config.supportsAskStreaming : null },
          userAgent: navigator.userAgent };
      }, runtimeFiles);
    },
    async tabId(pageToFind) {
      // A fresh marker binds the exact Playwright-created tab even if another
      // user's tab already displays the same URL. No arbitrary tab is selected.
      const marker = `webbrain-harness-${crypto.randomUUID()}`;
      await pageToFind.goto(`about:blank#${marker}`);
      return page.evaluate(async markerUrl => {
        const matches = (await chrome.tabs.query({})).filter(tab => tab.url === markerUrl);
        if (matches.length !== 1) throw new Error('Could not uniquely bind the harness tab.');
        return matches[0].id;
      }, `about:blank#${marker}`);
    },
    async close() { await page.close().catch(() => {}); },
    async downloads({ marker, after }) {
      return page.evaluate(async ({ marker, after }) => {
        const rows = await chrome.downloads.search({ query: [marker], state: 'complete', startedAfter: after });
        return rows.map(row => ({ filename: row.filename, url: row.url, referrer: row.referrer,
          state: row.state, exists: row.exists, startTime: row.startTime, totalBytes: row.totalBytes }));
      }, { marker, after });
    },
  };
}

// Playwright's connectOverCDP browserProcess.close closes its WebSocket, not
// CDP Browser.close (playwright-core/server/chromium/chromium.js). Never close
// the default context of an attached browser: that belongs to the user.
async function detachAttachedBrowser(browser, detach) {
  if (detach) await detach(browser);
  else await browser.close();
}

function createObserverTransport() {
  return { domOnly: true, extensionId: null,
    async metadata() { return { extensionId: null, extensionVersion: null, sourceHash: null,
      sourceHashFiles: [], provider: null, model: null, providerConfigured: false, providerCapabilities: null }; },
    async tabId() { return null; },
    async send() { throw new LocalBackendError('DOM-only observer cannot issue WebBrain run commands.', 'blocked', 'observer_runtime_unavailable'); },
    async close() {},
  };
}

export function createLocalBackend(role, options = {}) {
  const config = { ...role };
  const timeoutMs = options.timeoutMs || 120000;
  const pollMs = options.pollMs || 300;
  let context, browser, transport, metadata, profileKey;
  let attached = false;
  const handles = new Set();
  const ownedPages = new Set();
  const activeRuns = new Map();
  const usedRequests = new Set();
  const checkpoints = new Map();

  function assertConnected() {
    if (!context || !transport) throw new Error('Local backend is not connected.');
  }
  function ownHandle(handle) {
    assertConnected();
    if (!handles.has(handle) || handle.page?.isClosed?.()) throw new Error('Handle does not belong to this backend or its tab is closed.');
    return handle;
  }
  async function stateFor(handle, requestId = '') {
    const state = await transport.send('agent_run_state', { tabId: handle.tabId, requestId });
    if (state?.error || state?.ok === false) throw new Error(safeError(state.error || 'Run state unavailable.'));
    return state || {};
  }
  function matchesRun(state, entry) {
    return state?.runUi?.requestId === entry.requestId || state?.startingRequestId === entry.requestId;
  }
  function result(entry, journal, status, error = null) {
    return { status, runId: journal?.runId || entry.runId || entry.requestId,
      requestId: entry.requestId, content: safeError(journal?.finalContent || '', 30000),
      error: error ? safeError(error) : journal?.lastError ? safeError(journal.lastError) : null,
      finalUrl: entry.handle.page.url(), delivered: journal?.runSucceeded === true,
      attachmentDeliveryState: journal?.attachmentDeliveryState || '', updates: entry.updates };
  }

  const backend = {
    capabilities: { ...capabilities, activeSteering: config.name !== 'observer', interventions: config.name !== 'observer' },
    async connect({ setup = false } = {}) {
      if (context) return backend;
      try {
        assertConfiguration(config);
        const chromium = options.chromium || require('playwright').chromium;
        if (config.cdpUrl) {
          attached = true;
          browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: timeoutMs });
          const contexts = browser.contexts();
          if (contexts.length !== 1) throw new Error('CDP attachment requires one unambiguous browser context.');
          [context] = contexts;
        } else {
          const proposedProfileKey = path.resolve(config.profile).toLowerCase();
          if (profileOwners.has(proposedProfileKey)) throw new Error('Dedicated profile is already owned by another local backend.');
          profileKey = proposedProfileKey;
          profileOwners.add(profileKey);
          await fs.mkdir(config.profile, { recursive: true });
          const args = [];
          if (config.extensionPath && (config.name !== 'observer' || config.requireExtension === true)) {
            const extensionPath = path.resolve(config.extensionPath);
            const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
            if (manifest.name !== 'WebBrain' || manifest.background?.service_worker !== 'src/background.js') {
              throw new Error('extensionPath must contain the real WebBrain MV3 extension.');
            }
            args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
          }
          context = await chromium.launchPersistentContext(config.profile, { headless: config.headless === true,
            ...(config.executablePath ? { executablePath: config.executablePath } : { channel: 'chromium' }),
            viewport: { width: 1280, height: 900 }, args, timeout: timeoutMs });
          browser = context.browser?.();
        }
        transport = options.transportFactory ? await options.transportFactory(context, config, timeoutMs)
          : config.name === 'observer' && config.requireExtension !== true ? createObserverTransport()
            : await createRuntimeTransport(context, config, timeoutMs);
        if (transport.domOnly) Object.assign(backend.capabilities, { activeSteering: false, interventions: false, files: false, continuation: false });
        metadata = await transport.metadata();
        if (!transport.domOnly) {
          if (config.expectedVersion && config.expectedVersion !== metadata.extensionVersion) throw new Error('Installed extension version differs from the expected version.');
          if (config.expectedBuild && config.expectedBuild !== metadata.sourceHash) throw new Error('Installed extension fingerprint differs from the expected build.');
          if (config.sourceHash && config.sourceHash !== metadata.sourceHash) throw new Error('Installed extension source hash differs from the expected source hash.');
        }
        if (setup && options.fixture?.prepare) {
          await options.fixture.prepare({ context, extensionPage: transport.page, send: transport.send });
          metadata = await transport.metadata();
        }
        if (!transport.domOnly) {
          // Setup needs access to the real Settings UI before the user can
          // select these values. Doctor and every run still require a match.
          if (!setup && config.provider && config.provider !== metadata.provider) throw new Error('Installed active provider differs from the requested provider.');
          if (!setup && config.model && config.model !== metadata.model) throw new Error('Installed active model differs from the requested model.');
          if (config.sourceHash && config.sourceHash !== metadata.sourceHash) throw new Error('Installed extension source hash differs from the expected source hash.');
          if (config.expectedVersion && config.expectedVersion !== metadata.extensionVersion) throw new Error('Installed extension version differs from the expected version.');
          // expectedBuild identifies the exact reported installed four-file
          // fingerprint, not the repository commit or a complete bundle hash.
          if (config.expectedBuild && config.expectedBuild !== metadata.sourceHash) throw new Error('Installed extension fingerprint differs from the expected build.');
        }
        return backend;
      } catch (error) {
        await backend.close().catch(() => {});
        throw new LocalBackendError(error, 'blocked', 'local_connection_not_ready');
      }
    },
    async openSetup() {
      assertConnected();
      if (config.name !== 'actor' || transport.domOnly || !transport.extensionId) {
        throw new LocalBackendError('Only an actor with the verified WebBrain extension can open setup.', 'blocked', 'local_setup_unavailable');
      }
      const page = await context.newPage();
      ownedPages.add(page);
      try {
        await page.goto(`chrome-extension://${transport.extensionId}/src/ui/settings.html`, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        return { page, extensionId: transport.extensionId, url: page.url() };
      } catch (error) {
        await page.close().catch(() => {});
        ownedPages.delete(page);
        throw new LocalBackendError(error, 'blocked', 'local_setup_page_unavailable');
      }
    },
    async doctor() {
      assertConnected();
      metadata = await transport.metadata();
      const expectedMatches = transport.domOnly || (!config.provider || config.provider === metadata.provider)
        && (!config.model || config.model === metadata.model)
        && (!config.sourceHash || config.sourceHash === metadata.sourceHash)
        && (!config.expectedVersion || config.expectedVersion === metadata.extensionVersion)
        && (!config.expectedBuild || config.expectedBuild === metadata.sourceHash);
      const ready = expectedMatches && (config.name === 'observer' || metadata.providerConfigured === true);
      return { backend: 'local', browser: 'chromium', version: browser?.version?.() || metadata.userAgent,
        build: metadata.extensionVersion,
        extensionId: metadata.extensionId || transport.extensionId, extensionVersion: metadata.extensionVersion,
        sourceHash: metadata.sourceHash, sourceHashFiles: metadata.sourceHashFiles,
        sourceHashScope: transport.domOnly ? 'dom-only-observer:extension-not-inspected' : `installed-extension:${(metadata.sourceHashFiles || []).join(',')}`,
        provider: metadata.provider, model: metadata.model, providerCapabilities: metadata.providerCapabilities,
        capabilities: { ...backend.capabilities },
        readiness: ready ? 'ready' : 'not_ready', reason: ready ? null : !expectedMatches
          ? 'Installed provider, model, version or source no longer matches the requested configuration.'
          : 'Active provider is not configured; configure it in the dedicated browser before running.',
        ownership: attached ? 'attached' : 'dedicated', inferenceChecked: false };
    },
    async open(url) {
      assertConnected();
      const parsed = new URL(url);
      if (!['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) throw new Error('Unsupported harness page URL.');
      const page = await context.newPage();
      ownedPages.add(page);
      try {
        const tabId = await transport.tabId(page);
        await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        const handle = { page, tabId, url: page.url() };
        handles.add(handle);
        return handle;
      } catch (error) { await page.close().catch(() => {}); ownedPages.delete(page); throw new Error(safeError(error)); }
    },
    async run({ task, mode = 'act', handle, requestId = crypto.randomUUID(), onUpdate,
      timeoutMs: runTimeoutMs = timeoutMs, continueFrom, attachments } = {}) {
      try {
        ownHandle(handle);
        if (!['ask', 'act', 'dev'].includes(mode)) throw new Error('Unsupported run mode.');
        if (config.name === 'observer' && mode !== 'ask') throw new Error('Observer runs must use read-only Ask mode.');
        if (transport.domOnly) throw new Error('DOM-only observer cannot issue WebBrain run commands.');
        if (!continueFrom && !String(task || '').trim() && !attachments?.length) throw new Error('A run requires a task or supported attachment.');
        if (activeRuns.has(handle)) throw new Error('A harness run already owns this tab.');
        if (usedRequests.has(requestId)) throw new Error('Request ID has already been submitted; replay is not permitted.');
      } catch (error) {
        const failure = new LocalBackendError(error, 'blocked', 'local_run_not_ready');
        failure.noDispatch = true;
        throw failure;
      }
      const entry = { handle, requestId, runId: null, updates: [], lastSeq: 0 };
      activeRuns.set(handle, entry);
      let accepted = false;
      let dispatched = false;
      let rejectionProven = false;
      try {
        const initialState = await stateFor(handle);
        if (initialState.running || initialState.starting) throw new Error('Selected tab already has an active WebBrain run.');
        if (continueFrom) {
          const prior = initialState.runUi;
          const previousId = typeof continueFrom === 'string' ? continueFrom : continueFrom.runId || continueFrom.requestId;
          if (!prior || ![prior.runId, prior.requestId].includes(previousId)) throw new Error('Continuation must identify the current run in this exact tab.');
        }
        const ready = await backend.doctor();
        if (ready.readiness !== 'ready') throw new Error(ready.reason);
        usedRequests.add(requestId);
        if (options.onJournal) await options.onJournal({ type: 'attempt', requestId, tabId: handle.tabId, backend: 'local' });
        dispatched = true;
        const response = await transport.send(continueFrom ? 'continue_start' : 'chat_start', {
          tabId: handle.tabId, requestId, mode, ...(continueFrom ? {} : { text: task, attachments }), locale: 'en' });
        if (response?.error || response?.accepted !== true) {
          rejectionProven = response?.accepted === false;
          throw new Error(response?.error || 'WebBrain did not accept the run.');
        }
        accepted = true;
        if (options.onJournal) await options.onJournal({ type: 'accepted', requestId, tabId: handle.tabId, backend: 'local' });
        const deadline = Date.now() + runTimeoutMs;
        while (Date.now() < deadline) {
          const state = await stateFor(handle, requestId);
          const journal = state.runUi;
          if (state.detachedError?.requestId === requestId) return result(entry, journal, 'failed', state.detachedError.message);
          if (journal?.requestId === requestId) {
            entry.runId = journal.runId || state.runId || entry.runId;
            for (const event of journal.events || []) {
              if (Number(event.seq) <= entry.lastSeq) continue;
              if (Number(event.seq) > entry.lastSeq + 1) {
                const gap = { type: 'event_gap', seq: Number(event.seq) - 1, requestId, runId: entry.runId,
                  tabId: handle.tabId, data: { eventsMissing: true } };
                entry.updates.push(gap);
                if (onUpdate) await onUpdate(gap);
              }
              const update = { ...safeUpdate(event), requestId, runId: entry.runId, tabId: handle.tabId };
              entry.lastSeq = Number(event.seq);
              entry.updates.push(update);
              if (onUpdate) await onUpdate(update);
            }
            if (terminalStatuses.has(journal.status)) return result(entry, journal, journal.status);
          } else if (state.running || state.starting) {
            if (!matchesRun(state, entry)) throw new Error('Selected tab is owned by a different WebBrain run.');
          }
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
        await backend.stop(handle);
        return result(entry, null, 'timeout', 'Run timed out; Stop was requested for the matching owned run.');
      } catch (error) {
        if (accepted) await backend.stop(handle).catch(() => {});
        const ambiguous = dispatched && !accepted && !rejectionProven;
        if (ambiguous && options.onJournal) {
          try { await options.onJournal({ type: 'ambiguous', requestId, tabId: handle.tabId, backend: 'local' }); } catch { /* The original unknown acceptance remains unknown. */ }
        }
        const failure = new LocalBackendError(error, ambiguous ? 'ambiguous' : accepted ? 'failed' : 'blocked',
          accepted ? 'local_run_failed' : ambiguous ? 'local_acceptance_unknown' : 'local_run_not_ready');
        failure.noDispatch = !dispatched || rejectionProven;
        failure.ambiguous = ambiguous;
        throw failure;
      } finally { activeRuns.delete(handle); }
    },
    async inspectSavedRun({ tabId, runId, requestId } = {}) {
      assertConnected();
      if (!Number.isSafeInteger(tabId) || tabId <= 0 || !requestId) {
        throw new LocalBackendError('Saved-run inspection requires its exact positive tabId and requestId.', 'blocked', 'local_saved_run_identity_missing');
      }
      const state = await transport.send('agent_run_state', { tabId, requestId });
      const journal = state?.runUi;
      if (state?.error || !journal || journal.requestId !== requestId || runId && journal.runId !== runId) {
        throw new LocalBackendError('The installed run journal does not match the saved identity.', 'blocked', 'local_saved_run_identity_mismatch');
      }
      return { backend: 'local', source: 'installed-extension-run-journal', tabId, requestId,
        runId: journal.runId, status: journal.status, active: state.running === true || state.starting === true,
        delivered: journal.runSucceeded === true, attachmentDeliveryState: journal.attachmentDeliveryState || '',
        updates: (journal.events || []).map(safeUpdate) };
    },
    async collectDownload({ handle, marker, filename, resourceId, expectedSha256, afterTimestamp, after } = {}) {
      ownHandle(handle);
      if (config.cdpUrl && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.cdpUrl).hostname.toLowerCase())) {
        throw new LocalBackendError('Remote CDP download bytes are not available in this machine filesystem.', 'blocked', 'download_remote_filesystem_unavailable');
      }
      const unsupported = reason => { throw new LocalBackendError(reason, 'unsupported', reason); };
      const since = new Date(afterTimestamp || after || 'invalid');
      if (!marker || marker.length < 12 || !filename || path.basename(filename) !== filename || !filename.includes(marker)
        || !resourceId || !/^[a-f0-9]{64}$/i.test(expectedSha256 || '') || !Number.isFinite(since.getTime())) {
        unsupported('download_exact_identity_missing');
      }
      if (!transport.downloads) unsupported('download_observation_unavailable');
      const belongs = value => {
        try {
          const url = new URL(value);
          return url.searchParams.get('id') === resourceId || decodeURIComponent(url.pathname).split('/').includes(resourceId);
        } catch { return false; }
      };
      const selectedResource = belongs(handle.page.url());
      const rows = await transport.downloads({ marker, after: since.toISOString() });
      const candidates = rows.filter(row => row.state === 'complete' && row.exists !== false
        && path.basename(row.filename) === filename && new Date(row.startTime).getTime() >= since.getTime());
      if (candidates.length !== 1) unsupported('download_unique_completed_file_unproven');
      const [download] = candidates;
      // CDN URLs can omit Drive IDs. In that case the exact current resource
      // URL, unique marked filename and independently known bytes must agree.
      if (!selectedResource && !belongs(download.url) && !belongs(download.referrer)) unsupported('download_resource_binding_unproven');
      let bytes;
      try {
        const stat = await fs.stat(download.filename);
        if (!stat.isFile() || stat.mtimeMs < since.getTime() - 1500) unsupported('download_file_freshness_unproven');
        bytes = await fs.readFile(download.filename);
      } catch (error) {
        if (error instanceof LocalBackendError) throw error;
        throw new LocalBackendError('The observed download could not be read from the local filesystem.', 'blocked', 'download_local_file_unavailable');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== expectedSha256.toLowerCase()) unsupported('download_actual_checksum_mismatch');
      return { independent: true, resourceId, sha256, bytes: bytes.length };
    },
    async stop(runOrHandle) {
      assertConnected();
      const entry = activeRuns.get(runOrHandle) || [...activeRuns.values()]
        .find(value => value.runId === runOrHandle || value.requestId === runOrHandle);
      if (!entry) throw new Error('Stop requires a currently owned harness run.');
      const state = await stateFor(entry.handle, entry.requestId);
      if (!matchesRun(state, entry)) throw new Error('Stop refused because the tab is no longer owned by this run.');
      if (!state.running && !state.starting && terminalStatuses.has(state.runUi?.status)) return { ok: true, alreadyTerminal: true };
      const response = await transport.send('abort', { tabId: entry.handle.tabId });
      if (response?.ok !== true) throw new Error(safeError(response?.error || 'Stop was not acknowledged.'));
      return response;
    },
    async steer({ handle, task }) {
      ownHandle(handle);
      const entry = activeRuns.get(handle);
      if (!entry || !String(task || '').trim()) throw new Error('Steering requires an active owned run and a correction.');
      const state = await stateFor(handle, entry.requestId);
      if (!matchesRun(state, entry) || !state.running) throw new Error('Steering refused because the matching run is not active.');
      const response = await transport.send('chat_steer', { tabId: handle.tabId, requestId: entry.requestId,
        messageId: `harness-steer-${crypto.randomUUID()}`, text: task });
      if (response?.error || response?.accepted !== true) throw new Error(safeError(response?.error || 'Steering was not accepted.'));
      return { accepted: true, requestId: entry.requestId, runId: entry.runId };
    },
    async checkpoint({ handle, selector, state = 'visible', timeoutMs: checkpointTimeout = timeoutMs, requireActiveRun = false }) {
      ownHandle(handle);
      if (!selector || !['visible', 'hidden', 'attached', 'detached'].includes(state)) throw new Error('Checkpoint requires a selector and supported state.');
      checkpoints.delete(handle);
      const deadline = Date.now() + checkpointTimeout;
      const entry = requireActiveRun ? activeRuns.get(handle) : null;
      const missed = reason => { throw new LocalBackendError(reason, 'blocked', 'local_checkpoint_missed'); };
      if (requireActiveRun && !entry) missed('Active checkpoint requires the exact owned harness run.');
      const readActive = async () => {
        if (activeRuns.get(handle) !== entry) missed('The owned run ended before the active checkpoint.');
        const actual = await stateFor(handle, entry.requestId);
        if (actual.detachedError?.requestId === entry.requestId
          || actual.runUi?.requestId === entry.requestId && terminalStatuses.has(actual.runUi.status)) {
          missed('The owned run became terminal before the active checkpoint.');
        }
        if ((actual.running || actual.starting) && !matchesRun(actual, entry)) missed('A different run owns the tab at the active checkpoint.');
        if (actual.running && matchesRun(actual, entry)) {
          entry.runId = actual.runUi?.runId || actual.runId || entry.runId;
          return { runtimeRunning: true, requestId: entry.requestId, runId: entry.runId };
        }
        return null;
      };
      let timing = {};
      if (requireActiveRun) {
        while (Date.now() < deadline) {
          timing = await readActive();
          if (timing) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
        }
        if (!timing) missed('The exact owned run did not begin before the checkpoint deadline.');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) missed('The observable checkpoint deadline was missed.');
      try { await handle.page.locator(selector).waitFor({ state, timeout: remaining }); }
      catch (error) {
        if (requireActiveRun) missed('The requested selector state was not reached during the owned run.');
        throw error;
      }
      if (requireActiveRun) {
        timing = await readActive();
        if (!timing) missed('The owned run stopped before the observable checkpoint resolved.');
      }
      const checkpoint = { reached: true, selector, state, url: handle.page.url(), at: Date.now(), ...timing };
      checkpoints.set(handle, checkpoint);
      return checkpoint;
    },
    async intervene({ handle, kind, selector, text, url, filePath, checkpoint, deltaX = 0, deltaY = 300, value } = {}) {
      ownHandle(handle);
      if (config.name === 'observer') throw new Error('Observer cannot simulate human mutations.');
      const previous = checkpoints.get(handle);
      if (previous?.runtimeRunning && activeRuns.get(handle)?.requestId !== previous.requestId) {
        throw new LocalBackendError('The run identified by the intervention checkpoint is no longer owned.', 'blocked', 'local_checkpoint_missed');
      }
      if (checkpoint) await backend.checkpoint({ ...(typeof checkpoint === 'string' ? { selector: checkpoint } : checkpoint),
        ...(previous?.runtimeRunning ? { requireActiveRun: true } : {}), handle });
      const reached = checkpoints.get(handle);
      if (!reached || Date.now() - reached.at > 30000 || reached.url !== handle.page.url()) {
        throw new Error('Human intervention requires a recent observable checkpoint in this exact tab.');
      }
      if (reached.runtimeRunning) {
        const entry = activeRuns.get(handle);
        const actual = entry && await stateFor(handle, reached.requestId);
        if (!entry || entry.requestId !== reached.requestId || !actual.running || !matchesRun(actual, entry)
          || terminalStatuses.has(actual.runUi?.status)) {
          throw new LocalBackendError('The exact run ended before the checkpoint-based human intervention.', 'blocked', 'local_checkpoint_missed');
        }
      }
      checkpoints.delete(handle);
      const action = ({ type: 'fill', draftchange: 'fill', 'draft-change': 'fill', selectionText: 'selection' })[kind] || kind;
      if (action === 'navigate') await handle.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      else if (action === 'reload') await handle.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
      else if (action === 'click') await handle.page.locator(selector).click();
      else if (action === 'fill') await handle.page.locator(selector).fill(text);
      else if (action === 'press') await handle.page.locator(selector).press(text);
      else if (action === 'upload') await handle.page.locator(selector).setInputFiles(filePath);
      else if (action === 'select' && value !== undefined) await handle.page.locator(selector).selectOption(value);
      else if (action === 'selection' || action === 'select') {
        await handle.page.locator(selector).click();
        await handle.page.locator(selector).press(text || 'ControlOrMeta+A');
      } else if (action === 'scroll') {
        if (![deltaX, deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 2000)) throw new Error('Human scroll deltas must be finite and bounded to 2000 pixels.');
        if (selector) await handle.page.locator(selector).hover();
        await handle.page.mouse.wheel(deltaX, deltaY);
      }
      else throw new Error('Unsupported explicit human intervention.');
      return { performed: true, kind, finalUrl: handle.page.url() };
    },
    async attachFile(filePath) {
      const absolute = path.resolve(filePath);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Attachment must be a file no larger than 20 MiB.');
      const name = path.basename(absolute);
      const extension = path.extname(name).toLowerCase();
      const bytes = await fs.readFile(absolute);
      if (['.txt', '.md', '.csv', '.json'].includes(extension)) return { name, kind: 'text', textContent: bytes.toString('utf8') };
      const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
      if (!mime) throw new Error('Only WebBrain-supported text, image and PDF chat attachments are accepted.');
      return { name, kind: extension === '.pdf' ? 'document' : 'image', mimeType: mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    },
    async close() {
      for (const entry of [...activeRuns.values()]) await backend.stop(entry.handle).catch(() => {});
      for (const page of ownedPages) await page.close().catch(() => {});
      ownedPages.clear(); handles.clear(); checkpoints.clear();
      await transport?.close?.().catch(() => {});
      transport = null;
      if (attached && browser) await detachAttachedBrowser(browser, options.detachAttachedBrowser);
      else if (context) await context.close();
      context = null; browser = null; metadata = null;
      if (profileKey) profileOwners.delete(profileKey);
      profileKey = null;
    },
  };
  return backend;
}
