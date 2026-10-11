import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome','firefox']) {
  const { createChatSession, advanceChatSession, decideChatSend, markChatSendPending, serializeChatSession, normalizeNativeOpaqueBaseline } =
    await import(`../src/${build}/src/agent/chat-workflow.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createCompletionInvariantState, recordCompletionToolResult } = await import(`../src/${build}/src/agent/completion-invariant.js`);
  test(`${build}: opaque historical body alone cannot clear a restored WhatsApp pending send`, () => {
    const peer = 'whatsapp:phone:' + 'a'.repeat(32), threadKey = 'dom:' + peer;
    const before = { success: true, threadKey, composer: { available: true, empty: true },
      messages: [{ id: peer + ':incoming-1', direction: 'incoming', text: 'Owned question' }] };
    const observed = advanceChatSession(createChatSession(), before);
    const decision = decideChatSend(observed.session, before, 'Owned pending reply');
    assert.equal(decision.ok, true);
    const restarted = serializeChatSession(markChatSendPending(observed.session, decision));
    const historical = { ...before, messages: [...before.messages,
      { id: peer + ':old-body-remount', direction: 'outgoing', text: 'Owned pending reply' }] };
    const after = advanceChatSession(restarted, historical);
    assert.ok(after.session.pendingOutbound, 'Opaque old body/order provides no native delivery certificate.');
    assert.equal(decideChatSend(after.session, historical, 'Owned pending reply').ok, false);
  });

  function prepared() {
    const agent = new Agent({}), provider = { model:'owned-model',config:{ model:'owned-model',apiKey:'fixture-secret-never-export' } };
    agent._activeProvider = () => provider;
    const task = 'Chat with Fixture Mom and deliver one useful reply.';
    agent.conversations.set(1,[{role:'system',content:'Owned system'}, { role:'user',content:task,webbrainResumeTaskId:'resume-owned-task-1' }]);
    agent.completionInvariants.set(1,createCompletionInvariantState('owned-first-run'));
    const peer = 'whatsapp:phone:' + 'a'.repeat(32), threadKey = 'dom:' + peer, url = 'https://web.whatsapp.com/';
    const before = { success:true,threadKey,url,composer:{available:true,empty:true}, messages:[
      {id:peer+':opaque-Z-before',direction:'incoming',text:'Owned question'}],
      nativeChatMessageBaseline:{ schema:'webbrain-native-opaque-baseline/1',complete:true,threadKey,url,
        documentEpoch:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',timeOrigin:123456,
        messageIds:[peer+':opaque-Z-before'],tailId:peer+':opaque-Z-before' } };
    const initial = advanceChatSession(createChatSession(),before), decision = decideChatSend(initial.session,before,'Owned pending reply');
    assert.equal(agent._captureNativeWhatsappPending(1,decision,before,before.nativeChatMessageBaseline),true);
    const pending = serializeChatSession(markChatSendPending(initial.session,decision));
    agent.chatSessions.set(1,pending);
    const after = { ...before,observedAt:new Date().toISOString(),conversationId:peer,conversationIdentity:'Fixture Mom',
      messages:[...before.messages,{id:peer+':opaque-A-after',direction:'outgoing',text:decision.text,authoredText:decision.text}],
      nativeChatDeliveryProof:{schema:'webbrain-native-mounted-delivery/1',threadKey,url,
        documentEpoch:before.nativeChatMessageBaseline.documentEpoch,timeOrigin:123456,
        body:decision.text,baselineMessageIds:[peer+':opaque-Z-before'],messageId:peer+':opaque-A-after'} };
    return {agent,provider,pending,before,after,threadKey};
  }
  test(`${build}: durable native floor survives serialization and verified same-task reboot creates an exact prior receipt`, () => {
    const {agent,pending,after,threadKey} = prepared();
    const baseline = pending.pendingOutbound.nativeOpaqueBaseline;
    assert.ok(normalizeNativeOpaqueBaseline(baseline));
    assert.deepEqual(agent._nativeChatPendingRestore(1),baseline);
    assert.equal(JSON.stringify(baseline).includes('fixture-secret-never-export'),false);
    agent.completionInvariants.set(1,createCompletionInvariantState('owned-reboot-run'));
    agent._planExecutionGuards.set(1,{enabled:true,taskKey:baseline.taskKey,requiresSubmission:true,requiresStateChange:true,
      messaging:{target_kind:'named',recipients:[{identity:'Fixture Mom',role:'to'}]} });
    const advanced = advanceChatSession(pending,after);
    assert.equal(advanced.pendingDeliveryVerified,true); assert.equal(advanced.session.pendingOutbound,null);
    agent._rememberRecoveredWhatsappDelivery(1,pending,after,advanced);
    assert.ok(advanced.session.completionReceipt);
    agent.chatSessions.set(1,advanced.session);
    const result = agent._chatCompletionObservationResult(1,after,advanced);
    assert.ok(result.chatGoalDeliveryVerification);
    const evidence = agent._nativeChatTerminalEvidence(1,result,after.url);
    assert.equal(evidence.priorVerifiedGoal,true); assert.equal(evidence.threadKey,threadKey);
  });
  for (const changed of ['missing-proof','document','baseline-order','body','peer','new-task-same-text','provider-config']) {
    test(`${build}: reboot ${changed} cannot turn uncertainty into a delivery receipt`, () => {
      const {agent,pending,after,provider} = prepared();
      if (changed==='missing-proof') delete after.nativeChatDeliveryProof;
      if (changed==='document') after.nativeChatDeliveryProof.documentEpoch='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      if (changed==='baseline-order') after.nativeChatDeliveryProof.baselineMessageIds.push(after.nativeChatDeliveryProof.baselineMessageIds[0]);
      if (changed==='body') after.nativeChatDeliveryProof.body='Other reply';
      if (changed==='peer') after.nativeChatDeliveryProof.threadKey='dom:whatsapp:phone:'+'b'.repeat(32);
      if (changed==='new-task-same-text') agent.conversations.get(1).push({role:'user',content:agent.conversations.get(1)[1].content,
        webbrainResumeTaskId:'resume-owned-task-2'});
      if (changed==='provider-config') provider.config.model='other-model';
      const advanced = advanceChatSession(pending,after);
      if (!['new-task-same-text','provider-config'].includes(changed)) assert.ok(advanced.session.pendingOutbound);
      else assert.equal(agent._nativeChatPendingRestore(1),null,'A new genuine turn/config cannot request private floor revival.');
      agent.completionInvariants.set(1,createCompletionInvariantState('owned-reboot-run'));
      agent._planExecutionGuards.set(1,{enabled:true,taskKey:agent._progressTaskKeyHash(1),requiresSubmission:true,requiresStateChange:true,
        messaging:{target_kind:'named',recipients:[{identity:'Fixture Mom',role:'to'}]} });
      agent._rememberRecoveredWhatsappDelivery(1,pending,after,advanced);
      assert.equal(advanced.session.completionReceipt,null);
    });
  }
  test(`${build}: only app-certified native identity repair skips consequential action accounting`, () => {
    const repaired={success:true,dispatched:true,_nativeWhatsappReadRepair:true};
    const state=recordCompletionToolResult(createCompletionInvariantState(),'click_ax',{},repaired,{nativeChatReadRepair:true});
    assert.equal(state.hadAction,false);
    for (const [name,args,result,option] of [
      ['click_ax',{nativeChatReadRepair:true},repaired,undefined],
      ['click_ax',{}, {success:true,content:'native identity repair'}, {nativeChatReadRepair:true}],
      ['set_field',{},repaired,{nativeChatReadRepair:true}],
      ['click_ax',{}, {...repaired,outcomeUnknown:true},{nativeChatReadRepair:true}],
    ]) assert.equal(recordCompletionToolResult(createCompletionInvariantState(),name,args,result,option).verificationDebt,true);
    for (const owner of ['owned-current','owned-changed']) {
      const agent=new Agent({});agent._nativeChatOwnerScope=()=>owner;
      agent.completionInvariants.set(1,createCompletionInvariantState('owned-run'));
      agent._recordCompletionToolResult(1,'click_ax',{nativeChatReadRepair:true},repaired,
        {messageRecipientContext:{nativeWhatsappReadRepairOwner:'owned-current'}});
      assert.equal(agent.completionInvariants.get(1).hadAction,owner!=='owned-current');
    }
  });
  test(`${build}: a task or provider change during a native observation cannot clear durable pending state`, async () => {
    const originalBrowser = globalThis.browser;
    try {
      for (const change of ['task','provider','stop']) {
        const { agent, provider, pending, after } = prepared();
        agent._currentUrl = async () => after.url;
        let release;
        const dispatch = (_tab, name, params) => {
          assert.equal(name, 'observe_chat');
          assert.ok(params._nativeChatOwner);
          return new Promise(resolve => { release = () => resolve(after); });
        };
        agent._sendDevContentAction = dispatch;
        globalThis.browser = { tabs: { sendMessage: (tab, message) => dispatch(tab, message.action, message.params) } };
        const reading = agent._readChatObservation(1);
        while (!release) await Promise.resolve();
        if (change === 'task') agent.conversations.get(1).push({ role:'user',
          content:agent.conversations.get(1)[1].content, webbrainResumeTaskId:'new-genuine-task' });
        if (change === 'provider') provider.config.model = 'other-model';
        if (change === 'stop') agent._checkAbort = () => true;
        release();
        const result = await reading;
        assert.equal(result.success, false);
        assert.equal(result.reason, 'native_chat_owner_changed');
        assert.equal(result.nativeChatDeliveryProof, undefined);
        assert.deepEqual(agent.chatSessions.get(1), pending, 'An old owner cannot reconcile or resend the durable pending body.');
      }
    } finally { globalThis.browser = originalBrowser; }
  });
}
