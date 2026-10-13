import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import { WorkflowRunner } from './runner.mjs';
import { scenarios } from './scenarios.mjs';

// This layer exercises orchestration and independent DOM grading. The driver
// replaces backend.run only; it is not an installed-Agent/live-account result.
// Every browser request is fulfilled from an owned snapshot below.
const { chromium } = await import(process.env.WBTEST_PLAYWRIGHT_MODULE || 'playwright');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const escaped = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const html = value => `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif}main,header,a,div,span,input,textarea{min-height:2px}img{width:20px;height:20px}[contenteditable]{white-space:pre-wrap}</style>${value}`;
const account = identity => `<div id="identity">${escaped(identity)}</div>`;

function bindingFor(id) {
  const phone = ['telegram', 'whatsapp'].includes(id);
  const expectedIdentity = phone ? '+905550000001' : id === 'x' ? 'alice' : id === 'bluesky' ? 'alice.bsky.social'
    : id === 'mastodon' ? 'alice@qa.mastodon.test' : 'alice@example.test';
  const observerIdentity = phone ? '+905550000002' : 'bob@example.test';
  const urls = { x: 'https://x.com/home', whatsapp: 'https://web.whatsapp.com/', telegram: 'https://web.telegram.org/k/#123456',
    bluesky: 'https://bsky.app/', mastodon: 'https://qa.mastodon.test/', gmail: 'https://mail.google.com/mail/u/0/#all/thread00000001',
    protonmail: 'https://mail.proton.me/u/0/all-mail/thread00000001', drive: 'https://drive.google.com/drive/u/0/folders/ownedfolder12345' };
  return { url: urls[id], expectedIdentity, observerIdentity, identitySelector: '#identity',
    recipient: phone ? 'Bob QA' : observerIdentity,
    recipientIdentity: id === 'telegram' ? '123456' : observerIdentity,
    observerRecipient: phone ? 'Alice QA' : expectedIdentity,
    observerRecipientIdentity: id === 'telegram' ? '654321' : expectedIdentity,
    observerUrl: id === 'telegram' ? 'https://web.telegram.org/k/#654321' : urls[id],
    ...(id === 'drive' ? { folderUrl: urls.drive } : {}) };
}

function socialSnapshot(id, state) {
  if (state.deleted) return id === 'x' ? '<div data-testid="error-detail">This post was deleted</div>'
    : id === 'bluesky' ? '<div data-testid="notFoundScreen">Post has been deleted</div>' : '<div class="error-column">Status has been deleted</div>';
  if (!state.posted) {
    if (!state.body) return '<main>Owned empty timeline.</main>';
    const body = escaped(state.body);
    const media = state.attachment ? id === 'x' ? '<div data-testid="attachments"><img alt="owned fixture preview"></div>'
      : id === 'bluesky' ? '<div data-testid="selectedPhoto"><img alt="owned fixture preview"></div>' : '<div class="attachment-thumb">Owned preview</div>' : '';
    const saved = state.saved ? '<span data-testid="draftSaved">Saved draft</span>' : '';
    return id === 'x' ? `<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true">${body}</div>${media}${saved}</div>`
      : id === 'bluesky' ? `<div role="dialog"><div class="ProseMirror" contenteditable="true">${body}</div>${media}</div>`
        : `<div class="compose-form"><textarea>${body}</textarea>${media}</div>`;
  }
  const body = escaped(state.body);
  return id === 'x' ? `<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><div data-testid="tweetText">${body}</div><a href="/alice/status/1234567890123456789">time</a><div data-testid="tweetPhoto"><img alt="owned media"></div></article></main>`
    : id === 'bluesky' ? `<main><div data-testid="feedItem-by-alice"><a href="/profile/alice.bsky.social">Alice</a><div data-testid="postText">${body}</div><a href="/profile/alice.bsky.social/post/3mowned12345">time</a><div data-testid="postImage"><img alt="owned media"></div></div></main>`
      : `<main><div class="status" data-id="123456789"><a class="status__display-name" href="/@alice">Alice</a><div class="status__content">${body}</div><a class="status__relative-time" href="/@alice/123456789">time</a><div class="media-gallery"><img alt="owned media"></div></div></main>`;
}

