// list_downloads and read_downloaded_file see only the downloads of their own
// conversation: files WebBrain's download tools saved there, and downloads
// that started while one of its runs was active on the tab. The rest of the
// browser's download history is the user's own: it is never listed, and a
// file from it is read only after the user approves that exact file on
// WebBrain's card. Listed files carry their basename, never the local path.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let pw;
before(async () => { pw = await chromium.launch({ headless: true }); });
after(async () => { await pw?.close(); });

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-download-scope-'));
const owned = { id: 41, name: 'report.csv', text: 'region,total\nnorth,12\n' };
const later = { id: 43, name: 'export.json', text: '{"ok":true}' };
const private_ = { id: 7, name: 'tax-return-2025.txt', text: 'Private: not from this chat.' };
const outside = { id: 44, name: 'outside-run.txt', text: 'Downloaded between runs.' };
const records = new Map();
for (const file of [owned, later, private_, outside]) {
  const local = path.join(directory, file.name);
  await fs.writeFile(local, file.text);
  records.set(file.id, { id: file.id, state: 'complete', exists: true, filename: local, fileSize: Buffer.byteLength(file.text),
    mime: 'text/plain', startTime: new Date(2026, 9, file.id).toISOString(),
    url: `https://files.example/${file.name}`, dataUrl: `data:text/plain;base64,${Buffer.from(file.text).toString('base64')}` });
}

const searches = [];
let createdListeners = [];
let kind = 'chrome';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { id: 'webbrain-test', getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://owned.example/', title: 'Owned' }), query: async () => [], sendMessage: async () => ({}) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: 'https://owned.example/', documentId: 'owned-document' }] },
  scripting: { executeScript: async () => [{ result: null }] },
  downloads: {
    // Firefox reads only the payload captured in the record (a data: URL).
    search: async query => {
      searches.push(query);
      const view = ({ dataUrl, ...item }) => ({ ...item, ...(kind === 'firefox' ? { url: dataUrl } : {}) });
      if (query.id == null) return [...records.values()].map(view);
      return records.has(query.id) ? [view(records.get(query.id))] : [];
    },
    onCreated: {
      addListener: listener => { createdListeners.push(listener); },
      removeListener: listener => { createdListeners = createdListeners.filter(item => item !== listener); },
    },
  },
};
globalThis.chrome = api;
globalThis.browser = api;

const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
let localReads = [];
cdpClient.attach = async () => {};
cdpClient.probeLocalFile = async (_tabId, localPath, options) => {
  localReads.push(localPath);
  const data = await fs.readFile(localPath);
  const prefix = data.subarray(0, options.readPrefixBytes || options.maxBytes);
  return { exists: true, readable: true, size: data.length, base64: prefix.toString('base64'),
    dataBytesRead: prefix.length, dataTruncated: prefix.length < data.length };
};

const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  network: await import(`../src/${build}/src/network/network-tools.js`),
})));

function setup(Agent) {
  const provider = { name: 'local test', model: 'test', promptTier: 'full', contextWindow: 128000, supportsTools: true, supportsVision: false };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  return agent;
}

// The side panel's side of a card: every 'clarify' update, answered by `answer`.
function panel(agent, tabId, answer) {
  const cards = [];
  const onUpdate = (type, data) => {
    if (type !== 'clarify') return;
    cards.push(data);
    if (answer === 'stop') setTimeout(() => agent._cancelClarifications(tabId, 'stopped'), 0);
    else if (answer) setTimeout(() => agent.submitClarifyResponse(tabId, data.clarifyId, answer), 0);
  };
  return { cards, onUpdate };
}

