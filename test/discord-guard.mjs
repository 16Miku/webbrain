import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { getMessageRecipientGuardPolicy } from '../src/chrome/src/agent/adapters.js';
import { getMessageRecipientGuardPolicy as firefoxPolicy } from '../src/firefox/src/agent/adapters.js';
import { advanceChatSession, createChatSession, markChatSendPending } from '../src/chrome/src/agent/chat-workflow.js';

const url = 'https://discord.com/channels/123/456';
const fixture = `<!doctype html><style>
body {margin:0;font:16px sans-serif} nav {width:270px} button,[role=button],[role=menuitem],a {display:block;padding:8px}
ol {min-height:30px} main {position:fixed;left:320px;top:0;width:550px;height:700px}
#composer {position:fixed;left:330px;bottom:20px;width:420px;min-height:50px}
#send {position:fixed;left:760px;bottom:20px}
[role=dialog] {position:fixed;inset:40px;background:white;z-index:100;padding:20px}
[role=dialog] main {position:static;height:auto} [role=menu] {position:fixed;left:20px;top:250px;background:white;z-index:10}
[hidden] {display:none!important}
</style><nav aria-label="Kanallar">
<header><div id="server" role="button" tabindex="0" aria-label="Test, sunucu işlemleri" aria-expanded="false"><h2>Test</h2></div></header>
<div id="channels"><button id="create" type="button" aria-label="Kanal oluştur">+</button>
<button id="category" type="button" aria-label="Metin kanalları (kategori)" aria-expanded="true">Metin kanalları</button>
<a id="channel" href="/channels/123/456" aria-label="genel (metin kanalı)" aria-current="page">genel</a>
<button id="edit" type="button" aria-label="Kanalı düzenle">Kanalı düzenle</button>
<button id="nav-send" type="button">Send message</button></div></nav>
<section class="panels_fixture" aria-label="User status and settings"><div class="accountPopoutButtonWrapper_fixture"><img id="profile-avatar" src="https://cdn.discordapp.com/avatars/11/self.webp?size=56"></div><div class="nameTag_fixture"><div class="panelTitleContainer_fixture">WebBrain</div><div class="panelSubtext_fixture"><span class="hovered_fixture">webbrain_one</span></div></div><div class="buttons_fixture"><button id="user-settings-trigger" aria-label="Kullanıcı ayarları">⚙</button><button id="mute" role="switch" aria-label="Sessize al">●</button></div></section>
<main aria-label="general (channel)"><h2>general chat</h2><ol role="list" aria-label="Messages in general" data-list-id="chat-messages">
<li><div id="message" role="article" data-list-item-id="chat-messages___chat-messages-456-1001"><div class="contents"><img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1001"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1001" datetime="2026-09-29T01:00:00.000Z"></time></h3><div id="message-content-1001">Hello from the fixture</div></div><div role="group" aria-label="Message Actions"><button id="wave">Wave to say hi!</button><button id="lookalike" aria-expanded="false">Test, server actions</button></div></div></li>
</ol><div id="composer" role="textbox" aria-label="Message #general" contenteditable="true" data-slate-editor="true">Draft</div><button id="send" type="button">Send</button></main>`;
const call = (page, action, params={}) => page.evaluate(({action,params}) => new Promise(resolve => {
  const result = window.__wb_handler({target:'content',action,params},{},resolve);
  if (result !== true && result !== undefined) resolve(result);
}), {action,params});

