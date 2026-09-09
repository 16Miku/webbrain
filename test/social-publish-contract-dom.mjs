// Isolated DOM fixtures. Every request is fulfilled locally; no live account
// is opened and no publication is sent. Run with npm run test:social-contract:dom.
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import fs from 'node:fs';
import vm from 'node:vm';
const browser = await chromium.launch({headless:true});
let checked=0;
try {
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  const page=await context.newPage();
  for(const build of ['chrome','firefox']){
    const {Agent}=await import(`../src/${build}/src/agent/agent.js`);
    const invariant=await import(`../src/${build}/src/agent/completion-invariant.js`);
    const source=fs.readFileSync(`src/${build}/src/agent/agent.js`,'utf8');
    const marker=source.indexOf('const publicationRecordRoot = ${publicationResourceRecordRoot.toString()};');
    const raw=source.slice(source.lastIndexOf('`',marker)+1,source.indexOf('`',marker+1));
    const completionProbe=vm.runInNewContext('`'+raw+'`',invariant);
    const readPublished=()=>page.evaluate(code=>Function('return ('+code+')')(),completionProbe);

    const probe=async(selector='#publish')=>page.evaluate(({source,selector})=>{
      const fn=Function('return ('+source+')')();
      return fn('click',{selector});
    },{source:Agent._submitActionProbe.toString(),selector});
    for(const platform of ['twitter','bluesky']){
      await page.goto(platform==='twitter'?'https://x.com/home':'https://bsky.app/');
      // Run the real probe wrapper and dispatch gate against ordinary forms
      // on social domains, including an unrelated composer on the same page.
      const publishId=platform==='twitter'?'tweetButtonInline':'composerPublishBtn';
      const providerScope={chat:async()=>({content:'{}'})};
      const scopeAgent=new Agent({getActive:()=>providerScope}),scopeTab=909;
      scopeAgent.useSiteAdapters=true;scopeAgent._persist=()=>{};scopeAgent._currentUrl=async()=>page.url();
      scopeAgent.conversations.set(scopeTab,[{role:'system',content:'system'},{role:'user',content:'Save my profile settings. Do not publish anything.'}]);
      const scopeGuard=scopeAgent._startPlanExecutionGuard(scopeTab,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
      let scopeCalls=0;
      scopeAgent._chatWithCostAllowance=async()=>{scopeCalls++;return {content:JSON.stringify({version:1,status:'none',actions:[],requirements:null,prohibited:[],reason:'Settings only.'})};};
      const previousChrome=globalThis.chrome;
      globalThis.chrome={scripting:{executeScript:async({func,args})=>[{result:await page.evaluate(({source,args})=>Function('return ('+source+')')()(...args),{source:func.toString(),args})}]}};
      try {
        await scopeAgent._ensureProgressSessionForCurrentTask(scopeTab,{provider:providerScope,taskText:'Save profile settings',progressLedgerPolicy:'disabled'});
        assert.equal(await scopeAgent._adoptLiveSocialPublishWorkflow(scopeTab,providerScope),false);
        for(const external of [false,true]){
          const save=`<button id="save" ${external?'form="settings"':''}><span>Kaydet</span></button>`;
          await page.setContent(`<main><form id="settings"><input id="name" value="Alice"><textarea id="bio">My profile</textarea>${external?'':save}</form>${external?save:''}<div id="other-composer"><div contenteditable="true" role="textbox">Unrelated draft</div><button data-testid="${publishId}">Post</button></div></main>`);
          for(const [name,args] of [['click',{selector:'#save span'}],['press_keys',{key:'Enter'}]]){
            await page.locator('#name').focus();
            const ordinary=await scopeAgent._detectLikelySubmitAction(scopeTab,name,args);
            assert.equal(ordinary.isSubmit,true);
            assert.equal(ordinary.publicationControl,false,'own form is distinct from the nearby composer');
            assert.equal(ordinary.publicationSnapshot,null);
            assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,name,args,ordinary,providerScope),null);
            assert.equal(scopeCalls,0);checked++;
          }
        }
        // Exercise the actual batch caller with the actual injected detector.
        // Only the final tool execution is simulated; the caller must collect
        // composer ownership before either publication guard sees set_field.
        scopeAgent._skipPermissionGate=true;scopeAgent._ensureGateSetting=async()=>true;
        scopeAgent._recordProgressObservation=async()=>null;scopeAgent._autoRecordProgressAction=()=>null;
        scopeAgent._progressWarningForAction=()=>'';scopeAgent._captureFormValidationState=async()=>[];
        scopeAgent._waitForFormValidationFailure=async()=>null;
        for(const kind of ['search','composer','missing']){
          for(const submit of [true,false]){
            scopeAgent._clearLoopState(scopeTab); // Each fixture is a separate attempted action.
            await page.setContent(kind==='search'
              ? '<form><input id="field" type="search" name="q"><button>Search</button></form>'
              : kind==='composer'
                ? `<form><textarea id="field">Draft</textarea><button data-testid="${publishId}">Post</button></form>`
                : '<main>No resolved field</main>');
            await page.evaluate(()=>{window.__wb_ax_lookup=ref=>document.getElementById(ref);});
            let executions=0;
            scopeAgent.executeTool=async()=>{executions++;return {success:true,dispatched:true};};
            const messages=[];
            await scopeAgent._executeToolBatch(scopeTab,[{id:'set_field_case',function:{name:'set_field',arguments:JSON.stringify({ref_id:'field',text:'Hello',submit})}}],messages,()=>{},providerScope,'',new Set(['set_field']),1);
            const result=JSON.parse(scopeAgent._unwrapUntrusted(messages.find(m=>m.tool_call_id==='set_field_case').content));
            const reachesDispatch=!submit || kind==='search';
            assert.equal(executions,reachesDispatch?1:0,kind+' submit='+submit+' batch dispatch');
            assert.equal(result.success,reachesDispatch,kind+' submit='+submit+' batch result');
            if(!reachesDispatch) assert.equal(result.noDispatch,true);
            assert.equal(scopeCalls,0,'no publication model call for ordinary forms or bundled submission rejection');
            checked++;
          }
        }
        // A localized composer, an unnamed Post button, and an incomplete
        // composer all stay guarded. Implicit Enter must not become a bypass.
        for(const kind of ['localized','unnamed','incomplete']){
          await page.setContent(`<form id="composer">${kind==='incomplete'?'':'<textarea id="body">Hello</textarea>'}<button id="publish" ${kind==='unnamed'?'':`data-testid="${publishId}"`}>${kind==='unnamed'?'Post':'Yayınla'}</button></form>`);
          const detected=await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#publish'});
          assert.equal(detected.publicationControl,true,kind);
          assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#publish'},detected,providerScope)).noDispatch);
          if(kind!=='incomplete'){
            await page.locator('#body').focus();
            const implicit=await scopeAgent._detectLikelySubmitAction(scopeTab,'press_keys',{key:'Enter'});
            assert.equal(implicit.publicationControl,true,kind+' implicit submission');
            assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'press_keys',{key:'Enter'},implicit,providerScope)).noDispatch);
          }
          checked++;
        }
        assert.equal(scopeCalls,1,'one cached none contract, no authorization call');
        assert.equal(scopeGuard.siteWorkflow,null);
        // Cached none intent still permits a subsequent ordinary settings save.
        await page.setContent('<form><textarea>Bio</textarea><button id="save">Save</button></form>');
        const ordinary=await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#save'});
        assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#save'},ordinary,providerScope),null);
        assert.equal(scopeCalls,1);checked++;
        const opaque=await scopeAgent._detectLikelySubmitAction(scopeTab,'execute_js',{code:'publish()'});
        assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'execute_js',{code:'publish()'},opaque,providerScope)).noDispatch);checked++;
      } finally {if(previousChrome===undefined) delete globalThis.chrome;else globalThis.chrome=previousChrome;}
      const body='Beginning ① Ａ 👨‍👩‍👧\n\n'+ 'long exact body '.repeat(650)+'END';
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><main><div id="composer"><div contenteditable="true" role="textbox" id="body" style="white-space:pre-wrap"></div><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div></main>`);
      await page.locator('#body').fill(body);
      const result=await probe();
      assert.equal(result?.isSubmit,true,`${build}/${platform}: submit target`);
      assert.equal(result.publicationResourceUrlsComplete,true);
      assert.deepEqual(result.publicationResourceUrls,[]);
      assert.equal(result.publicationSnapshot?.complete,true,`${build}/${platform}: complete composer`);
      assert.equal(result.publicationSnapshot.posts[0].bodyText,body);
      assert.deepEqual(result.publicationSnapshot.posts[0].attachments,[]);
      assert.equal(result.publicationSnapshot.posts[0].context.kind,'post');
      checked++;
      // A link preview is not an uploaded attachment. Avatar/emoji images also
      // cannot satisfy the user's requested media count.
      await page.locator('#composer').evaluate(el=>{
        const box=document.createElement('div');box.setAttribute('data-testid','linkPreview');
        box.innerHTML='<img src="data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>" width="40" height="40">';
        el.append(box);
        const image=document.createElement('img');image.src='https://cdn.example/chart.png';image.width=80;image.height=60;image.alt='①';el.append(image);
      });
      const withMedia=await probe();
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments.length,1);
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments[0].alt,'①');
      checked++;
      // A missing parent in a reply composer is incomplete relationship
      // evidence; it must never be represented as permission for a new post.
      await page.locator('#composer').evaluate(el=>{const hint=document.createElement('span');hint.dataset.testid='replyingTo';hint.textContent='Replying to someone';el.append(hint);});
      const reply=await probe();
      assert.equal(reply.publicationSnapshot.complete,false);
      checked++;
      // Standard inline replies expose replyingTo, but no descendant status
      // link. Their parent comes from the active permalink route.
      const parent=platform==='twitter'?'https://x.com/bob/status/1111111111111111111':'https://bsky.app/profile/bob.bsky.social/post/3parent';
      const otherParent=platform==='twitter'?'https://x.com/carol/status/3333333333333333333':'https://bsky.app/profile/carol.bsky.social/post/3other';
      await page.evaluate(parent=>history.replaceState({},'',parent+'?source=fixture#reply'),parent);
      const inlineReply=await probe();
      assert.equal(inlineReply.publicationSnapshot.complete,true,'active thread identifies an inline reply parent');
      assert.deepEqual(inlineReply.publicationSnapshot.posts[0].context,{kind:'reply',target:parent});checked++;
      // A modal can target a different reply in the same thread. Its explicit
      // context wins; the background route must not fill missing modal proof.
      await page.locator('#composer').evaluate(el=>el.setAttribute('role','dialog'));
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.locator('#composer').evaluate((el,parent)=>{
        const card=document.createElement('article');card.dataset.testid='replyToPost';card.id='reply-parent';
        const link=document.createElement('a');link.href=parent;link.textContent='Parent';card.append(link);el.append(card);
      },otherParent);
      const modalReply=await probe();
      assert.equal(modalReply.publicationSnapshot.complete,true);
      assert.equal(modalReply.publicationSnapshot.posts[0].context.target,otherParent);checked++;
      // A second possible parent stays ambiguous even on a known thread route.
      await page.locator('#reply-parent').evaluate((el,parent)=>{const a=document.createElement('a');a.href=parent;a.textContent='Other parent';el.append(a);},parent);
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.locator('#reply-parent').evaluate(el=>el.remove());
      await page.locator('#composer').evaluate(el=>el.removeAttribute('role'));
      await page.evaluate(()=>history.replaceState({},'','/home?next=/bob/status/1111111111111111111'));
      // An authored body link cannot supply missing reply relationship proof.
      await page.locator('#body').evaluate((el,parent)=>{const a=document.createElement('a');a.href=parent;a.textContent='link';el.append(a);},parent);
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.evaluate(parent=>history.replaceState({},'',parent),parent);
      await page.locator('[data-testid="replyingTo"]').evaluate(el=>el.remove());
      const ordinary=await probe();
      assert.deepEqual(ordinary.publicationSnapshot.posts[0].context,{kind:'post',target:null});checked++;

      // Each attachment must have exactly one observed owner in a thread.
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><div id="composer"><section id="first"><div contenteditable="true" role="textbox">First</div><img src="https://cdn.example/one.png" width="40" height="40"></section><section><div contenteditable="true" role="textbox">Second</div><img src="https://cdn.example/two.png" width="40" height="40"></section><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div>`);
      const thread=await probe();
      assert.equal(thread.publicationSnapshot.complete,true);
      assert.deepEqual(thread.publicationSnapshot.posts.map(p=>p.attachments.length),[1,1]);checked++;
      await page.locator('#composer').evaluate(el=>el.append(el.querySelector('img').cloneNode()));
      const unowned=await probe();
      assert.equal(unowned.publicationSnapshot.complete,false,'unassigned thread media cannot disappear');checked++;

      // Exercise the actual injected completion probe, including its bounds.
      const permalink=platform==='twitter'?'https://x.com/alice/status/2222222222222222222':'https://bsky.app/profile/alice.bsky.social/post/3abc';
      const card=platform==='twitter'?'tweet':'feedItem-by-alice';
      const bodyId=platform==='twitter'?'tweetText':'postText';
      await page.setContent(`<article data-testid="${card}" id="published"><a href="${permalink}">timestamp</a><div data-testid="${bodyId}">Hello</div>${Array.from({length:13},(_,i)=>`<img src="https://cdn.example/${i}.png" alt="image" width="20" height="20">`).join('')}</article>`);
      let published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachments.length,13,'attachments beyond twelve must not disappear');
      assert.equal(published.attachmentsComplete,true);checked++;
      await page.locator('#published').evaluate(el=>{for(let i=0;i<8;i++)el.append(el.querySelector('img').cloneNode());});
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'overflow cannot prove an exact media count');checked++;
      await page.locator('#published').evaluate(el=>{
        [...el.querySelectorAll('img')].slice(1).forEach(node=>node.remove());
        el.querySelector('img').alt='a'.repeat(25001);
      });
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'truncated alt text cannot prove exactness');checked++;
      await page.locator('#published').evaluate((el,bodyId)=>{
        el.querySelector('img').alt='image';
        for(let i=0;i<8;i++)el.append(el.querySelector(`[data-testid="${bodyId}"]`).cloneNode(true));
      },bodyId);
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.bodyTextComplete,false,'overflow cannot prove a complete body');checked++;
      // Link thumbnails have no dedicated container on Bluesky. Check the
      // same media in the real composer and published-resource probes, then
      // drive no-attachment authorization and completion for the preview case.
      const previewImg='<img src="https://cdn.example/thumb.png" alt="Preview" width="40" height="40">';
      const uploadImg='<img src="https://cdn.example/upload.png" alt="Upload" width="40" height="40">';
      const outbound=`<a href="https://news.example/article">${previewImg}<span>Article</span></a>`;
      const uploadId=platform==='twitter'?'tweetPhoto':'postImage-0';
      for(const [kind,media,expectedCount] of [
        ['unmarked outbound preview',outbound,0],
        ['preview plus upload',outbound+uploadImg,1],
        ['uploaded wrapper inside outbound anchor',`<a href="https://news.example/article"><div data-testid="${uploadId}">${uploadImg}</div></a>`,1],
        ['onsite media link',`<a href="/photo/1">${uploadImg}</a>`,1],
        ['named card layout',`<div data-testid="card.layoutLarge.media">${previewImg}</div>`,0],
        ['plain external CDN image',uploadImg,1],
      ]){
        await page.evaluate(()=>history.replaceState({},'','/home'));
        const text='Hello https://news.example/article';
        await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><div id="composer"><div role="textbox" contenteditable="true">${text}</div>${media}<button id="publish" data-testid="${publishId}">Post</button></div>`);
        const detected=await probe();
        assert.equal(detected.publicationSnapshot.complete,true,kind);
        assert.equal(detected.publicationSnapshot.posts[0].attachments.length,expectedCount,kind+' composer count');
        const provider={chat:async()=>({content:'{}'})},previewAgent=new Agent({getActive:()=>provider}),previewTab=911;
        previewAgent.useSiteAdapters=true;previewAgent._persist=()=>{};previewAgent._currentUrl=async()=>page.url();
        previewAgent.conversations.set(previewTab,[{role:'system',content:'system'},{role:'user',content:`Post exactly ${text} on ${platform==='twitter'?'X':'Bluesky'} without attachments.`}]);
        previewAgent._startPlanExecutionGuard(previewTab,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
        const raw={version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:{source:'request',start:text,end:text}},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'post',target:null}}]}],requirements:'p1',prohibited:[],reason:'No attachments requested.'};
        let audits=0;
        previewAgent._chatWithCostAllowance=async(_p,messages,_o,_c,meta)=>{
          const input=JSON.parse(messages[1].content);
          if(meta.generationName==='social_publication_authorization') audits++;
          return {content:JSON.stringify(meta.generationName==='social_publication_authorization'?{key:input.key,actionId:input.action.id,authorized:true,reason:'Fixture audit.'}:raw)};
        };
        previewAgent._detectLikelySubmitAction=async()=>probe();
        const block=await previewAgent._workflowPreSubmitDispatchBlock(previewTab,'click',{selector:'#publish'},detected,provider);
        assert.equal(block===null,expectedCount===0,kind+' zero-upload contract');
        assert.equal(audits,expectedCount===0?1:0,kind+' only matching media reaches audit');
        if(expectedCount===0){
          previewAgent._beginCompletionInvariant(previewTab);
          previewAgent._recordCompletionToolResult(previewTab,'click',{selector:'#publish'},{success:true,dispatched:true});
          previewAgent._recordCompletionSubmitAttempt(previewTab,detected,'click',{selector:'#publish'},page.url(),page.url(),{success:true,dispatched:true});
        }
        await page.setContent(`<article data-testid="${card}"><a href="${permalink}">timestamp</a><div data-testid="${bodyId}">${text}</div>${media}</article>`);
        const state=await readPublished(),record=state.workflowResourceRecords.find(r=>r.url===permalink);
        assert.equal(record.attachmentsComplete,true,kind);
        assert.equal(record.attachments.length,expectedCount,kind+' published count');
        if(expectedCount===0){
          previewAgent._recordCompletionToolResult(previewTab,'read_page',{}, {success:true,url:page.url(),content:'Observed published post.'});
          assert(previewAgent._workflowTerminalEvidenceFromDone(previewTab,state,page.url(),previewAgent._completionSubmissionEvidence(previewTab,state,page.url())),kind+' completes with no uploaded attachment');
        }
        checked++;
      }
      // Drive composer observation, simulated dispatch, actual completion DOM
      // extraction, and terminal verification. No replyToUrl is hand-written.
      const profile=name=>platform==='twitter'?`https://x.com/${name}`:`https://bsky.app/profile/${name}.bsky.social`;
      const item=(id,who,href,text,hint='')=>`<div data-testid="cellInnerDiv" id="${id}-cell"><article data-testid="${card}" id="${id}"><div data-testid="User-Name"><a href="${profile(who)}">${who}</a><a href="${href}"><time>Today</time></a></div>${hint}<div data-testid="${bodyId}">${text}</div></article></div>`;
      const parentItem=item('parent-post','bob',parent,'Parent body');
      const hint=`<div data-testid="replyingTo" id="reply-hint">Replying to <a href="${profile('bob')}">@bob</a></div>`;
      const replyItem=item('reply-post','alice',permalink,'Hello',hint);
      const threadHtml=items=>`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link"':''} href="${platform==='twitter'?'/alice':'/profile/alice.bsky.social'}">Profile</a></nav><main><div data-testid="primaryColumn"><div id="thread">${items}</div></div></main>`;
      await page.evaluate(parent=>history.replaceState({},'',parent),parent);
      await page.setContent(threadHtml(parentItem+`<div id="composer"><div data-testid="replyingTo">Replying to <a href="${profile('bob')}">@bob</a></div><div contenteditable="true" role="textbox">Hello</div><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Reply</button></div>`));
      const provider={chat:async()=>({content:'{}'})},agent=new Agent({getActive:()=>provider}),tabId=910;
      const request=`Reply exactly Hello to ${parent} on ${platform==='twitter'?'X':'Bluesky'} without attachments.`;
      agent.useSiteAdapters=true;agent._persist=()=>{};agent._currentUrl=async()=>page.url();
      agent.conversations.set(tabId,[{role:'system',content:'system'},{role:'user',content:request}]);
      agent._startPlanExecutionGuard(tabId,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
      const reference=text=>({source:'request',start:text,end:text});
      const raw={version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:reference('Hello')},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'reply',target:reference(parent)}}]}],requirements:'p1',prohibited:[],reason:'Fixture request.'};
      agent._chatWithCostAllowance=async(_p,messages,_o,_c,meta)=>{
        const input=JSON.parse(messages[1].content);
        return {content:JSON.stringify(meta.generationName==='social_publication_authorization'?{key:input.key,actionId:input.action.id,authorized:true,reason:'Fixture authorization.'}:raw)};
      };
      agent._detectLikelySubmitAction=async()=>probe();
      const detected=await probe();
      assert.equal(detected.publicationSnapshot.account,platform==='twitter'?'twitter:alice':'bluesky:alice.bsky.social','reply recipient cannot become the publishing account');
      assert.equal(await agent._workflowPreSubmitDispatchBlock(tabId,'click',{selector:'#publish'},detected,provider),null);
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId,'click',{selector:'#publish'},{success:true,dispatched:true});
      agent._recordCompletionSubmitAttempt(tabId,detected,'click',{selector:'#publish'},parent,parent,{success:true,dispatched:true});
      await page.setContent(threadHtml(parentItem+replyItem));
      const verify=async()=>{
        const state=await readPublished();
        agent._recordCompletionToolResult(tabId,'read_page',{}, {success:true,url:page.url(),content:'Observed thread.'});
        return {state,record:state.workflowResourceRecords.find(r=>r.url===permalink),terminal:agent._workflowTerminalEvidenceFromDone(tabId,state,page.url(),agent._completionSubmissionEvidence(tabId,state,page.url()))};
      };
      let verified=await verify();
      assert.equal(verified.record.replyToUrl,parent,'published reply profile hint resolves through surrounding thread');
      assert(verified.terminal,`${build}/${platform}: actual extracted reply relationship completes the submitted contract`);checked++;
      await page.evaluate(permalink=>history.replaceState({},'',permalink+'?s=20#reply'),permalink);
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      // Native profile-only reply UI may have no reply-specific test ID.
      await page.locator('#reply-hint').evaluate(el=>el.removeAttribute('data-testid'));
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      for(const variation of ['feed','wrong-profile','missing-parent','reordered','gap','duplicate-parent','quoted-parent','body-mention']){
        await page.evaluate(permalink=>history.replaceState({},'',permalink),permalink);
        await page.setContent(threadHtml(parentItem+replyItem));
        if(variation==='feed') await page.evaluate(()=>history.replaceState({},'','/home'));
        if(variation==='wrong-profile') await page.locator('#reply-hint a').evaluate((el,href)=>el.href=href,profile('carol'));
        if(variation==='missing-parent') await page.locator('#parent-post-cell').evaluate(el=>el.remove());
        if(variation==='reordered') await page.locator('#thread').evaluate(el=>el.prepend(el.lastElementChild));
        if(variation==='gap') await page.locator('#parent-post-cell').evaluate(el=>{const gap=document.createElement('div');gap.dataset.testid='cellInnerDiv';gap.textContent='Show more';el.after(gap);});
        if(variation==='duplicate-parent') await page.locator('#parent-post-cell').evaluate(el=>el.before(el.cloneNode(true)));
        if(variation==='quoted-parent') await page.locator('#reply-post').evaluate(el=>{const quote=document.createElement('div');quote.dataset.testid='quoteTweet';quote.append(document.querySelector('#parent-post-cell'));el.append(quote);});
        if(variation==='body-mention') await page.locator('#reply-hint').evaluate((el,bodyId)=>{el.removeAttribute('data-testid');document.querySelector(`#reply-post [data-testid="${bodyId}"]`).append(el);},bodyId);
        verified=await verify();assert.equal(verified.record.replyToUrl,'',variation);assert.equal(verified.terminal,null,variation);checked++;
      }
      // Explicit app-provided parent metadata also works outside a thread,
      // but invalid metadata cannot be repaired by the background page URL.
      await page.evaluate(()=>history.replaceState({},'','/home'));
      await page.setContent(threadHtml(replyItem));
      await page.locator('#reply-post').evaluate((el,parent)=>el.setAttribute('data-in-reply-to-url',parent),parent);
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      await page.locator('#reply-post').evaluate(el=>el.setAttribute('data-in-reply-to-url','https://example.com/bob/status/1111111111111111111'));
      verified=await verify();assert.equal(verified.record.replyToUrl,'');assert.equal(verified.terminal,null);checked++;
      await page.evaluate(permalink=>history.replaceState({},'',permalink),permalink);
      await page.setContent(threadHtml(parentItem+replyItem));
      const mentioned=platform==='twitter'?'https://x.com/alice/status/5555555555555555555':'https://bsky.app/profile/alice.bsky.social/post/3mentioned';
      await page.locator(`#reply-post [data-testid="${bodyId}"]`).evaluate((el,href)=>{const link=document.createElement('a');link.href=href;link.textContent=href;el.append(link);},mentioned);
      verified=await verify();
      assert.equal(verified.state.workflowResourceRecords.find(r=>r.url===mentioned)?.replyToUrl,'','an authored permalink does not inherit the surrounding card relationship');
      assert.equal(verified.record.replyToUrl,parent);assert.equal(verified.terminal,null);checked++;




    }
  }
} finally { await browser.close(); }
console.log(`${checked} isolated publication DOM checks passed`);
