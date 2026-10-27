import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { defaultDecide, fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// A deletion in vision mode, end to end in the installed MV3 extension. In a
// vision run every click is a click_at point, and WebBrain's deletion guard
// used to refuse any coordinate click ("Activate the specific control with a
// ref or selector click") although a vision run offers no ref, selector or
// tree tool: a user's "delete this note" could never be carried out. The
// background, Agent, submit probe, guards, CDP capture and trusted input are
// real; a loopback provider plays the model, reads the frame labels and
// clicks the note's Delete button and then the site's own confirmation.
//   node test/quality/vision-mode-delete-mv3.mjs          the request names the note
//   node test/quality/vision-mode-delete-mv3.mjs --vague  "delete it": WebBrain's card asks once
const vague = process.argv.includes('--vague');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-delete-mv3');
await fs.mkdir(out, { recursive: true });

const NOTES = [
  { id: 'n1', text: 'Buy oat milk' },
  { id: 'n2', text: 'Call the dentist on Monday' },
  { id: 'n3', text: 'Pick up dry cleaning' },
];
// Absolute positions keep the fixture's CSS geometry known to the "model".
const row = index => ({ x: 60, y: 100 + index * 70, w: 520, h: 56 });
const LAYOUT = {
  deleteButton: index => ({ x: 60 + 420, y: 100 + index * 70 + 10, w: 90, h: 36 }),
  dialog: { x: 380, y: 260, w: 420, h: 200 },
  confirm: { x: 380 + 290, y: 260 + 140, w: 110, h: 40 },
  cancel: { x: 380 + 170, y: 260 + 140, w: 100, h: 40 },
};
const target = 0;
const request = vague ? 'delete it' : `Delete my note "${NOTES[target].text}".`;
const body = `<!doctype html><meta charset="utf-8"><title>My notes</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:30px;margin:0}
ul{list-style:none;margin:0;padding:0}.note{position:absolute;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}
.note p{position:absolute;left:12px;top:0;margin:0;line-height:56px}
.note .delete{position:absolute;left:420px;top:10px;width:90px;height:36px;font:15px sans-serif;background:#c62828;color:#fff;border:0;border-radius:4px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.35)}
#dialog{position:fixed;left:${LAYOUT.dialog.x}px;top:${LAYOUT.dialog.y}px;width:${LAYOUT.dialog.w}px;height:${LAYOUT.dialog.h}px;box-sizing:border-box;background:#fff;border-radius:8px}
#dialog h2{position:absolute;left:20px;top:16px;margin:0;font:20px sans-serif}#dialog p{position:absolute;left:20px;top:56px;margin:0;width:380px}
#dialog button{position:absolute;top:140px;height:40px;font:15px sans-serif;border-radius:4px}
#cancel{left:170px;width:100px;background:#eee;border:1px solid #999}#confirm{left:290px;width:110px;background:#c62828;color:#fff;border:0}</style>
<h1>My notes</h1><ul id="notes">${NOTES.map((note, index) => {
  const box = row(index);
  return `<li class="note" data-id="${note.id}" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px"><p>${note.text}</p><button class="delete" type="button">Delete</button></li>`;
}).join('')}</ul><div id="modal-root"></div>
<script>
const modalRoot = document.getElementById('modal-root');
for (const button of document.querySelectorAll('.note .delete')) button.onclick = () => {
  const item = button.closest('.note'), id = item.dataset.id, text = item.querySelector('p').textContent;
  modalRoot.innerHTML = '<div class="overlay"></div><div role="dialog" aria-modal="true" aria-labelledby="dialog-title" id="dialog">'
    + '<h2 id="dialog-title">Delete this note?</h2><p></p><button id="cancel" type="button">Cancel</button><button id="confirm" type="button">Delete</button></div>';
  modalRoot.querySelector('p').textContent = '"' + text + '" will be removed for good.';
  modalRoot.querySelector('#cancel').onclick = () => modalRoot.replaceChildren();
  modalRoot.querySelector('#confirm').onclick = async () => {
    const response = await fetch('/api/notes/' + id, { method: 'DELETE' });
    if (response.ok) { item.remove(); modalRoot.replaceChildren(); }
  };
};
</script>`;

const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['The note is deleted.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Delete the note.', steps: [{ id: '1', action: 'Delete the note and confirm.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };

const providerCalls = [];
const deletes = [];
const offered = [];
let keyframe = null;
let actionCalls = 0;
const centre = (rect, image) => ({
  x: Math.round((rect.x + rect.w / 2) / image.ratio),
  y: Math.round((rect.y + rect.h / 2) / image.ratio),
});
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';

const server = http.createServer(async (incoming, response) => {
  const deleted = /^\/api\/notes\/(n\d)$/.exec(incoming.url || '')?.[1];
  if (deleted && incoming.method === 'DELETE') {
    deletes.push(deleted);
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
  }
  if (incoming.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const system = textOf(input.messages?.[0]?.content);
    // The deletion question is answered as a model would read the request.
    const fixedChoice = fixtureFixedChoiceReply(input.messages, {
      deletion_request: ({ request: asked, page }) => defaultDecide('deletion_request', { request: asked, page }),
    });
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The note is no longer listed.' }) };
    } else if (!isAction) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      offered.push(input.tools.map(tool => tool.function?.name || tool.name));
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const declared = /SCREENSHOT f\d+[\s\S]*?(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
        if (declared) keyframe = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
      }
      const step = actionCalls++;
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const clicks = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .filter(item => item.function.name === 'click_at').map(item => /"success":true/.test(results.get(item.id) || ''));
      const done = clicks.filter(Boolean).length;
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      // A refused click is not retried blindly: the run ends and the test reads why.
      else if (clicks.length > done) call = { name: 'done', args: { outcome: 'blocked', summary: 'A click was refused.' } };
      else if (done === 0) call = { name: 'click_at', args: centre(LAYOUT.deleteButton(target), keyframe) };
      else if (done === 1) call = { name: 'click_at', args: centre(LAYOUT.confirm, keyframe) };
      else call = { name: 'done', args: { outcome: 'success', summary: 'The note was deleted.' } };
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `vision-delete-${step}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/notes`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-delete-mv3-'));
let context;
try {
  // A copy of the extension that lets the test answer WebBrain's own card.
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.visionDeleteFixtureAgent = agent;\n');
  context = await chromium.launchPersistentContext(path.join(profile, 'user'), {
    headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  // visionMode is deliberately left unset: vision mode is the default.
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 10, systemOneEnabled: false,
    tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000,
    enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  // WebBrain's deletion card is answered "Delete"; any other question would be unexpected.
  const cards = [], unexpected = [];
  let answering = true;
  const answerer = (async () => {
    const answered = new Set();
    while (answering) {
      const pending = await worker.evaluate(tabId => [...(globalThis.visionDeleteFixtureAgent?._pendingClarifications?.get(tabId)?.keys() || [])], tabId).catch(() => []);
      for (const clarifyId of pending) {
        if (answered.has(clarifyId)) continue;
        answered.add(clarifyId);
        if (!clarifyId.startsWith('deletion_')) { unexpected.push(clarifyId); continue; }
        cards.push(clarifyId);
        assert.equal((await message('clarify_response', { tabId, clarifyId, answer: 'once', source: 'option' })).ok, true);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  })();
  const result = await message('chat', { tabId, text: request, mode: 'act', requestId: 'vision-delete-mv3', locale: 'en' });
  answering = false; await answerer;
  const remaining = await page.evaluate(() => [...document.querySelectorAll('.note')].map(item => item.dataset.id));
  const blocked = result.updates.filter(event => event.type === 'tool_result' && event.data?.result?.actionGuard)
    .map(event => ({ tool: event.data.name, reason: event.data.result.actionGuard.reason, error: String(event.data.result.error || '').slice(0, 300) }));
  const prompts = result.updates.filter(event => event.type === 'clarify' && event.data?.promptKind === 'mutationConfirmation')
    .map(event => event.data.mutationConfirmation);
  await fs.writeFile(path.join(out, `evidence${vague ? '-vague' : ''}.json`), JSON.stringify({ request, result, deletes, remaining, blocked,
    cards, prompts, unexpected, offered }, (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[screenshot omitted]' : item, 2));

  assert.deepEqual(unexpected, [], 'no other question was asked');
  assert.deepEqual(blocked, [], `no step of the deletion was refused: ${JSON.stringify(blocked)}`);
  assert.ok(offered.length, 'the model was asked to act');
  for (const tools of offered) {
    assert.ok(tools.includes('click_at'), `a vision tool surface: ${tools}`);
    for (const name of ['click', 'click_ax', 'get_accessibility_tree']) assert.ok(!tools.includes(name), `${name} not offered`);
  }
  // A vague request is put to the user once, about this note; the answer also
  // covers the site's own confirmation. A request naming the note asks nothing.
  assert.equal(cards.length, vague ? 1 : 0, JSON.stringify(prompts));
  if (vague) assert.match(String(prompts[0]?.item || ''), /Buy oat milk/, JSON.stringify(prompts));
  assert.deepEqual(deletes, [NOTES[target].id], 'exactly the note whose Delete opened the confirmation was deleted, once');
  assert.deepEqual(remaining, ['n2', 'n3']);
  const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  assert.equal(done?.done, true, JSON.stringify(done));
  assert.equal(done?.outcome, 'success', JSON.stringify(done));
  console.log(JSON.stringify({ passed: true, installedMV3: true, vague, deletes, cards: cards.length, actionCalls }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-delete-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