for (const [kind, engine, AgentClass, policy] of [
  ['chrome',chromium,Agent,getMessageRecipientGuardPolicy],
  ['firefox',firefox,FirefoxAgent,firefoxPolicy],
]) {
  test(`${kind}: Discord management and observation regressions`, async t => {
    assert.deepEqual(policy(url), {adapterName:'discord',verifyActiveRecipient:true});
    assert.deepEqual(policy('https://discord.com/channels/@me/456'), {adapterName:'discord',verifyActiveRecipient:true});
    assert.notEqual(policy('https://discord.com.evil.example/channels/123/456')?.adapterName,'discord');
    const browser = await engine.launch();
    const sources = await Promise.all(['accessibility-tree.js','rich-text-toolbar-heuristic.js','chat-observation.js','content.js']
      .map(file=>readFile(new URL(`../src/${kind}/src/content/${file}`,import.meta.url),'utf8')));
    const setup = async (extra='') => {
      const page=await browser.newPage({viewport:{width:1000,height:800}});
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixture+extra}));
      await page.addInitScript(() => {
        const runtime={onMessage:{addListener:fn=>{window.__wb_handler=fn;}},getURL:path=>path};
        window.chrome={runtime};window.browser={runtime};
        window.fixtureClicks=[];
        document.addEventListener('click',event=>{event.preventDefault();window.fixtureClicks.push(event.target.closest('[id]')?.id);});
      });
      await page.goto(url);
      for (const source of sources) await page.addScriptTag({content:source});
      const agent=new AgentClass({getActive:()=>({supportsVision:false})});
      agent._messageRecipientContentProbe=(_,params)=>call(page,'probe_message_recipient_guard',params);
      const guard=async(tool,args)=>{
        if(tool==='set_field' && args.selector){
          await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
          args={...args,ref_id:await page.locator(args.selector).evaluate(el=>window.__wb_ax_ref(el))};
        }
        return agent._messageRecipientGuardBlock(1,tool,args,page.url());
      };
      const probe=(tool,args)=>call(page,'probe_message_recipient_guard',{tool,args,adapterName:'discord'});
      return {page,guard,probe};
    };
    try {
      await t.test('server menu works by selector, text, AX ref, index and coordinates with or without a composer',async()=>{
        const {page,guard,probe}=await setup();
        try {
          for (const withComposer of [true,false]) {
            if(!withComposer) await page.locator('#composer').evaluate(el=>el.remove());
            await call(page,'get_accessibility_tree',{filter:'all',maxChars:30000});
            const ref=await page.locator('#server').evaluate(el=>window.__wb_ax_ref(el));
            const items=await call(page,'get_interactive_elements');
            const index=items.findIndex(el=>el.id==='server');
            assert.ok(index>=0);
            const rect=await page.locator('#server').boundingBox();
            for (const [tool,args] of [['click',{selector:'#server'}],['click',{text:'Test'}],
              ['click_ax',{ref_id:ref}],['click',{index}],['click',{x:rect.x+rect.width/2,y:rect.y+rect.height/2}]]) {
              const classified=await probe(tool,args);
              assert.equal(classified.nonMessagingTarget,true,JSON.stringify({tool,args,classified}));
              assert.equal(await guard(tool,args),null);
              const result=await call(page,tool,args);
              assert.equal(result.success,true,JSON.stringify(result));
            }
          }
          assert.equal((await page.evaluate(()=>window.fixtureClicks)).filter(id=>id==='server').length,10);
          for(const selector of ['#create','#category','#channel','#edit']) assert.equal(await guard('click',{selector}),null);
        } finally {await page.close();}
      });
      await t.test('only the known server menu entries bypass message classification',async()=>{
        const {page,guard,probe}=await setup(`<div role="menu" id="guild-header-popout">
<div role="menuitem" id="guild-header-popout-settings">Server Settings</div>
<div role="menuitem" id="guild-header-popout-create-channel">Create Channel</div>
<div role="menuitem" id="guild-header-popout-create-category">Create Category</div>
<div role="menuitem" id="unknown">Forward</div></div>`);
        try {
          for(const id of ['settings','create-channel','create-category']) assert.equal(await guard('click',{selector:`#guild-header-popout-${id}`}),null);
          assert.equal((await guard('click',{selector:'#unknown'}))?.noDispatch,true);
          await page.locator('#guild-header-popout-settings').evaluate(el=>el.textContent='Paramètres du serveur');
          await page.locator('#guild-header-popout-create-channel').evaluate(el=>el.textContent='Kanal erstellen');
          await page.locator('#guild-header-popout-create-category').evaluate(el=>el.textContent='Kategori oluştur');
          for(const id of ['settings','create-channel','create-category']) {
            const selector=`#guild-header-popout-${id}`;
            assert.equal((await probe('click',{selector})).nonMessagingTarget,true,`${id} accepts translated labels by structural ID`);
            assert.equal(await guard('click',{selector}),null);
          }
          await page.locator('#guild-header-popout-settings').evaluate(el=>el.textContent='Send invitation');
          assert.notEqual((await probe('click',{selector:'#guild-header-popout-settings'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('creation dialogs allow field submission and Enter while the channel composer is still mounted',async()=>{
        for(const [id,label,radios] of [
          ['channel-create','Kanal erstellen','<div role="radiogroup"><input type="radio" checked><input type="radio"><input type="radio"></div>'],
          ['category-create','Kategori oluştur',''],
        ]) {
          const {page,guard,probe}=await setup(`<div id="${id}" data-dialog="modal" role="dialog" aria-modal="true" aria-label="${label}"><div role="log"></div><div role="log"></div>
<header><h1 id="heading-${id}">${label}</h1><button type="button" aria-label="Close">×</button></header>${radios}
<input id="name" type="text" placeholder="${label}" value="test"><input id="private" type="checkbox" role="switch">
<button id="save" type="submit">${label}</button><button id="cancel" type="button">Esc</button></div>`);
          try {
            assert.equal((await probe('click',{selector:'#save'})).nonMessagingTarget,true,'localized creation title is recognized structurally');
            assert.equal(await guard('click',{selector:'#save'}),null);
            assert.equal(await guard('click',{selector:'#cancel'}),null);
            assert.equal(await guard('set_field',{selector:'#name',value:'test',submit:true}),null);
            await page.locator('#name').focus();
            assert.equal(await guard('press_keys',{key:'Enter'}),null);
            assert.equal((await guard('click',{selector:'#server'}))?.noDispatch,true,'background menu stays blocked');
          } finally {await page.close();}
        }
      });
      await t.test('server settings are recognized by their stable layer and tab structure',async()=>{
        const {page,guard}=await setup(`<div role="dialog" data-layer="GUILD_SETTINGS" aria-label="Sunucu ayarları" aria-modal="true"><nav><div role="tablist"><div role="tab" id="roles">Rolleri yönet</div><div role="tab">Güvenlik kurulumu</div></div></nav><main><textarea id="description">Server description</textarea><button id="save">Değişiklikleri kaydet</button></main><button id="test-send">Send test message</button></div>`);
        try {
          for(const selector of ['#roles','#description','#save']) assert.equal(await guard('click',{selector}),null);
          assert.equal(await guard('set_field',{selector:'#description',value:'new',submit:true}),null);
          assert.equal((await guard('click',{selector:'#test-send'}))?.noDispatch,true);
        } finally {await page.close();}
      });
      await t.test('localized channel settings allow the Slate topic editor but not a message composer',async()=>{
        const {page,guard,probe}=await setup(`<div role="dialog" data-layer="CHANNEL_SETTINGS" aria-modal="true" aria-label="Kanal ayarları">
<nav><div role="tablist"><div role="tab">Genel</div><div id="permissions" role="tab">İzinler</div></div></nav>
<div role="tabpanel"><input type="text" aria-label="Channel Name"><div id="topic" role="textbox" contenteditable="true" data-slate-editor="true" aria-label="Let everyone know how to use this channel!">Send bug reports here</div><button id="save">Save Changes</button><input id="input-send" type="submit" value="Send"></div></div>`);
        try {
          for(const selector of ['#permissions','#topic','#save']) assert.equal(await guard('click',{selector}),null);
          assert.equal(await guard('set_field',{selector:'#topic',value:'new topic',submit:true}),null);
          await page.locator('#topic').focus();
          assert.equal(await guard('press_keys',{key:'Enter'}),null);
          assert.notEqual((await probe('click',{selector:'#input-send'})).nonMessagingTarget,true);
          await page.locator('#topic').evaluate(el=>el.setAttribute('aria-label','Message #general'));
          assert.notEqual((await probe('click',{selector:'#save'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('account settings gear and user settings surface use structural markers',async()=>{
        const {page,guard,probe}=await setup();
        try {
          assert.notEqual((await probe('click',{selector:'#mute'})).nonMessagingTarget,true,'account audio switch is not a settings action');
          assert.equal((await guard('click',{selector:'#mute'}))?.noDispatch,true);
          assert.equal((await probe('click',{selector:'#user-settings-trigger'})).nonMessagingTarget,true,'localized account gear is recognized by its account-panel structure');
          assert.equal(await guard('click',{selector:'#user-settings-trigger'}),null);
          await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend',`<div id="user-settings-modal" role="dialog" aria-modal="true" aria-labelledby="heading-user-settings-modal"><h1 id="heading-user-settings-modal">Hesap</h1><nav aria-label="Einstellungen"><ul><li data-settings-sidebar-item="account_panel"><div role="link">Hesap</div></li><li data-settings-sidebar-item="appearance_panel"><div role="link">Görünüm</div></li></ul></nav><main><button id="theme-control">Temayı değiştir</button></main></div>`));
          assert.equal((await probe('click',{selector:'#theme-control'})).nonMessagingTarget,true,'user settings sidebar identifies the dialog without English labels');
          assert.equal(await guard('click',{selector:'#theme-control'}),null);
        } finally {await page.close();}
      });
      await t.test('sends, message actions, lookalikes and foreign origins remain protected',async()=>{
        const {page,guard,probe}=await setup();
        try {
          for(const selector of ['#send','#nav-send','#wave','#lookalike']) {
            assert.notEqual((await probe('click',{selector})).nonMessagingTarget,true);
            assert.equal((await guard('click',{selector}))?.noDispatch,true);
          }
          await page.locator('#composer').focus();
          assert.equal((await guard('press_keys',{key:'Enter'}))?.noDispatch,true);
          assert.equal((await guard('set_field',{selector:'#composer',value:'Draft',submit:true}))?.noDispatch,true);
          await page.locator('#server').evaluate(el=>el.setAttribute('aria-disabled','true'));
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true);
          await page.locator('#server').evaluate(el=>{
            el.removeAttribute('aria-disabled');
            const overlay=document.createElement('div');overlay.id='overlay';
            overlay.style='position:fixed;inset:0;background:white;z-index:999';document.body.append(overlay);
          });
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true,'covered controls fail closed');
          await page.goto('https://discord.com.evil.example/channels/123/456');
          for(const source of sources) await page.addScriptTag({content:source});
          assert.notEqual((await probe('click',{selector:'#server'})).nonMessagingTarget,true,'origin is checked even with an adapter hint');
          await page.locator('#composer').focus();
          const result=await page.evaluate(()=>window.__wb_observe_chat_dom({}));
          assert.equal(result.success,false);
        } finally {await page.close();}
      });
      await t.test('unknown dialogs and chat editors inside settings never gain management classification',async()=>{
        const {page,probe}=await setup(`<div role="dialog" aria-modal="true" aria-label="Forward"><h1>Forward</h1><input type="text"><button id="forward">Create Channel</button></div>`);
        try {
          assert.notEqual((await probe('click',{selector:'#forward'})).nonMessagingTarget,true);
          await page.locator('[role=dialog]').evaluate(el=>{
            el.setAttribute('aria-label','Create Channel');el.querySelector('h1').textContent='Create Channel';
            const editor=document.createElement('div');editor.setAttribute('data-slate-editor','true');el.append(editor);
          });
          assert.notEqual((await probe('click',{selector:'#forward'})).nonMessagingTarget,true);
        } finally {await page.close();}
      });
      await t.test('channel observation recognizes the transcript, empty channels and stable server/channel identity',async()=>{
        const {page}=await setup();
        try {
          await page.locator('#composer').focus();
          const observe=()=>page.evaluate(()=>window.__wb_observe_chat_dom({}));
          const result=await observe();
          assert.equal(result.success,true,JSON.stringify(result));
          assert.equal(result.conversationId,'discord:123:456');
          assert.equal(result.threadKey,'dom:discord:123:456');
          assert.equal(result.conversationIdentity,'#general');
          assert.deepEqual(result.messages,[{
            id:'discord:456:1001', direction:'incoming', text:'Hello from the fixture',
            author:'Ficsit', timestamp:'2026-09-29T01:00:00.000Z',
          }]);
          await page.locator('#composer').evaluate(el=>el.setAttribute('aria-label','Nachricht #general'));
          await page.locator('main').evaluate(el=>el.setAttribute('aria-label','general (Kanal)'));
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.setAttribute('aria-label','Nachrichten in general'));
          await page.locator('#channel').evaluate(el=>el.setAttribute('aria-label','general (Textkanal)'));
          await page.locator('section').evaluate(el=>el.setAttribute('aria-label','Benutzerstatus und Einstellungen'));
          const localized=await observe();
          assert.equal(localized.success,true,JSON.stringify(localized));
          assert.equal(localized.conversationId,result.conversationId);
          assert.equal(localized.threadKey,result.threadKey);
          assert.deepEqual(localized.messages,result.messages);

          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/22/avatars/other.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'incoming','guild-profile avatars retain the member identity');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/guilds/123/users/11/avatars/self.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'outgoing','guild-profile avatar identity detects the signed-in user');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/22/other.webp?size=160'));

          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          const defaultAvatars=await observe();
          assert.equal(defaultAvatars.messages[0].direction,'unknown','shared Discord default avatars do not identify message authors');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/embed/avatars/4.png'));
          assert.equal((await observe()).messages[0].direction,'incoming','different default avatar indices cannot be the same account');
          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/11/self.webp?size=56'));
          assert.equal((await observe()).messages[0].direction,'incoming','a default avatar cannot belong to the custom-avatar account');
          await page.locator('#profile-avatar').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','https://cdn.discordapp.com/avatars/22/other.webp?size=160'));
          assert.equal((await observe()).messages[0].direction,'incoming','a custom avatar cannot belong to the default-avatar account');
          await page.locator('#message .contents img').evaluate(el=>el.setAttribute('src','/assets/embed/avatars/3.png'));
          let advanced=advanceChatSession(createChatSession({threadKey:result.threadKey}),defaultAvatars);
          await page.locator('#wave').evaluate(el=>el.textContent='Changed hover action');
          const afterHover=await observe();
          assert.deepEqual(afterHover.messages.map(item=>item.text),result.messages.map(item=>item.text),'message actions do not alter observed content');
          assert.equal(afterHover.messages[0].direction,'unknown','default-avatar direction stays unresolved after hover');
          advanced=advanceChatSession(advanced.session,afterHover);
          assert.deepEqual(advanced.newMessages,[],'hover does not create a new message');

          const attemptedAt=new Date(Date.now()-1000).toISOString();
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1002"><div class="contents">
              <img src="/assets/embed/avatars/3.png"><h3><span id="message-username-1002"><span data-text="WebBrain">WebBrain</span></span><time id="message-timestamp-1002" datetime="${new Date().toISOString()}"></time></h3>
              <div id="message-content-1002">My answer</div></div></div></li>
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-999-1003"><div id="message-content-1003">Wrong channel</div></div></li>
            <li><div role="article" class="isSystemMessage_fixture" data-list-item-id="chat-messages___chat-messages-456-1004"><div id="message-content-1004">A member joined</div></div></li>`));
          const afterDraft=await observe();
          const pending=markChatSendPending(advanced.session,{
            ok:true,messageKey:'test-pending',threadKey:result.threadKey,text:'My answer',attemptedAt,
          },Date.parse(attemptedAt));
          const dispatchedPending={...pending,pendingOutbound:{...pending.pendingOutbound,dispatchedAt:attemptedAt}};
          const blockedByDraft=advanceChatSession(dispatchedPending,afterDraft);
          assert.equal(blockedByDraft.pendingDeliveryVerified,false,'an uncleared composer draft is not delivery evidence');
          assert.ok(blockedByDraft.session.pendingOutbound,'uncertain sends stay pending when the composer is not empty');
          await page.locator('#composer').evaluate(el=>el.textContent='');
          const afterSend=await observe();
          assert.deepEqual(afterSend.messages.map(item=>item.id),['discord:456:1001','discord:456:1002']);
          assert.equal(afterSend.messages[1].direction,'unknown','nickname equality never asserts message authorship');
          const withoutDispatchEvidence=advanceChatSession(pending,afterSend,Date.parse(afterSend.observedAt));
          assert.equal(withoutDispatchEvidence.pendingDeliveryVerified,false,'an ordinary observation cannot infer Discord message authorship');
          advanced=advanceChatSession(dispatchedPending,afterSend,Date.parse(afterSend.observedAt));
          assert.equal(advanced.newMessages[0].direction,'unknown','transaction evidence does not overwrite the message author direction');
          assert.equal(advanced.session.state,'we_responded');
          assert.equal(advanced.session.pendingOutbound,null,'self-authored default-avatar message clears pending send');
          assert.equal(advanced.pendingDeliveryVerified,true,'the unique fresh exact-text bubble and empty composer verify this pending send');

          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1005">
              <div id="message-reply-context-1005"><div id="message-content-1002">My answer</div></div>
              <div class="contents"><img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1005"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1005" datetime="2026-09-29T01:02:00.000Z"></time></h3>
              <div id="message-content-1005">A new reply <span role="button"><img class="emoji" alt="🚀" src="/emoji.svg"></span></div></div><div role="group">Reply Forward Add Reaction</div></div></li>`));
          const afterReply=await observe();
          assert.equal(afterReply.messages[2].text,'A new reply 🚀');
          assert.equal(afterReply.messages[2].direction,'incoming');
          advanced=advanceChatSession(advanced.session,afterReply);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1005']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1006"><div class="contents">
              <img src="https://cdn.discordapp.com/avatars/22/other.webp?size=160"><h3><span id="message-username-1006"><span data-text="Ficsit">Ficsit</span></span><time id="message-timestamp-1006" datetime="2026-09-29T01:03:00.000Z"></time></h3>
              <div id="message-content-1006"></div></div><div id="message-accessories-1006"><div class="attachment_fixture"><img width="64" height="64" alt="support-error.png" src="/assets/support-error.png"></div>
              <div role="img" aria-label="Sticker, Wave" style="display:block;width:24px;height:24px"></div><div class="embedTitle_fixture">Build error report</div><div class="embedDescription_fixture">Setup fails on startup</div></div></div></li>`));
          const afterAttachment=await observe();
          assert.equal(afterAttachment.messages[3].direction,'incoming');
          assert.equal(afterAttachment.messages[3].text,
            'Attachment: support-error.png\nAttachment: Sticker, Wave\nAttachment: Build error report\nAttachment: Setup fails on startup');
          advanced=advanceChatSession(advanced.session,afterAttachment);
          assert.deepEqual(advanced.newMessages.map(item=>item.id),['discord:456:1006']);
          assert.equal(advanced.nextAction,'reply');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.insertAdjacentHTML('beforeend',`
            <li><div role="article" data-list-item-id="chat-messages___chat-messages-456-1007"><div class="contents">
              <img src="/assets/embed/avatars/3.png"><h3><span id="message-username-1007"><span data-text="WebBrain">WebBrain</span></span><time id="message-timestamp-1007" datetime="${new Date().toISOString()}"></time></h3>
              <div id="message-content-1007">A member with the same display name</div></div></div></li>`));
          const collidingNickname=await observe();
          assert.equal(collidingNickname.messages.at(-1).direction,'unknown','a member sharing the account display name is not called outgoing');
          await page.locator('[data-list-id=chat-messages]').evaluate(el=>el.replaceChildren());
          assert.equal((await observe()).success,true);
          await page.locator('#channel').evaluate(el=>el.setAttribute('href','/channels/123/999'));
          assert.equal((await observe()).success,false,'stale channel identity fails closed');
        } finally {await page.close();}
      });
    } finally {await browser.close();}
  });
}
