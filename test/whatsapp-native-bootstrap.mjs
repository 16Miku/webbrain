import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';

// The native composer has a generic placeholder, not a recipient-valued label.
// Only the exact native contact-name carrier is a read-only repair control.
// All page data, contacts, phone numbers and network belong to this fixture.
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:260px}#main{position:absolute;left:280px;width:950px;height:780px}header{height:70px}[role=button],button{padding:8px}[data-testid=conversation-panel-messages]{height:600px}[contenteditable]{min-height:32px;width:600px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;background:white}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Owned Contact</span></div></div></aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div id="outer"><div id="carrier" role="button" tabindex="0" data-testid="conversation-info-header"><div><div><div><div><div><div data-testid="conversation-info-header-chat-title-name"><span data-testid="conversation-info-header-chat-title">Owned Contact</span></div></div></div></div></div></div></div><div id="avatar" role="button">Avatar</div></div><div><button id="call" type="button">Call</button><button id="search" type="button">Search</button><button id="menu" type="button">Menu</button></div></header>
<div data-testid="conversation-panel-messages"><div role="row"><div data-id="owned-incoming" data-testid="conv-msg-owned-incoming"><div data-testid="msg-container"><div data-pre-plain-text="[12:00, 08/10/2026] Owned Contact: "><span data-testid="selectable-text">Owned question</span></div><span data-icon="tail-in">◁</span></div></div></div></div>
<footer><div id="composer" contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" aria-placeholder="Type a message"></div><button id="send" type="button" aria-label="Send">Send</button></footer></div>`;

