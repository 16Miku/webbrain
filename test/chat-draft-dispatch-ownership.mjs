import assert from 'node:assert/strict';
import { test } from 'node:test';

const area={get:async()=>({}),set:async()=>{},remove:async()=>{}};
globalThis.chrome=globalThis.browser={runtime:{getURL:x=>`extension://owned/${x}`},storage:{local:area,session:area},tabs:{get:async id=>({id,url:'https://web.telegram.org/k/#123456'})}};
const threadKey='dom:telegram:k:123456:0',body='Owned exact reply.';
for(const build of ['chrome','firefox']){
  const {Agent}=await import(`../src/${build}/src/agent/agent.js`);
  const setup=()=>{
    const tabId=93;let provider={model:'owned',config:{model:'owned'}};
    const agent=new Agent({getActive:()=>provider});
    agent._persist=()=>{};agent._persistNow=async()=>true;
    agent.conversations.set(tabId,[{role:'system',content:'Owned fixture runtime.'},{role:'user',content:'Reply once in the authorized current conversation.'}]);
    agent._beginCompletionInvariant(tabId);
    assert.ok(agent._nativeChatOwnerScope(tabId),'The original fixture is genuinely owned before testing its retirement.');
    const observation={success:true,url:'https://web.telegram.org/k/#123456',threadKey,
      nativeChatMessageBaseline:{threadKey,coverage:'mounted_native_id_floor',complete:true,messageIds:['telegram:k:123456:0:1']},
      composer:{available:true,empty:true,ref:'ref_1'},messages:[{id:'telegram:k:123456:0:1:rquestion',direction:'incoming',text:'Owned question?'}]};
    let childCalls=0,submitted=0,readProof=true;
    agent._readChatObservation=async()=>({...structuredClone(observation),...(readProof&&!observation.composer.empty?{_nativeChatDraftCurrent:true}:{})});
    agent._messageRecipientGuardBlock=async(_tab,_name,_args,_url,context)=>{
      context.messageRecipientNativeChatBaseline=structuredClone(observation.nativeChatMessageBaseline);return null;};
    agent.executeTool=async(_tab,name,args,_update,context)=>{
      assert.equal(name,'set_field');childCalls++;
      if(!context.nativeChatDraftBinding){observation.composer.empty=false;return {success:true,verified:true,dispatched:true,
        submissionDispatched:false,submissionBlockedBeforeDispatch:true,outcomeUnknown:true,_nativeChatDraftBinding:{token:'actual-private-child-fixture'}};}
      submitted++;observation.composer.empty=true;observation.nativeChatMessageBaseline.messageIds.push('telegram:k:123456:0:2');
      observation.messages.push({id:'telegram:k:123456:0:2',direction:'outgoing',text:args.text});
      return {success:true,verified:true,dispatched:true,submissionDispatched:true,outcomeUnknown:true};
    };
    const send=()=>agent._sendChatWorkflow(tabId,{thread_key:threadKey,composer_ref:'ref_1',text:body});
    return {agent,tabId,observation,send,get childCalls(){return childCalls;},get submitted(){return submitted;},
      changeProvider(){provider={...provider};},changeConfig(){provider.config.model='changed';},setReadProof(value){readProof=value;}};
  };
  test(`${build}: owned draft requires a genuine later observation and new send decision`,async()=>{
    const f=setup();await f.agent._observeChatWorkflow(f.tabId);const blocked=await f.send();
    assert.equal(blocked.reason,'native_chat_submit_blocked_before_dispatch');assert.equal(blocked.dispatched,true);
    assert.equal(blocked.submissionDispatched,false);assert.equal(blocked.outcomeUnknown,true);
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound.dispatchedAt,undefined);
    assert.equal(JSON.stringify(blocked).includes('actual-private-child-fixture'),false);
    const premature=await f.send();assert.equal(premature.reason,'composer_not_empty');assert.equal(f.childCalls,1);
    const fresh=await f.agent._observeChatWorkflow(f.tabId);assert.equal(fresh.ownedDraftRecovery.available,true);
    const sent=await f.send();assert.equal(sent.deliveryVerified,true);assert.equal(sent.success,true);
    assert.equal(f.childCalls,2);assert.equal(f.submitted,1);assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound,null);
  });
  for(const change of ['stop','provider-object','provider-config','new-same-text-task','new-run','queued-steering','missing-live-proof','changed-floor','foreign-thread','manual-draft'])test(`${build}: ${change} cannot promote an old draft to a new send`,async()=>{
    const f=setup();await f.agent._observeChatWorkflow(f.tabId);await f.send();await f.agent._observeChatWorkflow(f.tabId);
    if(change==='stop')f.agent.abort(f.tabId);
    if(change==='provider-object')f.changeProvider();if(change==='provider-config')f.changeConfig();
    if(change==='new-same-text-task')f.agent.conversations.get(f.tabId).push({role:'user',content:'Reply once in the authorized current conversation.'});
    if(change==='new-run')f.agent._beginCompletionInvariant(f.tabId);
    if(change==='queued-steering')f.agent._steeringRuns.set(f.tabId,{messages:[{id:'new',text:'New task'}],revision:0,authorizedRevision:0});
    if(change==='missing-live-proof')f.setReadProof(false);
    if(change==='changed-floor')f.observation.nativeChatMessageBaseline.messageIds.push('telegram:k:123456:0:35');
    if(change==='foreign-thread')f.observation.threadKey='dom:telegram:k:987654:0';
    if(change==='manual-draft')f.agent._nativeChatPreparedDrafts.clear();
    const result=await f.send();assert.equal(result.success,false);assert.equal(result.noDispatch,true);
    assert.equal(f.childCalls,1);assert.equal(f.submitted,0);
  });
  test(`${build}: communication loss or actual Enter never creates recoverable no-submit evidence`,async()=>{
    for(const kind of ['communication','actual-enter','missing-private-lease']){
      const f=setup();await f.agent._observeChatWorkflow(f.tabId);
      f.agent.executeTool=async(_tab,_name,_args,_update,context)=>{f.observation.composer.empty=false;
        context._contentActionDispatchState.started=true;
        if(kind==='communication')throw new Error('Owned receiver closed after draft write');
        return {success:true,verified:true,dispatched:true,outcomeUnknown:true,
          submissionDispatched:kind==='actual-enter',submissionBlockedBeforeDispatch:kind!=='actual-enter'};};
      const result=await f.send();assert.equal(result.success,false);assert.equal(result.outcomeUnknown,true);
      assert.equal(f.agent._nativeChatPreparedDrafts?.has(f.tabId)||false,false);
      assert.ok(f.agent.chatSessions.get(f.tabId).pendingOutbound);
      assert.equal((await f.agent._observeChatWorkflow(f.tabId)).ownedDraftRecovery,undefined);
      assert.equal((await f.send()).reason,'composer_not_empty');
    }
  });

  test(`${build}: explicit reconcile flag observes a known pre-Enter draft without clearing or prompting`,async()=>{
    const f=setup();await f.agent._observeChatWorkflow(f.tabId);const blocked=await f.send();
    assert.equal(blocked.composer.empty,false);assert.equal(blocked.composer.requiresFreshObservation,true);
    assert.equal(blocked.submissionOutcomeUnknown,false);assert.equal(blocked.outcomeUnknown,true);
    const key=f.agent.chatSessions.get(f.tabId).pendingOutbound.key;let confirmations=0;
    f.agent._confirmPendingChatReconciliation=async()=>{confirmations++;return null;};
    const fresh=await f.agent._observeChatWorkflow(f.tabId,{reconcile_pending_outbound:true,pending_outbound_key:key});
    assert.equal(confirmations,0);assert.equal(fresh.ownedDraftRecovery.available,true);
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound.key,key);assert.equal(f.submitted,0);
    assert.equal((await f.send()).deliveryVerified,true);assert.equal(f.childCalls,2);assert.equal(f.submitted,1);
  });
  test(`${build}: retained latest-only draft observation requires repair before a new send`,async()=>{
    const f=setup();await f.agent._observeChatWorkflow(f.tabId);await f.send();const key=f.agent.chatSessions.get(f.tabId).pendingOutbound.key;
    f.agent._readChatObservation=async()=>({...structuredClone(f.observation),composer:{...f.observation.composer,available:false},
      _nativeChatDraftRetained:true,nativeChatReadRepair:{phase:'read_latest',direction:'bottom',ref_id:'ref_99'}});
    let confirmations=0;f.agent._confirmPendingChatReconciliation=async()=>{confirmations++;return null;};
    const fresh=await f.agent._observeChatWorkflow(f.tabId,{reconcile_pending_outbound:true,pending_outbound_key:key});
    assert.equal(confirmations,0);assert.equal(fresh.ownedDraftRecovery.available,false);
    assert.equal(fresh.nativeChatReadRepair.direction,'bottom');assert.equal(fresh.ownedDraftRecovery.submissionDispatched,false);
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound.key,key);
    assert.equal((await f.send()).success,false);assert.equal(f.childCalls,1);assert.equal(f.submitted,0);
  });
  for(const change of ['actual-enter','missing-lease','wrong-key','wrong-body','wrong-thread','expired','provider','task','run','steering'])test(`${build}: ${change} cannot suppress unknown-send reconciliation using a draft marker`,async()=>{
    const f=setup();await f.agent._observeChatWorkflow(f.tabId);await f.send();let key=f.agent.chatSessions.get(f.tabId).pendingOutbound.key;
    if(change==='actual-enter'||change==='missing-lease')f.agent._nativeChatPreparedDrafts.clear();
    if(change==='wrong-key')key='other';
    if(change==='wrong-body')f.agent.chatSessions.get(f.tabId).pendingOutbound.text='Different pending body';
    if(change==='wrong-thread')f.observation.threadKey='dom:telegram:k:987654:0';
    if(change==='expired')f.agent._nativeChatPreparedDrafts.get(f.tabId).expiresAt=0;
    if(change==='provider')f.changeProvider();
    if(change==='task')f.agent.conversations.get(f.tabId).push({role:'user',content:'Different current task'});
    if(change==='run')f.agent._beginCompletionInvariant(f.tabId);
    if(change==='steering')f.agent._steeringRuns.set(f.tabId,{messages:[{id:'new',text:'Different current task'}],revision:0,authorizedRevision:0});
    let confirmations=0;f.agent._confirmPendingChatReconciliation=async()=>{confirmations++;return null;};
    const result=await f.agent._observeChatWorkflow(f.tabId,{reconcile_pending_outbound:true,pending_outbound_key:key});
    assert.equal(result.success,false);assert.equal(result.ownedDraftRecovery,undefined);
    assert.equal(confirmations,change==='wrong-key'?0:1);assert.equal(f.submitted,0);assert.ok(f.agent.chatSessions.get(f.tabId).pendingOutbound);
  });
  test(`${build}: generic draft mutation cannot become a dispatched outbound marker`,async()=>{
    const f=setup();const pending={key:'owned',threadKey,text:body,dispatchId:'one'};
    f.agent.chatSessions.set(f.tabId,{threadKey,pendingOutbound:pending});
    await f.agent._settleGenericChatDispatch(f.tabId,{genericChatPending:{key:'owned',threadKey,dispatchId:'one'}},
      {success:true,verified:true,dispatched:true,submissionDispatched:false},true,true);
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound.dispatchedAt,undefined);
    assert.equal(f.agent.chatSessions.get(f.tabId).pendingOutbound,pending);
  });
}
