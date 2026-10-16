// Regression tests for four narrow fixes, exercised against both builds:
//  U1  fetch_url / research_url say how content was retrieved: fetch_url opens
//      no tab; research_url uses a background tab that is never activated.
//  S1  trace run ids, conversation ids, text-parsed tool-call ids, progress
//      session ids, and completion run tokens carry no long decimal run that
//      Cloud payment-card redaction could rewrite.
//  H1  "Summarize this page" keeps reading while read_page reports hasMore.
//  I1  navigate's description matches the real leave-page dialog behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadBuild(build) {
  const src = (rel) => import(new URL(`../src/${build}/src/${rel}`, import.meta.url).href);
  const [network, tools, runHeader, share, runtime, actions, agent, parser] = await Promise.all([
    src('network/network-tools.js'),
    src('agent/tools.js'),
    src('trace/run-header.js'),
    src('trace/webbrain-share-outbox.js'),
    src('trace/cloud-runtime-outbox.js'),
    src('ui/recommended-actions.js'),
    src('agent/agent.js'),
    src('agent/tool-call-parser.js'),
  ]);
  return { build, network, tools, runHeader, share, runtime, actions, Agent: agent.Agent, parser };
}

const BUILDS = [await loadBuild('chrome'), await loadBuild('firefox')];
const API_NAME = { chrome: 'chrome', firefox: 'browser' };

