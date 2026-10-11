import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { createCompletionInvariantState, completionDoneBlock } from '../src/chrome/src/agent/completion-invariant.js';

const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

// Grounded in the native self Settings profile captured from WebK: username
// and two independent numeric peer leaves belong to one active native panel.
const aliasProfile = `<div id="column-left"><div class="settings-container active"><div class="settings-layer profile-container active"><div class="profile-content is-me">
  <div class="profile-name"><span class="peer-title" data-peer-id="123456">Owned QA</span></div>
  <div class="profile-avatars-avatar active"><div class="avatar" data-peer-id="123456">Q</div></div>
  <div class="row row-with-icon"><div class="row-icon"><span class="tgico row-icon-icon">\ueac1</span></div><div class="row-title">Owned_QA</div><div class="row-subtitle">Translated label is not authority</div></div>
</div></div></div></div>`;
const aliasRightProfile = `<div id="column-right"><div class="shared-media-container profile-container active"><div class="profile-content search-empty">
  <div class="profile-name"><span class="peer-title" data-peer-id="123456">Owned QA</span></div>
  <div class="profile-avatars-avatar active"><div class="avatar" data-peer-id="123456">Q</div></div>
  <div class="row row-with-icon"><div class="row-icon"><span class="tgico row-icon-icon">\ueac1</span></div><div class="row-title">Owned_QA</div><div class="row-subtitle">Translated label is not authority</div></div>
</div></div></div>`;