for (const [build, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) {
  test(`${build}: authentic native WhatsApp header bootstrap stays read-only and exactly scoped`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','content.js']
        .map(file => readFile(file === 'chat-observation.js' && process.env.WEBBRAIN_NATIVE_BOOTSTRAP_READER
          ? process.env.WEBBRAIN_NATIVE_BOOTSTRAP_READER
          : new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const listener of qaHandlers) listener(message, {}, resolve);
      }), { target: 'content', action, params });
      async function prepare(kind = '') {
        await page.goto('https://web.whatsapp.com/');
        await page.evaluate(kind => {
          window.qaHandlers = []; window.qaOpened = 0; window.qaSent = 0;
          const runtime = { getURL: value => value, onMessage: { addListener: listener => qaHandlers.push(listener) } };
          window.chrome = window.browser = { runtime };
          document.querySelector('#carrier').onclick = () => {
            qaOpened++;
            const drawer = document.createElement('div'); drawer.dataset.testid = 'chat-info-drawer';
            drawer.innerHTML = '<header><button type="button" aria-label="Close">Close</button></header><div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text">Owned Contact</span><span data-testid="selectable-text">+90 555 000 00 01</span>';
            drawer.querySelector('button').onclick = () => drawer.remove(); document.body.append(drawer);
          };
          document.querySelector('#send').onclick = () => qaSent++;
          if (kind === 'named-label') document.querySelector('#composer').setAttribute('aria-label','Type a message to Owned Contact');
          if (kind === 'wrong-row') document.querySelector('[data-testid="cell-frame-title"]').textContent = 'Another contact';
          if (kind === 'no-row') document.querySelector('[aria-selected]').removeAttribute('aria-selected');
          if (kind === 'duplicate-composer') document.querySelector('footer').append(document.querySelector('#composer').cloneNode(true));
          if (kind === 'outside-main') document.body.append(document.querySelector('#composer'));
          if (kind === 'focused-search' || kind === 'focused-editor') {
            const other = document.createElement(kind === 'focused-search' ? 'input' : 'textarea');
            other.id = 'other-editor'; document.querySelector('aside').append(other); other.focus();
          }
          if (kind === 'outer-sibling-control') { const button = document.createElement('button'); button.textContent = 'Delete'; document.querySelector('#outer').append(button); }
          if (kind === 'outer-form') { const form = document.createElement('form'), carrier = document.querySelector('#carrier'); document.querySelector('#outer').replaceWith(form); form.append(carrier); form.id = 'outer'; form.setAttribute('role','button'); }
        }, kind);
        for (const source of sources) await page.addScriptTag({ content: source });
        const provider = { model: 'owned-model', config: { model: 'owned-model' }, supportsVision: false };
        const agent = new Agent({ getActive: () => provider });
        const tabId = 91;
        agent.conversations.set(tabId, [{ role: 'system', content: 'Owned fixture system context.' },
          { role: 'user', content: 'Reply once to the currently open Owned Contact.', webbrainResumeTaskId: 'owned-resume-task' }]);
        agent._beginCompletionInvariant(tabId);
        agent._planExecutionGuards.set(tabId, { messaging: { target_kind: 'named', recipients: ['Owned Contact'] }, requiresSubmission: true });
        agent._currentUrl = async () => page.url();
        agent._sendDevContentAction = (_, action, params) => call(action, params);
        if (build === 'firefox') globalThis.browser = { tabs: { sendMessage: (_, message) => call(message.action, message.params) } };
        assert.ok(agent._nativeChatOwnerScope(tabId), 'The real Agent must issue a current private native owner.');
        const observe = async () => call('observe_chat', await agent._chatObservationParams(tabId));
        const readRef = async selector => {
          await call('get_accessibility_tree', { filter: 'all' });
          return page.locator(selector).evaluate(node => __wb_ax_ref(node));
        };
        const guarded = async selector => {
          const ref_id = await readRef(selector), context = {};
          const block = await agent._messageRecipientGuardBlock(tabId, 'click_ax', { ref_id }, page.url(), context);
          return { block, context, ref_id };
        };
        return { agent, tabId, observe, guarded };
      }
      for (const [kind, target] of [['', '#carrier'], ['named-label', '#carrier']]) await t.test(`bootstrap ${kind || 'generic-placeholder'} ${target}`, async () => {
        const f = await prepare(kind);
        const first = await f.observe();
        assert.equal(first.success, false, 'Read-only observation must not open the drawer.');
        const opened = await f.guarded(target);
        assert.equal(opened.block, null, JSON.stringify(opened.block));
        assert.equal(first.nativeWhatsappRepair?.phase, 'open_contact', JSON.stringify(first));
        assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === carrier, first.nativeWhatsappRepair.ref_id), true, 'The repair hint is the exact private native carrier, never the whole header.');
        assert.equal(opened.context.nativeWhatsappReadRepairOwner, f.agent._nativeChatOwnerScope(f.tabId));
        const click = await call('click_ax', { ref_id: opened.ref_id, _nativeChatOwner: opened.context.nativeWhatsappReadRepairOwner });
        assert.equal(click.success, true, JSON.stringify(click)); assert.equal(click._nativeWhatsappReadRepair, true);
        await page.waitForTimeout(30);
        const closed = await f.guarded('[data-testid="chat-info-drawer"] header button');
        assert.equal(closed.block, null, JSON.stringify(closed.block));
        assert.equal((await call('click_ax', { ref_id: closed.ref_id, _nativeChatOwner: closed.context.nativeWhatsappReadRepairOwner })).success, true);
        const observation = await f.observe(); assert.equal(observation.success, true, JSON.stringify(observation));
        assert.equal(observation.conversationId, 'whatsapp:phone:' + createHash('sha256').update('+905550000001').digest('hex').slice(0,32));
        assert.equal(JSON.stringify(observation).includes('905550000001'), false);
        assert.deepEqual(await page.evaluate(() => ({ opened: qaOpened, sent: qaSent, draft: composer.textContent })), { opened: 1, sent: 0, draft: '' });
      });
      for (const kind of ['wrong-row','no-row','duplicate-composer','outside-main','outer-sibling-control','outer-form']) await t.test(`refuse ${kind}`, async () => {
        const f = await prepare(kind); const first = await f.observe();
        if (['wrong-row','no-row','duplicate-composer','outside-main'].includes(kind)) assert.equal(first.nativeWhatsappRepair, undefined);
        const attempt = await f.guarded('#outer');
        assert.equal(attempt.block?.noDispatch, true, JSON.stringify(attempt.block));
        assert.deepEqual(await page.evaluate(() => ({ opened: qaOpened, sent: qaSent })), { opened: 0, sent: 0 });
      });
      for (const kind of ['focused-search','focused-editor']) await t.test(`focused ${kind} is not native repair observation`, async () => {
        const f = await prepare(kind); const first = await f.observe();
        assert.equal(first.success, false); assert.equal(first.nativeWhatsappRepair, undefined);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'other-editor', 'Read-only repair must not focus another editor.');
        assert.equal(await page.evaluate(() => qaOpened + qaSent), 0);
      });
      await t.test('old hint cannot dispatch after Stop or a different document', async () => {
        let f = await prepare(); const initial = await f.observe();
        const args = { ref_id: initial.nativeWhatsappRepair.ref_id };
        await call('get_accessibility_tree', args);
        f.agent.abortFlags.set(f.tabId, true);
        let block = await f.agent._messageRecipientGuardBlock(f.tabId, 'click_ax', args, page.url(), {});
        assert.equal(block?.noDispatch, true); assert.equal(await page.evaluate(() => qaOpened), 0);
        f = await prepare(); await f.observe();
        block = await f.agent._messageRecipientGuardBlock(f.tabId, 'click_ax', args, page.url(), {});
        assert.equal(block?.noDispatch, true, 'A route/document-scoped old AX pointer cannot alias the new carrier.');
        assert.equal(await page.evaluate(() => qaOpened), 0);
      });
      await t.test('read repair never exempts a send, call or other header control', async () => {
        const f = await prepare(); await f.observe();
        for (const selector of ['#send','#call','#search','#menu','#avatar','#outer','[data-testid="conversation-header"]']) {
          const attempt = await f.guarded(selector); assert.equal(attempt.block?.noDispatch, true, JSON.stringify(attempt.block));
        }
        assert.equal(await page.evaluate(() => qaSent), 0);
      });
      for (const drift of ['header-clone','carrier-clone','selected-roundtrip','owner-change']) await t.test(`repair snapshot invalidated by ${drift}`, async () => {
        const f = await prepare('named-label'); await f.observe();
        const pins = await page.evaluate(() => { window.qaRepair = __wb_native_whatsapp_repair_snapshot(carrier); return !!qaRepair; });
        assert.equal(pins, true);
        const valid = await page.evaluate(drift => {
          if (drift === 'owner-change') __wb_update_native_chat_owner('another-private-owner');
          else if (drift === 'selected-roundtrip') { const selected = document.querySelector('[aria-selected]'); selected.setAttribute('aria-selected','false'); selected.setAttribute('aria-selected','true'); }
          else { const node = document.querySelector(drift === 'header-clone' ? '[data-testid="conversation-header"]' : '#carrier'); const clone = node.cloneNode(false); while (node.firstChild) clone.append(node.firstChild); node.replaceWith(clone); }
          return __wb_native_whatsapp_repair_matches(qaRepair);
        }, drift);
        assert.equal(valid, false, 'An identical native title cannot inherit prior header/node/task authority.');
      });
    } finally { await browser.close(); }
  });
}