// Swap browser globals for one test body and always restore them.
async function withGlobals(overrides, fn) {
  const saved = new Map();
  for (const key of Object.keys(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    globalThis[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function fakeResponse(url, contentType, body) {
  return {
    status: 200,
    url,
    headers: new Headers({ 'content-type': contentType }),
    text: async () => body,
  };
}

// ─── U1: retrieval metadata ─────────────────────────────────────────────

for (const { build, network } of BUILDS) {
  test(`${build}: fetch_url reports a background fetch and the credential mode actually used`, async () => {
    const fetchInits = [];
    const fetchStub = async (url, init) => {
      fetchInits.push(init);
      if (String(url).endsWith('.json')) return fakeResponse(String(url), 'application/json', '{"ok":true}');
      if (String(url).endsWith('.bin')) return fakeResponse(String(url), 'application/octet-stream', 'binary');
      return fakeResponse(String(url), 'text/html', '<html><title>Other</title><body>Untrusted article body</body></html>');
    };
    const tabsApi = { tabs: { get: async () => ({ id: 5, url: 'https://www.example.com/dashboard' }) } };

    await withGlobals({ fetch: fetchStub, [API_NAME[build]]: tabsApi }, async () => {
      const crossSite = await network.fetchUrl('https://news.example.org/story', {}, { tabId: 5 });
      assert.equal(crossSite.success, true);
      assert.equal(crossSite.retrieval, 'background_fetch');
      assert.equal(crossSite.visibleTabOpened, false);
      assert.equal(crossSite.activeTabChanged, false);
      assert.equal(crossSite.credentials, 'none', 'cross-site reads are anonymous');
      assert.equal(fetchInits.at(-1).credentials, 'omit', 'credentials field must match the request');
      assert.match(crossSite.text, /Untrusted article body/, 'page text is still returned for wrapping');

      const sameSite = await network.fetchUrl('https://api.example.com/v1/me.json', {}, { tabId: 5 });
      assert.equal(sameSite.success, true);
      assert.equal(sameSite.retrieval, 'background_fetch');
      assert.equal(sameSite.credentials, 'same_site_cookies');
      assert.equal(fetchInits.at(-1).credentials, 'include', 'credentials field must match the request');
      assert.match(sameSite.json, /"ok": true/);

      const binary = await network.fetchUrl('https://files.example.net/file.bin', {}, {});
      assert.equal(binary.retrieval, 'background_fetch');
      assert.equal(binary.credentials, 'none');
      assert.equal(binary.visibleTabOpened, false);
    });
  });

  test(`${build}: fetch_url page-context API replay reports the page's own cookies without a tab change`, async () => {
    const replayStore = new Map([['api_9_req_1', {
      tabId: 9,
      url: 'https://app.example.com/api/items',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }]]);
    const payload = { ok: true, status: 200, url: 'https://app.example.com/api/items', contentType: 'application/json', text: '{"items":[]}' };
    const api = build === 'chrome'
      ? {
        tabs: { get: async () => ({ id: 9, url: 'https://app.example.com/items' }) },
        scripting: { executeScript: async () => [{ result: payload }] },
      }
      : {
        tabs: {
          get: async () => ({ id: 9, url: 'https://app.example.com/items' }),
          executeScript: async () => [payload],
        },
      };
    const fetchStub = async () => { throw new Error('background fetch must not run for page replay'); };
    await withGlobals({ fetch: fetchStub, __webbrainApiRequestReplay: replayStore, [API_NAME[build]]: api }, async () => {
      const result = await network.fetchUrl('https://app.example.com/api/items', { replayRequestId: 'api_9_req_1' }, { tabId: 9 });
      assert.equal(result.success, true);
      assert.equal(result.replayContext, 'page');
      assert.equal(result.retrieval, 'background_fetch');
      assert.equal(result.visibleTabOpened, false);
      assert.equal(result.activeTabChanged, false);
      assert.equal(result.credentials, 'same_site_cookies');
    });
  });

  test(`${build}: research_url reports the background tab it opened without claiming it was hidden`, async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let createProps = null;
    let removeCalls = 0;
    const pageResult = {
      title: 'Rendered page',
      url: 'https://spa.example.com/app',
      text: 'Untrusted rendered text',
      originalLength: 23,
      links: [{ text: 'Next', href: 'https://spa.example.com/next' }],
    };
    const tabs = {
      async create(props) { createProps = props; return { id: 77, url: props.url }; },
      async get() { return { id: 77, url: 'https://spa.example.com/app' }; },
      async remove() { removeCalls++; },
      onUpdated: {
        addListener(fn) { nativeSetTimeout(() => fn(77, { status: 'complete' }), 0); },
        removeListener() {},
      },
    };
    const api = build === 'chrome'
      ? { tabs, scripting: { async executeScript() { return [{ result: pageResult }]; } } }
      : { tabs: { ...tabs, async executeScript() { return [pageResult]; } } };
    // Skip only the fixed 800 ms SPA hydration pause.
    const fastTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms === 800 ? 0 : ms, ...args);
    await withGlobals({ setTimeout: fastTimeout, [API_NAME[build]]: api }, async () => {
      const result = await network.researchUrl('https://spa.example.com/app', { timeout: 1000 });
      assert.equal(result.success, true, result.error);
      assert.equal(result.retrieval, 'background_tab');
      assert.equal(result.backgroundTabOpened, true, 'a real tab was created and may be seen in the tab strip');
      assert.equal(result.backgroundTabActivated, false);
      assert.equal(result.backgroundTabCloseRequested, true);
      assert.equal(result.activeTabChanged, false);
      for (const stale of ['visibleTabOpened', 'hiddenTabClosed']) {
        assert.equal(Object.hasOwn(result, stale), false, `${stale} misdescribes a tab that sits in the tab strip`);
      }
      assert.equal(createProps.active, false, 'backgroundTabActivated:false must reflect an inactive tab');
      assert.equal(removeCalls, 1, 'backgroundTabCloseRequested:true must reflect the tab removal');
      assert.equal(result.text, 'Untrusted rendered text');
    });
  });
}

for (const { build, network, Agent } of BUILDS) {
  test(`${build}: retrieval flags survive the result cap inside the untrusted wrapper`, async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const huge = {
      title: 'Huge',
      url: 'https://big.example.com/',
      text: 'body '.repeat(40000),
      originalLength: 200000,
      links: Array.from({ length: 50 }, (_, i) => ({ text: 'L'.repeat(80), href: `https://big.example.com/${'p'.repeat(200)}/${i}` })),
    };
    const tabs = {
      async create(props) { return { id: 78, url: props.url }; },
      async get() { return { id: 78, url: 'https://big.example.com/' }; },
      async remove() {},
      onUpdated: {
        addListener(fn) { nativeSetTimeout(() => fn(78, { status: 'complete' }), 0); },
        removeListener() {},
      },
    };
    const api = build === 'chrome'
      ? { tabs, scripting: { async executeScript() { return [{ result: huge }]; } } }
      : { tabs: { ...tabs, async executeScript() { return [huge]; } } };
    const fastTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms === 800 ? 0 : ms, ...args);
    const result = await withGlobals({ setTimeout: fastTimeout, [API_NAME[build]]: api },
      () => network.researchUrl('https://big.example.com/', { timeout: 1000 }));
    const agent = new Agent({});
    const content = agent._wrapUntrusted('research_url', agent._limitToolResult(result));
    assert.match(content, /^<untrusted_page_content id="[0-9a-z]+">/, 'page text must stay inside the untrusted boundary');
    assert.match(content, /"retrieval":"background_tab","backgroundTabOpened":true,"backgroundTabActivated":false,"backgroundTabCloseRequested":true,"activeTabChanged":false/);
  });
}