function chatSnapshot(id, role, state, binding) {
  const peer = role === 'A' ? binding.recipientIdentity : binding.observerRecipientIdentity;
  const name = role === 'A' ? binding.recipient : binding.observerRecipient;
  const rows = state.records.map((row, index) => {
    const body = row.deleted ? 'You deleted this message' : escaped(row.body);
    const attachment = row.file && !row.deleted ? id === 'telegram' ? `<span class="document-name">${escaped(row.file)}</span>`
      : `<span data-testid="document-title">${escaped(row.file)}</span>` : '';
    if (id === 'telegram') return row.deleted ? '' : `<div class="bubble ${role === 'A' ? 'is-out is-sent' : 'is-in'}" data-mid="${42 + index}" data-peer-id="${peer}"><div class="message">${body}</div>${attachment}</div>`;
    const identifier = `${role === 'A' ? 'true' : 'false'}_${peer.replace(/[^0-9]/g, '')}@c.us_MSG${100000 + index}`;
    return `<div data-id="${identifier}"><span data-testid="selectable-text">${body}</span><div data-testid="msg-meta"><span aria-label="Sent">✓</span></div>${attachment}</div>`;
  }).join('');
  const editor = state.body && !state.posted ? escaped(state.body) : '';
  if (id === 'telegram') return `<div class="chat"><div class="topbar"><span class="peer-title" data-peer-id="${peer}">${name}</span></div><div class="bubbles-inner">${rows}</div><div class="input-message-input" contenteditable="true">${editor}</div></div>`;
  return `<div data-testid="chat-info-drawer"><span data-testid="phone-number">${peer}</span></div><div id="main"><header><span data-testid="conversation-info-header-chat-title">${name}</span></header><div data-testid="conversation-panel-messages">${rows}</div><footer><div contenteditable="true" role="textbox">${editor}</div></footer></div>`;
}

function mailSnapshot(id, state, binding) {
  if (!state.posted && state.body) return id === 'gmail'
    ? `<div role="dialog"><span email="${binding.recipientIdentity}">Bob</span><div contenteditable="true" role="textbox">${escaped(state.body)}</div>${state.saved ? '<div class="aYF">Saved to Drafts</div>' : ''}</div>`
    : `<div class="composer"><span data-address="${binding.recipientIdentity}">Bob</span><div contenteditable="true">${escaped(state.body)}</div>${state.saved ? '<div data-testid="composer:saved">Saved draft</div>' : ''}</div>`;
  const rows = state.records.map(row => id === 'gmail'
    ? `<div class="adn" data-legacy-message-id="${row.id}"><span class="gD" email="${binding.expectedIdentity}">Alice</span><span class="g2" email="${binding.recipientIdentity}">Bob</span><div class="a3s aiL">${escaped(row.body)}</div>${row.file ? `<span class="aV3">${escaped(row.file)}</span>` : ''}</div>`
    : `<div class="message-container" data-message-id="${row.id}"><span data-testid="message-header:from">${binding.expectedIdentity}</span><span data-testid="message-header:to">${binding.recipientIdentity}</span><div class="message-content">${escaped(row.body)}</div>${row.file ? `<span class="attachment-name">${escaped(row.file)}</span>` : ''}</div>`).join('');
  return id === 'gmail' ? `<div role="main">${rows}</div>` : `<div class="conversation">${rows}</div>`;
}