for (const { build, Agent, network } of builds) {
  test(`${build}: list_downloads never enumerates the browser's download history`, async () => {
    kind = build;
    searches.length = 0;
    const none = await network.listDownloads({}, {});
    assert.equal(none.success, true);
    assert.deepEqual(none.downloads, []);
    assert.match(none.note, /ask them to attach it/);
    const some = await network.listDownloads({ limit: 1 }, { downloadIds: new Set([owned.id, later.id]) });
    assert.deepEqual(some.downloads.map(item => item.id), [later.id], 'newest first, within the limit');
    const listed = await network.listDownloads({}, { downloadIds: [owned.id, later.id, 999] });
    assert.deepEqual(listed.downloads.map(item => [item.id, item.filename]), [[later.id, later.name], [owned.id, owned.name]]);
    for (const item of listed.downloads) assert.doesNotMatch(item.filename, /[\\/]/, 'basename only, never the local path');
    assert.ok(searches.length > 0 && searches.every(query => Number.isSafeInteger(query.id)),
      `every lookup names one conversation download: ${JSON.stringify(searches)}`);
  });

  test(`${build}: a download from this conversation is listed and read without asking`, async () => {
    kind = build;
    const agent = setup(Agent);
    const tabId = build === 'chrome' ? 5101 : 5102;
    agent._pinDownloadHandles(tabId, 'download_files', { success: true, downloads: [{ success: true, downloadId: owned.id, state: 'complete' }] });
    const { cards, onUpdate } = panel(agent, tabId, null);
    const listed = await agent.executeTool(tabId, 'list_downloads', {}, onUpdate);
    assert.deepEqual(listed.downloads.map(item => [item.id, item.filename]), [[owned.id, owned.name]]);
    localReads = [];
    const read = await agent.executeTool(tabId, 'read_downloaded_file', { downloadId: owned.id }, onUpdate);
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(read.text, owned.text);
    assert.equal(read.filename, owned.name, 'the read names the file by its basename');
    assert.equal(cards.length, 0, 'no card for a file this conversation downloaded');
  });

  test(`${build}: downloads that start during a run belong to its conversation, and survive a worker restart`, async () => {
    kind = build;
    createdListeners = [];
    const agent = setup(Agent);
    const tabId = build === 'chrome' ? 5111 : 5112;
    agent.conversations.set(tabId, [{ role: 'system', content: 'test' }]);
    agent.conversationIds.set(tabId, `conv_${tabId}`);
    for (const listener of createdListeners) listener({ id: outside.id });
    await agent._claimRunEntry(tabId, 'interactive', {});
    agent._watchRunDownloads();
    assert.equal(createdListeners.length, 1, 'one listener for the worker, added with the first run');
    for (const listener of createdListeners) listener({ id: later.id });
    agent._releaseRunEntry(tabId);
    for (const listener of createdListeners) listener({ id: outside.id });
    const listed = await agent.executeTool(tabId, 'list_downloads', {});
    assert.deepEqual(listed.downloads.map(item => item.id), [later.id], 'a download outside a run is not the conversation\'s');

    const entry = agent._conversationStorageEntry(tabId);
    assert.deepEqual(entry.conversationDownloads, { conversationId: `conv_${tabId}`, ids: [later.id] });
    const restored = setup(Agent);
    const stored = { [`agentConv:${tabId}`]: entry };
    const session = api.storage.session;
    api.storage.session = { ...session, get: async key => (typeof key === 'string' && key in stored ? { [key]: stored[key] } : {}) };
    try {
      await restored._hydrate(tabId);
      assert.deepEqual([...restored._conversationDownloads.get(tabId)], [later.id]);
      const other = setup(Agent);
      stored[`agentConv:${tabId}`] = { ...entry, conversationDownloads: { conversationId: 'conv_other', ids: [private_.id] } };
      await other._hydrate(tabId);
      assert.equal(other._conversationDownloads.has(tabId), false, 'another conversation\'s ids are not restored');
    } finally { api.storage.session = session; }
    restored.clearConversation(tabId);
    assert.equal(restored._conversationDownloads.has(tabId), false, 'a cleared conversation starts empty');
  });

  test(`${build}: a file from outside this conversation is read only after the user approves that exact file`, async () => {
    kind = build;
    const tabId = build === 'chrome' ? 5121 : 5122;

    const declined = setup(Agent);
    const deny = panel(declined, tabId, 'deny');
    localReads = [];
    const refused = await declined.executeTool(tabId, 'read_downloaded_file', { downloadId: private_.id }, deny.onUpdate);
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'download_not_from_conversation');
    assert.equal(refused.readDeclined, true);
    assert.equal(refused.text, undefined);
    assert.deepEqual(localReads, [], 'no bytes read');
    assert.equal(deny.cards.length, 1);
    assert.equal(deny.cards[0].promptKind, 'download_read');
    assert.deepEqual(deny.cards[0].downloadReadConfirmation, { filename: private_.name, host: build === 'chrome' ? 'files.example' : '' });
    assert.deepEqual(deny.cards[0].options, ['once', 'deny']);
    assert.doesNotMatch(JSON.stringify(deny.cards[0]), new RegExp(directory.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').slice(0, 40)),
      'the card names the file, not its local path');

    const approved = setup(Agent);
    const once = panel(approved, tabId, 'once');
    const read = await approved.executeTool(tabId, 'read_downloaded_file', { downloadId: private_.id }, once.onUpdate);
    assert.equal(read.success, true, JSON.stringify(read));
    assert.equal(read.text, private_.text);
    assert.equal(once.cards.length, 1);
    const again = await approved.executeTool(tabId, 'read_downloaded_file', { downloadId: private_.id }, panel(approved, tabId, 'deny').onUpdate);
    assert.equal(again.readDeclined, true, '"Read this file once" covers one read');
    assert.deepEqual((await approved.executeTool(tabId, 'list_downloads', {})).downloads, [], 'an approved read does not list the file');

    const stopped = setup(Agent);
    const stop = panel(stopped, tabId, 'stop');
    const cancelled = await stopped.executeTool(tabId, 'read_downloaded_file', { downloadId: private_.id }, stop.onUpdate);
    assert.equal(cancelled.success, false);
    assert.equal(cancelled.cancelled, true);

    const unattended = setup(Agent);
    unattended.scheduledRunPolicies.set(tabId, { requireConsequentialConfirmation: false });
    const nobody = panel(unattended, tabId, 'once');
    const unasked = await unattended.executeTool(tabId, 'read_downloaded_file', { downloadId: private_.id }, nobody.onUpdate);
    assert.equal(unasked.success, false);
    assert.match(unasked.error, /cannot be asked/);
    assert.equal(nobody.cards.length, 0, 'an unattended run shows no card and reads nothing');

    const guessed = setup(Agent);
    const guess = panel(guessed, tabId, 'once');
    const missing = await guessed.executeTool(tabId, 'read_downloaded_file', { downloadId: 999 }, guess.onUpdate);
    assert.equal(missing.code, 'download_not_from_conversation');
    assert.equal(guess.cards.length, 0, 'no card for an id that names no readable download');
  });

  test(`${build}: the side panel names the file as text on fixed choices that never time out`, async () => {
    const source = (await fs.readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal((source.match(/card\.dataset\.downloadReadConfirmation === '1'\) return;/g) || []).length, 2,
      'neither a restored card nor an auto-answer times it out');
    const extract = name => {
      const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
      assert.ok(start >= 0, name);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const page = await pw.newPage();
    try {
      await page.setContent('<div id="messages"><div class="message assistant" data-run-request-id="read-request"><div class="message-content"><div class="message-text"></div></div></div></div>');
      await page.evaluate(({ functions, dictionary }) => {
        const noop = () => {};
        Object.assign(window, {
          messagesEl: document.querySelector('#messages'), currentAssistantEl: document.querySelector('.assistant'), currentTabId: 7,
          submittedClarificationIds: new Set(), answers: [],
          t: (key, params) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (params?.[name] != null ? String(params[name]) : `{${name}}`)),
          submitClarify: (_card, _tab, clarifyId, value, source) => window.answers.push({ clarifyId, value, source }),
          hideRecommendedActions: noop, resetChatNavigation: noop, hideActivity: noop, scrollToBottom: noop, applyClarifyTimeoutExtension: noop,
          addMessage: () => { throw new Error('no new message'); },
        });
        (0, eval)(functions);
        window.renderClarifyCard({ clarifyId: 'download_read_1', promptKind: 'download_read', question: 'English fallback',
          downloadReadConfirmation: { filename: '<img src=x onerror=alert(1)>.txt', host: 'files.example' }, options: ['once', 'deny'] });
      }, { functions: ['renderClarifyCard', 'clarificationSubmissionKey'].map(extract).join('\n'), dictionary: english });
      const card = page.locator('.clarify-card[data-download-read-confirmation="1"]');
      assert.equal(await card.locator('.clarify-question').innerText(), english['sp.download_read.question']);
      assert.equal(await card.locator('.clarify-subject').innerText(), '<img src=x onerror=alert(1)>.txt (from files.example)');
      assert.equal(await card.locator('img').count(), 0, 'the page-settable name is text, not markup');
      assert.deepEqual(await card.locator('.clarify-option').allInnerTexts(), [english['sp.download_read.read'], english['sp.download_read.dont']]);
      assert.equal(await card.locator('.clarify-input').count(), 0, 'fixed choices, no free text');
      assert.equal(await card.getAttribute('data-memory-source'), '', 'the answer is not remembered as a clarification');
      await card.locator('.clarify-option[data-value="once"]').click();
      assert.deepEqual(await page.evaluate(() => window.answers), [{ clarifyId: 'download_read_1', value: 'once', source: 'option' }]);
    } finally { await page.close(); }
  });
}

test.after(async () => {
  const real = await fs.realpath(directory);
  assert.ok(real.startsWith(path.resolve(await fs.realpath(os.tmpdir())) + path.sep + 'webbrain-download-scope-'));
  await fs.rm(real, { recursive: true, force: true });
});