for (const { build, tools } of BUILDS) {
  test(`${build}: background read tool descriptions are accurate, compact, and route open/show requests to navigate`, () => {
    const NAVIGATE_ROUTE = 'To open/show a page, use navigate and confirm its URL/title.';
    const FETCH_GUIDANCE = `Background read: opens or shows no tab; active tab unchanged. ${NAVIGATE_ROUTE}`;
    const RESEARCH_TAB = 'Open a URL in a background tab (it may briefly appear in the tab strip),';
    const RESEARCH_GUIDANCE = `Active tab unchanged. ${NAVIGATE_ROUTE}`;
    for (const [mode, tier] of [['ask', 'full'], ['act', 'full'], ['act', 'mid'], ['act', 'compact']]) {
      const schemas = new Map(tools.getToolsForMode(mode, { tier }).map(tool => [tool.function.name, tool.function.description]));
      const fetchDescription = schemas.get('fetch_url') || '';
      assert.ok(fetchDescription.endsWith(` ${FETCH_GUIDANCE}`), `${mode}/${tier} fetch_url`);
      if (tier === 'compact') {
        assert.equal(schemas.has('research_url'), false, 'research_url is not in the compact tier');
        continue;
      }
      const researchDescription = schemas.get('research_url') || '';
      assert.ok(researchDescription.startsWith(RESEARCH_TAB), `${mode}/${tier} research_url`);
      assert.ok(researchDescription.endsWith(` ${RESEARCH_GUIDANCE}`), `${mode}/${tier} research_url`);
      // A visible tab-strip tab must not be described as hidden or never shown.
      assert.doesNotMatch(researchDescription, /hidden|never shown/i, `${mode}/${tier} research_url`);
    }
    // fetch_url is in the compact tier small local models use, so the added
    // guidance stays short (about 120 characters per tool).
    assert.ok(` ${FETCH_GUIDANCE}`.length <= 125);
    assert.ok(` (it may briefly appear in the tab strip) ${RESEARCH_GUIDANCE}`.length <= 125);
    assert.match(tools.SYSTEM_PROMPT_ACT, /without showing the page, so when the user asks to open, go to, or show a page, use `navigate` instead/);
  });
}

// ─── S1: redaction-safe identifiers ─────────────────────────────────────

// A 13-digit ms timestamp (2026-10-15T12:00:00Z) that passes the Luhn check.
const LUHN_VALID_MS = 1792065600000;

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Local stand-in for card redaction: 13–19 digits, optionally separated by
// spaces or dashes, that pass Luhn.
function cardLikeRuns(text) {
  return [...String(text).matchAll(/\d(?:[ -]?\d){12,18}/g)]
    .map(match => match[0].replace(/[ -]/g, ''))
    .filter(luhnValid);
}

test('the fixture timestamp is a Luhn-valid 13-digit run that old run ids exposed', () => {
  assert.equal(String(LUHN_VALID_MS).length, 13);
  assert.equal(luhnValid(String(LUHN_VALID_MS)), true);
  assert.deepEqual(cardLikeRuns(`run_${LUHN_VALID_MS}_abc123`), [String(LUHN_VALID_MS)], 'old format is redactable');
});

