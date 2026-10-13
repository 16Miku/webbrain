import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';
import {chromium,firefox} from 'playwright';
import {Agent as ChromeAgent} from '../src/chrome/src/agent/agent.js';
import {Agent as FirefoxAgent} from '../src/firefox/src/agent/agent.js';
import {cdpClient} from '../src/chrome/src/cdp/cdp-client.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=','base64'),html=Buffer.from('<!doctype html><html>viewer</html>');
for(const kind of ['chrome','firefox'])test(`${kind}: actual normal Agent upload respects bytes before page assignment`,async t=>{
 const native=await(kind==='chrome'?chromium:firefox).launch();const page=await native.newPage();
 const savedChrome=globalThis.chrome,savedBrowser=globalThis.browser,attach=cdpClient.attach,send=cdpClient.sendCommand;
 try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<input id="file" type="file" accept="image/*"><script>window.events=[];for(const n of ["input","change"])document.addEventListener(n,e=>events.push(e.type));</script>'}));await page.goto('https://owned.example.test/upload');
 const api={runtime:{},tabs:{async get(){return{id:71,url:page.url()};},async executeScript(_tab,p){return[await page.evaluate(code=>window.eval(code),p.code)];},async sendMessage(){return{success:true};}}};
 globalThis.chrome=api;globalThis.browser=api;
 if(kind==='chrome'){const cdp=await page.context().newCDPSession(page);cdpClient.attach=async()=>{};cdpClient.sendCommand=(_t,m,p={})=>cdp.send(m,p);}
 const Agent=kind==='chrome'?ChromeAgent:FirefoxAgent;const agent=new Agent({getActive:()=>({supportsVision:false})});agent._resolvePromptTier=()=> 'full';agent._currentUrl=async()=>page.url();
 const state=()=>page.evaluate(()=>({events:events.slice(),files:Array.from(document.querySelector('#file').files).map(f=>({name:f.name,size:f.size}))}));
 await t.test('renamed HTML rejects known no-dispatch in the real handler',async()=>{
 const [a]=agent._registerUserAttachments(71,[{name:'image.png',mimeType:'image/png',dataUrl:`data:image/png;base64,${html.toString('base64')}`}]);
 const r=await agent._executeToolImpl(71,'upload_file',{selector:'#file',attachmentId:a.attachmentId});
 assert.equal(r.success,false);assert.equal(r.noDispatch,true);assert.equal(r.dispatched,false);assert.equal(r.reasonCode,'file_type_mismatch');assert.deepEqual(await state(),{events:[],files:[]});
 });
 await t.test('actual PNG attaches once through the same real handler',async()=>{
 const [a]=agent._registerUserAttachments(71,[{name:'image.png',mimeType:'image/png',dataUrl:`data:image/png;base64,${png.toString('base64')}`}]);
 const r=await agent._executeToolImpl(71,'upload_file',{selector:'#file',attachmentId:a.attachmentId});
 assert.equal(r.success,true);assert.equal(r.verified,false);assert.equal(r.remoteStateVerified,false);assert.deepEqual(await state(),{events:['input','change'],files:[{name:'image.png',size:png.length}]});
 });
 }finally{globalThis.chrome=savedChrome;globalThis.browser=savedBrowser;cdpClient.attach=attach;cdpClient.sendCommand=send;await native.close();}
});
for(const kind of ['chrome','firefox'])test(`${kind}: recipient binding and BiDi preparation cannot override file accept`,async t=>{
 const native=await(kind==='chrome'?chromium:firefox).launch();const page=await native.newPage();
 const savedChrome=globalThis.chrome,savedBrowser=globalThis.browser,attach=cdpClient.attach,send=cdpClient.sendCommand;
 try{
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('https://www.instagram.com/direct/t/123/');
 await page.setContent(`<style>body{margin:0;font:16px sans-serif}#composer{position:fixed;left:340px;top:390px;width:430px;height:200px}textarea{width:300px;height:90px}h2{position:fixed;left:350px;top:60px}</style><form id="composer"><h2 id="recipient">Gamze</h2><textarea id="body" aria-label="Message"></textarea><input id="file" type="file" accept="image/*" hidden><span id="counter">1</span><button type="button">Send</button></form><input id="other" type="file" hidden>`);
 await page.evaluate(()=>{window.handlers=[];const runtime={onMessage:{addListener(fn){handlers.push(fn);}},getURL:p=>p};window.chrome={runtime};window.browser={runtime};window.events=[];for(const n of ['input','change'])document.querySelector('#file').addEventListener(n,e=>events.push(e.type));});
 for(const file of ['file-upload-policy.js','rich-text-toolbar-heuristic.js','accessibility-tree.js','content.js'])await page.addScriptTag({content:await fs.readFile(new URL(`../src/${kind}/src/content/${file}`,import.meta.url),'utf8')});
 const deliver=m=>page.evaluate(m=>new Promise(resolve=>{for(const f of handlers)f(m,{},resolve);}),m);
 const api={runtime:{},tabs:{async get(){return{id:71,url:page.url()};},async sendMessage(_t,m){return deliver(m);},async executeScript(_t,p){return[await page.evaluate(code=>window.eval(code),p.code)];}}};globalThis.chrome=api;globalThis.browser=api;
 if(kind==='chrome'){const cdp=await page.context().newCDPSession(page);cdpClient.attach=async()=>{};cdpClient.sendCommand=(_t,m,p={})=>cdp.send(m,p);}
 const Agent=kind==='chrome'?ChromeAgent:FirefoxAgent;const agent=new Agent({getActive:()=>({supportsVision:false})});agent._resolvePromptTier=()=> 'full';agent._currentUrl=async()=>page.url();agent._planExecutionGuards.set(71,{messaging:{target_kind:'named',recipients:['Gamze']},requiresSubmission:true,requiresStateChange:true});
 const state=()=>page.evaluate(()=>({events:events.slice(),files:document.querySelector('#file').files.length}));
 await t.test('actual recipient proof never overrides accept mismatch',async()=>{
 const [a]=agent._registerUserAttachments(71,[{name:'image.png',mimeType:'image/png',dataUrl:`data:image/png;base64,${html.toString('base64')}`}]);const args={selector:'#file',attachmentId:a.attachmentId},ctx={};
 assert.equal(await agent._messageRecipientGuardBlock(71,'upload_file',args,page.url(),ctx),null);assert.ok(ctx.messageRecipientDispatchBinding?.token);
 const r=await agent.executeTool(71,'upload_file',args,null,ctx);assert.equal(r.success,false);assert.equal(r.noDispatch,true);assert.equal(r.reasonCode,'file_type_mismatch');assert.deepEqual(await state(),{events:[],files:0});
 });
 if(kind==='firefox')await t.test('BiDi preparation rejects before native target token is created',async()=>{
 const r=await deliver({target:'content',action:'bidi_prepare_upload',params:{selector:'#file',base64:html.toString('base64'),filename:'image.png',mimeType:'image/png',_bidiPrepare:'00000000-0000-4000-8000-000000000001'}});
 assert.equal(r.noDispatch,true);assert.equal(r.reasonCode,'file_type_mismatch');assert.equal(await page.locator('#file').getAttribute('data-webbrain-bidi'),null);assert.deepEqual(await state(),{events:[],files:0});
 });
 }finally{globalThis.chrome=savedChrome;globalThis.browser=savedBrowser;cdpClient.attach=attach;cdpClient.sendCommand=send;await native.close();}
});

