import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { BidiSession } from '../firefox-companion/session.mjs';
const profile = await mkdtemp(join(tmpdir(), 'webbrain-firefox-test-'));
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<button id="click">Click</button><input id="text"><input id="file" type="file"><script>
    window.events=[]; document.addEventListener('click',e=>events.push(['click',e.isTrusted]));
    document.addEventListener('input',e=>events.push(['input',e.isTrusted]));
    document.querySelector('#click').onclick=()=>{window.answer=confirm('Continue?')};
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const firefox = spawn(process.env.FIREFOX_BINARY || '/Applications/Firefox.app/Contents/MacOS/firefox', ['--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let session;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi')), 20000);
    let output = '';
    firefox.stderr.on('data', data => { output += data; const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    firefox.on('error', reject);
  });
  session = new BidiSession();
  await session.connect(port);
  await session.send('webExtension.install', { extensionData: { type: 'path', path: fileURLToPath(new URL('../src/firefox/', import.meta.url)) } });
  const { context } = await session.send('browsingContext.create', { type: 'tab' });
  await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
  const evaluate = async expression => (await session.send('script.evaluate', { target: { context }, expression, awaitPromise: true })).result;
  const mark = async selector => {
    const token = crypto.randomUUID();
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute('data-webbrain-bidi', ${JSON.stringify(token)})`);
    return { token, url };
  };
  const runId = crypto.randomUUID();
  const binding = await mark('html'); await session.openRun(runId, binding.token, binding.url);
  assert.equal((await session.perform(runId, 'click', await mark('#click'))).success, true);
  assert.equal((await evaluate('window.answer')).value, false, 'unapproved confirm must be dismissed');
  assert.equal((await evaluate('events.some(e => e[0] === "click" && e[1])')).value, true);
  await evaluate(`document.querySelector('#click').onclick=()=>{window.answer=prompt('Input?')}`);
  await session.perform(runId, 'click', await mark('#click'));
  assert.equal((await evaluate('window.answer')).type, 'null');
  await evaluate(`document.querySelector('#click').onclick=()=>{alert('Notice');window.acknowledged=true}`);
  await session.perform(runId, 'click', await mark('#click'));
  assert.equal((await evaluate('window.acknowledged')).value, true);
  const typed = await session.perform(runId, 'field', { ...await mark('#text'), text: 'Hello Firefox', clear: true });
  assert.equal(typed.verified, true);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Hello Firefox');
  await evaluate(`document.querySelector('#text').setSelectionRange(1, 1)`);
  const appended = await session.perform(runId, 'type', { ...await mark('#text'), text: ' world' });
  assert.equal(appended.verified, true);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Hello Firefox world');
  assert.equal((await evaluate('events.some(e => e[0] === "input" && e[1])')).value, true);
  const uploaded = await session.perform(runId, 'upload', { ...await mark('#file'), filename: 'sample.txt', base64: Buffer.from('upload test').toString('base64') });
  assert.equal(uploaded.success, true);
  assert.equal((await evaluate('document.querySelector("#file").files[0].text()')).value, 'upload test');
  const tree = await session.send('browsingContext.getTree', {});
  const extensionContext = tree.contexts.find(item => item.url?.startsWith('moz-extension://'));
  assert.ok(extensionContext, 'installed extension opens onboarding');
  const extensionOrigin = new URL(extensionContext.url).origin === 'null' ? extensionContext.url.split('/').slice(0, 3).join('/') : new URL(extensionContext.url).origin;
  const extensionEval = async expression => {
    const result = await session.send('script.evaluate', { target: { context: extensionContext.context }, expression, awaitPromise: true });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
    return result.result;
  };
  const tabId = (await extensionEval(`browser.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(url)}).id)`)).value;
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<canvas id="point-canvas" style="position:fixed;left:10px;top:200px;width:300px;height:60px"></canvas>'); document.querySelector('#point-canvas').onclick=e=>window.clickedPoint={x:e.clientX,y:e.clientY,trusted:e.isTrusted};`);
  const pointToken = crypto.randomUUID();
  const pointResponse = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content',action:'click',params:{x:22,y:210,coordinate_space:'css',_bidiPrepare:${JSON.stringify(pointToken)}}}).then(value=>JSON.stringify(value))`);
  const pointPrepared = JSON.parse(pointResponse.value);
  assert.deepEqual(pointPrepared.point,{x:22,y:210});
  await session.perform(runId,'click',{token:pointToken,url,point:pointPrepared.point});
  assert.deepEqual(JSON.parse((await evaluate('JSON.stringify(window.clickedPoint)')).value),{x:22,y:210,trusted:true});
  await evaluate(`document.body.insertAdjacentHTML('beforeend', '<input id="checkable" type="checkbox"><input id="blocked-checkable" type="checkbox">'); document.querySelector('#blocked-checkable').onclick=event=>event.preventDefault();`);
  const checked = await session.perform(runId, 'click', {
    ...await mark('#checkable'),
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'checkable' },
  });
  assert.equal(checked.success, true);
  assert.equal(checked.verified, true);
  assert.equal(checked.checkedAfter, true);
  const blockedCheck = await session.perform(runId, 'click', {
    ...await mark('#blocked-checkable'),
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'blocked-checkable' },
  });
  assert.equal(blockedCheck.success, false);
  assert.equal(blockedCheck.verified, false);
  assert.equal(blockedCheck.noProgress, true);
  await evaluate(`document.body.style.minHeight='3000px'; document.body.insertAdjacentHTML('beforeend', '<button id="below-fold" style="position:absolute;top:2600px">Below fold</button>'); document.querySelector('#below-fold').onclick=e=>window.belowFoldTrusted=e.isTrusted;`);
  const belowFoldToken = crypto.randomUUID();
  const belowFoldPrepared = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content',action:'click',params:{selector:'#below-fold',_bidiPrepare:${JSON.stringify(belowFoldToken)}}}).then(value=>JSON.stringify(value))`);
  assert.equal(JSON.parse(belowFoldPrepared.value).bidiPrepared, true);
  assert.equal((await session.perform(runId, 'click', { token: belowFoldToken, url })).success, true);
  assert.equal((await evaluate('window.belowFoldTrusted')).value, true);
  await evaluate(`document.activeElement.blur()`);
  assert.equal((await session.perform(runId, 'key', { ...await mark('body'), key: 'Escape' })).success, true);
  const shadowToken = crypto.randomUUID();
  await evaluate(`const host=document.createElement('div'); host.id='shadow-host'; host.style.cssText='position:fixed;left:20px;top:300px'; host.attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow button</button>'; host.shadowRoot.querySelector('button').setAttribute('data-webbrain-bidi', ${JSON.stringify(shadowToken)}); host.shadowRoot.querySelector('button').onclick=e=>window.shadowTrusted=e.isTrusted; document.body.append(host);`);
  const shadowNode = await session.send('script.evaluate', { target: { context }, expression: "document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-button')", awaitPromise: true });
  const locate = session.locate;
  session.locate = async () => ({ context, node: { sharedId: shadowNode.result.sharedId } });
  assert.equal((await session.perform(runId, 'click', { token: shadowToken, url })).success, true);
  session.locate = locate;
  assert.equal((await evaluate('window.shadowTrusted')).value, true);
  const obscured = await mark('#point-canvas');
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="point-cover" style="position:fixed;left:20px;top:205px;width:10px;height:10px;background:red;z-index:99999"></div>')`);
  await assert.rejects(session.perform(runId,'click',{...obscured,point:{x:22,y:210}}), error=>error.dispatchState.noDispatch===true && /covered/.test(error.message));
  await evaluate(`document.querySelector('#point-canvas').remove();document.querySelector('#point-cover').remove()`);
  const token = crypto.randomUUID();
  const prepared = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content', action:'type', params:{selector:'#text', text:'Through extension', clear:true, _bidiPrepare:${JSON.stringify(token)}}}).then(value => JSON.stringify(value))`);
  assert.equal(JSON.parse(prepared.value).bidiPrepared, true, 'packaged content script prepares a target');
  assert.equal((await session.perform(runId, 'type', { token, url, text: 'Through extension', clear: true })).verified, true);
  // A newline is literal editing, never an Enter-to-send shortcut.
  await evaluate(`document.body.insertAdjacentHTML('beforeend', '<textarea id="multiline"></textarea><input id="other">'); window.enters=0; document.addEventListener('keydown', e=>{if(e.key==='Enter'){window.enters++;e.preventDefault()}});`);
  const multiline = await session.perform(runId, 'field', { ...await mark('#multiline'), text: 'first\nsecond', clear: true, submit: false });
  assert.equal(multiline.verified, true);
  assert.equal((await evaluate('window.enters')).value, 0);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'first\nsecond', clear: true, submit: false }), /multiline/);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Through extension');
  // Focus handlers must not redirect a secret into another input.
  await evaluate(`document.querySelector('#other').focus(); document.querySelector('#text').onfocus=()=>document.querySelector('#other').focus();`);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'private payload', clear: true }), /Target|Focus/);
  assert.equal((await evaluate('document.querySelector("#other").value')).value, '');
  await evaluate(`document.querySelector('#text').onfocus=null;`);
  await evaluate(`document.querySelector('#text').oninput=()=>{if(document.querySelector('#text').value==='ready')document.querySelector('#other').focus()};`);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'ready', clear: true, submit: true }), /Focus changed/);
  assert.equal((await evaluate('window.enters')).value, 0);
  await evaluate(`document.querySelector('#text').oninput=null; document.body.insertAdjacentHTML('beforeend','<div id="rich" contenteditable="true" style="width:300px;height:80px;border:1px solid"></div>');`);
  assert.equal((await session.perform(runId, 'field', { ...await mark('#rich'), text: 'first\nsecond', clear: true, submit: false })).verified, true);
  assert.equal((await evaluate('window.enters')).value, 0);

  // Invoke the real client in the packaged extension with a transport stub; no
  // native manifest is installed in the user's normal Firefox configuration.
  await session.perform(runId, 'key', { ...await mark('#text'), key: 'Tab', repeat: 2 });
  assert.equal((await evaluate('document.activeElement.id')).value, 'checkable');
  const deferred = await extensionEval(`(async () => {
    const {FirefoxBidiClient} = await import(${JSON.stringify(extensionOrigin + '/src/bidi/client.js')});
    const client = new FirefoxBidiClient(browser);
    client.connect = async () => ({});
    const calls = []; client.request = async (command) => { calls.push(command); return {}; };
    await browser.storage.local.set({firefoxBidiEnabled:true});
    const blank = await browser.tabs.create({url:'about:blank'});
    await client.startRun(blank.id);
    const initial = client.runs.get(blank.id).bound === true;
    await client.perform(blank.id, 'navigate', {url:${JSON.stringify(url)}});
    await new Promise(resolve => setTimeout(resolve, 500));
    await client.bindRun(blank.id, client.runs.get(blank.id));
    const bound = client.runs.get(blank.id).bound;
    client.stopRun(blank.id); await browser.tabs.remove(blank.id);
    await browser.storage.local.set({firefoxBidiEnabled:false});
    return JSON.stringify({initial,bound,calls});
  })()`);
  const deferredResult = JSON.parse(deferred.value);
  assert.equal(deferredResult.initial, false);
  assert.equal(deferredResult.bound, true);
  assert.ok(deferredResult.calls.includes('openRun'));
  const settings = await session.send('browsingContext.create', { type: 'tab' });
  await session.send('browsingContext.navigate', { context: settings.context, url: extensionOrigin + '/src/ui/settings.html', wait: 'complete' });
  await session.send('script.evaluate', { target: { context: settings.context }, expression: "(async () => { document.querySelector('[data-tab=display]').click(); await new Promise(r => setTimeout(r, 500)); document.getElementById('firefox-bidi-card').closest('details').open = true; document.getElementById('firefox-bidi-card').scrollIntoView({behavior:'instant', block:'center'}); await new Promise(r => setTimeout(r, 250)); })()", awaitPromise: true });
  const screenshot = await extensionEval(`browser.tabs.query({}).then(tabs => browser.tabs.captureTab(tabs.find(tab => tab.url.endsWith('/src/ui/settings.html')).id, {format:'png'}))`);
  await writeFile('/tmp/webbrain3-firefox-bidi-settings.png', Buffer.from(screenshot.value.split(',')[1], 'base64'));
  await evaluate(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; })`);
  assert.equal((await session.perform(runId, 'navigate', { url: url + 'next' })).success, true);
  assert.equal((await evaluate('location.href')).value, url + 'next');
  await session.closeRun(runId);
  // Remember an idle tab's dialog, but handle it only once a run owns that tab.
  await session.send('browsingContext.navigate', {context, url, wait:'complete'});
  const bind = await mark('html');
  const opened = new Promise(resolve => {
    const receive = session.receive.bind(session);
    session.receive = message => { receive(message); if (message.method === 'browsingContext.userPromptOpened') resolve(); };
  });
  await evaluate('setTimeout(()=>alert("Pending notice"),0)'); await opened;
  assert.ok(session.dialogs.has(context));
  const resumed = crypto.randomUUID();
  await session.openRun(resumed, bind.token, bind.url);
  assert.equal(session.dialogs.has(context), false);
  assert.equal((await session.perform(resumed, 'field', { ...await mark('#text'), text: 'resumed', clear: true })).verified, true);
  // Stop after the first real text key command has been sent. At most that
  // single in-flight character may land; the rest must never be queued.
  const originalSend = session.send.bind(session); let stopped = false;
  session.send = (method, params) => {
    const result = originalSend(method, params);
    if (method === 'input.performActions' && !stopped) {
      stopped = true; void session.closeRun(resumed);
    }
    return result;
  };
  await assert.rejects(session.perform(resumed, 'type', { ...await mark('#text'), text: 'a'.repeat(500) }), /stopped/);
  const afterStop = (await evaluate('document.querySelector("#text").value')).value;
  assert.ok(afterStop.length <= 'resumed'.length + 1, afterStop);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await evaluate('document.querySelector("#text").value')).value, afterStop);
  await assert.rejects(session.perform(resumed, 'click', await mark('#click')), /stopped|disconnected/);
  console.log('PASS: Firefox connection, dialogs, uploads, literal newlines, focus guards, interrupted typing, deferred blank-tab binding, and packaged extension integration');
} finally {
  await session?.close().catch(() => {});
  firefox.kill('SIGTERM');
  await new Promise(resolve => { if (firefox.exitCode != null) resolve(); else { firefox.once('exit', resolve); setTimeout(resolve, 3000); } });
  server.close();
  await rm(profile, { recursive: true, force: true });
}
