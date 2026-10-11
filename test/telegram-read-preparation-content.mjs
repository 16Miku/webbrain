import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const owner = 'owned-native-read-preparation-task-1';
const selfProfile = `<div class="settings-container active"><div class="settings-layer profile-container active"><div class="profile-content is-me"><div class="profile-name"><span class="peer-title" data-peer-id="123456">Owned QA</span></div><div class="profile-avatars-avatar active"><div class="avatar" data-peer-id="123456">Q</div></div><div class="row row-with-icon"><div class="row-icon"><span class="tgico row-icon-icon">\ueac1</span></div><div class="row-title">owned_qa</div></div></div></div></div>`;
const ordinaryProfile = `<div id="column-right"><div class="shared-media-container profile-container active"><div class="profile-content"><div class="profile-name"><span class="peer-title" data-peer-id="123456">Owned QA</span></div><div class="profile-avatars-avatar active"><div class="avatar" data-peer-id="123456">Q</div></div><div class="row row-with-icon"><div class="row-icon"><span class="tgico row-icon-icon">\ueac1</span></div><div class="row-title">owned_qa</div></div></div></div></div>`;
const fixture = `<!doctype html><style>body{margin:0;font:16px sans-serif}.chat{margin-left:320px;width:800px}.topbar{height:70px}.user-title{display:inline-block;min-width:100px;height:40px}.bubbles-inner{height:500px}.input-message-input{display:inline-block;width:650px;min-height:32px}button{height:32px}#column-left{position:absolute;left:0;top:0;width:280px}.sidebar-header{height:64px}.sidebar-tools-button{width:40px}.btn-menu{position:absolute;top:70px;left:30px;width:220px;background:white}.btn-menu-item{min-height:32px}.tgico{display:inline-block;min-width:18px;min-height:18px}.profile-name,.row-title,.row-icon{min-height:24px}.avatar{width:40px;height:40px}</style>
<div id="column-left"><div class="sidebar-slider"><div class="item-main"><div class="sidebar-header"><button id="tools" class="btn-icon rp btn-menu-toggle sidebar-tools-button is-visible">Menu</button><button id="new-menu" class="btn-menu-toggle">New Chats</button></div></div></div></div>
<div class="chat"><div class="sidebar-header topbar"><div class="chat-info-container"><div class="chat-info"><div class="person"><div class="content"><div class="top"><div id="profile" class="user-title"><span class="peer-title" data-peer-id="123456" data-me-as-notes="1"><span class="i18n">Saved Messages</span></span></div></div></div></div></div><button id="call">Call</button><button id="search">Search</button></div></div><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned fixture</div></div></div><div class="input-message-input" contenteditable="true" data-peer-id="123456"></div><button id="send">Send</button></div>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: native Telegram identity preparation uses one current read-only dispatch token`, async t => {
    const browser = await engine.launch({ headless:true });
    try {
      const page = await browser.newPage({ viewport:{width:1280,height:800} });
      await page.route('**/*', route => route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
      const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','content.js'].map(file=>readFile(new URL(`../src/${build}/src/content/${file}`,import.meta.url),'utf8')));
      const call = (action, params={}) => page.evaluate(message=>new Promise(resolve=>{for(const handler of fixtureHandlers)handler(message,{},resolve);}),{target:'content',action,params});
      const setup = async () => {
        await page.goto('about:blank'); await page.goto('https://web.telegram.org/k/#@owned_qa'); await page.setContent(fixture);
        await page.evaluate(({selfProfile,ordinaryProfile})=>{
          window.fixtureHandlers=[];window.actions={tools:0,settings:0,profile:0,send:0};
          const runtime={onMessage:{addListener(handler){fixtureHandlers.push(handler);}},getURL:value=>value};window.chrome=window.browser={runtime};
          tools.onclick=()=>{actions.tools++;tools.classList.add('menu-open');const menu=document.createElement('div');menu.className='btn-menu bottom-right active was-open';menu.innerHTML='<div id="settings" class="btn-menu-item rp-overflow" role="button"><span class="tgico btn-menu-item-icon">\uea22</span><span class="i18n btn-menu-item-text">Different translated Settings label</span></div><div id="contacts" class="btn-menu-item rp-overflow" role="button"><span class="tgico btn-menu-item-icon">\uea57</span><span class="btn-menu-item-text">Contacts</span></div>';document.body.append(menu);settings.onclick=()=>{actions.settings++;menu.remove();tools.classList.remove('menu-open');document.querySelector('#column-left').insertAdjacentHTML('beforeend',selfProfile);};};
          profile.onclick=()=>{actions.profile++;document.body.insertAdjacentHTML('beforeend',ordinaryProfile);};send.onclick=()=>actions.send++;
        },{selfProfile,ordinaryProfile});
        for(const source of sources)await page.addScriptTag({content:source});
        await page.locator('.input-message-input').focus();
      };
      const ref = async selector=>{await call('get_accessibility_tree',{filter:'all'});return page.locator(selector).first().evaluate(node=>__wb_ax_ref(node));};
      const probe = async selector=>{const ref_id=await ref(selector);const result=await call('probe_message_recipient_guard',{tool:'click_ax',args:{ref_id},adapterName:'telegram',bindDispatch:true,_nativeChatOwner:owner});return {ref_id,result};};
      const dispatch = (prepared, extra={})=>call('click_ax',{ref_id:prepared.ref_id,_nativeChatOwner:owner,_nativeTelegramReadRepairRequired:true,nativeTelegramReadRepairBinding:prepared.result.nativeTelegramReadRepairBinding,...extra});
      await t.test('cold native own Settings can be opened without resolving or sending to an alias',async()=>{
        await setup();const cold=await call('observe_chat',{_nativeChatOwner:owner});assert.equal(cold.success,false);
        assert.equal(cold.nativeTelegramRepair.phase,'open_menu');
        assert.equal(await page.evaluate(ref=>__wb_ax_lookup(ref)===tools,cold.nativeTelegramRepair.ref_id),true);
        const anchored=await call('get_accessibility_tree',{ref_id:cold.nativeTelegramRepair.ref_id,filter:'all'});assert.equal(anchored.error,undefined);assert.ok(JSON.stringify(anchored).includes(cold.nativeTelegramRepair.ref_id));
        const menu=await probe('#tools');assert.equal(menu.result.nativeTelegramRepair,true,JSON.stringify(menu.result));assert.ok(menu.result.nativeTelegramReadRepairBinding?.token);
        const menuResult=await dispatch(menu);assert.equal(menuResult.success,true,JSON.stringify(menuResult));assert.equal(menuResult._nativeTelegramReadRepair,true);
        const opened=await call('observe_chat',{_nativeChatOwner:owner});assert.equal(opened.success,false);assert.equal(opened.nativeTelegramRepair.phase,'open_self_settings');
        assert.equal(await page.evaluate(ref=>__wb_ax_lookup(ref)===settings,opened.nativeTelegramRepair.ref_id),true);
        const menuTree=await call('get_accessibility_tree',{ref_id:opened.nativeTelegramRepair.ref_id,filter:'all'});assert.equal(menuTree.error,undefined);assert.ok(JSON.stringify(menuTree).includes(opened.nativeTelegramRepair.ref_id));
        const settings=await probe('#settings');assert.equal(settings.result.nativeTelegramRepair,true,JSON.stringify(settings.result));
        const result=await dispatch(settings);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result._nativeTelegramReadRepair,true);
        assert.equal(result.nativeTelegramReadRepairBinding,undefined,'Private dispatch token must not be projected back.');
        const observed=await call('observe_chat',{_nativeChatOwner:owner});assert.equal(observed.success,true,JSON.stringify(observed));assert.equal(observed.conversationId,'telegram:k:123456:0');
        assert.deepEqual(await page.evaluate(()=>actions),{tools:1,settings:1,profile:0,send:0});
      });
      await t.test('exact current native title may open ordinary profile',async()=>{
        await setup();const prepared=await probe('#profile .i18n');assert.equal(prepared.result.nativeTelegramRepair,true,JSON.stringify(prepared.result));
        assert.equal((await dispatch(prepared)).success,true);assert.equal((await call('observe_chat',{_nativeChatOwner:owner})).success,true);
        assert.deepEqual(await page.evaluate(()=>actions),{tools:0,settings:0,profile:1,send:0});
      });
      await t.test('a read-only click with a changed native peer cannot certify completion',async()=>{
        await setup();const prepared=await probe('#profile');
        await page.evaluate(()=>{profile.onclick=()=>{actions.profile++;document.querySelector('.chat .peer-title').dataset.peerId='987654';};});
        const result=await dispatch(prepared);assert.equal(result.success,true,JSON.stringify(result));assert.notEqual(result._nativeTelegramReadRepair,true);
        assert.equal(await page.evaluate(()=>actions.send),0);assert.equal(await page.evaluate(()=>actions.profile),1);
      });
      await t.test('an action attribute cannot disguise an actionable native-looking control',async()=>{
        await setup();await page.evaluate(()=>tools.dataset.action='send');
        const prepared=await probe('#tools');assert.notEqual(prepared.result.nativeTelegramRepair,true);
        assert.equal((await dispatch(prepared)).noDispatch,true);assert.equal(await page.evaluate(()=>actions.tools),0);
      });
      await t.test('native identity drift inside the actual local dispatch hook is checked before clicking',async()=>{
        await setup();const prepared=await probe('#tools');assert.equal(prepared.result.nativeTelegramRepair,true);
        await page.evaluate(()=>{window.__wbPageMonitor={beginContentAction(){return ()=>{};},beforeLocalDispatch(){},withLocalDispatch(callback){const peer=document.querySelector('.chat .peer-title');peer.dataset.peerId='987654';peer.dataset.peerId='123456';return callback();}};});
        const result=await dispatch(prepared);assert.equal(result.noDispatch,true,JSON.stringify(result));assert.equal(result.dispatched,false);
        assert.equal(await page.evaluate(()=>actions.tools),0);assert.equal(await page.evaluate(()=>actions.send),0);
      });
      for(const selector of ['#send','#new-menu','#call','#search','.topbar','.chat-info-container'])await t.test(`no read-only preparation bypass for ${selector}`,async()=>{
        await setup();const prepared=await probe(selector);assert.notEqual(prepared.result.nativeTelegramRepair,true);assert.equal(prepared.result.nativeTelegramReadRepairBinding,undefined);
        const result=await dispatch(prepared);assert.equal(result.noDispatch,true,JSON.stringify(result));assert.equal(result.dispatched,false);
        assert.deepEqual(await page.evaluate(()=>actions),{tools:0,settings:0,profile:0,send:0});
      });
      for(const mutation of ['owner','route','peer','peer-return','target-clone','target-hide-return','wrong-target','reuse','forged-token','missing-owner'])await t.test(`prepared native read refuses ${mutation}`,async()=>{
        await setup();const prepared=await probe('#tools');assert.equal(prepared.result.nativeTelegramRepair,true);
        if(mutation==='reuse')assert.equal((await dispatch(prepared)).success,true);
        else await page.evaluate(mutation=>{
          if(mutation==='route')location.hash='@other_qa';
          if(mutation==='peer'||mutation==='peer-return'){document.querySelector('.chat .peer-title').dataset.peerId='987654';if(mutation==='peer-return')document.querySelector('.chat .peer-title').dataset.peerId='123456';}
          if(mutation==='target-clone')tools.replaceWith(tools.cloneNode(true));
          if(mutation==='target-hide-return'){tools.hidden=true;tools.hidden=false;}
        },mutation);
        const extra=mutation==='owner'?{_nativeChatOwner:'different-owner'}:mutation==='missing-owner'?{_nativeChatOwner:''}:mutation==='wrong-target'?{ref_id:await ref('#send')}:mutation==='forged-token'?{nativeTelegramReadRepairBinding:{token:'invented'}}:{};
        const result=await dispatch(prepared,extra);assert.equal(result.noDispatch,true,JSON.stringify(result));assert.equal(result.dispatched,false);
        assert.equal(await page.evaluate(()=>actions.send),0);assert.equal(await page.evaluate(()=>actions.tools),mutation==='reuse'?1:0);
      });
      for (const selfHint of ['0', null]) await t.test(`ordinary alias repair uses its current profile with native self hint ${selfHint}`, async () => {
        await setup();
        await page.evaluate(selfHint => {
          const peer = document.querySelector('.chat .peer-title');
          if (selfHint === null) peer.removeAttribute('data-me-as-notes');
          else peer.setAttribute('data-me-as-notes', selfHint);
          peer.querySelector('.i18n').textContent = 'Owned current bot';
          document.querySelector('.input-message-input').textContent = 'Owned draft remains';
        }, selfHint);
        const cold = await call('observe_chat', { _nativeChatOwner: owner });
        assert.equal(cold.success, false);
        assert.equal(cold.nativeTelegramRepair?.phase, 'open_profile');
        assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === profile, cold.nativeTelegramRepair.ref_id), true);
        assert.doesNotMatch(cold.error, /Saved Messages|Settings/);
        assert.match(cold.error, /After opening that profile, call chat_observe again/);
        assert.equal(await page.evaluate(() => __wb_get_native_chat_context(document.querySelector('.input-message-input'))), null);
        const prepared = await probe('#profile');
        assert.equal(prepared.result.nativeTelegramRepair, true);
        assert.equal((await dispatch(prepared)).success, true);
        const fresh = await call('observe_chat', { _nativeChatOwner: owner });
        assert.equal(fresh.success, true, JSON.stringify(fresh));
        assert.equal(fresh.conversationId, 'telegram:k:123456:0');
        assert.equal(await page.locator('.input-message-input').textContent(), 'Owned draft remains');
        assert.deepEqual(await page.evaluate(() => actions), { tools: 0, settings: 0, profile: 1, send: 0 });
      });
      await t.test('ordinary alias repair ignores unrelated visible own Settings', async () => {
        await setup();
        await page.evaluate(() => {
          document.querySelector('.chat .peer-title').setAttribute('data-me-as-notes', '0');
          tools.click();
        });
        const cold = await call('observe_chat', { _nativeChatOwner: owner });
        assert.equal(cold.success, false);
        assert.equal(cold.nativeTelegramRepair?.phase, 'open_profile');
        assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === profile, cold.nativeTelegramRepair.ref_id), true);
        const prepared = await probe('#profile');
        assert.equal((await dispatch(prepared)).success, true);
        assert.equal((await call('observe_chat', { _nativeChatOwner: owner })).success, true);
        assert.deepEqual(await page.evaluate(() => actions), { tools: 1, settings: 0, profile: 1, send: 0 });
      });
      await t.test('ordinary alias repair never substitutes Settings for an unsafe profile control', async () => {
        await setup();
        await page.evaluate(() => {
          document.querySelector('.chat .peer-title').setAttribute('data-me-as-notes', '0');
          profile.setAttribute('data-action', 'send');
        });
        const cold = await call('observe_chat', { _nativeChatOwner: owner });
        assert.equal(cold.success, false);
        assert.equal(cold.reason, 'native_telegram_alias_binding_required');
        assert.equal(cold.nativeTelegramRepair?.ref_id, undefined);
        assert.equal(await page.evaluate(() => __wb_get_native_chat_context(document.querySelector('.input-message-input'))), null);
        assert.deepEqual(await page.evaluate(() => actions), { tools: 0, settings: 0, profile: 0, send: 0 });
      });
      for(const mutation of ['contacts','wrong-icon','wrong-owner-menu','duplicate-menu','duplicate-trigger'])await t.test(`native portal Settings refuses ${mutation}`,async()=>{
        await setup();assert.equal((await dispatch(await probe('#tools'))).success,true);
        await page.evaluate(mutation=>{
          if(mutation==='wrong-icon')settings.querySelector('.tgico').textContent='\uea57';
          if(mutation==='wrong-owner-menu')tools.classList.remove('menu-open');
          if(mutation==='duplicate-menu')document.body.append(document.querySelector('.btn-menu').cloneNode(true));
          if(mutation==='duplicate-trigger')tools.after(tools.cloneNode(true));
        },mutation);
        const prepared=await probe(mutation==='contacts'?'#contacts':'#settings');assert.notEqual(prepared.result.nativeTelegramRepair,true);
        assert.equal((await dispatch(prepared)).noDispatch,true);assert.equal(await page.evaluate(()=>actions.settings),0);
      });
    } finally { await browser.close(); }
  });
}