for (const { build, runHeader, share, runtime } of BUILDS) {
  test(`${build}: generateTraceRunId keeps run ids free of long decimal runs`, () => {
    const runId = runHeader.generateTraceRunId(LUHN_VALID_MS, 'k3x9q2ab');
    assert.equal(runId, `run_${LUHN_VALID_MS.toString(36)}_k3x9q2ab`);
    assert.match(runId, /^run_[0-9a-z]+_[0-9a-z]+$/);
    assert.doesNotMatch(runId, /\d{13,}/);
    assert.doesNotMatch(runId, /\d{9,}/);
    assert.deepEqual(cardLikeRuns(runId), []);
    // Even an all-digit token stays far below card length.
    assert.doesNotMatch(runHeader.generateTraceRunId(LUHN_VALID_MS, '12345678'), /\d{9,}/);
    // Malformed inputs still produce a well-formed id.
    assert.match(runHeader.generateTraceRunId(Number.NaN, 'A-b_C!'), /^run_0_abc$/);
    assert.match(runHeader.generateTraceRunId(LUHN_VALID_MS, ''), /^run_[0-9a-z]+_0$/);

    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'done', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"done":true}' },
    ];
    for (const id of [runId, `run_${LUHN_VALID_MS}_abc123`]) {
      // Old and new ids remain valid opaque keys everywhere they travel.
      assert.deepEqual(runHeader.normalizeRunHeader({ parentRunId: id }), { parentRunId: id });
      const diagnostic = share.buildShareDiagnosticItem({ runId: id, events: [{ seq: 1, kind: 'llm_request', data: { step: 0 } }], status: 'done' });
      assert.equal(diagnostic.id, `diag_${id}`);
      assert.equal(diagnostic.diagnostic.event.runId, id);
      const generation = share.buildShareGenerationItem({ runId: id, finalContent: 'answer', messages: [{ role: 'user', content: 'q' }] });
      assert.equal(generation.id, id);
      const terminal = runtime.buildTerminalRuntimeEvent({ runId: id, status: 'done', finalContent: 'x', messages });
      assert.equal(terminal.event_id, `${id}:1:terminal_runtime`);
    }
    const uploaded = JSON.stringify([
      share.buildShareDiagnosticItem({ runId, events: [{ seq: 1, kind: 'llm_request', data: { step: 0 } }], status: 'done' }).id,
      share.buildShareGenerationItem({ runId, finalContent: 'answer', messages: [{ role: 'user', content: 'q' }] }).id,
      runtime.buildTerminalRuntimeEvent({ runId, status: 'done', finalContent: 'x', messages }).event_id,
    ]);
    assert.deepEqual(cardLikeRuns(uploaded), [], 'uploaded keys must not contain a card-like run');
  });
}

for (const { build, Agent } of BUILDS) {
  test(`${build}: conversation ids use a base36 timestamp`, async () => {
    const agent = new Agent({});
    agent._hydrate = async () => {};
    agent._persistNow = async () => {};
    const realNow = Date.now;
    Date.now = () => LUHN_VALID_MS;
    try {
      agent.getConversation(41, 'ask');
      await agent.forkConversation(41, 42);
    } finally {
      Date.now = realNow;
    }
    for (const tabId of [41, 42]) {
      const conversationId = agent.conversationIds.get(tabId);
      assert.match(conversationId, new RegExp(`^conv_${tabId}_${LUHN_VALID_MS.toString(36)}_[0-9a-z]{12}$`));
      assert.doesNotMatch(conversationId, /\d{13,}/);
      assert.deepEqual(cardLikeRuns(conversationId), []);
      assert.deepEqual(cardLikeRuns(agent._shareSessionId(conversationId)), []);
    }
  });
}

test('the old text-parsed tool-call id format exposed the same redactable run', () => {
  assert.deepEqual(cardLikeRuns(`fallback_call_${LUHN_VALID_MS}_0`), [String(LUHN_VALID_MS)]);
});