for (const [build, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) {
  test(`${build}: Telegram WebK aliases require independent native self identity and pin it through actual dispatch`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','content.js']
        .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      const prepare = async (profile = true) => {
        // A same-URL goto can be a same-document navigation. setContent then
        // clears window listeners while keeping globals, which is unlike a
        // fresh content-script installation. Isolate every native document.
        await page.goto('about:blank');
        await page.goto('https://web.telegram.org/k/#@owned_qa');
        await page.setContent(`<!doctype html><style>body{font:16px sans-serif}.chat{margin-left:320px;width:800px}.topbar{height:70px}.bubbles-inner{height:450px}.bubbles-scrollable{height:450px;overflow-y:auto}.input-message-input{display:inline-block;width:650px;min-height:32px}button{height:32px}#column-left{position:absolute;left:0;top:0;width:280px}.profile-name,.row-title,.row-subtitle,.row-icon{min-height:24px}.avatar{width:40px;height:40px}.tgico{display:inline-block;min-width:16px;min-height:16px}</style>
          ${profile==='ordinary' ? aliasRightProfile : profile==='both' ? aliasProfile+aliasRightProfile : profile ? aliasProfile : ''}<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456" data-me-as-notes="${profile==='ordinary' ? '0':'1'}">${profile==='ordinary' ? 'Owned QA':'Saved Messages'}</span></div></div></div><div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned question</div></div></div></div></div><div class="input-message-input" contenteditable="true" data-peer-id="123456">Owned reply</div><button id="send" aria-label="Send">Send</button></div>`);
        await page.evaluate(() => {
          window.fixtureHandlers = []; window.sentCount = 0; window.qaAliasHashChanges=0;
          window.addEventListener('hashchange',()=>qaAliasHashChanges++);
          const runtime = { onMessage: { addListener(fn) { fixtureHandlers.push(fn); } }, getURL: value => value };
          window.chrome = window.browser = { runtime };
          send.onclick = () => sentCount++;
        });
        for (const source of sources) await page.addScriptTag({ content: source });
        await page.locator('[contenteditable]').focus();
        const agent = new Agent({});
        agent._currentUrl = async () => page.url();
        agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
        agent._planExecutionGuards.set(73, { messaging: { target_kind: 'named', recipients: [{ identity:'telegram:k:123456:0',role:'to' }] }, requiresSubmission: true });
        const bind = async () => {
          const context = {};
          const blocked = await agent._messageRecipientGuardBlock(73, 'click', { selector: '#send' }, page.url(), context);
          return { blocked, context };
        };
        return { agent, bind, observe: () => call(page, 'observe_chat') };
      };
      await t.test('alias and named canonical peer from native self Settings', async () => {
        const f = await prepare();
        const observed = await f.observe();
        assert.equal(observed.success, true, JSON.stringify(observed));
        assert.equal(observed.conversationId, 'telegram:k:123456:0');
        const pinned = await f.agent._pinActiveConversationMessagingTarget(73, { target_kind:'active_conversation' }, page.url());
        assert.equal(pinned.ok, true); assert.equal(pinned.target.recipients[0].identity,'telegram:k:123456:0');
        const named = await f.agent._pinActiveConversationMessagingTarget(73, { target_kind:'named',recipients:[{identity:'@OWNED_QA',role:'to'}] },page.url());
        assert.equal(named.ok,true,JSON.stringify(named));assert.equal(named.target.recipients[0].identity,'telegram:k:123456:0');
        const bound = await f.bind(); assert.equal(bound.blocked, null, JSON.stringify(bound.blocked));
        const sent = await call(page, 'click', { selector:'#send',...bound.context });
        assert.equal(sent.success, true, JSON.stringify(sent)); assert.equal(await page.evaluate(() => sentCount), 1);
      });
      const lateNamed = async identity => {
        const f = await prepare(false);
        const pinned = await f.agent._pinActiveConversationMessagingTarget(73, {
          target_kind:'named', recipients:[{identity,role:'to'}],
        }, page.url());
        assert.equal(pinned.ok,true);
        assert.equal(pinned.target.recipients[0].identity,identity,
          'The initial authorized name is retained until its independent profile becomes available.');
        f.agent._planExecutionGuards.set(73,{messaging:pinned.target,requiresSubmission:true,requiresStateChange:true});
        await page.evaluate(html=>document.body.insertAdjacentHTML('beforeend',html),aliasRightProfile);
        return f;
      };
      for(const identity of ['@OWNED_QA','Owned_QA']) await t.test('late ordinary profile resolves '+identity+' without new consent',async()=>{
        const f=await lateNamed(identity);
        const observation=await f.observe();assert.equal(observation.success,true,JSON.stringify(observation));
        assert.equal(observation.threadKey,'dom:telegram:k:123456:0');
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        assert.equal(f.agent._planExecutionGuards.get(73).messaging.recipients[0].identity,'telegram:k:123456:0');
        assert.ok(bound.context.messageRecipientDispatchBinding?.token);
        assert.equal((await call(page,'click',{selector:'#send',...bound.context})).success,true);
        assert.equal(await page.evaluate(()=>sentCount),1);
        const replay=await call(page,'click',{selector:'#send',...bound.context});
        assert.equal(replay.noDispatch,true,'The original dispatch token remains one-use.');
        assert.equal(await page.evaluate(()=>sentCount),1);
      });
      for(const identity of ['@other_qa','telegram:k:987654:0','dom:telegram:k:123456:0']) await t.test('late peer cannot borrow authorization from '+identity,async()=>{
        const f=await lateNamed(identity);assert.equal((await f.observe()).success,true);
        const bound=await f.bind();assert.equal(bound.blocked?.reasonCode,'active_recipient_unverified',JSON.stringify(bound.blocked));
        assert.equal(bound.blocked.noDispatch,true);assert.equal(bound.context.messageRecipientDispatchBinding,undefined);
        assert.equal(f.agent._planExecutionGuards.get(73).messaging.recipients[0].identity,identity);
        assert.equal(await page.evaluate(()=>sentCount),0);
      });
      await t.test('missing native profile never resolves a late named recipient',async()=>{
        const f=await prepare(false);
        f.agent._planExecutionGuards.set(73,{messaging:{target_kind:'named',recipients:[{identity:'@owned_qa',role:'to'}]},requiresSubmission:true,requiresStateChange:true});
        assert.equal((await f.observe()).success,false);
        assert.equal((await f.bind()).blocked?.noDispatch,true);
        assert.equal(f.agent._planExecutionGuards.get(73).messaging.recipients[0].identity,'@owned_qa');
        assert.equal(await page.evaluate(()=>sentCount),0);
      });
      for(const mutation of ['profile-change-return','wrong-peer','document-token']) await t.test('late resolved name retains dispatch fence after '+mutation,async()=>{
        const f=await lateNamed('@owned_qa');
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        if(mutation==='document-token') await prepare('ordinary');
        else await page.evaluate(mutation=>{
          if(mutation==='profile-change-return'){const name=document.querySelector('.profile-content .row-title').firstChild;name.data='other_qa';name.data='Owned_QA';}
          if(mutation==='wrong-peer')for(const node of document.querySelectorAll('[data-peer-id]'))node.dataset.peerId='987654';
        },mutation);
        const attempted=await call(page,'click',{selector:'#send',...bound.context});
        assert.equal(attempted.noDispatch,true,JSON.stringify(attempted));assert.equal(attempted.dispatched,false);
        assert.equal(await page.evaluate(()=>sentCount),0);
      });
      for(const mutation of ['task','run','steering','Stop']) await t.test('late native recipient cannot send across '+mutation+' owner change',async()=>{
        const f=await lateNamed('@owned_qa');
        await page.locator('[contenteditable]').evaluate(node=>{node.textContent='';});
        const provider={model:'neutral-local-fixture',config:{}};
        f.agent.providerManager={getActive:()=>provider};
        f.agent.conversations.set(73,[{role:'system',content:'Neutral native recipient fixture.'},{role:'user',content:'Send one reply to @owned_qa.'}]);
        f.agent.completionInvariants.set(73,createCompletionInvariantState('current-native-recipient-run'));
        f.agent._persist=()=>{};
        f.agent._readChatObservation=async()=>{
          const observation=await f.observe();
          if(mutation==='task')f.agent.conversations.get(73).push({role:'user',content:'Send a different reply to another recipient.'});
          if(mutation==='run')f.agent.completionInvariants.set(73,createCompletionInvariantState('new-native-recipient-run'));
          if(mutation==='steering')f.agent._steeringRuns.set(73,{messages:[],revision:2,authorizedRevision:1});
          if(mutation==='Stop')f.agent.abortFlags.set(73,true);
          return observation;
        };
        assert.ok(f.agent._nativeChatOwnerScope(73),'Production owner must exist before observation.');
        let dispatches=0;f.agent.executeTool=async()=>{dispatches++;throw Error('Unexpected dispatch');};
        const result=await f.agent._sendChatWorkflow(73,{thread_key:'dom:telegram:k:123456:0',text:'Fresh exact reply'});
        assert.equal(result.reason,'native_chat_owner_changed',JSON.stringify(result));assert.equal(result.noDispatch,true);
        assert.equal(dispatches,0);assert.equal(await page.evaluate(()=>sentCount),0);
      });
      await t.test('late alias resolution retains an uncertain pending outgoing',async()=>{
        const f=await lateNamed('@owned_qa');
        await page.locator('[contenteditable]').evaluate(node=>{node.textContent='';});
        f.agent._readChatObservation=()=>f.observe();f.agent._persist=()=>{};
        await f.agent._observeChatWorkflow(73);
        const session=f.agent.chatSessions.get(73);
        const pending={key:'original-uncertain-send',text:'Earlier owned outgoing',threadKey:session.threadKey,attemptedAt:new Date().toISOString()};
        f.agent.chatSessions.set(73,{...session,pendingOutbound:pending});
        let dispatches=0;f.agent.executeTool=async()=>{dispatches++;throw Error('Unexpected dispatch');};
        const result=await f.agent._sendChatWorkflow(73,{thread_key:'dom:telegram:k:123456:0',text:'Distinct new reply'});
        assert.equal(result.reason,'send_pending',JSON.stringify(result));assert.equal(result.noDispatch,true);
        assert.equal(f.agent.chatSessions.get(73).pendingOutbound.key,pending.key);
        assert.equal(f.agent.chatSessions.get(73).completionReceipt,null);
        assert.equal(dispatches,0);assert.equal(await page.evaluate(()=>sentCount),0);
      });
      await t.test('no self profile is actionable and stays fail closed', async () => {
        const f = await prepare(false), observation = await f.observe();
        assert.equal(observation.success, false); assert.equal(observation.reason,'native_telegram_alias_binding_required');
        assert.match(observation.error,/Settings/); assert.match(observation.error,/numeric|peer/i);
        assert.equal((await f.bind()).blocked?.noDispatch,true); assert.equal(await page.evaluate(() => sentCount),0);
      });
      await t.test('ordinary native right profile independently binds an exact username',async () => {
        const f=await prepare('ordinary');
        const observation=await f.observe();assert.equal(observation.success,true,JSON.stringify(observation));
        assert.equal(observation.conversationId,'telegram:k:123456:0');
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        assert.equal((await call(page,'click',{selector:'#send',...bound.context})).success,true);
        assert.equal(await page.evaluate(() => sentCount),1);
      });
      await t.test('ordinary native profile can bind a negative canonical peer',async () => {
        const f=await prepare('ordinary');
        await page.evaluate(() => { for(const node of document.querySelectorAll('[data-peer-id]'))node.dataset.peerId='-123456'; });
        const observation=await f.observe();assert.equal(observation.success,true,JSON.stringify(observation));
        assert.equal(observation.conversationId,'telegram:k:-123456:0');
        f.agent._planExecutionGuards.get(73).messaging.recipients[0].identity='telegram:k:-123456:0';
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        assert.equal((await call(page,'click',{selector:'#send',...bound.context})).success,true);
        assert.equal(await page.evaluate(() => sentCount),1);
      });
      await t.test('native self Settings never certifies a negative self peer',async () => {
        const f=await prepare();
        await page.evaluate(() => { for(const node of document.querySelectorAll('[data-peer-id]'))node.dataset.peerId='-123456'; });
        assert.equal((await f.observe()).success,false);
        assert.equal((await f.bind()).blocked?.noDispatch,true);assert.equal(await page.evaluate(()=>sentCount),0);
      });
      for(const field of ['profile-title','profile-avatar','native-header','native-composer','live-bubble','header-topic']) {
        for(const invalid of ['zero-width','unicode-decimal']) await t.test(`initial ${field} machine peer rejects ${invalid}`,async () => {
          const f=await prepare('ordinary');
          await page.evaluate(({field,invalid})=>{
            const selectors={'profile-title':'.profile-name .peer-title','profile-avatar':'.profile-content .avatar','native-header':'.chat .peer-title','native-composer':'[contenteditable]','live-bubble':'.bubble','header-topic':'.chat .peer-title'};
            if(field==='header-topic')document.querySelector(selectors[field]).dataset.threadId=invalid==='zero-width'?'0\u200b':'０';
            else document.querySelector(selectors[field]).dataset.peerId=invalid==='zero-width'?'123456\u200b':'１２３４５６';
          },{field,invalid});
          assert.equal((await f.observe()).success,false,'A fresh native read must not normalize malformed machine identity.');
          assert.equal((await f.bind()).blocked?.noDispatch,true);assert.equal(await page.evaluate(()=>sentCount),0);
        });
      }
      for(const mutation of ['username','profile-peer','avatar-peer','old-profile','duplicate-profile','profile-clone','inactive-return','two-composers']) await t.test(`ordinary alias rejects ${mutation}`,async () => {
        const f=await prepare('ordinary');
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        await page.evaluate(mutation=>{
          const profile=document.querySelector('.profile-content');
          if(mutation==='username')profile.querySelector('.row-title').textContent='other_qa';
          if(mutation==='profile-peer')profile.querySelector('.profile-name .peer-title').dataset.peerId='987654';
          if(mutation==='avatar-peer')profile.querySelector('.avatar').dataset.peerId='987654';
          if(mutation==='old-profile'){profile.querySelector('.row-title').textContent='old_qa';profile.querySelector('.profile-name .peer-title').dataset.peerId='987654';profile.querySelector('.avatar').dataset.peerId='987654';}
          if(mutation==='duplicate-profile')profile.parentElement.append(profile.cloneNode(true));
          if(mutation==='profile-clone')profile.replaceWith(profile.cloneNode(true));
          if(mutation==='inactive-return'){profile.parentElement.classList.remove('active');profile.parentElement.classList.add('active');}
          if(mutation==='two-composers')document.querySelector('.chat').append(document.querySelector('[contenteditable]').cloneNode(true));
        },mutation);
        const result=await call(page,'click',{selector:'#send',...bound.context});assert.equal(result.noDispatch,true,JSON.stringify(result));
        assert.equal(await page.evaluate(()=>sentCount),0);
      });
      await t.test('two independently eligible native profile witnesses remain ambiguous',async () => {
        const f=await prepare('both');assert.equal((await f.observe()).success,false);
        assert.equal((await f.bind()).blocked?.noDispatch,true);assert.equal(await page.evaluate(()=>sentCount),0);
      });
      await t.test('native geometry-visible fake editor cannot discard the actual alias proof',async () => {
        const f=await prepare();
        await page.evaluate(() => {
          const fake=document.querySelector('[contenteditable]').cloneNode(true);
          fake.removeAttribute('data-peer-id');fake.classList.add('input-field-input-fake');
          const rect=document.querySelector('[contenteditable]').getBoundingClientRect();
          Object.assign(fake.style,{position:'absolute',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',pointerEvents:'none'});
          document.querySelector('.chat').append(fake);
          document.querySelector('[contenteditable]').blur();
        });
        assert.equal((await f.observe()).success,true);
        const bound=await f.bind();assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        assert.equal((await call(page,'click',{selector:'#send',...bound.context})).success,true);
        assert.equal(await page.evaluate(() => sentCount),1);
      });
      await t.test('two independently eligible native composers remain ambiguous',async () => {
        const f=await prepare();
        await page.evaluate(() => { const composer=document.querySelector('[contenteditable]');composer.blur();document.querySelector('.chat').append(composer.cloneNode(true)); });
        assert.equal((await f.observe()).success,false);
        assert.equal((await f.bind()).blocked?.noDispatch,true);
        assert.equal(await page.evaluate(() => sentCount),0);
      });
      const mutations = ['username','username-return','username-clone','peer','peer-return','avatar-peer','avatar-peer-return','avatar-clone','header-peer-clone','icon','icon-clone','row-clone','profile-clone','remove-return','inactive','inactive-return','is-me','hidden','hidden-return','hidden-ancestor','opacity-ancestor','inert-ancestor','wrapper-hidden-return','wrapper-style-return','duplicate-profile','duplicate-username','duplicate-avatar','bad-unicode','peer-unicode','two-at','route','route-return','topic','foreign-bubble'];
      for (const mutation of mutations) await t.test(`reject stale alias proof: ${mutation}`, async () => {
        const f = await prepare();
        if(mutation.startsWith('wrapper-'))await page.evaluate(()=>{const username=document.querySelector('.profile-content .row-title'),wrapper=document.createElement('div');wrapper.id='native-username-wrapper';username.before(wrapper);wrapper.append(username);});
        const bound = await f.bind(); assert.equal(bound.blocked,null,JSON.stringify(bound.blocked));
        assert.equal(bound.context.messageRecipientGuardRequired,true,JSON.stringify(Object.keys(bound.context)));
        const aliasBefore=mutation==='route-return' ? await page.evaluate(()=>__wb_get_native_chat_context(document.querySelector('[contenteditable]')).aliasWitnessSignature) : '';
        await page.evaluate(mutation => {
          const profile = document.querySelector('.profile-content'), username = profile.querySelector('.row-title');
          const peer = profile.querySelector('.profile-name .peer-title'), avatar = profile.querySelector('.avatar'), icon = profile.querySelector('.row-icon-icon');
          if (mutation === 'username' || mutation === 'username-return') { username.firstChild.data='other_qa'; if(mutation.endsWith('return'))username.firstChild.data='Owned_QA'; }
          if (mutation === 'username-clone') username.replaceWith(username.cloneNode(true));
          if (mutation === 'peer' || mutation === 'peer-return') { peer.dataset.peerId='987654'; if(mutation.endsWith('return'))peer.dataset.peerId='123456'; }
          if (mutation === 'avatar-peer' || mutation === 'avatar-peer-return') { avatar.dataset.peerId='987654';if(mutation.endsWith('return'))avatar.dataset.peerId='123456'; }
          if (mutation === 'avatar-clone') avatar.replaceWith(avatar.cloneNode(true));
          if (mutation === 'header-peer-clone') { const node=document.querySelector('.chat .peer-title');node.replaceWith(node.cloneNode(true)); }
          if (mutation === 'icon') icon.textContent='Username';
          if (mutation === 'icon-clone') icon.replaceWith(icon.cloneNode(true));
          if (mutation === 'row-clone') { const node=username.closest('.row');node.replaceWith(node.cloneNode(true)); }
          if (mutation === 'profile-clone') profile.replaceWith(profile.cloneNode(true));
          if (mutation === 'remove-return') { const parent=profile.parentElement;profile.remove();parent.append(profile); }
          if (mutation === 'inactive' || mutation === 'inactive-return') { profile.parentElement.classList.remove('active');if(mutation.endsWith('return'))profile.parentElement.classList.add('active'); }
          if (mutation === 'is-me') profile.classList.remove('is-me');
          if (mutation === 'hidden' || mutation === 'hidden-return') { username.hidden=true;if(mutation.endsWith('return'))username.hidden=false; }
          if (mutation === 'hidden-ancestor') document.querySelector('#column-left').setAttribute('aria-hidden','true');
          if (mutation === 'opacity-ancestor') document.querySelector('#column-left').style.opacity='0';
          if (mutation === 'inert-ancestor') document.querySelector('#column-left').inert=true;
          if (mutation === 'wrapper-hidden-return') { const wrapper=document.querySelector('#native-username-wrapper');wrapper.hidden=true;wrapper.hidden=false; }
          if (mutation === 'wrapper-style-return') { const wrapper=document.querySelector('#native-username-wrapper');wrapper.style.opacity='0';wrapper.style.opacity='1'; }
          if (mutation === 'duplicate-profile') profile.parentElement.append(profile.cloneNode(true));
          if (mutation === 'duplicate-username') profile.append(username.closest('.row').cloneNode(true));
          if (mutation === 'duplicate-avatar') avatar.parentElement.append(avatar.cloneNode(true));
          if (mutation === 'bad-unicode') username.textContent='Owned_\u200bQA';
          if (mutation === 'peer-unicode') peer.dataset.peerId='123456\u200b';
          if (mutation === 'two-at') username.textContent='@@Owned_QA';
          if (mutation === 'route' || mutation === 'route-return') { location.hash='@other_qa';if(mutation.endsWith('return'))location.hash='@owned_qa'; }
          if (mutation === 'topic') location.hash='@owned_qa?thread=10';
          if (mutation === 'foreign-bubble') document.querySelector('.bubble').dataset.peerId='987654';
        }, mutation);
        if(mutation==='route-return') {
          await page.waitForFunction(()=>qaAliasHashChanges>=2);
          const aliasAfter=await page.evaluate(()=>__wb_get_native_chat_context(document.querySelector('[contenteditable]')).aliasWitnessSignature);
          assert.notEqual(aliasAfter,aliasBefore,'A processed real hash transition must replace the alias certificate.');
        }
        const attempted = await call(page, 'click', { selector:'#send',...bound.context });
        assert.equal(attempted.noDispatch,true,JSON.stringify(attempted)); assert.equal(attempted.dispatched,false,JSON.stringify(attempted));
        assert.equal(await page.evaluate(() => sentCount),0,'Old alias proof cannot dispatch even if final text or classes returned.');
      });
      await t.test('benign profile decoration and exact one optional at-sign remain valid',async () => {
        const f = await prepare();
        await page.evaluate(() => { document.querySelector('.row-title').textContent='@OWNED_QA'; });
        const bound=await f.bind();assert.equal(bound.blocked,null);
        await page.evaluate(() => { const image=document.createElement('img');image.alt='Decoration';document.querySelector('.avatar').append(image);document.querySelector('.row-subtitle').textContent='Different translated label'; });
        assert.equal((await call(page,'click',{selector:'#send',...bound.context})).success,true);
        assert.equal(await page.evaluate(() => sentCount),1);
      });
      await t.test('queued material records invalidate before their observer callback runs',async () => {
        await prepare();
        const result=await page.evaluate(() => {
          const composer=document.querySelector('[contenteditable]');
          const first=__wb_get_native_chat_context(composer);
          const username=document.querySelector('.profile-content .row-title');
          username.firstChild.data='other_qa';username.firstChild.data='Owned_QA';
          const second=__wb_get_native_chat_context(composer);
          return {first:!!first,second:!!second,revised:first.aliasWitnessSignature!==second.aliasWitnessSignature};
        });
        assert.deepEqual(result,{first:true,second:true,revised:true},'A fresh read may bind current facts, but cannot reuse the prior dispatch certificate after queued identity drift.');
      });
    } finally { await browser.close(); }
  });
}

for (const [build, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) {
  for (const client of ['k', 'a']) {
    test(`${build}: official Telegram Web${client.toUpperCase()} header pins native peer through startup and one-use dispatch`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
        await page.goto(`https://web.telegram.org/${client}/#123456`);
        await page.setContent(`<!doctype html><style>body{margin:0;font:16px sans-serif}.chat,#MiddleColumn{margin-left:320px;width:900px;height:760px}.topbar,.MiddleHeader{height:70px}.user-title,.fullName{margin:0;padding:15px}.bubbles-inner,.MessageList{height:570px}.bubbles-scrollable{height:570px;overflow-y:auto}.input-message-input,#editable-message-text{display:inline-block;width:650px;min-height:32px}button{height:32px}.MessageOutgoingStatus i{display:inline-block;width:16px;height:16px}</style>
          ${client === 'k' ? `<div class="chat"><div class="topbar sidebar-header"><div class="chat-info-container"><div class="chat-info"><div class="person"><div class="content"><div class="top"><div class="user-title"><span class="peer-title" data-peer-id="123456">WebBrain QA Bot</span></div></div></div></div></div></div></div><div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Fixture question</div></div></div></div></div><div class="input-message-input" contenteditable="true" data-peer-id="123456">Fixture reply</div><button id="send" aria-label="Send">Send</button></div>` : `<div id="MiddleColumn"><div class="MiddleHeader"><div class="ChatInfo"><div class="Avatar" data-peer-id="123456" style="width:20px;height:20px"></div><h3 class="fullName">WebBrain QA Bot</h3></div></div><div class="MessageList with-bottom-snap" data-list-key="123456_-1_thread"><div class="messages-container"><div class="Message" data-message-id="1"><div class="text-content">Fixture question</div></div><div class="list-bottom-marker"></div></div></div><div id="editable-message-text" role="textbox" contenteditable="true">Fixture reply</div><button id="send" aria-label="Send">Send</button></div>`}`);
        await page.evaluate(client => {
          window.fixtureHandlers = [];
          const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
          window.chrome = { runtime }; window.browser = { runtime }; window.sentCount = 0;
          window.nativeId = 10; window.deferDelivery = false;
          window.appendOutgoing = (id, text, confirmed = true) => {
            const row = document.createElement('div');
            if (client === 'k') {
              row.className = `bubble is-out ${confirmed ? 'is-sent' : 'is-sending'}`;
              row.dataset.mid = id; row.dataset.peerId = '123456';
              const body = document.createElement('div'); body.className = 'message'; body.textContent = text; row.append(body);
            } else {
              row.className = 'Message own'; row.dataset.messageId = id;
              const body = document.createElement('div'); body.className = 'text-content'; body.textContent = text;
              const meta = document.createElement('div'); meta.className = 'MessageOutgoingStatus';
              const status = document.createElement('i'); status.className = confirmed ? 'icon-check' : 'icon-message-pending';
              meta.append(status); row.append(body, meta);
            }
            const transcript = document.querySelector('.bubbles-inner,.messages-container');
            // Native rows have one identity per message. Re-rendering/editing
            // an already mounted ID replaces that row rather than duplicating
            // its key; the existing-ID delivery negative still checks it.
            const previous = Array.from(transcript.querySelectorAll('.bubble,.Message')).find(node =>
              node.getAttribute(client === 'k' ? 'data-mid' : 'data-message-id') === String(id));
            if (previous) previous.replaceWith(row); else transcript.append(row);
            const pane = document.querySelector('.bubbles-scrollable,.MessageList'); pane.scrollTop = pane.scrollHeight;
          };
          document.querySelector('#send').addEventListener('click', () => {
            window.sentCount++;
            const composer = document.querySelector('[contenteditable]');
            if (!window.deferDelivery) window.appendOutgoing(String(++window.nativeId), composer.textContent.trim());
            composer.textContent = '';
          });
        }, client);
        for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'chat-observation.js', 'content.js']) {
          await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
        }
        await page.locator('[contenteditable]').focus();
        const agent = new Agent({});
        agent._currentUrl = async () => page.url();
        agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
        agent._readChatObservation = () => call(page, 'observe_chat');
        agent._persist = () => {};
        agent.completionInvariants.set(73, createCompletionInvariantState('native-chat-lab'));
        const pinned = await agent._pinActiveConversationMessagingTarget(73, { target_kind: 'active_conversation' }, page.url());
        assert.equal(pinned.ok, true, JSON.stringify(pinned));
        assert.equal(pinned.target.recipients[0].identity, `telegram:${client}:123456:0`);
        const named = await agent._pinActiveConversationMessagingTarget(73, {
          target_kind: 'named', recipients: [{ identity: 'WebBrain QA Bot', role: 'to' }],
        }, page.url());
        assert.equal(named.target.recipients[0].identity, `telegram:${client}:123456:0`, 'A named alias should resolve to the visible peer before later sends');
        agent._planExecutionGuards.set(73, { messaging: pinned.target, requiresStateChange: true, requiresSubmission: true });
        const bind = async () => {
          const context = {};
          const blocked = await agent._messageRecipientGuardBlock(73, 'click', { selector: '#send' }, page.url(), context);
          return { blocked, context };
        };
        for (let index = 0; index < 2; index++) {
          await page.locator('[contenteditable]').evaluate(node => { node.textContent = 'Fixture reply'; });
          const { blocked, context } = await bind();
          assert.equal(blocked, null, JSON.stringify(blocked));
          assert.ok(context.messageRecipientDispatchBinding?.token);
          if (index === 1) await page.evaluate(() => {
            // Focus/draft presentation changes are not recipient changes.
            document.querySelector('[contenteditable]').classList.add('fixture-focus-state');
            document.querySelector('.topbar,.MiddleHeader').classList.add('fixture-online-state');
          });
          const sent = await call(page, 'click', { selector: '#send', ...context });
          assert.equal(sent.success, true, JSON.stringify(sent));
          agent._recordCompletionToolResult(73, 'click', { selector: '#send' }, sent, { messageRecipientContext: context });
          assert.equal(agent.completionInvariants.get(73).verificationDebt, true);
          const verified = await agent._observeChatWorkflow(73);
          assert.ok(verified.chatDeliveryVerification, JSON.stringify(verified));
          agent._recordCompletionToolResult(73, 'chat_observe', {}, verified);
          assert.equal(completionDoneBlock(agent.completionInvariants.get(73), 'done', { outcome: 'success' }), null,
            'A newly confirmed exact-body native outgoing should allow success after an independent observation');
        }
        await page.locator('[contenteditable]').evaluate(node => { node.textContent = 'Delayed fixture reply'; });
        await page.evaluate(() => { window.deferDelivery = true; });
        const uncertain = await bind();
        assert.equal(uncertain.blocked, null);
        const delayed = await call(page, 'click', { selector: '#send', ...uncertain.context });
        agent._recordCompletionToolResult(73, 'click', { selector: '#send' }, delayed, { messageRecipientContext: uncertain.context });
        const verify = async () => {
          const observation = await agent._observeChatWorkflow(73);
          agent._recordCompletionToolResult(73, 'chat_observe', {}, observation);
          return observation;
        };
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'Bare chat observation cannot verify a dispatch');
        await page.evaluate(() => window.appendOutgoing('2', 'Delayed fixture reply'));
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'An older virtualized matching row cannot prove the latest send');
        await page.evaluate(() => window.appendOutgoing('12', 'Delayed fixture reply'));
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'A message already mounted before dispatch cannot prove a new send');
        await page.evaluate(() => window.appendOutgoing('13', 'Different fixture reply'));
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'The exact authored body must match');
        await page.evaluate(() => window.appendOutgoing('14', 'Delayed fixture reply', false));
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'A pending bubble cannot prove delivery');
        assert.equal(agent.completionInvariants.get(73).verificationDebt, true);
        await page.evaluate(client => {
          if (client === 'k') document.querySelector('[data-mid="14"]').className = 'bubble is-out is-sent';
          else document.querySelector('[data-message-id="14"] .MessageOutgoingStatus i').className = 'icon-check';
        }, client);
        assert.ok((await verify()).chatDeliveryVerification, 'An independently observed late confirmation should clear the latest send');
        assert.equal(agent.completionInvariants.get(73).verificationDebt, false);
        agent._recordCompletionToolResult(73, 'click', { selector: '#unrelated-action' }, { success: true });
        assert.equal((await verify()).chatDeliveryVerification, undefined, 'A chat observation cannot verify a later unrelated consequential action');
        assert.equal(agent.completionInvariants.get(73).verificationDebt, true);
        await page.locator('[contenteditable]').evaluate(node => { node.textContent = 'Reserved fixture reply'; });
        const reserved = await bind();
        assert.equal(reserved.blocked, null);
        await page.evaluate(client => {
          location.hash = '987654';
          if (client === 'k') document.querySelector('.input-message-input').dataset.peerId = '987654';
          else document.querySelector('.MiddleHeader .Avatar').dataset.peerId = '987654';
        }, client);
        const transition = await agent._pinActiveConversationMessagingTarget(73, { target_kind: 'active_conversation' }, page.url());
        assert.equal(transition.ok, false, 'New header/composer with the previous transcript is unverified');
        const drifted = await call(page, 'click', { selector: '#send', ...reserved.context });
        assert.equal(drifted.dispatched, false, JSON.stringify(drifted));
        await page.evaluate(client => {
          if (client === 'k') {
            for (const row of document.querySelectorAll('.bubble')) row.dataset.peerId = '987654';
            document.querySelector('.user-title .peer-title').dataset.peerId = '987654';
          }
          else document.querySelector('.MessageList').dataset.listKey = '987654_-1_thread';
        }, client);
        const changed = await agent._pinActiveConversationMessagingTarget(73, { target_kind: 'active_conversation' }, page.url());
        assert.equal(changed.ok, true);
        assert.equal(changed.target.recipients[0].identity, `telegram:${client}:987654:0`);
        const rejected = await bind();
        assert.equal(rejected.blocked?.reasonCode, 'active_recipient_unverified', 'A second peer with the same name must not inherit the original task');
        await page.evaluate(() => {
          const header = document.querySelector('.topbar,.MiddleHeader'); header.after(header.cloneNode(true));
        });
        const ambiguous = await agent._pinActiveConversationMessagingTarget(73, { target_kind: 'active_conversation' }, page.url());
        assert.equal(ambiguous.ok, false, 'Two native headers cannot identify one recipient');
        assert.equal(await page.evaluate(() => window.sentCount), 3);
      } finally { await browser.close(); }
    });
  }
}