function driveSnapshot(role, state, url, binding) {
  const canonical = `/file/d/${state.fileId}/view`;
  if (state.deleted && new URL(url).pathname === canonical) return '<main role="main"><div role="alert">File is in the trash</div></main>';
  if (role === 'B' && state.shared) return `<h1>${escaped(state.fileName)}</h1><div role="document">Owned file preview.</div>`;
  const row = state.fileName ? `<div role="row" data-id="${state.fileId}" aria-selected="true"><div role="gridcell">${escaped(state.fileName)}</div><a href="${canonical}">Open</a></div>` : '';
  const share = state.shared ? `<div role="dialog" data-file-id="${state.fileId}"><h2>${escaped(state.fileName)}</h2><div class="permission-row"><span data-email="${binding.recipientIdentity}">Bob</span><span>Viewer</span></div></div>` : '';
  return `<main role="main"><div role="grid">${row}</div></main>${share}`;
}

async function harness(t, scenario, { mutate, runtimeStatus = 'completed' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-runner-owned-integration-'));
  const binding = bindingFor(scenario.site);
  const config = { schema: 'authenticated-tests/1', target: 'fixtures', cwd: process.cwd(), actors: {
    A: { name: 'actor', backend: 'local', profile: path.join(directory, 'actor-profile') },
    B: { name: 'observer', backend: 'local', profile: path.join(directory, 'observer-profile') },
  }, sites: { [scenario.site]: binding }, artifacts: directory, timeoutMs: 5000, totalTimeoutMs: 60000,
    maxRuns: 50, pollMs: 10, allowedActions: [], allowedRecipients: [], allowedDestinations: [], liveMutations: false,
    interventions: {}, secrets: [], manualEvidenceFile: null };
  const state = { records: [], fileId: 'ownedfile123456789', body: '', posted: false, saved: false, attachment: false };
  const calls = [], reloads = [], pages = { A: new Set(), B: new Set() };
  const contexts = {};
  let actorStageIndex = 0;
  const actorStages = scenario.steps.filter(stage => stage.actor === 'A');
  const render = (role, url) => html(account(role === 'A' ? binding.expectedIdentity : binding.observerIdentity)
    + (scenario.kind === 'social' ? socialSnapshot(scenario.site, state)
      : scenario.kind === 'chat' ? chatSnapshot(scenario.site, role, state, binding)
        : scenario.kind === 'mail' ? mailSnapshot(scenario.site, state, binding) : driveSnapshot(role, state, url, binding)));
  const refreshSnapshots = async () => {
    for (const role of ['A', 'B']) for (const page of pages[role]) await page.setContent(render(role, page.url()));
  };
  const factory = async (role, _config, { onJournal } = {}) => {
    const key = role.name === 'actor' ? 'A' : 'B';
    const context = contexts[key] = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: render(key, route.request().url()) }));
    return { capabilities: { domObservation: true, checkpoints: false, interventions: false },
      async connect() {},
      async doctor() { return { backend: 'deterministic-integration', browser: 'owned-dom-fixtures', readiness: true,
        provider: 'deterministic-integration', model: 'fixture-state-driver', sourceHashScope: 'owned-snapshots',
        capabilities: { domObservation: true } }; },
      async open(url) {
        calls.push({ type: 'open', role: key, url });
        const page = await context.newPage();
        pages[key].add(page);
        await page.goto(url);
        const reload = page.reload.bind(page);
        page.reload = async settings => { reloads.push({ role: key, stage: calls.findLast(call => call.type === 'run')?.stage }); return reload(settings); };
        return { page, tabId: calls.length, url: page.url() };
      },
      async run({ task, mode, handle, requestId, onUpdate }) {
        try {
        assert.equal(key, 'A', 'Observer B never gets an action task or runtime run.');
        assert.equal(typeof task, 'string', 'planTask returns an object; only its natural-language task belongs on the runtime bus.');
        assert.equal(mode, 'act');
        const stage = actorStages[actorStageIndex++];
        assert.ok(stage, 'Only scenario-defined actor stages may run.');
        const marker = task.match(/WBQA-[a-f0-9-]{36}/i)?.[0];
        assert.ok(marker, 'Every actual task retains its exact unique marker.');
        state.marker = marker;
        const quoted = [...task.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match => JSON.parse(match[0]));
        const body = quoted.findLast(value => value.startsWith(`${marker} `));
        const filePath = quoted.find(value => value.endsWith(`${marker}.txt`) || value.endsWith(`${marker}.png`));
        if (filePath && path.isAbsolute(filePath)) state.filePath = filePath;
        calls.push({ type: 'run', role: key, stage: stage.id, task, requestId, body, resourceKey: stage.resourceKey });
        await onJournal?.({ type: 'attempt', requestId, tabId: handle.tabId, backend: 'deterministic-integration' });
        await onJournal?.({ type: 'accepted', requestId, runId: `fixture-${requestId}`, tabId: handle.tabId, backend: 'deterministic-integration' });
        await onUpdate?.({ type: 'tool_call', runId: `fixture-${requestId}`, data: { name: `fixture_${stage.action}` } });
        if (stage.expectation === 'composer') { state.body = body; state.posted = false; state.saved ||= stage.requiresSavedDraft; state.attachment ||= stage.requiresAttachment; }
        else if (scenario.kind === 'social') {
          if (stage.action === 'delete') state.deleted = true;
          else state.posted = true;
          if (['navigation', 'delete'].includes(stage.action)) {
            const canonical = scenario.site === 'x' ? 'https://x.com/alice/status/1234567890123456789'
              : scenario.site === 'bluesky' ? 'https://bsky.app/profile/alice.bsky.social/post/3mowned12345'
                : 'https://qa.mastodon.test/@alice/123456789';
            assert.ok(task.includes(canonical), 'Persist and cleanup use the independently captured exact permalink.');
            await handle.page.goto(canonical);
          }
        } else if (scenario.kind === 'chat' || scenario.kind === 'mail') {
          if (stage.action === 'delete') {
            const target = state.records.find(record => record.key === stage.resourceKey);
            assert.ok(target && task.includes(target.id), 'Cleanup task names the immutable record captured for this exact resource key.');
            target.deleted = true;
            if (scenario.kind === 'mail') {
              await handle.page.goto(scenario.site === 'gmail' ? binding.url.replace('#all/', '#trash/') : binding.url.replace('/all-mail/', '/trash/'));
            }
          } else if (['send', 'reply', 'forward'].includes(stage.action)) {
            state.posted = true;
            const index = state.records.length;
            const id = scenario.site === 'whatsapp' ? `true_905550000002@c.us_MSG${100000 + index}`
              : scenario.site === 'telegram' ? `123456:${42 + index}` : `message0000000${index + 1}`;
            state.records.push({ key: stage.captureResourceKey, id, body, file: stage.requiresAttachment ? path.basename(state.filePath) : null });
          }
        } else {
          if (stage.action === 'upload') state.fileName = path.basename(state.filePath);
          if (stage.action === 'rename') state.fileName = quoted.find(value => value === `${marker}-renamed.txt`);
          if (stage.action === 'share') state.shared = true;
          if (stage.action === 'delete') state.deleted = true;
          if (['download', 'delete'].includes(stage.action)) await handle.page.goto(`https://drive.google.com/file/d/${state.fileId}/view`);
        }
        if (mutate) await mutate({ stage, state, pages, binding });
        await refreshSnapshots();
        return { status: runtimeStatus, runId: `fixture-${requestId}`, finalUrl: handle.page.url(), content: 'Deterministic integration driver terminal.', delivered: runtimeStatus === 'completed' };
        } catch (error) { t.diagnostic(`Owned driver failure: ${error.stack}`); throw error; }
      },
      async collectDownload({ handle, resourceId, expectedSha256 }) {
        assert.equal(new URL(handle.page.url()).pathname, `/file/d/${resourceId}/view`);
        const data = await fs.readFile(state.filePath);
        const sha256 = createHash('sha256').update(data).digest('hex');
        assert.equal(sha256, expectedSha256);
        return { independent: true, resourceId, sha256, bytes: data.length };
      },
      async close() { await context.close(); },
    };
  };
  const runner = await new WorkflowRunner(config, directory, { backendFactory: factory }).initialize();
  const observe = runner.observe.bind(runner);
  runner.observe = async (...args) => {
    try { return await observe(...args); } catch (error) { t.diagnostic(`Owned observer failure: ${error.stack}`); throw error; }
  };
  t.after(async () => { await runner.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { runner, state, calls, reloads, binding, directory };
}

for (const scenario of scenarios) {
  test(`deterministic integration: ${scenario.site} carries real plans through DOM evidence and owned cleanup`, async t => {
    const { runner, state, calls, reloads } = await harness(t, scenario);
    const result = await runner.runScenario(scenario);
    if (result.code === 'unexpected_error') t.diagnostic(`Owned pipeline calls: ${JSON.stringify(calls.map(call => ({ type: call.type, stage: call.stage, role: call.role })))}`);
    if (scenario.site === 'telegram') {
      assert.equal(result.status, 'failed');
      assert.equal(result.stage, 'cleanup-file');
      assert.equal(result.cleanup, 'pending', 'A disappeared Telegram row is not positive immutable deletion proof.');
      assert.ok(runner.ledger.pendingResources().length > 0);
    } else {
      assert.equal(result.status, 'passed', `Failed at ${result.stage}: ${result.code}`);
      assert.equal(result.stages.length, scenario.steps.length, 'The pipeline reached every required stage.');
      assert.equal(result.cleanup, 'verified');
      assert.equal(runner.ledger.pendingResources().length, 0);
      assert.equal(runner.ledger.pendingEntries().length, 0);
    }
    assert.equal(runner.doctors.A.provider, 'deterministic-integration');
    assert.equal(calls.filter(call => call.type === 'run' && call.role === 'B').length, 0);
    assert.equal(runner.ledger.data.entries.some(entry => entry.actor === 'B'), false, 'Read-only receipts create no mutation attempt.');
    for (const stage of scenario.steps.filter(stage => stage.actor === 'B')) {
      const observation = result.stages.find(row => row.id === stage.id);
      assert.equal(observation.delivery, 'read_only_observer');
      assert.equal(observation.effect, 'independently_verified');
    }
    assert.equal(reloads.some(row => ['compose', 'replace-body', 'attach-media', 'draft-reopen'].includes(row.stage)), false,
      'Independent composer evidence must not reload and discard the unsent UI.');
    const replacement = calls.find(call => call.type === 'run' && call.stage === 'replace-body');
    if (replacement) assert.equal(replacement.body, `${state.marker} revised exact text 🧠`);
    const cleanupCalls = calls.filter(call => call.type === 'run' && call.stage.startsWith('cleanup'));
    for (const cleanup of cleanupCalls) assert.ok(cleanup.resourceKey, 'Cleanup follows each stage-captured resource key.');
  });
}

test('deterministic integration: backend completion does not override a wrong independently observed body', async t => {
  const scenario = scenarios.find(item => item.site === 'x');
  const { runner } = await harness(t, scenario, { mutate({ stage, state }) {
    if (stage.id === 'replace-body') state.body += ' unexpected appended text';
  } });
  const result = await runner.runScenario(scenario);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'replace-body');
  assert.equal(result.stages.at(-1).delivery, 'runtime_completed');
  assert.equal(result.stages.at(-1).effect, 'unverified');
  assert.equal(runner.ledger.pendingEntries().length, 1);
});

test('deterministic integration: a runtime failure preserves independently proven effects without claiming stage success', async t => {
  const scenario = scenarios.find(item => item.site === 'x');
  const { runner } = await harness(t, scenario, { runtimeStatus: 'failed' });
  const result = await runner.runScenario(scenario);
  assert.equal(result.status, 'failed');
  assert.equal(result.stage, 'compose');
  assert.equal(result.stages[0].effect, 'independently_verified');
  assert.equal(result.stages[0].status, 'failed');
});
