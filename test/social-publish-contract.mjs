import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';

const ref = (text, source = 'request') => ({ source, start: text, end: text });
const count = (type = 'any', min = 0, max = 0, format = null) => ({ kind: 'count', type, format, min, max });
const rawAction = (id, platform, text = 'Hello') => ({ id, platform, account: null,
  posts: [{ body: { kind: 'exact', source: ref(text) }, media: count(), context: { kind: 'post', target: null } }] });
const withTriggers = node => typeof node === 'string' ? node : { ...node, ...(node.kind === 'fallback' ? {trigger:node.trigger || 'not_published'} : {}), items: node.items.map(withTriggers) };
const rawContract = (actions = [rawAction('p1', 'twitter')], requirements = 'p1') => ({
  version: 1, status: 'ready', actions, requirements: withTriggers(requirements), prohibited: [], reason: 'User requested publication.',
});
const snapshot = (bodyText = 'Hello', account = 'twitter:alice') => ({ complete: true, account,
  posts: [{ complete: true, bodyText, attachments: [], context: { kind: 'post', target: null } }] });

for (const browser of ['chrome', 'firefox']) {
  const api = await import(`../src/${browser}/src/agent/social-publish-contract.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const normalize = (raw, request = 'Post Hello on X and Bluesky') => api.normalizePublicationContract(raw, { request });

  test(`${browser}: source anchors preserve long, multilingual, compatibility-distinct text`, () => {
    const body = 'Beginning ① Ａ 👨‍👩‍👧\n\n' + 'payload '.repeat(1800) + 'Unique ending.';
    const source = `Post on X: ${body}\nThen tell me when done.`;
    const resolved = api.resolvePublicationText({ source: 'request', start: 'Beginning ①', end: 'Unique ending.' }, { request: source });
    assert.equal(resolved, body);
    assert.throws(() => api.resolvePublicationText(ref('same'), { request: 'same and same' }), /ambiguous/);
    assert.throws(() => api.resolvePublicationText(ref('missing'), { request: source }));
    assert.throws(() => api.resolvePublicationText(ref('Hello', '__proto__'), { request: 'Hello' }));
    for (const [a,b] of [['①','1'], ['Ａ','A'], ['a  b','a b'], ['a\n\nb','a\nb'], ['👨‍👩‍👧','👨👩👧']]) {
      assert.notEqual(api.exactPublicationText(a), api.exactPublicationText(b));
    }
    assert.equal(api.exactPublicationText('e\u0301\r\nx'), api.exactPublicationText('é\nx'));
  });

  test(`${browser}: schema cannot invent destinations, lose constraints, or contradict prohibitions`, () => {
    const good = rawContract();
    assert.equal(normalize(good).status, 'ready');
    const mutations = [
      x => { x.actions[0].platform = 'X'; },
      x => { delete x.actions[0].posts[0].media; },
      x => { x.prohibited = ['twitter']; },
      x => { x.requirements = {kind: 'all', items:['p1','missing']}; },
      x => { x.requirements = {kind: 'all', items:['p1','p1']}; },
      x => { x.actions[0].posts[0].media.min = -1; },
      x => { x.actions[0].posts[0].media.kind = 'whatever'; },
      x => { x.actions[0].posts[0].body.source = ref('omitted'); },
      x => { x.actions[0].authorize = true; },
      x => { x.status = 'none'; },
    ];
    for (const mutate of mutations) { const copy = structuredClone(good); mutate(copy); assert.throws(() => normalize(copy)); }
    assert.throws(() => normalize({ ...good, actions: [...good.actions, rawAction('p2','bluesky')] }));
  });

  test(`${browser}: all, any and fallback differ and uncertain delivery never unlocks another post`, () => {
    const actions = [rawAction('p1','twitter'), rawAction('p2','bluesky')];
    for (const kind of ['all','any','fallback']) {
      const contract = normalize(rawContract(actions,{kind,items:['p1','p2']}));
      assert.deepEqual(api.publicationProgress(contract).eligible, kind === 'fallback' ? ['p1'] : ['p1','p2']);
      const verified = api.publicationProgress(contract,{p1:{status:'verified'}});
      assert.equal(verified.complete,kind !== 'all');
      const pending = api.publicationProgress(contract,{p1:{status:'pending'}});
      assert.deepEqual(pending.eligible,kind === 'all' ? ['p2'] : []);
      const failed = api.publicationProgress(contract,{p1:{status:'failed'}});
      assert.deepEqual(failed.eligible,['p2']);
    }
  });

  test(`${browser}: typed media constraints preserve counts, alternatives, file identity and exact alt text`, () => {
    const c = { kind:'all',items:[count('video',1,1),count('image',0,2),count('gif',0,0),count('any',1,3)] };
    const record = {attachments:[{type:'video',src:'https://cdn/a.mp4'}]};
    assert(api.publicationMediaMatches(c,record));
    record.attachments.push({type:'image',src:'https://cdn/a.png',name:'a.png',alt:'①'});
    assert(api.publicationMediaMatches(c,record));
    assert(api.publicationMediaMatches({kind:'file',name:'a.png'},record));
    assert(!api.publicationMediaMatches({kind:'file',name:'b.png'},record));
    assert(api.publicationMediaMatches({kind:'alt',name:'a.png',value:'①'},record));
    assert(!api.publicationMediaMatches({kind:'alt',name:'a.png',value:'1'},record));
    assert(!api.publicationMediaMatches({kind:'alt',name:'a.png',value:'①'},{...record,uploadNameBindingAmbiguous:true}));
    record.attachments.push({type:'animated_gif',src:'https://cdn/tweet_video/a.mp4'});
    assert(!api.publicationMediaMatches(c,record));
    assert(api.publicationMediaMatches({kind:'any',items:[count('any',0,0), count('gif',1,1)]},record));
    assert(!api.publicationMediaMatches(count('image',0,0),{attachments:[{type:'unknown'}]}));
  });

  function setup(request = 'Post Hello on X', raw = rawContract()) {
    const provider = { model: 'user-selected-provider-model', chat: async () => ({content:'{}'}) };
    const agent = new Agent({getActive:()=>provider});
    const tabId = 763;
    agent.useSiteAdapters = true;
    agent._persist = () => {};
    agent._currentUrl = async () => 'https://x.com/compose/post';
    agent.conversations.set(tabId,[{role:'system',content:'system'},{role:'user',content:request}]);
    const guard = agent._startPlanExecutionGuard(tabId,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
    const calls = [];
    agent._chatWithCostAllowance = async (usedProvider,messages,_options,_cost,meta) => {
      assert.equal(usedProvider,provider);
      calls.push({messages,meta});
      if (meta.generationName === 'social_publication_authorization') {
        const input = JSON.parse(messages[1].content);
        return {content:JSON.stringify({key:input.key,actionId:input.action.id,authorized:true,reason:'Matches user request.'})};
      }
      return {content:JSON.stringify(raw)};
    };
    const detected = {isSubmit:true,publicationResourceUrls:[],publicationResourceUrlsComplete:true,
      publicationAccountIdentity:'twitter:alice',publicationAccountIdentityComplete:true,publicationSnapshot:snapshot()};
    agent._detectLikelySubmitAction = async () => structuredClone(detected);
    return {agent,tabId,guard,provider,calls,detected};
  }

  test(`${browser}: selected provider compiles once and checks the concrete draft before dispatch`, async () => {
    const {agent,tabId,guard,provider,calls,detected} = setup();
    assert(await agent._adoptLiveSocialPublishWorkflow(tabId,provider));
    assert.equal(guard.siteWorkflow.adapterName,'twitter');
    assert.equal(await agent._adoptLiveSocialPublishWorkflow(tabId,provider),false);
    assert.equal(calls.length,1);
    assert.equal(await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{ref_id:'post'},detected,provider),null);
    assert.equal(calls.length,2);
    assert.equal(await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{ref_id:'post'},detected,provider),null);
    assert.equal(calls.length,2);
    const binding = agent._workflowSubmitBindingForAttempt(tabId,'https://x.com/compose/post',{},detected);
    assert.equal(binding.socialPublication.actionId,'p1');
    assert.equal(binding.socialPublication.snapshot.posts[0].bodyText,'Hello');
    agent._recordCompletionSubmitAttempt(tabId,detected,'click_ax',{},'https://x.com/compose/post','https://x.com/compose/post',{success:true});
    assert.equal(guard.socialPublication.outcomes.p1.status,'pending');
    assert((await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{},detected,provider)).noDispatch);
    assert.deepEqual(agent._missingSocialPublishTargets(guard),['twitter']);
  });

  test(`${browser}: read-only, negated and narrative tasks cannot acquire a publication from their text`, async () => {
    for (const request of ['Explain how brands publish on X effectively','The team will post on X tomorrow',
      'Do not publish anything; open composer to inspect','Read posts on X and summarize them']) {
      const {agent,tabId,guard,provider,detected} = setup(request,{version:1,status:'none',actions:[],requirements:null,prohibited:['twitter'],reason:'No publication authorized.'});
      assert.equal(await agent._adoptLiveSocialPublishWorkflow(tabId,provider),false);
      assert.deepEqual([...agent._trustedSocialPublishTargetAdapters(guard)],[]);
      assert((await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{},detected,provider)).noDispatch);
    }
  });

  test(`${browser}: malformed/partial intent and failed semantic audits block without deterministic fallback`, async () => {
    const state = setup('Post Hello with an image on X',{workflowFields:[{field:'body',value:'Hello'}]});
    await state.agent._adoptLiveSocialPublishWorkflow(state.tabId,state.provider);
    assert.equal(state.calls.length,2);
    assert.equal(state.guard.socialPublication.contract,null);
    assert((await state.agent._workflowPreSubmitDispatchBlock(state.tabId,'click_ax',{},state.detected,state.provider)).noDispatch);
    assert.equal(state.calls.length,2);
    const other = setup();
    await other.agent._adoptLiveSocialPublishWorkflow(other.tabId,other.provider);
    other.agent._chatWithCostAllowance = async()=>({content:'{"authorized":true}'});
    assert((await other.agent._workflowPreSubmitDispatchBlock(other.tabId,'click_ax',{},other.detected,other.provider)).noDispatch);
    assert.equal(other.guard.socialPublication.dispatch,null);
  });

  test(`${browser}: changed body/account and absent baseline cannot reuse authorization`, async () => {
    for (const mutation of [d=>{d.publicationSnapshot.posts[0].bodyText='Wrong';},d=>{d.publicationSnapshot.account='twitter:bob';},d=>{d.publicationResourceUrlsComplete=false;}]) {
      const {agent,tabId,provider,detected} = setup();
      const fresh = structuredClone(detected); mutation(fresh);
      agent._detectLikelySubmitAction=async()=>fresh;
      assert((await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{},detected,provider)).noDispatch);
    }
  });

  test(`${browser}: exact body fallback does not fold compatibility characters`, () => {
    const {agent} = setup();
    for (const [wanted,observed] of [['①','1'],['Ａ','A'],['👨‍👩‍👧','👨👩👧']]) {
      assert.equal(agent._workflowSocialPublishedBodyObserved({field:'body',value:wanted},{text:observed}),false);
      assert.equal(agent._workflowSocialPublishedBodyObserved({field:'body',value:wanted},{bodyText:observed}),false);
    }
  });
  async function dispatchedFixture(raw = rawContract(), request = 'Post Hello on X', composer = snapshot()) {
    const fixture = setup(request,raw);
    const {agent,tabId,provider,detected} = fixture;
    detected.publicationSnapshot=composer;
    await agent._adoptLiveSocialPublishWorkflow(tabId,provider);
    assert.equal(await agent._workflowPreSubmitDispatchBlock(tabId,'click_ax',{},detected,provider),null);
    agent._beginCompletionInvariant(tabId);
    agent._recordCompletionToolResult(tabId,'click_ax',{}, {success:true,dispatched:true});
    agent._recordCompletionSubmitAttempt(tabId,detected,'click_ax',{},'https://x.com/compose/post','https://x.com/compose/post',{success:true,dispatched:true});
    const url = 'https://x.com/alice/status/2222222222222222222';
    agent._recordCompletionToolResult(tabId,'click_ax',{}, {success:true});
    agent._recordCompletionToolResult(tabId,'read_page',{}, {success:true,url,content:'Published post.'});
    const submit = agent._completionSubmitStates.get(tabId);
    const page = {workflowResourceUrls:[url],workflowResourceRecords:[{url,text:'Hello',bodyText:'Hello',bodyTextComplete:true,attachmentsComplete:true,attachments:[],contextUrls:[]}]};
    const terminal = (state=page,attempt=submit) => agent._workflowTerminalEvidenceFromDone(tabId,state,url,{submit:attempt,verifiedFinalSubmit:false,relevantForms:0});
    return {...fixture,url,submit,page,terminal};
  }

  test(`${browser}: opening a baseline-new permalink verifies the dispatched account and exact body`,async()=>{
    const f=await dispatchedFixture();
    const evidence=f.terminal();
    assert.equal(evidence?.source,'dispatch_bound_published_resource');
    assert.equal(evidence.socialActionId,'p1');
    f.guard.workflowTerminalEvidence=evidence;
    assert.deepEqual(f.agent._missingSocialPublishTargets(f.guard),[]);
    assert.equal(f.guard.socialPublication.outcomes.p1.status,'verified');
  });

  test(`${browser}: missing baseline, stale posts, wrong account/body/media and missing authorship never verify`,async()=>{
    const mutations=[
      (f,p,s)=>{delete s.workflowBinding.preDispatchPublishedResourceIdentities;},
      (f,p,s)=>{s.workflowBinding.preDispatchPublishedResourceIdentities=['twitter:status:2222222222222222222'];},
      (f,p)=>{p.workflowResourceRecords[0].url='https://x.com/bob/status/2222222222222222222';},
      (f,p)=>{p.workflowResourceRecords[0].bodyText='Hello extra';},
      (f,p)=>{p.workflowResourceRecords[0].attachments=[{type:'image',src:'https://cdn/unrequested.png'}];},
      (f,p)=>{delete p.workflowResourceRecords[0].bodyText;},
      (f,p,s)=>{delete s.workflowBinding.socialPublication;},
    ];
    for(const mutate of mutations){
      const f=await dispatchedFixture();const p=structuredClone(f.page),s=structuredClone(f.submit);mutate(f,p,s);
      assert.equal(f.terminal(p,s),null);
    }
  });

  test(`${browser}: named media and alt text are checked against the same contract before and after dispatch`,async()=>{
    const raw=rawContract();
    raw.actions[0].posts[0].media={kind:'all',items:[count('any',1,1),count('image',1,1),
      {kind:'file',name:ref('chart.png')},{kind:'alt',name:ref('chart.png'),value:ref('①')} ]};
    const composer=snapshot();composer.posts[0].attachments=[{type:'image',name:'chart.png',src:'https://cdn/chart.png',alt:'①'}];
    const f=await dispatchedFixture(raw,'Post Hello on X with chart.png and alt text ①',composer);
    f.page.workflowResourceRecords[0].attachments=structuredClone(composer.posts[0].attachments);
    assert(f.terminal());
    f.page.workflowResourceRecords[0].attachments[0].alt='1';
    assert.equal(f.terminal(),null);
  });

  test(`${browser}: a stronger model still cannot authorize a changed exact body through well-formed output`,async()=>{
    const f=setup('Post ① on X',rawContract([rawAction('p1','twitter','①')]));
    f.detected.publicationSnapshot=snapshot('1');
    assert((await f.agent._workflowPreSubmitDispatchBlock(f.tabId,'click_ax',{},f.detected,f.provider)).noDispatch);
    assert.equal(f.calls.filter(c=>c.meta.generationName==='social_publication_authorization').length,0);
  });

  test(`${browser}: verified destinations survive rebinding and an any choice cannot publish twice`,async()=>{
    for(const kind of ['all','any','fallback']){
      const actions=[rawAction('p1','twitter'),rawAction('p2','bluesky')];
      const f=await dispatchedFixture(rawContract(actions,{kind,items:['p1','p2']}),'Post Hello on X and Bluesky');
      f.guard.workflowTerminalEvidence=f.terminal();
      f.agent._currentUrl=async()=> 'https://bsky.app/';
      assert.equal(await f.agent._adoptLiveSocialPublishWorkflow(f.tabId,f.provider),kind==='all');
      assert.equal(f.guard.socialPublication.outcomes.p1.status,'verified');
      assert.deepEqual(f.agent._missingSocialPublishTargets(f.guard),kind==='all'?['bluesky']:[]);
      assert.equal(f.calls.filter(c=>c.meta.generationName==='social_publication_contract').length,1);
    }
  });

  test(`${browser}: trusted Continue carries raw contract sources and a changed user task invalidates them`,async()=>{
    const f=await dispatchedFixture();
    f.guard.workflowTerminalEvidence=f.terminal();
    f.agent._recordSocialPublishTargetSatisfied(f.guard);
    f.guard.evidenceTaskKey=f.guard.taskKey;
    f.agent._storeContinuationExecutionEvidence(f.tabId);
    const next=f.agent._startPlanExecutionGuard(f.tabId,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true,
      siteWorkflow:f.guard.siteWorkflow},{trustedContinuation:true});
    assert.equal(next.socialPublication?.key,f.guard.socialPublication.key);
    assert.equal(next.socialPublication?.outcomes.p1.status,'verified');
    f.agent.conversations.get(f.tabId).push({role:'user',content:'Do not publish anything else.'});
    const changed=f.agent._startPlanExecutionGuard(f.tabId,'act',{requestKind:'execute',requiresStateChange:false,requiresSubmission:false});
    assert.equal(changed.socialPublication,null);
  });

  test(`${browser}: nested alternative branches cannot switch after partial publication`,()=>{
    const actions=[rawAction('p1','twitter'),rawAction('p2','bluesky'),rawAction('p3','twitter')];
    for(const kind of ['any','fallback']){
      const c=normalize(rawContract(actions,{kind,items:[{kind:'all',items:['p1','p2']},'p3']}));
      assert.deepEqual(api.publicationProgress(c,{p1:{status:'verified'}}).eligible,['p2']);
      assert.deepEqual(api.publicationProgress(c,{p1:{status:'verified'},p2:{status:'failed'}}).eligible,[]);
    }
  });

  test(`${browser}: publication shortcuts and page callbacks cannot bypass the concrete click contract`,async()=>{
    for(const [name,args] of [['press_keys',{key:'Space'}],['press_keys',{key:'Enter'}],['execute_js',{code:'publish()'}],['execute_webmcp_tool',{}],['fetch_url',{url:'https://x.com/api/post',method:'POST'}]]){
      const f=setup();
      assert((await f.agent._workflowPreSubmitDispatchBlock(f.tabId,name,args,null,f.provider)).noDispatch);
    }
  });

  test(`${browser}: a thread needs every exact post and verified parent order`,async()=>{
    const action=rawAction('p1','twitter');action.posts.push(rawAction('unused','twitter','Second').posts[0]);
    const composer=snapshot();composer.posts.push(snapshot('Second').posts[0]);
    const f=await dispatchedFixture(rawContract([action]),'Post Hello then Second as a thread on X',composer);
    const second={...f.page.workflowResourceRecords[0],url:'https://x.com/alice/status/3333333333333333333',text:'Second',bodyText:'Second',replyToUrl:f.url};
    f.page.workflowResourceRecords.push(second);f.page.workflowResourceUrls.push(second.url);
    assert(f.terminal());
    second.replyToUrl='https://x.com/alice/status/1111111111111111111';
    assert.equal(f.terminal(),null);
  });

  test(`${browser}: observed reply parent must match the contract and survive the final recheck`,async()=>{
    const parent='https://x.com/bob/status/1111111111111111111';
    const other='https://x.com/carol/status/3333333333333333333';
    const action=rawAction('p1','twitter');action.posts[0].context={kind:'reply',target:ref(parent)};
    for(const mode of ['matching','host-alias','different','missing','changed']){
      const f=setup(`Reply exactly Hello to ${parent} on X`,rawContract([action]));
      f.agent._currentUrl=async()=>parent;
      f.detected.publicationSnapshot.posts[0].context={kind:'reply',target:mode==='host-alias'?parent.replace('x.com','twitter.com')+'?s=20#reply':mode==='different'?other:mode==='missing'?null:parent};
      if(mode==='missing') f.detected.publicationSnapshot.complete=false;
      if(mode==='changed') f.agent._detectLikelySubmitAction=async()=>{
        const fresh=structuredClone(f.detected);fresh.publicationSnapshot.posts[0].context.target=other;return fresh;
      };
      const block=await f.agent._workflowPreSubmitDispatchBlock(f.tabId,'click_ax',{},f.detected,f.provider);
      if(mode==='matching'||mode==='host-alias'){
        assert.equal(block,null);
        assert.equal(f.guard.socialPublication.dispatch.snapshot.posts[0].context.target,mode==='host-alias'?parent.replace('x.com','twitter.com')+'?s=20#reply':parent);
      } else {
        assert.equal(block.noDispatch,true,mode);
        assert.equal(f.guard.socialPublication.dispatch,null,mode);
      }
      assert.equal(f.calls.length,mode==='matching'||mode==='host-alias'||mode==='changed'?2:1,'a missing/wrong parent cannot be supplied by the contract or audit');
    }
  });

  test(`${browser}: reply and quote completion require the correct relationship`,async()=>{
    const target='https://x.com/bob/status/1111111111111111111';
    for(const kind of ['reply','quote']){
      const action=rawAction('p1','twitter');action.posts[0].context={kind,target:ref(target)};
      const composer=snapshot();composer.posts[0].context={kind,target};
      const f=await dispatchedFixture(rawContract([action]),`Post Hello as a ${kind} to ${target} on X`,composer);
      const record=f.page.workflowResourceRecords[0];
      if(kind==='reply') record.replyToUrl=target; else record.contextUrls=[target];
      assert(f.terminal());
      record.replyToUrl=kind==='reply'?'':target;
      record.contextUrls=kind==='reply'?[target]:[];
      assert.equal(f.terminal(),null,'a quote cannot prove a reply or vice versa');
      record.replyToUrl=target;record.contextUrls=[target];
      assert.equal(f.terminal(),null,'an extra public relationship is not authorized');
    }
  });

  test(`${browser}: fallback checks the specified failure cause`,()=>{
    for(const trigger of ['unavailable','publish_failed','not_published']){
      const c=normalize(rawContract([rawAction('p1','twitter'),rawAction('p2','bluesky')],{kind:'fallback',trigger,items:['p1','p2']}));
      for(const cause of ['unavailable','publish_failed']){
        assert.deepEqual(api.publicationProgress(c,{p1:{status:'failed',cause}}).eligible,
          trigger==='not_published'||trigger===cause?['p2']:[]);
      }
    }
  });

  test(`${browser}: media-only publication has an explicit empty body`,async()=>{
    const action=rawAction('p1','twitter');action.posts[0].body={kind:'empty',source:null};action.posts[0].media=count('image',1,1);
    const raw=rawContract([action]);assert.equal(normalize(raw).actions[0].posts[0].body.value,'');
    const composer=snapshot('');composer.posts[0].attachments=[{type:'image',src:'https://cdn/image.png'}];
    const f=await dispatchedFixture(raw,'Post an image on X without a caption',composer);
    f.page.workflowResourceRecords[0].bodyText='';f.page.workflowResourceRecords[0].attachments=structuredClone(composer.posts[0].attachments);
    assert(f.terminal());
    f.page.workflowResourceRecords[0].bodyText='Unrequested caption';assert.equal(f.terminal(),null);
  });

  test(`${browser}: contract runtime methods stay mirrored`,()=>{
    assert(Agent.prototype._socialPublishedContractMatches.toString().includes('publicationMediaMatches'));
    const prompt=api.publicationContractMessages({request:'Do not publish anything'})[0].content;
    assert.match(prompt,/negation/);
    assert.match(prompt,/never independent permission/);
  });

}

test('Chrome and Firefox share the contract runtime and composer extraction', async () => {
  assert.equal(fs.readFileSync('src/chrome/src/agent/social-publish-contract.js','utf8'),fs.readFileSync('src/firefox/src/agent/social-publish-contract.js','utf8'));
  const {Agent:Chrome}=await import('../src/chrome/src/agent/agent.js');
  const {Agent:Firefox}=await import('../src/firefox/src/agent/agent.js');
  const methods=Object.getOwnPropertyNames(Chrome.prototype).filter(name=>/^_(?:socialPublication|ensureSocialPublication|socialPublishedContract|socialSnapshot|adoptLiveSocial|missingSocial|recordSocialPublish)/.test(name));
  for(const name of methods) assert.equal(Chrome.prototype[name].toString()===Firefox.prototype[name].toString(),true,name);
  const composer=Agent=>{
    const source=Agent._submitActionProbe.toString();
    return source.slice(source.indexOf('const publicationEditorText ='),source.indexOf('const transactionOrderSite ='));
  };
  assert.equal(composer(Chrome)===composer(Firefox),true,'composer snapshot parity');
  const chromeInvariant=await import('../src/chrome/src/agent/completion-invariant.js');
  const firefoxInvariant=await import('../src/firefox/src/agent/completion-invariant.js');
  assert.equal(chromeInvariant.publicationResourceRecordRoot.toString()===firefoxInvariant.publicationResourceRecordRoot.toString(),true,'publication record parity');
  assert.equal(chromeInvariant.publicationReplyParent.toString()===firefoxInvariant.publicationReplyParent.toString(),true,'published reply parent parity');
});
