import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const html = `<!doctype html><style>button,input,textarea,[contenteditable]{margin:8px} dialog{position:fixed;top:40px;width:400px;height:200px}</style>
<input value="Unrelated search draft" aria-label="Unrelated search">
<section id="composer" data-record-id="7"><div contenteditable="true" aria-label="Comment">Exact observed developer comment.</div><input type="password" value="fixture-password">
<div><div><div><div><div><div><button id="post" type="button"><span>Post</span></button></div></div></div></div></div></div></section>
<section id="other"><button id="menu">Open menu</button></section>
<script>window.count=0;window.clicked=null;document.addEventListener('click',e=>{const button=e.target.closest('button');if(button){window.clicked=button.id;if(button.id==='post')window.count++;}});</script>`;
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addInitScript(() => {
      window.qaListeners = []; window.qaRun = 'click-memory-fixture';
      window.chrome = window.browser = { runtime: { getURL: value => value, onMessage: { addListener: listener => qaListeners.push(listener), removeListener() {} }, async sendMessage(message) { return message.action === 'get_page_monitor_state' ? { active: true, runToken: qaRun, documentToken: message.documentToken } : { accepted: true }; } } };
      window.qaMessage = (action, params = {}) => new Promise(resolve => { for (const listener of qaListeners) { let answered = false; const result = listener({ target: 'content', action, params: { runToken: qaRun, ...params } }, {}, value => { answered = true; resolve(value); }); if (answered || result === true) break; } });
    });
    for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) await page.context().addInitScript({ content: await readFile(new URL(`../src/${name}/src/content/${file}`, import.meta.url), 'utf8') });
    await page.goto(origin + '/item/7');
    const { observeMemoryPageInPage, BotMemorySession } = await import(`../src/${name}/src/agent/bot-memory.js`);
    const { Agent } = await import(`../src/${name}/src/agent/agent.js`);
    globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } }, runtime: { getURL: value => value } };
    const read = args => page.evaluate(observeMemoryPageInPage, { toolName: 'click', ...args });
    const indexed = await page.evaluate(() => {
      for (let index = 0; index < 20; index++) if (__wb_resolve_click_target_for_submit_probe({ index })?.id === 'post') return index;
      throw Error('Fixture post index not found');
    });
    for (const args of [{ text: 'Post', textMatch: 'exact' }, { index: indexed }, { selector: '#post', matchIndex: 0 }]) {
      const observation = await read(args);
      assert.equal(observation.elementFacts.found, true, name+JSON.stringify(args));
      assert.equal(observation.elementFacts.label, 'Post');
      assert.equal(observation.elementFacts.draftText, 'Exact observed developer comment.', 'Deep form-less sibling composer is captured');
      assert.ok(!observation.elementFacts.draftText.includes('Unrelated search'));
      assert.ok(!JSON.stringify(observation).includes('fixture-password'));
      assert.equal(await page.evaluate(() => window.count), 0, 'Observation does not click or focus');
    }
    const menu = await read({ text: 'Open menu' });
    assert.equal(menu.elementFacts.draftText, '', 'A button without its own editor does not collect unrelated page inputs');
    const selector = await read({ selector: 'button', matchIndex: 1 });
    assert.equal(selector.elementFacts.label, 'Open menu');
    const hidden = await page.evaluate(() => { const button=document.createElement('button');button.id='other-post';button.textContent='Post';document.querySelector('#other').append(button);return true; });
    assert.equal(hidden, true);
    assert.equal((await read({ text: 'Post', textMatch: 'exact' })).elementFacts.found, false, 'Multiple distinct Post controls remain ambiguous');
    await page.locator('#other-post').evaluate(node => node.remove());
    await page.evaluate(() => { const dialog=document.createElement('dialog');dialog.open=true;dialog.innerHTML='<button id="modal-post">Post</button>';document.body.append(dialog); });
    assert.equal(await page.evaluate(() => __wb_resolve_click_target_for_submit_probe({ text: 'Post' })?.id), 'modal-post', 'Text matching is scoped to the current dialog');
    await page.locator('dialog').evaluate(node => node.remove());
    await page.evaluate(() => { const box=document.createElement('section');box.id='labels-fixture';box.innerHTML='<label style="display:none" for="first-label">Hidden fallback</label><input id="first-label"><label style="display:none" for="last-label">Hidden fallback</label><input id="last-label"><label style="display:none">Hidden adjacent</label><input id="adjacent-label">';document.body.append(box); });
    assert.equal(await page.evaluate(() => __wb_resolve_click_target_for_submit_probe({text:'Hidden fallback'})?.id),'last-label','Duplicate fallback labels keep the dispatcher Map last-wins order');
    assert.equal(await page.evaluate(() => !!__wb_resolve_click_target_for_submit_probe({text:'Hidden adjacent'})),false,'No-match fallback does not invent an adjacent label target');
    await page.locator('#labels-fixture').evaluate(node=>node.remove());
    await page.evaluate(()=>{const box=document.createElement('section');box.id='select-fixture';box.innerHTML='<button id="prefix-save">Save settings</button><select><option>Other</option><option>Save</option></select>';document.body.append(box);});
    assert.equal(await page.evaluate(()=>!!__wb_resolve_click_target_for_submit_probe({text:'Save'})),false,'Exact option rescue cannot authorize the earlier prefix button');
    assert.equal(await page.evaluate(()=>document.querySelector('#select-fixture select').value),'Other','Memory observation never changes a selected option');
    await page.locator('#select-fixture').evaluate(node=>node.remove());
    for (const [attribute, hint] of [['id','api_key'],['placeholder','PIN'],['placeholder','CVV'],['id','passphrase']]) {
      await page.evaluate(({attribute,hint})=>{const box=document.createElement('section');box.id='credential-fixture';box.innerHTML='<div><div><div><div><div><button id="credential-post">Post credential draft</button></div></div></div></div></div>';const input=document.createElement('input');input.setAttribute(attribute,hint);input.value='credential-fixture-value';box.prepend(input);document.body.append(box);},{attribute,hint});
      const observation=await read({selector:'#credential-post'});
      assert.equal(observation.elementFacts.draftText,'','Credential metadata cannot become the nested publication draft');
      assert.ok(!JSON.stringify(observation).includes('credential-fixture-value'));
      await page.locator('#credential-fixture').evaluate(node=>node.remove());
    }
    await page.evaluate(()=>{const box=document.createElement('section');box.id='credential-fixture';box.innerHTML='<label for="scoped-credential">PIN</label><input id="scoped-credential"><div><div><div><div><div><button id="credential-post">Post credential draft</button></div></div></div></div></div>';box.querySelector('input').value='credential-fixture-value';document.body.append(box);});
    assert.equal((await read({selector:'#credential-post'})).elementFacts.draftText,'','Associated labels also identify credential drafts');
    await page.locator('#credential-fixture').evaluate(node=>node.remove());

    const target = { kind: 'url', url: origin + '/item/7' }, calls = [];
    const session = new BotMemorySession({ version: 1, policyVersion: 1, botId: 'fixture', runId: 'fixture-run', callbackUrl: origin + '/api/internal/bot-memory/fixture-run', callbackToken: 'fixture-only-capability-'.repeat(3), policy: { schemaVersion: 1, actions: [{ key: 'post', effect: 'write' }] }, context: {} }, {
      observe: async (_tab, args) => { const value = await page.evaluate(observeMemoryPageInPage, args); value.targets=[target]; return value; },
      fetchImpl: async (_url, options) => { const value=JSON.parse(options.body);calls.push(value); if(value.operation==='prepare'){assert.equal(value.args.observation.elementFacts.draftText,'Exact observed developer comment.');return Response.json({allowed:true,reservation:{attemptId:'attempt-7',requestId:value.args.requestId,actionKey:'post',target}});}if(value.operation==='dispatch')return Response.json({attempt:{id:'attempt-7',status:'dispatched'}});if(value.operation==='verify')return Response.json({verified:true,status:'verified'});return Response.json({status:value.args.status}); },
    });
    const agent = new Agent({ getActive: () => ({ model: 'fixture' }) });agent._botMemorySessions.set(7,session);
    agent._executeToolWithLifecycle = async (_tab, tool, args) => {
      if(tool==='click'){assert.deepEqual(calls.map(call=>call.operation),['prepare','dispatch']);return page.evaluate(args=>qaMessage('click',args),args);}
      return {success:true,text:'Exact observed developer comment. Posted on item 7.'};
    };
    const action = await agent.executeTool(7,'click',{index:String(indexed)},null,{detectedSubmitAction:{isSubmit:true,method:'POST',url:target.url,action:'/comments'}});
    assert.equal(action.success,true,JSON.stringify(action));
    assert.equal(await page.evaluate(()=>window.count),1,'The real content dispatcher clicks the same observed Post control');
    assert.equal(action.memoryAttemptId,'attempt-7');
    await agent.executeTool(7,'read_page',{});
    assert.deepEqual(calls.map(call=>call.operation),['prepare','dispatch','verify']);
    await session.close();
    console.log(`${name}: click-by-index/text/selector shares observed target, rejects ambiguity, and records before local fixture submission`);
    await browser.close();browser=null;
  }
} finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
