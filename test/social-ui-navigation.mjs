import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
import { createCompletionInvariantState } from '../src/chrome/src/agent/completion-invariant.js';

// The page, native AX refs, submit probe, normalized intent contract, and
// content dispatch are real. Every browser request is fulfilled locally.
const noneContract = {version:1,status:'none',actions:[],requirements:null,prohibited:[],reason:'No publication requested.'};

for (const build of ['chrome','firefox']) {
  test(`${build}: ordinary UI activation respects the current publication obligation`, async t => {
    const {Agent} = await import(`../src/${build}/src/agent/agent.js`);
    const browser = await (build==='chrome'?chromium:firefox).launch({headless:true});
    const context = await browser.newContext();
    let requests = 0;
    await context.route('**/*', route => {requests++; return route.fulfill({contentType:'text/html',body:'<!doctype html>'});});
    const page = await context.newPage();
    await page.goto('https://bsky.app/');
    await page.evaluate(() => {
      window.contentListeners=[];
      window.chrome={runtime:{sendMessage:()=>{},onMessage:{addListener:fn=>window.contentListeners.push(fn)}}};
      window.browser=window.chrome;
    });
    for(const name of ['accessibility-tree.js','content.js'])await page.addScriptTag({content:readFileSync(`src/${build}/src/content/${name}`,'utf8')});
    const call = (action, params) => page.evaluate(({action,params}) => new Promise(resolve => {
      for(const listener of window.contentListeners) listener({target:'content',action,params},{},resolve);
    }),{action,params});
    const originalChrome=globalThis.chrome;
    const originalBrowser=globalThis.browser;
    if(build==='chrome')globalThis.chrome={scripting:{executeScript:async({func,args})=>[{frameId:0,result:await page.evaluate(({source,args})=>Function('return ('+source+')')()(...args),{source:func.toString(),args})}]}};
    else{
      globalThis.chrome=undefined;
      globalThis.browser={tabs:{executeScript:async(_tab,{code})=>[await page.evaluate(code=>Function('return ('+code+')')(),code)]}};
    }
    try {
      const setup = async (html, options={}) => {
        await page.setContent('<style>button,[role=button],a{display:inline-block;min-width:70px;min-height:30px} [hidden]{display:none}</style>'+html);
        await page.evaluate(() => {
          window.uiClicks=[];
          document.addEventListener('click',event=>{
            const control=event.target.closest('button,[role=button],a');
            if(control){event.preventDefault();window.uiClicks.push(control.id);if(control.id==='dismiss')control.closest('[role=dialog]')?.remove();}
          });
        });
        const provider={model:'owned-fixture-provider',chat:async()=>({content:'{}'})};
        const agent=new Agent({getActive:()=>provider});
        agent._currentUrl=async()=>page.url();
        agent._persist=()=>{};
        agent.conversations.set(1,[{role:'system',content:'system'},{role:'user',content:options.request||'Inspect the current UI and dismiss its informational dialog. Send and publish nothing.'}]);
        const guard=agent._startPlanExecutionGuard(1,'act',{requestKind:'execute',requiresStateChange:false,requiresSubmission:false,...options.gate});
        agent._chatWithCostAllowance=async()=>({content:JSON.stringify(options.contract||noneContract)});
        if(options.compile!==false)await agent._ensureSocialPublicationContract(1,provider);
        return {agent,guard,provider};
      };
      const attempt = async (f,args) => {
        const detected=await f.agent._detectLikelySubmitAction(1,'click_ax',args);
        const blocked=await f.agent._socialPublicationPreSubmitBlock(1,'click_ax',args,detected,f.provider);
        if(blocked)return {detected,result:blocked};
        return {detected,result:await call('click_ax',args)};
      };
      const targetRef = async id => {
        const tree=await call('get_accessibility_tree',{filter:'all',maxChars:16000});
        assert.equal(typeof tree.pageContent,'string',JSON.stringify(tree));
        return page.evaluate(id=>window.__wb_ax_ref(document.getElementById(id)),id);
      };

      await t.test('observed native verification modal Close is dispatched and the dialog actually disappears',async()=>{
        const f=await setup('<div role="dialog" aria-label="Make adjustments to email settings for your account"><button id="verify" type="button">Send verification email</button><button id="dismiss" type="button" aria-label="Close active dialog"></button></div>');
        const ref=await targetRef('dismiss');
        const {detected,result}=await attempt(f,{ref_id:ref});
        assert.equal(detected?.resolvedOrdinaryActivationTarget,true);
        assert.equal(result.success,true);
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),['dismiss']);
        assert.equal(await page.locator('[role=dialog]').count(),0);
      });

      for(const [label,tag]of [['Show details','button'],['Expand filters','div'],['Dismiss notice','button']]){
        await t.test(`ordinary ${label} is not forced into a publication contract`,async()=>{
          const f=await setup(`<${tag} id="ordinary" ${tag==='button'?'type="button"':'role="button" tabindex="0"'}>${label}</${tag}>`);
          const {detected,result}=await attempt(f,{ref_id:await targetRef('ordinary')});
          assert.equal(detected?.resolvedOrdinaryActivationTarget,true);
          assert.equal(result.success,true);
          assert.deepEqual(await page.evaluate(()=>window.uiClicks),['ordinary']);
        });
      }

      const unsafeControls=[
        ['native publish','<div><textarea>Draft</textarea><button id="unsafe" type="button" data-testid="composerPublishBtn">Post</button></div>'],
        ['publish without an editor','<button id="unsafe" type="button" data-testid="composerPublishBtn">Post</button>'],
        ['native send','<button id="unsafe" type="button" data-testid="sendMessageButton">Send message</button>'],
        ...['send','sendMessageButton','dmComposerSendButton','send-message-button'].map(marker=>[`unnamed native send ${marker}`,`<button id="unsafe" type="button" data-testid="${marker}"></button>`]),
        ['unnamed unresolved purpose','<button id="unsafe" type="button"></button>'],
        ['send verification email','<div role="dialog"><button id="unsafe" type="button">Send verification email</button></div>'],
        ['custom submit attribute','<button id="unsafe" type="button" onclick="document.querySelector(\'form\').requestSubmit()">Finish</button><form></form>'],
        ['custom action','<button id="unsafe" type="button" data-action="submit">Finish</button>'],
        ['conflicting accessible commit name','<button id="unsafe" type="button" aria-label="Send">Show details</button>'],
        ['explicit submit type','<button id="unsafe" type="submit">Finish</button>'],
        ['hidden target','<button id="unsafe" type="button" hidden>Show details</button>'],
        ['unbound saved resource deletion','<button id="unsafe" type="button">Delete resource</button>'],
      ];
      for(const[name,html]of unsafeControls)await t.test(`${name} retains no-dispatch protection`,async()=>{
        const f=await setup(html);
        const ref=await targetRef('unsafe');
        const {detected,result}=await attempt(f,{ref_id:ref});
        assert.notEqual(detected?.resolvedOrdinaryActivationTarget,true);
        assert.equal(result.noDispatch,true);
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });

      await t.test('associated forms retain their existing generic submission classification',async()=>{
        const f=await setup('<form id="f"><input name="value"></form><button id="unsafe" type="button" form="f">Finish</button>');
        const detected=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('unsafe')});
        assert.equal(detected?.isSubmit,true);
        assert.equal(detected?.publicationControl,false);
        assert.notEqual(detected?.resolvedOrdinaryActivationTarget,true);
        // The social guard delegates this already classified ordinary form to
        // the generic form/confirmation gates; it is not the new UI exemption.
        assert.equal(await f.agent._socialPublicationPreSubmitBlock(1,'click_ax',{},detected,f.provider),null);
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });

      for(const[condition,options,change]of[
        ['missing contract',{compile:false}],
        ['ambiguous contract',{contract:{...noneContract,status:'clarify',reason:'Intent ambiguous.'}}],
        ['submission obligation',{gate:{requiresSubmission:true}}],
        ['unknown submission obligation',{gate:{requiresSubmission:null}}],
        ['ready publication contract',{request:'Post Hello on Bluesky.',contract:{version:1,status:'ready',actions:[{id:'p1',platform:'bluesky',account:null,posts:[{body:{kind:'exact',source:{source:'request',start:'Hello',end:'Hello'}},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'post',target:null}}]}],requirements:'p1',prohibited:[],reason:'Publication requested.'}}],
        ['contract requires refresh',{},f=>{f.guard.socialPublication.needsRecompile=true;}],
      ])await t.test(`${condition} does not turn a resolved preparatory activation into publication`,async()=>{
        const f=await setup('<button id="ordinary" type="button">Show details</button>',options);
        change?.(f);
        const {result}=await attempt(f,{ref_id:await targetRef('ordinary')});
        assert.equal(result.success,true);
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),['ordinary']);
      });
      for(const[condition,options,change]of[
        ['different task identity',{},f=>{f.guard.taskKey='replacement-task';}],
        ['Stop',{},f=>{f.agent._checkAbort=()=>true;}],
        ['pending accepted steering',{},f=>{f.agent._hasPendingSteering=()=>true;}],
        ['task replacement during URL read',{},f=>{f.agent._currentUrl=async()=>{f.agent._planExecutionGuards.set(1,{...f.guard});return page.url();};}],
      ])await t.test(`${condition} cannot exempt an ordinary activation`,async()=>{
        const f=await setup('<button id="ordinary" type="button">Show details</button>',options);
        change?.(f);
        const {result}=await attempt(f,{ref_id:await targetRef('ordinary')});
        assert.equal(result.noDispatch,true);
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });

      await t.test('missing refs and ambiguous text never manufacture a resolved target',async()=>{
        const f=await setup('<button type="button">Show details</button><button type="button">Show details</button>');
        for(const[tool,args]of [['click_ax',{ref_id:'ref_999999999999'}],['click',{text:'Show details',textMatch:'exact'}]]){
          const detected=await f.agent._detectLikelySubmitAction(1,tool,args);
          assert.notEqual(detected?.resolvedOrdinaryActivationTarget,true);
          assert.equal((await f.agent._socialPublicationPreSubmitBlock(1,tool,args,detected,f.provider)).noDispatch,true);
        }
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });
      await t.test('structural resource popup labels pass with no publication contract and after steering',async()=>{
        for(const host of ['https://example.test/','https://x.com/','https://bsky.app/']) {
          await page.goto(host);
          await page.evaluate(() => { window.contentListeners=[]; window.chrome={runtime:{sendMessage:()=>{},onMessage:{addListener:fn=>window.contentListeners.push(fn)}}};window.browser=window.chrome; });
          for(const name of ['accessibility-tree.js','content.js'])await page.addScriptTag({content:readFileSync(`src/${build}/src/content/${name}`,'utf8')});
          const f=await setup('<button id="ordinary" type="button" aria-haspopup="menu" aria-controls="choices">Thread post options</button><div id="choices" role="menu"></div>',{compile:false});
          f.guard.steeringPriorSubmission={dispatched:true,observedAfterSubmit:false};
          for(const [tool,args]of [['click_ax',{ref_id:await targetRef('ordinary')}],['click',{selector:'#ordinary'}]]) {
            const detected=await f.agent._detectLikelySubmitAction(1,tool,args);
            assert.equal(detected.resolvedPreparatoryTarget,true);
            assert.equal(f.agent._steeringPriorSubmissionBlock(1,tool,args,detected),null);
            assert.equal(await f.agent._socialPublicationPreSubmitBlock(1,tool,args,detected,f.provider),null);
          }
        }
      });
      await t.test('compound and localized commit captions do not gain ordinary activation status',async()=>{
        for(const caption of ['Click here to publish','Schedule and publish','Review then delete','Click to confirm','Jetzt senden','Şimdi gönder']) {
          const f=await setup(`<button id="unsafe" type="button">${caption}</button>`,{compile:false});
          const detected=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('unsafe')});
          assert.notEqual(detected?.resolvedOrdinaryActivationTarget,true,caption);
        }
      });
      await t.test('native resource scope ignores unrelated height but rejects virtualization, hiding and replaced owners',async()=>{
        const url='https://bsky.app/profile/alice/post/900';
        for(const failure of [null,'virtualized','hidden','replaced-owner','expired']) {
          const f=await setup(`<section id="collection"><article id="resource" ${failure==='virtualized'?'aria-setsize="200" aria-posinset="1"':''}><a rel="bookmark" href="${url}">Original</a><p>Saved exact body</p><button id="ordinary" type="button" aria-haspopup="menu">Resource controls</button></article></section><aside style="height:3000px">Unrelated sidebar</aside><form><button id="finish" type="submit">Save</button></form>`,{compile:false});
          const observed=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('ordinary')});
          assert.equal(observed.actionResource?.complete,true);
          f.guard.steeringPriorSubmissionReconciliation={resourceScopeToken:observed.actionResource.scopeToken,resourceUrl:url};
          await page.evaluate(({failure,token})=>{const article=document.getElementById('resource');
            if(failure==='hidden')article.hidden=true;
            else if(failure==='replaced-owner')article.parentElement.outerHTML='<section id="collection"></section>';
            else article.remove();
            if(failure==='expired')globalThis.__wbResourceMutationScopes.scopes.get(token).until=0;
          },{failure,token:observed.actionResource.scopeToken});
          const fresh=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('finish')},{mutationReconciliation:true});
          assert.equal(fresh.reconciliationResourceScanComplete,false,'Whole-page height cannot prove absence');
          assert.equal(fresh.reconciliationScope?.removed===true,failure===null,String(failure));
        }
      });
      await t.test('native draft toolbar and selected local attachment controls remain preparation',async()=>{
        const f=await setup('<section><div role="toolbar" aria-controls="draft"><button id="ordinary" type="button">Remove formatting</button></div><div id="draft" contenteditable="true">Local draft</div></section>',{compile:false});
        let detected=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('ordinary')});
        assert.equal(detected.resolvedNonSubmitTarget,true);
        assert.equal(detected.mutationKind,undefined);
        assert.equal(await f.agent._socialPublicationPreSubmitBlock(1,'click_ax',{},detected,f.provider),null);
        const attached=await setup('<div role="dialog"><div contenteditable="true">Local draft</div><input id="file" type="file"><figure><img id="preview" style="width:30px;height:30px"><button id="ordinary" type="button">Remove attachment</button></figure></div>',{compile:false});
        await page.locator('#file').setInputFiles({name:'local.txt',mimeType:'text/plain',buffer:Buffer.from('local fixture')});
        await page.evaluate(()=>{document.getElementById('preview').src=URL.createObjectURL(document.getElementById('file').files[0]);});
        detected=await attached.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('ordinary')});
        assert.equal(detected.resolvedNonSubmitTarget,true);
        assert.equal(detected.mutationKind,undefined);
        assert.equal(await attached.agent._socialPublicationPreSubmitBlock(1,'click_ax',{},detected,attached.provider),null);
      });
      await t.test('form editor ownership cannot turn Save or resource deletion into local formatting',async()=>{
        const f=await setup('<form><div role="toolbar" aria-controls="draft"><button id="bold" type="button">Bold</button><button id="format" type="button">Remove formatting</button><button id="save" type="button">Save</button><button id="delete" type="button">Delete record</button><button id="remove" type="button">Remove record</button><button id="title-save" type="button" title="Save record">Bold</button><button id="title-delete" type="button" title="Delete record">Bold</button></div><div id="draft" contenteditable="true">Local draft</div></form>',{compile:false});
        f.guard.steeringPriorSubmission={dispatched:true,observedAfterSubmit:false};
        for(const id of ['bold','format']) {
          const detected=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef(id)});
          assert.equal(detected.isSubmit,false,id);assert.equal(detected.resolvedNonSubmitTarget,true,id);
          assert.equal(f.agent._steeringPriorSubmissionBlock(1,'click_ax',{},detected),null,id);
        }
        for(const id of ['save','delete','remove','title-save','title-delete']) {
          const detected=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef(id)});
          assert.equal(detected.isSubmit,true,id);assert.notEqual(detected.resolvedDraftControl,true,id);
          assert.equal(f.agent._steeringPriorSubmissionBlock(1,'click_ax',{},detected).noDispatch,true,id);
        }
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });
      await t.test('resource B never borrows A and portal ownership requires its actual clicked native launcher',async()=>{
        const url='https://bsky.app/profile/alice/post/900';
        const f=await setup(`<section><article id="owned"><a rel="bookmark" href="${url}">Original</a><p>Saved body</p><button id="launcher" type="button" aria-haspopup="menu" aria-controls="choices">Resource controls</button></article><article id="other"><p>Unbound resource B</p><button id="wrong" type="button">Delete record</button></article></section><div id="choices" role="menu" aria-labelledby="launcher"><button id="portal" type="button">Delete record</button></div><div id="unrelated" role="menu"><button id="foreign" type="button">Delete record</button></div>`,{compile:false});
        f.agent.completionInvariants.set(1,createCompletionInvariantState('owned-resource-run'));
        let portal=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('portal')});
        assert.equal(portal.actionResource,undefined,'Read-only preparation does not establish portal ownership');
        await page.evaluate(()=>{document.getElementById('choices').hidden=true;document.getElementById('launcher').addEventListener('click',()=>{document.getElementById('choices').hidden=false;});});
        const args={ref_id:await targetRef('launcher')}, opened=await attempt(f,args);
        assert.equal(opened.result.success,true);
        f.agent._recordCompletionToolResult(1,'click_ax',args,opened.result,{detectedSubmit:opened.detected});
        assert.equal(f.guard.resolvedResourceScope.launcherDispatched,true);
        const wrongArgs={ref_id:await targetRef('wrong')}, wrong=await f.agent._detectLikelySubmitAction(1,'click_ax',wrongArgs);
        assert.equal(wrong.actionResource,undefined,'An existing different owner vetoes fallback, even if it lacks a permalink');
        // B is bound only to its own visible record, which this request never asks to delete.
        assert.equal(wrong.actionRecord?.text,'Unbound resource B');
        assert.equal((await f.agent._resourceMutationPreSubmitBlock(1,'click_ax',wrongArgs,wrong,f.provider)).actionGuard.reason,'deletion_not_requested');
        portal=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('portal')});
        assert.equal(portal.actionResource.url,url,'A native aria-controls/labelledby relation resolves the actual opened A menu');
        const foreign=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('foreign')});
        assert.equal(foreign.actionResource,undefined,'A different portal cannot borrow the latest URL');
        f.guard.resolvedResourceScope.launcherDispatched=false;
        portal=await f.agent._detectLikelySubmitAction(1,'click_ax',{ref_id:await targetRef('portal')});
        assert.equal(portal.actionResource,undefined,'Uncertain or undispatched launchers confer no ownership');
      });
      await t.test('unique text and selector resolve the same ordinary native activation',async()=>{
        const f=await setup('<button id="ordinary" type="button">Show details</button>');
        for(const args of [{text:'Show details',textMatch:'exact'},{selector:'#ordinary'}]){
          const detected=await f.agent._detectLikelySubmitAction(1,'click',args);
          assert.equal(detected?.resolvedOrdinaryActivationTarget,true);
          assert.equal(await f.agent._socialPublicationPreSubmitBlock(1,'click',args,detected,f.provider),null);
          assert.equal((await call('click',args)).success,true);
        }
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),['ordinary','ordinary']);
      });
      await t.test('no publication task still cannot bypass activation keys, callback tools, or social API writes',async()=>{
        const f=await setup('<button id="ordinary" type="button">Show details</button>');
        for(const[tool,args]of [['press_keys',{key:'Enter'}],['press_keys',{key:'Space'}],['execute_js',{code:'document.querySelector("button").click()'}],['execute_webmcp_tool',{name:'publish'}],['fetch_url',{url:'https://bsky.app/api/post',method:'POST',body:'{}'}]]){
          const detected=await f.agent._detectLikelySubmitAction(1,tool,args);
          assert.equal((await f.agent._socialPublicationPreSubmitBlock(1,tool,args,detected,f.provider)).noDispatch,true,tool);
        }
        assert.deepEqual(await page.evaluate(()=>window.uiClicks),[]);
      });
      assert.equal(requests,4,'only the intercepted fixture navigations occurred');
    }finally{globalThis.chrome=originalChrome;globalThis.browser=originalBrowser;await browser.close();}
  });
}
