import assert from 'node:assert/strict';
import { test } from 'node:test';

let session = {}, failWrite = false, writes = [], writeBudget = Infinity;
const area = {
  get: async key => key === null ? structuredClone(session) : { [key]: structuredClone(session[key]) },
  set: async values => { writes.push(structuredClone(values)); if (failWrite) throw new Error('Storage unavailable'); if (JSON.stringify(values).length > writeBudget) throw new Error('QUOTA_BYTES quota exceeded'); Object.assign(session, structuredClone(values)); },
  remove: async key => { delete session[key]; },
};
globalThis.chrome = globalThis.browser = { alarms:{}, runtime:{ getURL:x=>x }, storage:{ session:area, local:{ get:async()=>({}), set:async()=>{} } } };

for (const build of ['chrome','firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { createTabChatHandoffCoordinator } = await import(`../src/${build}/src/ui/tab-chat-persistence.js`);
  const archive = { id:'source', messages:[{role:'user',text:'recovered conversation',userTextSource:'verbatim'}] };
  async function fixture() {
    session = { 'tabChat:42':'previous transcript', 'tabChatHandoff:42':{ownerId:'panel',generation:1} };
    failWrite = false; writes=[]; writeBudget=Infinity;
    const agent = new Agent({getActive:()=>({supportsVision:false})});
    agent.hydratedTabs.add(42);
    agent.getConversation(42,'ask').push({role:'user',content:'previous conversation'});
    await agent._persistNow(42);
    const handoff = createTabChatHandoffCoordinator(area);
    const recover = (generation=1, html='recovered transcript') => handoff.replace(42,html,{
      ownerId:'panel', handoffGeneration:generation,
      commit:storageEntries=>agent.recoverChatHistory(42,archive,{storageEntries}),
    });
    return {agent,handoff,recover};
  }
  test(`${build}: recovery commits model context, transcript, and handoff together`,async()=>{
    const f=await fixture(); writes=[];
    const result=await f.recover();
    assert.equal(writes.length,1);
    assert.equal(writes[0]['tabChat:42'],'recovered transcript');
    assert.equal(writes[0]['tabChatHandoff:42'].generation,2);
    assert.equal(writes[0]['agentConv:42'].conversationId,result.conversationId);
    assert.equal((await f.handoff.save(42,'stale old transcript',{ownerId:'panel',handoffGeneration:1})).skipped,true);
    assert.equal((await f.handoff.load(42)).html,'recovered transcript');
    // Reopening after losing the response does not depend on the initiating panel.
    const reopened=createTabChatHandoffCoordinator(area);
    assert.equal((await reopened.load(42)).html,'recovered transcript');
    const restarted=new Agent({getActive:()=>({supportsVision:false})});
    await restarted._hydrate(42);
    assert.equal(restarted.conversationIds.get(42),result.conversationId);
    assert.equal(restarted.conversations.get(42)[1].content,'recovered conversation');
  });
  test(`${build}: failed atomic recovery preserves both old model and old UI`,async()=>{
    const f=await fixture(), old=structuredClone(session), oldId=f.agent.conversationIds.get(42);
    await f.handoff.load(42);
    failWrite=true;
    await assert.rejects(f.recover(),/Unable to persist/);
    failWrite=false;
    assert.deepEqual(session,old);
    assert.equal(f.agent.conversationIds.get(42),oldId);
    assert.equal(f.agent.conversations.get(42)[1].content,'previous conversation');
    assert.equal((await f.handoff.load(42)).html,'previous transcript');
  });
  test(`${build}: quota retry compacts both transcript and model in the same write`,async()=>{
    const f=await fixture();
    const html='<div class="message assistant"><div class="message-text">'+ 'old context '.repeat(60000) +' latest result</div></div>';
    writeBudget=300*1024; writes=[];
    const result=await f.recover(1,html);
    assert.equal(writes.length,2);
    assert.ok(writes[0]['tabChat:42'].length>writeBudget);
    assert.ok(writes[1]['tabChat:42'].length<=256*1024);
    assert.match(writes[1]['tabChat:42'],/latest result/);
    assert.equal(writes[1]['agentConv:42'].conversationId,result.conversationId);
    assert.equal(writes[1]['tabChatHandoff:42'].generation,2);
    assert.equal(session['agentConv:42'].conversationId,result.conversationId);
    assert.equal(session['tabChat:42'],writes[1]['tabChat:42']);
    assert.equal((await f.handoff.load(42)).html,html,'The live cache keeps the lossless transcript');
  });
  test(`${build}: stale recovery owner is rejected before changing model context`,async()=>{
    const f=await fixture(), old=structuredClone(session);
    await assert.rejects(f.recover(99),/panel changed/);
    assert.deepEqual(session,old);
    assert.equal(f.agent.conversations.get(42)[1].content,'previous conversation');
  });
}
