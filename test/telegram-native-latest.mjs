import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Actual native collector, one-use recipient dispatch and durable chat kernel.
// All browser requests are intercepted. Native markers come from the pinned
// WebK bubbles.ts and WebA MessageListContent/MessageListBottomMarker sources.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const kernel = await import(`../src/${build}/src/agent/chat-workflow.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  test(`${build}: native mounted floor metadata is bounded, same-thread and independent of authored messages`, () => {
    const threadKey = 'dom:telegram:k:123456:0';
    const snapshot = { threadKey, messages: [{ id: 'telegram:k:123456:0:10', direction: 'incoming', text: 'Owned question' }],
      composer: { available: true, empty: true }, nativeChatMessageBaseline: {
        threadKey, coverage: 'mounted_native_id_floor', complete: true, messageIds: ['telegram:k:123456:0:5000'] } };
    const session = kernel.createChatSession({ threadKey });
    assert.equal(kernel.decideChatSend(session, snapshot, 'Owned reply').nativeMessageFloor, '5000');
    for (const [field, value] of [['threadKey','dom:telegram:k:987654:0'], ['coverage','complete_history'],
      ['complete',false], ['messageIds',['telegram:k:987654:0:5000']],
      ['messageIds',['telegram:k:123456:0:5','telegram:k:123456:0:05']],
      ['messageIds',['telegram:k:123456:0:5x']],
      ['messageIds',Array.from({length:201},(_,index)=>`telegram:k:123456:0:${index+1}`)]]) {
      const raw = { ...snapshot, nativeChatMessageBaseline: { ...snapshot.nativeChatMessageBaseline, [field]: value } };
      const normalized = kernel.normalizeChatSnapshot(raw);
      assert.equal(normalized.nativeMessageBaselineComplete, false);
      assert.equal(normalized.nativeMessageFloor, undefined);
      assert.equal(kernel.decideChatSend(session, raw, 'Owned reply').reason, 'native_baseline_unverified');
      const pending = kernel.markChatSendPending(session, kernel.decideChatSend(session,snapshot,'Owned reply'));
      const sameBody = { ...raw, messages: [{ id:'telegram:k:123456:0:9000',direction:'outgoing',text:'Owned reply' }] };
      assert.ok(kernel.advanceChatSession(pending,sameBody).session.pendingOutbound,
        'Incomplete or foreign mounted metadata cannot acknowledge a matching outgoing row.');
    }
    const empty = { ...snapshot, messages: [], nativeChatMessageBaseline: { ...snapshot.nativeChatMessageBaseline,messageIds:[] } };
    assert.equal(kernel.decideChatSend(session,empty,'Owned reply').nativeMessageFloor,'0');
    assert.equal(kernel.decideChatSend(session,{...snapshot,nativeChatMessageBaseline:null},'Owned reply').ok,false);
  });
  const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','content.js'].map(async file => {
    const before = process.env.WEBBRAIN_TELEGRAM_LATEST_BEFORE_SOURCE === '1' && ['chat-observation.js','content.js'].includes(file);
    return readFile(new URL(before
      ? `../ci/artifacts/quality-audit-2026-10-07/telegram-latest-candidate/${build}-${file}`
      : `../src/${build}/src/content/${file}`, import.meta.url), 'utf8');
  }));
  test(`${build}: native Telegram latest position fences virtual history before real dispatch`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const client of ['k','a']) {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
        const reset = async (latest = true, count = 10) => {
          await page.goto('about:blank'); await page.goto(`https://web.telegram.org/${client}/#123456`);
          await page.setContent(`<!doctype html><style>body{font:16px sans-serif;margin:20px}.chat,#MiddleColumn{width:760px}.topbar,.MiddleHeader{height:60px}.bubbles-scrollable,.MessageList{height:220px;overflow-y:auto}.bubble,.Message{height:30px}.bubbles-inner,.messages-container{padding-bottom:450px}.input-message-input,#editable-message-text{min-height:30px;width:650px}.Avatar{height:32px;width:32px}.icon-check{display:inline-block;height:12px;width:12px}button{width:120px;height:34px}</style>
            ${client === 'k' ? `<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">Owned QA</span></div></div></div><div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner has-rights is-chat"></div></div></div><div class="input-message-input" role="textbox" contenteditable="true" data-peer-id="123456"></div><button id="send" aria-label="Send">Send</button></div>`
              : `<div id="MiddleColumn"><div class="MiddleHeader"><div class="ChatInfo"><div class="Avatar" data-peer-id="123456"></div><h3 class="fullName">Owned QA</h3></div></div><div class="MessageList with-bottom-snap" data-list-key="123456_-1_thread"><div class="messages-container"><div class="list-bottom-marker"></div></div></div><div id="editable-message-text" role="textbox" contenteditable="true"></div><button id="send" aria-label="Send">Send</button></div>`}`);
          await page.evaluate(({ client, latest, count }) => {
            window.fixtureHandlers = []; window.physicalSends = 0; window.nativePending = null;
            window.chrome = window.browser = { runtime: { onMessage: { addListener(fn) { fixtureHandlers.push(fn); } }, getURL: value => value } };
            const pane = document.querySelector('.bubbles-scrollable,.MessageList');
            const rows = document.querySelector('.bubbles-inner,.messages-container');
            window.qaRow = (id, text, own = false, delivered = true) => {
              const row = document.createElement('div'); row.className = client === 'k'
                ? `bubble ${own ? `is-out ${delivered ? 'is-sent' : 'is-sending'}` : 'is-in'}` : `Message ${own ? 'own' : ''}`;
              row.setAttribute(client === 'k' ? 'data-mid' : 'data-message-id', String(id)); row.dataset.peerId = '123456';
              const body = document.createElement('div'); body.className = client === 'k' ? 'message' : 'text-content'; body.textContent = text; row.append(body);
              if (own && client === 'a') { const status = document.createElement('span'); status.className = 'MessageOutgoingStatus'; const icon = document.createElement('i'); icon.className = delivered ? 'icon-check' : 'icon-message-pending'; status.append(icon); row.append(status); }
              return row;
            };
            for (let id = 1; id <= count; id++) rows.prepend(qaRow(id, 'Owned question ' + id));
            window.qaSetLatest = value => {
              if (client === 'k') document.querySelector('.bubbles').classList.toggle('scrolled-down', value);
              else document.querySelector('.MessageList').classList.toggle('with-bottom-snap', value);
              pane.scrollTop = value ? pane.scrollHeight : 0;
            };
            qaSetLatest(latest);
            document.querySelector('#send').addEventListener('click', () => {
              const composer = document.querySelector('[contenteditable]'); if (!composer.innerText.trim()) return;
              physicalSends++; nativePending = { id: 9000, text: composer.innerText, delivered: false };
              composer.replaceChildren(); rows.prepend(qaRow(nativePending.id, nativePending.text, true, false)); qaSetLatest(true);
            });
          }, { client, latest, count });
          for (const source of sources) await page.addScriptTag({ content: source });
          await call('get_accessibility_tree', { filter: 'all' });
        };
        const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
          for (const handler of fixtureHandlers) handler(message, {}, resolve);
        }), { target: 'content', action, params });
        const observe = () => call('observe_chat');
        const type = async (body = 'Owned reply') => {
          const ref_id = await page.locator('[contenteditable]').evaluate(node => __wb_ax_ref(node));
          const value = await call('set_field', { ref_id, text: body, clear: true, submit: false });
          assert.equal(value.success, true, JSON.stringify({ error: value.error, reason: value.reason }));
        };
        const probe = (extra = {}) => call('probe_message_recipient_guard', {
          tool: 'click', args: { selector: '#send', atLatest: true, ...extra }, adapterName: 'telegram', bindDispatch: true,
          nativeLatestPosition: { verified: true, atLatest: true }, ...extra });
        const send = binding => call('click', { selector: '#send', messageRecipientGuardRequired: true,
          messageRecipientDispatchBinding: binding });
        const zeroSends = async () => assert.equal(await page.evaluate(() => physicalSends), 0);

        await t.test(`${client}: old virtual viewport exposes exact repair and cannot dispatch or acknowledge history`, async () => {
          await reset(false); const before = await observe();
          assert.equal(before.success, true); assert.equal(before.composer.available, false);
          assert.equal(before.nativeLatestPosition?.atLatest, false); assert.deepEqual(before.messages, []);
          assert.equal(before.nativeChatReadRepair?.direction, 'bottom'); assert.ok(before.nativeChatReadRepair.ref_id);
          const session = kernel.advanceChatSession(kernel.createChatSession(), before).session;
          assert.equal(kernel.decideChatSend(session, before, 'Owned reply').ok, false);
          await type(); const blocked = await probe();
          // Keep the original bug's actual side-effect chain when running the
          // preserved before source; no manufactured receipt or done result.
          if (blocked.messageRecipientDispatchBinding) await send(blocked.messageRecipientDispatchBinding);
          assert.notEqual(blocked.conclusive, true); assert.equal(blocked.messageRecipientDispatchBinding, undefined);
          await zeroSends();
        });
        await t.test(`${client}: complete latest native floor retains global maximum outside the bounded cache`, async () => {
          await reset(true, 235); const observation = await observe();
          assert.equal(observation.nativeLatestPosition?.atLatest, true); assert.equal(observation.messages.length, 200);
          await type(); const bound = await probe();
          assert.equal(bound.conclusive, true); assert.equal(bound.nativeChatMessageBaseline?.complete, true);
          assert.equal(bound.nativeChatMessageBaseline.messageIds.length, 200);
          assert.ok(bound.nativeChatMessageBaseline.messageIds.includes(`telegram:${client}:123456:0:235`));
          assert.equal((await send(bound.messageRecipientDispatchBinding)).success, true);
          assert.equal(await page.evaluate(() => physicalSends), 1);
        });
        for (const maxText of ['Owned earlier different reply', '']) await t.test(`${client}: kernel floor includes ${maxText ? 'authored' : 'unsupported-body'} global maximum before an old-tail remount`, async () => {
          await reset(true, 235);
          await page.evaluate(maxText => {
            const first = document.querySelector('.bubble,.Message'); first.replaceWith(qaRow(5000,maxText,true,true)); qaSetLatest(true);
          }, maxText);
          const before = await observe(); let session = kernel.advanceChatSession(kernel.createChatSession(), before).session;
          const decision = kernel.decideChatSend(session, before, 'Owned reply'); assert.equal(decision.ok, true);
          session = kernel.markChatSendPending(session, decision); await type(); const bound = await probe();
          assert.ok(bound.nativeChatMessageBaseline.messageIds.includes(`telegram:${client}:123456:0:5000`));
          assert.equal((await send(bound.messageRecipientDispatchBinding)).success, true);
          await page.evaluate(() => {
            const rows = document.querySelector('.bubbles-inner,.messages-container'), marker = document.querySelector('.list-bottom-marker');
            rows.replaceChildren(qaRow(4000,'Owned reply',true,true), qaRow(9000,nativePending.text,true,false));
            if (marker) rows.append(marker); qaSetLatest(true);
          });
          const after = await observe(); session = kernel.advanceChatSession(session, after).session;
          assert.ok(session.pendingOutbound, JSON.stringify({ floor: decision.nativeMessageFloor, physicalSendPending: true,
            observedOutgoingIds: after.messages.filter(m=>m.direction==='outgoing').map(m=>m.id) }));
          assert.equal(decision.nativeMessageFloor, '5000'); assert.equal(await page.evaluate(() => physicalSends), 1);
        });
        await t.test(`${client}: an empty native newest conversation has a zero send floor without claiming history completeness`, async () => {
          await reset(true, 0); const before = await observe();
          assert.equal(before.success, true); assert.equal(before.composer.available, true); assert.deepEqual(before.messages, []);
          assert.equal(before.historyComplete, undefined);
          let session = kernel.advanceChatSession(kernel.createChatSession(), before).session;
          const decision = kernel.decideChatSend(session, before, 'Owned first reply'); assert.equal(decision.ok, true);
          session = kernel.markChatSendPending(session, decision); await type('Owned first reply'); const bound = await probe();
          assert.equal(bound.nativeChatMessageBaseline?.complete, true); assert.deepEqual(bound.nativeChatMessageBaseline.messageIds, []);
          assert.equal(bound.nativeChatMessageBaseline.coverage, 'mounted_native_id_floor');
          assert.equal((await send(bound.messageRecipientDispatchBinding)).success, true);
          session = kernel.advanceChatSession(session, await observe()).session; assert.ok(session.pendingOutbound);
          assert.equal(await page.evaluate(() => physicalSends), 1);
        });
        await t.test(`${client}: losing latest between binding and native dispatch blocks the one-use send`, async () => {
          await reset(); await type(); const bound = await probe(); assert.ok(bound.messageRecipientDispatchBinding);
          await page.evaluate(() => qaSetLatest(false));
          const blocked = await send(bound.messageRecipientDispatchBinding); assert.equal(blocked.noDispatch, true); await zeroSends();
        });
        await t.test(`${client}: a new delivered same-body native row between floor capture and dispatch cannot acknowledge a later send`, async () => {
          await reset(); const before = await observe();
          let session = kernel.advanceChatSession(kernel.createChatSession(), before).session;
          const decision = kernel.decideChatSend(session, before, 'Owned reply'); assert.equal(decision.ok, true);
          session = kernel.markChatSendPending(session, decision);
          await type(); const bound = await probe(); assert.ok(bound.messageRecipientDispatchBinding);
          await page.evaluate(() => { document.querySelector('.bubbles-inner,.messages-container').prepend(qaRow(35,'Owned reply',true,true)); qaSetLatest(true); });
          const result = await send(bound.messageRecipientDispatchBinding);
          const after = await observe(); session = kernel.advanceChatSession(session, after).session;
          assert.equal(result.noDispatch, true, JSON.stringify({ dispatched: result.dispatched, pending: !!session.pendingOutbound, outgoingIds: after.messages.filter(m=>m.direction==='outgoing').map(m=>m.id) }));
          await zeroSends();
        });
        for (const arrival of ['matching-outgoing','different-outgoing','incoming']) await t.test(`${client}: actual chat_send observes again after ${arrival} arrives before recipient preparation`, async () => {
          await reset(); const before = await observe();
          const agent=new Agent({}); let preparationCalls=0,pendingSaves=0,nestedDispatches=0;
          agent._readChatObservation=()=>observe(); agent._currentUrl=async()=>page.url(); agent._persist=()=>{};
          // No fabricated persistence receipt: this branch must stop before
          // reaching either the storage adapter or the physical dispatcher.
          agent._persistNow=async()=>{pendingSaves++;return false;};
          agent.executeTool=async()=>{nestedDispatches++;throw new Error('A stale decision reached nested dispatch.');};
          agent._messageRecipientContentProbe=(_,params)=>call('probe_message_recipient_guard',params);
          const pinned=await agent._pinActiveConversationMessagingTarget(73,{target_kind:'active_conversation'},page.url());
          assert.equal(pinned.ok,true);
          agent._planExecutionGuards.set(73,{ messaging:pinned.target,requiresStateChange:true,requiresSubmission:true });
          agent.chatSessions.set(73,kernel.advanceChatSession(kernel.createChatSession(),before).session);
          agent._messageRecipientContentProbe=async(_,params)=>{
            if(params.bindDispatch===true && params.tool==='set_field') {
              preparationCalls++;
              await page.evaluate(arrival=>{ document.querySelector('.bubbles-inner,.messages-container')
                .prepend(qaRow(35,arrival==='matching-outgoing'?'Owned reply':'Owned new context',arrival!=='incoming',true));qaSetLatest(true); },arrival);
            }
            return call('probe_message_recipient_guard',params);
          };
          const result=await agent._sendChatWorkflow(73,{thread_key:before.threadKey,composer_ref:before.composer.ref,text:'Owned reply'});
          assert.equal(preparationCalls,1,'The actual guarded recipient probe receives the native arrival.');
          assert.equal(result.reason,'native_chat_baseline_changed_before_dispatch',JSON.stringify({error:result.error,reason:result.reason}));
          assert.equal(result.noDispatch,true); assert.equal(result.dispatched,false);
          assert.equal(pendingSaves,0); assert.equal(nestedDispatches,0);
          assert.equal(agent.chatSessions.get(73).pendingOutbound,null); await zeroSends();
          const fresh=await observe(); assert.ok(fresh.messages.some(message=>message.id.startsWith(`telegram:${client}:123456:0:35`)));
        });
        await t.test(`${client}: native scroll/end-node replacement cannot inherit the original dispatch`, async () => {
          await reset(); await type(); const bound = await probe(); assert.ok(bound.messageRecipientDispatchBinding);
          await page.evaluate(() => { const pane = document.querySelector('.bubbles-scrollable,.MessageList'); pane.replaceWith(pane.cloneNode(true)); const current = document.querySelector('.bubbles-scrollable,.MessageList'); current.scrollTop = current.scrollHeight; });
          assert.equal((await send(bound.messageRecipientDispatchBinding)).noDispatch, true); await zeroSends();
        });
        await t.test(`${client}: physical bottom without the native newest marker remains unverified`, async () => {
          await reset(); await page.evaluate(() => { if (document.querySelector('.bubbles')) document.querySelector('.bubbles').classList.remove('scrolled-down'); else document.querySelector('.list-bottom-marker').remove(); });
          const observed = await observe(); assert.equal(observed.composer.available, false); assert.deepEqual(observed.messages, []);
          await type(); assert.equal((await probe()).messageRecipientDispatchBinding, undefined); await zeroSends();
        });
        for (const mutation of ['duplicate-id','foreign-peer','pending-row','malformed-id']) await t.test(`${client}: latest does not waive ${mutation} baseline`, async () => {
          await reset(); await page.evaluate(({client,mutation}) => {
            const row = document.querySelector('.bubble,.Message');
            if (mutation === 'duplicate-id') row.setAttribute(client === 'k' ? 'data-mid' : 'data-message-id', '1');
            if (mutation === 'foreign-peer') row.dataset.peerId = '987654';
            if (mutation === 'malformed-id') row.setAttribute(client === 'k' ? 'data-mid' : 'data-message-id', '1x');
            if (mutation === 'pending-row') row.replaceWith(qaRow(20,'Owned reply',true,false));
            const pane = document.querySelector('.bubbles-scrollable,.MessageList'); pane.scrollTop = pane.scrollHeight;
          }, { client, mutation });
          const observation = await observe();
          if (observation.success) {
            const session = kernel.advanceChatSession(kernel.createChatSession(),observation).session;
            assert.equal(kernel.decideChatSend(session,observation,'Owned reply').ok,false);
          }
          await type(); const blocked = await probe(); assert.equal(blocked.messageRecipientDispatchBinding, undefined); await zeroSends();
        });
        await t.test(`${client}: a dispatched pending send stays pending in history, then real native delivery clears it once`, async () => {
          await reset(); const before = await observe();
          let session = kernel.advanceChatSession(kernel.createChatSession(), before).session;
          const decision = kernel.decideChatSend(session, before, 'Owned reply'); assert.equal(decision.ok, true);
          session = kernel.markChatSendPending(session, decision);
          await type(); const bound = await probe(); assert.equal((await send(bound.messageRecipientDispatchBinding)).success, true);
          await page.evaluate(() => { const rows = document.querySelector('.bubbles-inner,.messages-container');
            rows.querySelector('[data-mid="5"],[data-message-id="5"]').replaceWith(qaRow(5,'Owned reply',true,true)); qaSetLatest(false); });
          const historical = await observe(); assert.deepEqual(historical.messages, []);
          session = kernel.advanceChatSession(session, historical).session; assert.ok(session.pendingOutbound);
          assert.equal(kernel.decideChatSend(session, historical, 'Owned follow-up').ok, false);
          await page.evaluate(() => qaSetLatest(true)); session = kernel.advanceChatSession(session, await observe()).session;
          assert.ok(session.pendingOutbound, 'A matching historical row cannot acknowledge the still-pending native row.');
          await page.evaluate(client => { const row = document.querySelector(client === 'k' ? '[data-mid="9000"]' : '[data-message-id="9000"]'); if (client === 'k') row.className='bubble is-out is-sent'; else row.querySelector('.MessageOutgoingStatus i').className='icon-check'; nativePending.delivered=true; }, client);
          const delivered = await observe(); session = kernel.advanceChatSession(session, delivered).session;
          assert.equal(session.pendingOutbound, null); assert.equal(await page.evaluate(() => physicalSends), 1);
          assert.equal(kernel.decideChatSend(session, delivered, 'Owned reply').duplicate, true);
        });
        await page.close();
      }
    } finally { await browser.close(); }
  });
}