for (const { build, parser, share, runtime } of BUILDS) {
  test(`${build}: text-parsed tool-call ids stay intact in share and runtime uploads`, () => {
    const realNow = Date.now;
    Date.now = () => LUHN_VALID_MS;
    let calls;
    try {
      calls = parser.parseToolCallsFromText(
        '<tool_call>{"name":"read_page","arguments":{}}</tool_call>\n<tool_call>{"name":"done","arguments":{"summary":"ok"}}</tool_call>',
        new Set(['read_page', 'done']),
      );
    } finally {
      Date.now = realNow;
    }
    const stamp = LUHN_VALID_MS.toString(36);
    assert.deepEqual(calls.map(call => call.id), [`fallback_call_${stamp}_0`, `fallback_call_${stamp}_1`]);
    for (const call of calls) assert.doesNotMatch(call.id, /\d{9,}/);

    const messages = [
      { role: 'user', content: 'Read the page, then finish.' },
      { role: 'assistant', content: null, tool_calls: calls },
      { role: 'tool', tool_call_id: calls[0].id, content: '{"success":true}' },
      { role: 'tool', tool_call_id: calls[1].id, content: '{"success":true,"done":true}' },
    ];
    // Share request: tool_calls[].id and tool_call_id are uploaded verbatim.
    const generation = share.buildShareGenerationItem({
      runId: 'run_abc_def',
      finalContent: 'ok',
      messages: [...messages, { role: 'assistant', content: 'ok' }],
    });
    const sharedIds = generation.request.flatMap(message =>
      [...(message.tool_calls || []).map(call => call.id), message.tool_call_id].filter(Boolean));
    assert.deepEqual(sharedIds, [calls[0].id, calls[1].id, calls[0].id, calls[1].id]);
    // Runtime event: the terminal call id is uploaded as terminal_tool.call_id.
    const terminal = runtime.buildTerminalRuntimeEvent({ runId: 'run_abc_def', status: 'done', finalContent: 'ok', messages });
    assert.equal(terminal.event.data.terminal_tool.call_id, calls[1].id);
    assert.deepEqual(cardLikeRuns(JSON.stringify([sharedIds, terminal.event.data.terminal_tool.call_id])), []);
  });
}

for (const { build, Agent } of BUILDS) {
  test(`${build}: progress session ids use a base36 timestamp and still round-trip`, () => {
    const agent = new Agent({ getActive: () => ({ contextWindow: 128000, supportsVision: false }) });
    const tabId = 43;
    agent._persist = () => {};
    agent.conversationModes.set(tabId, 'act');
    agent.conversations.set(tabId, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Follow Alice.' },
    ]);
    const realNow = Date.now;
    Date.now = () => LUHN_VALID_MS;
    let session;
    try {
      session = agent._setProgressSession(tabId, {
        mode: 'active', allowedActions: ['follow'], forbiddenActions: [], targets: ['Alice'], confidence: 0.95,
      }, { taskText: 'Follow Alice.', source: 'classifier' });
    } finally {
      Date.now = realNow;
    }
    assert.match(session.sessionId, new RegExp(`^progress_${tabId}_${LUHN_VALID_MS.toString(36)}_\\d+$`));
    assert.deepEqual(cardLikeRuns(session.sessionId), []);
    // The id is an opaque key: the ledger, progress_read, and the resume
    // instruction (model-facing, hence uploaded with shared requests) all
    // carry it verbatim.
    const update = agent._progressUpdate(tabId, {
      items: [{ id: 'alice', label: 'Alice', target: 'Alice', action: 'follow', status: 'pending' }],
    });
    assert.equal(update.success, true, update.error);
    const read = agent._progressRead(tabId, { sessionId: session.sessionId });
    assert.equal(read.sessionId, session.sessionId);
    assert.deepEqual(read.rows.map(row => [row.id, row.sessionId]), [['alice', session.sessionId]]);
    assert.ok(agent._buildAutoProgressResumeInstruction(tabId)
      .includes(`progress_read({sessionId: "${session.sessionId}"})`));
  });

  // Native chat reply rows store this token as chatRunToken, which the pinned
  // ledger shows to the model.
  test(`${build}: completion run tokens use a base36 timestamp`, () => {
    const agent = new Agent({});
    const realNow = Date.now;
    Date.now = () => LUHN_VALID_MS;
    let token;
    try {
      token = agent._beginCompletionInvariant(44);
    } finally {
      Date.now = realNow;
    }
    assert.match(token, new RegExp(`^completion_44_${LUHN_VALID_MS.toString(36)}_\\d+$`));
    assert.equal(agent.completionInvariants.get(44).runToken, token);
    assert.deepEqual(cardLikeRuns(token), []);
  });
}