// Offline owned-Agent dispatch races: browser transports are simulated, no session opens.
import os from 'node:os';
import path from 'node:path';
let savedPathNextTab = 871;
const savedPathDeferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function savedPathHarness({ pause, change, memory = false, monitorChange = null, transportFailure = false } = {}) {
  const tab = savedPathNextTab++, requestId = `owned-upload-offline-${tab}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-upload-fence-'));
  const filename = path.join(dir, 'image.png'); await fs.writeFile(filename, png);
  const savedApi = globalThis.chrome, savedBrowser = globalThis.browser;
  const saved = Object.fromEntries(['attach', 'querySelectorPierce', 'releaseObjectGroup', 'probeLocalFile', 'getFileInputFiles'].map(k => [k, cdpClient[k]]));
  const state = { connected: true, fileInput: true, disabled: false, accept: 'image/*', token: 'offline-document', revision: 0,
    physicalCalls: 0, events: [], monitorCalls: 0, byteReads: 0, targetCalls: 0, phases: [], accepted: null,
    started: false, prefixBytesUnchanged: true, signalAbortedAtChange: null };
  let agent, feedback, paused = false;
  const reached = savedPathDeferred(), resume = savedPathDeferred();
  const mutate = async at => {
    state.phases.push(`pause:${at}`);
    if (change === 'steer') {
      state.accepted = agent.steerMessage(tab, 'Do not attach the previous file. Only calculate 2 + 2.', { requestId, messageId: `correction-${tab}` });
      state.signalAbortedAtChange = agent._runAbortSignal(tab).aborted;
    } else if (change === 'feedback') {
      state.accepted = agent.observePageFeedback({ tab: { id: tab }, frameId: 0, documentId: 'browser-doc', url: 'https://owned.example.test/upload' },
        { ...feedback, seq: 1, kind: 'input', source: 'user', revision: 1, target: 'input#other' });
    } else if (change === 'abort') agent.abort(tab);
    else if (change === 'file') await fs.writeFile(filename, '<!doctype html><html>changed</html>');
    else if (change === 'accept') state.accept = 'application/pdf';
    else if (change === 'disabled') state.disabled = true;
    else if (change === 'detached') state.connected = false;
    else if (change === 'type') state.fileInput = false;
  };
  const pauseAt = async at => {
    if (pause !== at || paused) return;
    paused = true; reached.resolve(); await resume.promise; await mutate(at);
  };
  const metadata = () => ({ connected: state.connected, fileInput: state.fileInput, disabled: state.disabled, accept: state.accept });
  const api = {
    runtime: { getURL: v => `extension://offline/${v}` }, storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'browser-doc', url: 'https://owned.example.test/upload' }] },
    tabs: {
      get: async () => ({ id: tab, url: 'https://owned.example.test/upload' }),
      sendMessage: async (_tab, message) => {
        const run = agent?._pageFeedbackRuns.get(tab);
        const base = { runToken: run?.token, documentToken: state.token };
        if (message.action === 'page_monitor_capture_model') return { ...base, ready: true, snapshotToken: `captured-${tab}`,
          targetCount: 1, page: { success: true, pageContent: 'file input selector="#file" accept="image/*"', url: 'https://owned.example.test/upload' } };
        if (message.action === 'page_monitor_validate_model') return { ...base, ready: true, snapshotToken: `captured-${tab}` };
        if (message.action === 'page_monitor_prepare') return { ready: true, modelBindingValid: true };
        if (message.action === 'page_monitor_dispatch') {
          state.monitorCalls++; state.phases.push('owner-fence');
          await pauseAt('monitor');
          if (monitorChange) {
            if (monitorChange === 'steer') {
              state.accepted = agent.steerMessage(tab, 'Do not attach this file.', { requestId, messageId: `monitor-correction-${tab}` });
              state.signalAbortedAtChange = agent._runAbortSignal(tab).aborted;
            } else if (monitorChange === 'abort') agent.abort(tab);
            else {
              state[monitorChange === 'accept' ? 'accept' : monitorChange === 'detached' ? 'connected' : 'disabled'] = monitorChange === 'accept' ? 'application/pdf' : monitorChange === 'disabled';
              state.accepted = agent.observePageFeedback({ tab: { id: tab }, frameId: 0, documentId: 'browser-doc', url: 'https://owned.example.test/upload' },
                { ...feedback, seq: 1, kind: 'dom', source: 'unknown', revision: 1, target: 'input#file' });
            }
          }
          return { guard: { ...base, operationId: message.params.operationId, revision: state.revision } };
        }
        return { ready: true, active: true, ...base };
      },
    },
    debugger: { sendCommand: (_debuggee, method, params, callback) => {
      const run = async () => {
        if (method === 'Runtime.callFunctionOn') {
          const declaration = params.functionDeclaration || '';
          if (declaration.includes('data-webbrain-native-target')) {
            state.targetCalls++; state.phases.push('target-capture'); await pauseAt('target');
            return { result: { value: state.connected ? { nativeTarget: params.arguments[0].value, documentToken: state.token, documentRevision: state.revision } : null } };
          }
          if (declaration.includes('transfer.items.add(file)')) {
            state.physicalCalls++; state.events.push('input', 'change');
            return { result: { value: { success: true, dispatched: true, name: 'image.png', size: png.length, type: 'image/png' } } };
          }
          if (declaration.includes('connected: this.isConnected')) {
            state.phases.push('final-input-read'); await pauseAt('input');
          } else state.phases.push('initial-input-read');
          return { result: { value: metadata() } };
        }
        if (method === 'DOM.setFileInputFiles') {
          state.physicalCalls++; state.events.push('input', 'change'); state.phases.push('physical-attachment');
          if (transportFailure) throw new Error('Attachment command reply lost');
        }
        return {};
      };
      void run().then(callback, error => { api.runtime.lastError = { message: error.message }; try { callback(); } finally { delete api.runtime.lastError; } });
    } },
  };
  globalThis.chrome = api; globalThis.browser = api;
  cdpClient.attach = async () => { cdpClient.sessions.set(tab, {}); };
  cdpClient.querySelectorPierce = async () => ({ objectIds: ['native-input'], objectGroup: `objects-${tab}` });
  cdpClient.releaseObjectGroup = async () => {};
  cdpClient.getFileInputFiles = async () => state.physicalCalls ? [{ name: 'image.png', size: png.length, readable: true }] : [];
  cdpClient.probeLocalFile = async (_tab, p, options = {}) => {
    if (options.includeData) {
      state.byteReads++; state.phases.push(`saved-read:${state.byteReads}`);
      if (state.byteReads === 2) await pauseAt('file');
    }
    const data = await fs.readFile(p), stat = await fs.stat(p);
    return { exists: true, readable: true, filename: path.basename(p), size: data.length, lastModified: stat.mtimeMs, mimeType: 'image/png',
      ...(options.includeData ? { base64: data.subarray(0, options.readPrefixBytes || data.length).toString('base64') } : {}) };
  };
  const provider = { promptTier: 'full', supportsVision: false, model: 'offline' };
  agent = new ChromeAgent({ getActive: () => provider, getProvider: () => provider });
  agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
  await agent._claimRunEntry(tab, 'interactive', { detachedRequestId: requestId }, () => {});
  feedback = agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'browser-doc', url: 'https://owned.example.test/upload' }, state.token);
  assert.equal(feedback.active, true);
  const messages = [{ role: 'user', content: 'Attach the selected image to the current form.' }];
  agent.conversations.set(tab, messages);
  await agent._capturePageFeedbackModelState(tab, messages);
  assert.ok(agent._pageFeedbackRuns.get(tab).modelState.actionBinding);
  const dispatchState = { started: false };
  let args = { selector: '#file', filePath: filename };
  if (memory) {
    const [attachment] = agent._registerUserAttachments(tab, [{ name: 'image.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` }]);
    args = { selector: '#file', attachmentId: attachment.attachmentId };
  }
  const promise = agent.executeTool(tab, 'upload_file', args, () => {}, { _contentActionDispatchState: dispatchState });
  if (pause) { await reached.promise; resume.resolve(); }
  let result;
  try { result = await promise; } finally {
    state.started = dispatchState.started;
    if (state.accepted) assert.equal(state.accepted.accepted, true);
    if (change === 'steer' || monitorChange === 'steer') assert.equal(state.signalAbortedAtChange, false, 'Accepted steering must exercise the non-aborted current run');
    agent._releaseRunEntry(tab); cdpClient.sessions.delete(tab);
    for (const [k, value] of Object.entries(saved)) cdpClient[k] = value;
    globalThis.chrome = savedApi; globalThis.browser = savedBrowser;
    const ownedDirectory = await fs.realpath(dir);
    assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-upload-fence-'));
    await fs.rm(ownedDirectory, { recursive: true, force: true });
  }
  return { result, state };
}

for (const pause of ['file', 'input']) for (const change of ['steer', 'feedback']) test(`Chrome saved-path final fence: real owned Agent blocks ${change} during final ${pause} read`, async () => {
  const { result, state } = await savedPathHarness({ pause, change });
  assert.equal(state.physicalCalls, 0, 'No DOM.setFileInputFiles after the genuine current-owner change');
  assert.deepEqual(state.events, []); assert.equal(state.started, false);
  assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
  assert.notEqual(result.outcomeUnknown, true); assert.equal(result.pageFeedbackPending, true);
});
test('Chrome saved-path final fence: unchanged actual Agent attaches once with one final owner fence', async () => {
  const { result, state } = await savedPathHarness();
  assert.equal(result.success, true); assert.equal(result.verified, false); assert.equal(result.remoteStateVerified, false);
  assert.equal(state.physicalCalls, 1); assert.deepEqual(state.events, ['input', 'change']); assert.equal(state.started, true);
  assert.equal(state.monitorCalls, 1); assert.equal(state.targetCalls, 1);
  assert.ok(state.phases.indexOf('owner-fence') < state.phases.indexOf('physical-attachment'));
});
for (const pause of ['file', 'input']) test(`Chrome saved-path final fence: real Stop during final ${pause} read is known no-dispatch`, async () => {
  const { result, state } = await savedPathHarness({ pause, change: 'abort' });
  assert.equal(state.physicalCalls, 0); assert.equal(state.started, false); assert.deepEqual(state.events, []);
  assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
  assert.notEqual(result.outcomeUnknown, true);
});
test('Chrome saved-path final fence: saved file identity change remains known no-dispatch', async () => {
  const { result, state } = await savedPathHarness({ pause: 'file', change: 'file' });
  assert.equal(result.reasonCode, 'file_identity_changed'); assert.equal(result.noDispatch, true); assert.equal(result.outcomeUnknown, false);
  assert.equal(state.physicalCalls, 0); assert.ok(state.monitorCalls <= 1); assert.equal(state.started, false);
});
for (const change of ['accept', 'disabled', 'detached', 'type']) test(`Chrome saved-path final fence: current input ${change} change remains known no-dispatch`, async () => {
  const { result, state } = await savedPathHarness({ pause: 'input', change });
  assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false); assert.equal(result.outcomeUnknown, false);
  assert.equal(state.physicalCalls, 0); assert.ok(state.monitorCalls <= 1); assert.equal(state.started, false);
});
for (const monitorChange of ['steer', 'abort', 'accept', 'disabled', 'detached']) test(`Chrome saved-path final fence: current owner catches ${monitorChange} during its final round trip`, async () => {
  const { result, state } = await savedPathHarness({ monitorChange });
  assert.equal(result.success, false); assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false);
  assert.equal(state.monitorCalls, 1); assert.equal(state.physicalCalls, 0); assert.equal(state.started, false); assert.deepEqual(state.events, []);
});
test('Chrome saved-path final fence: actual command reply loss remains dispatched rather than known no-dispatch', async () => {
  const { result, state } = await savedPathHarness({ transportFailure: true });
  assert.equal(result.success, false); assert.equal(result.dispatched, true); assert.notEqual(result.noDispatch, true);
  assert.equal(state.physicalCalls, 1); assert.equal(state.started, true);
});
test('Chrome saved-path final fence: saved-memory lane already checks the genuine owner after target preparation', async () => {
  const { result, state } = await savedPathHarness({ memory: true, pause: 'target', change: 'steer' });
  assert.equal(result.noDispatch, true); assert.equal(result.dispatched, false); assert.notEqual(result.outcomeUnknown, true);
  assert.equal(state.physicalCalls, 0); assert.equal(state.started, false); assert.deepEqual(state.events, []);
});
