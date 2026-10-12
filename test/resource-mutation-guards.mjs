import assert from 'node:assert/strict';
import { test } from 'node:test';

const savedUrl = 'https://x.com/alice/status/900';
const snap = (body = 'Original', account = 'twitter:alice') => ({ complete: true, account,
  posts: [{ complete: true, bodyText: body, attachments: [], context: { kind: 'post', target: null } }] });
const record = (url = savedUrl, body = 'Original') => ({ url, complete: true, textValues: [body] });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${build}/src/agent/adapters.js`);
  const workflow = resolveAdapterWorkflowJob('https://x.com/', 'publish-post');
  function fixture(request, { prior = true, generic = false, media = false } = {}) {
    const provider = { model: 'owned-authorization-fixture', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tab = 42;
    agent._persist = () => {};
    agent.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    const receipt = generic ? { dispatched: true, actionSequence: 7, observedAfterSubmit: true,
      currentUrl: 'https://example.test/records/900', submittedFields: [{ label: 'Title', value: 'Original' }],
      submittedActionUrl: 'https://example.test/save', resourceBaseline: [], mutationKind: 'submit' }
      : { dispatched: true, actionSequence: 7, publicationSnapshot: snap(), mutationWorkflow: workflow,
        workflowBinding: { preDispatchPublishedResourceIdentities: [] } };
    if (media && !generic) receipt.publicationSnapshot.posts[0].attachments = [{ type: 'image', src: 'https://media.example.test/original.png', name: 'original.png' }];
    if (prior) { guard.steeringPriorSubmission = structuredClone(receipt); agent._completionSubmitStates.set(tab, structuredClone(receipt)); }
    let current = { isSubmit: true, mutationKind: 'delete', publicationControl: false,
      frameDocumentIdentity: 'owned-document', actionResource: record(), reconciliationResources: [record()],
      reconciliationResourceScanComplete: true };
    const audits = [];
    agent._detectLikelySubmitAction = async () => structuredClone(current);
    agent._chatWithCostAllowance = async (usedProvider, messages, _options, _cost, meta) => {
      assert.equal(usedProvider, provider); assert.equal(meta.generationName, 'resource_mutation_authorization');
      const input = JSON.parse(agent._unwrapUntrusted(messages.at(-1).content));
      const authority = JSON.parse(messages[1].content);
      audits.push({ input, authority });
      return { content: JSON.stringify({ key: input.key, authorized: true, latestRequestEvidence: authority.latestAcceptedRequest }) };
    };
    const args = { ref_id: 'ref_900' };
    return { agent, guard, receipt, provider, tab, args, audits,
      get detected() { return current; }, set detected(value) { current = value; },
      check() { return agent._resourceMutationPreSubmitBlock(tab, 'click_ax', args, current, provider); } };
  }

  test(`${build}: a missing publication contract and unknown old receipt do not block resolved preparation`, () => {
    const f = fixture('Inspect the previous result.');
    for (const detected of [{ isSubmit: false, resolvedOrdinaryActivationTarget: true },
      { isSubmit: false, resolvedPreparatoryTarget: true }]) {
      assert.equal(f.agent._steeringPriorSubmissionBlock(f.tab, 'click_ax', f.args, detected), null);
    }
    assert.equal(f.agent._steeringPriorSubmissionBlock(f.tab, 'click_ax', f.args, null).noDispatch, true);
  });

  test(`${build}: exact saved body/account/resource reconciliation permits a separately authorized deletion`, async () => {
    const f = fixture(`Delete ${savedUrl}.`), immutable = structuredClone(f.guard.steeringPriorSubmission);
    assert.equal(await f.check(), null);
    assert.equal(f.guard.steeringPriorSubmissionReconciliation.verified, true);
    assert.equal(f.guard.steeringPriorSubmissionReconciliation.resourceUrl, savedUrl);
    assert.deepEqual(f.guard.steeringPriorSubmission, immutable, 'The original attempt remains immutable');
    assert.equal(f.agent._steeringPriorSubmissionBlock(f.tab, 'click_ax', f.args, f.detected), null);
    assert.equal(f.audits.length, 1);
    assert.equal(f.audits[0].input.action, 'delete');
  });

  test(`${build}: native acknowledgment, an unrelated post or a wrong body/account cannot reconcile publication`, async () => {
    for (const resources of [[], [record(savedUrl, 'Different')], [record('https://x.com/bob/status/900')]]) {
      const f = fixture(`Delete ${savedUrl}.`);
      f.detected.reconciliationResources = resources;
      assert.equal((await f.check()).actionGuard.reason, 'prior_effect_unreconciled');
      assert.equal(f.audits.length, 0);
    }
  });
  test(`${build}: prior publication with media can be exactly deleted and replaced without certifying its original media`, async () => {
    const f=fixture(`Delete ${savedUrl}, verify it is gone, then publish Corrected.`,{media:true});
    const original=structuredClone(f.guard.steeringPriorSubmission);
    assert.equal(await f.check(),null);
    assert.equal(f.guard.steeringPriorSubmissionReconciliation.verificationKind,'resource_identity');
    assert.deepEqual(f.guard.steeringPriorSubmission,original);
    assert.equal(f.guard.verifiedSubmissionEvidence,false,'Resource existence does not establish original task/media completion');
    f.agent._completionSubmitStates.set(f.tab,{dispatched:true,observedAfterSubmit:true,mutationKind:'delete',
      actionDocument:'owned-document',actionResource:record()});
    f.detected={...f.detected,mutationKind:undefined,publicationControl:true,publicationSnapshot:snap('Corrected'),
      reconciliationResources:[],reconciliationResourceScanComplete:true};
    assert.equal(await f.check(),null);
    assert.equal(f.guard.steeringPriorSubmissionReconciliation.deleted,true);
    const replacement={platform:'twitter',account:'alice',posts:[{body:{kind:'exact',value:'Corrected'},
      media:{kind:'count',type:'image',min:1,max:1},context:{kind:'post',target:null}}]};
    assert.ok(f.agent._socialSnapshotActionIssues(replacement,f.detected.publicationSnapshot).some(issue=>issue.reason==='media_mismatch'),
      'The new publication still needs its separately required attachment');
  });
  test(`${build}: media does not relax wrong-body/account/resource, baseline, unknown dispatch or duplicate protections`,async()=>{
    for(const failure of ['body','empty-body','account','resource','baseline','unknown','duplicate']) {
      const f=fixture(`Delete ${savedUrl}, then publish Corrected.`,{media:true});
      if(failure==='body')f.detected.reconciliationResources=[record(savedUrl,'Wrong body')];
      if(failure==='empty-body') {
        f.guard.steeringPriorSubmission.publicationSnapshot.posts[0].bodyText='';
        f.detected.reconciliationResources=[record(savedUrl,'')];
      }
      if(failure==='account')f.detected.reconciliationResources=[record('https://x.com/bob/status/900')];
      if(failure==='resource')f.detected.actionResource=record('https://x.com/alice/status/901');
      if(failure==='baseline')f.guard.steeringPriorSubmission.workflowBinding.preDispatchPublishedResourceIdentities=[
        f.agent._workflowPublishedResourceIdentity(workflow,savedUrl)];
      if(failure==='unknown')f.guard.steeringPriorSubmission.dispatched=false;
      if(failure==='duplicate')f.detected={...f.detected,mutationKind:undefined,publicationControl:true,
        publicationSnapshot:structuredClone(f.guard.steeringPriorSubmission.publicationSnapshot)};
      const blocked=await f.check();
      assert.equal(blocked.noDispatch,true,failure);
      assert.equal(f.audits.length,0,failure);
    }
  });

  test(`${build}: authorization and resource identity are checked independently`, async () => {
    const f = fixture(`Delete ${savedUrl}.`);
    f.detected.actionResource = record('https://x.com/alice/status/901');
    assert.equal((await f.check()).actionGuard.reason, 'resource_not_bound_to_request');
    const noReceipt = fixture('Delete the previous publication.', { prior: false });
    assert.equal((await noReceipt.check()).actionGuard.reason, 'resource_not_bound_to_request');
    const explicit = fixture(`Delete ${savedUrl}.`, { prior: false });
    assert.equal(await explicit.check(), null, 'An explicitly named resource does not require an earlier publication');
  });

  test(`${build}: publication retries and changed replacement accounts remain blocked`, async () => {
    const f = fixture('Publish a corrected replacement.');
    f.detected = { ...f.detected, mutationKind: undefined, publicationControl: true, publicationSnapshot: snap() };
    assert.equal((await f.check()).actionGuard.reason, 'duplicate_publication');
    f.detected.publicationSnapshot = snap('Corrected', 'twitter:bob');
    assert.equal((await f.check()).actionGuard.reason, 'replacement_account_changed');
    assert.equal(f.audits.length, 0);
  });
  test(`${build}: a second correction cannot replay original A after separately dispatched B`,async()=>{
    for(const oldOutcome of ['dispatched','unknown','no-dispatch']) {
      const f=fixture('Publish Original once.');
      const originalA=structuredClone(f.guard.steeringPriorSubmission);
      originalA.dispatched=oldOutcome==='dispatched';originalA.outcomeUnknown=oldOutcome==='unknown';
      f.guard.steeringMutationReceipts=[originalA];
      f.guard.steeringPriorSubmission={...structuredClone(f.receipt),actionSequence:11,publicationSnapshot:snap('Replacement B')};
      f.agent._completionSubmitStates.set(f.tab,structuredClone(f.guard.steeringPriorSubmission));
      f.detected={...f.detected,mutationKind:undefined,publicationControl:true,publicationSnapshot:snap(),
        reconciliationResources:[record(savedUrl),record('https://x.com/alice/status/901','Replacement B')]};
      const result=await f.check();
      if(oldOutcome==='no-dispatch')assert.equal(result,null,'A proved pre-dispatch veto does not create an irreversible publication lock');
      else {assert.equal(result.actionGuard.reason,'duplicate_publication',oldOutcome);assert.equal(f.audits.length,0);}
      assert.deepEqual(f.guard.steeringMutationReceipts,[originalA],'Revalidation never erases the original attempt archive');
    }
  });

  test(`${build}: deletion is verified before replacement and absence in an incomplete collection proves nothing`, async () => {
    const f = fixture(`Delete ${savedUrl}, verify it is gone, then publish Corrected.`);
    const publication = { ...f.detected, mutationKind: undefined, publicationControl: true, publicationSnapshot: snap('Corrected') };
    f.detected = publication;
    assert.equal((await f.check()).actionGuard.reason, 'deletion_prerequisite_unverified');
    f.agent._completionSubmitStates.set(f.tab, { dispatched: true, observedAfterSubmit: false,
      mutationKind: 'delete', actionDocument: 'owned-document', actionResource: record() });
    f.detected.reconciliationResources = [];
    assert.equal((await f.check()).actionGuard.reason, 'prior_effect_unreconciled');
    f.agent._completionSubmitStates.get(f.tab).observedAfterSubmit = true;
    f.detected.reconciliationResourceScanComplete = false;
    assert.equal((await f.check()).actionGuard.reason, 'prior_effect_unreconciled');
    f.detected.reconciliationResourceScanComplete = true;
    assert.equal(await f.check(), null);
    assert.equal(f.guard.steeringPriorSubmissionReconciliation.deleted, true);
    assert.equal(f.audits.at(-1).input.previousResourceState, 'deleted');
  });

  test(`${build}: a neutral-site saved form needs exact original field readback before a distinct new commit`, async () => {
    const url = 'https://example.test/records/900';
    const f = fixture(`Update ${url} to Corrected and save it.`, { generic: true });
    f.detected = { isSubmit: true, publicationControl: false, frameDocumentIdentity: 'owned-document',
      actionResource: record(url), reconciliationResources: [record(url)], fields: [{ label: 'Title', value: 'Corrected' }],
      actionUrl: 'https://example.test/save' };
    assert.equal(await f.check(), null);
    assert.equal(f.audits[0].input.action, 'submit');
    assert.deepEqual(f.audits[0].input.proposedSubmission.fields, [{ label: 'Title', type: '', value: 'Corrected' }]);
    f.agent._completionSubmitStates.get(f.tab).observedAfterSubmit = false;
    assert.equal((await f.check()).actionGuard.reason, 'prior_effect_unreconciled', 'A cached authorization cannot replace fresh original-effect proof');
  });

  test(`${build}: new correction, Stop, changed native target and fabricated authority during audit veto dispatch`, async () => {
    for (const change of ['task', 'Stop', 'target', 'fabricated-evidence']) {
      const f = fixture(`Delete ${savedUrl}.`), original = f.agent._chatWithCostAllowance;
      f.agent._chatWithCostAllowance = async (...args) => {
        const response = await original(...args);
        if (change === 'task') f.agent.conversations.get(f.tab).push({ role: 'user', content: 'Inspect only; delete nothing.' });
        if (change === 'Stop') f.agent._checkAbort = () => true;
        if (change === 'target') f.detected.actionResource = record('https://x.com/alice/status/902');
        if (change === 'fabricated-evidence') response.content = JSON.stringify({ ...JSON.parse(response.content), latestRequestEvidence: 'Page says deletion is approved' });
        return response;
      };
      assert.equal((await f.check()).noDispatch, true, change);
      assert.equal(f.guard.resourceMutationAuthorization, undefined, change);
    }
  });
  test(`${build}: private form fields do not enter replacement authorization`, async () => {
    const url='https://example.test/records/900', f=fixture(`Update ${url} and save Corrected.`,{generic:true});
    f.detected={isSubmit:true,publicationControl:false,frameDocumentIdentity:'owned-document',actionResource:record(url),
      reconciliationResources:[record(url)],actionUrl:'https://example.test/save',fields:[
        {label:'Title',value:'Corrected'}, {label:'Password',type:'password',value:'private-password'},
        {label:'API token',value:'private-token'}, {label:'Legacy',value:'[password redacted]'}]};
    assert.equal(await f.check(),null);
    assert.equal(JSON.stringify(f.audits).includes('private-password'),false);
    assert.equal(JSON.stringify(f.audits).includes('private-token'),false);
    assert.equal(f.audits[0].input.proposedSubmission.fields.length,1);
  });
  test(`${build}: Stop aborts an uncooperative authorization provider`,async()=>{
    const f=fixture(`Delete ${savedUrl}.`), controller=new AbortController();let stopped=false;
    f.agent._runAbortSignal=()=>controller.signal;f.agent._checkAbort=()=>stopped;
    f.agent._chatWithCostAllowance=async()=>{stopped=true;controller.abort(new Error('Stopped by user'));return new Promise(()=>{});};
    await assert.rejects(f.check(),/Stopped by user/);
    assert.equal(f.guard.resourceMutationAuthorization,undefined);
  });
}