// ─── H1: page summaries follow read_page continuations ──────────────────

const LONG_ARTICLE = { url: 'https://news.example.com/article/story', title: 'Long article', text: 'word '.repeat(500) };

for (const { build, actions } of BUILDS) {
  test(`${build}: summarize-page keeps reading until read_page reports hasMore:false`, () => {
    const action = actions.buildRecommendedActions(LONG_ARTICLE).find(candidate => candidate.id === 'summarize-page');
    assert.ok(action, 'summarize-page recommendation missing');
    assert.match(action.prompt, /^Use read_page first/);
    assert.match(action.prompt, /While read_page returns hasMore:true, call it again with its exact continuationArgs until hasMore is false/);
    assert.match(action.prompt, /If you stop reading early, say which part of the page the summary covers/);
    const { runOptions } = action;
    assert.equal(runOptions.tool, 'read_page');
    assert.deepEqual(runOptions.args, { includeChrome: false });
    assert.equal(runOptions.steps.length, 3);
    assert.match(runOptions.steps[1], /hasMore:true[\s\S]*exact returned continuationArgs until hasMore is false/);
    assert.match(runOptions.steps[2], /if you stopped before hasMore:false, say which part/);
    assert.equal(runOptions.steps.some(step => /Summarize the returned/.test(step)), false, 'one-window summary step removed');
  });

  test(`${build}: explain-page read_page variant also honors continuations`, () => {
    const source = fs.readFileSync(path.join(ROOT, `src/${build}/src/ui/recommended-actions.js`), 'utf8');
    assert.match(source, /'Use read_page first for the current long-form page\. If read_page returns hasMore:true, continue with its exact continuationArgs as needed\./);
    assert.match(source, /'If read_page returns hasMore:true, continue with the exact returned continuationArgs as needed\.'/);
    assert.doesNotMatch(source, /Explain the page from the returned page text\./);
  });
}

// ─── I1: navigate leave-page wording ────────────────────────────────────

for (const { build, tools } of BUILDS) {
  test(`${build}: navigate describes automatic Leave and unanswered confirmations accurately`, () => {
    const description = tools.AGENT_TOOLS.find(tool => tool.function.name === 'navigate').function.description;
    assert.doesNotMatch(description, /cannot be accepted automatically/);
    assert.match(description, /attached files or two or more filled fields, this is blocked and returns blockedUnsavedChanges/);
    assert.match(description, /Other edits \(a single field, rich-text content\) are not detected/);
    assert.match(description, /leave-page warning may be answered Leave automatically, so save first/);
    assert.match(description, /leave-page confirmation that WebBrain cannot answer stays open, this returns navigationPending\/confirmationPossible instead of success and the user must answer it/);
  });
}

test('navigate, fetch_url, and research_url descriptions stay aligned across builds', () => {
  const [chrome, firefox] = BUILDS.map(({ tools }) => new Map(tools.AGENT_TOOLS.map(tool => [tool.function.name, tool.function.description])));
  assert.equal(chrome.get('navigate'), firefox.get('navigate'));
  assert.equal(chrome.get('fetch_url'), firefox.get('fetch_url'));
  // The builds word the rest of research_url differently; the tab wording and
  // the closing guidance must match.
  const head = (description) => description.slice(0, description.indexOf('),') + 2);
  const tail = (description) => description.slice(description.indexOf('Active tab unchanged.'));
  assert.equal(head(chrome.get('research_url')), head(firefox.get('research_url')));
  assert.equal(tail(chrome.get('research_url')), tail(firefox.get('research_url')));
});
