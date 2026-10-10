// Real extension worlds, local pages only; no solver keys or paid requests.
// Requires installed Firefox with BiDi (or FIREFOX_BINARY); Playwright's
// patched Firefox does not reliably support native extension BiDi sessions.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { BidiSession } from '../firefox-companion/session.mjs';

const sitekey = '10000000-ffff-ffff-ffff-000000000001';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'");
  if (url.pathname === '/sdk.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(`window.bridgeAtFirstScript = !!window.__webbrainCaptchaCallbacks;
      (() => {
        const widgets = new Map(); let counter = 0;
        const api = { render(container, params) {
          const element = document.getElementById(container);
          const id = 'widget-' + (++counter);
          const field = document.createElement('textarea');field.name = window.fieldName;field.id = 'answer-' + id;
          element.append(field);widgets.set(id, { params });return id;
        }, getResponse:()=>'', getRespKey:()=>'', reset:()=>{}, remove:()=>{},
        execute(id) { return new Promise((resolve, reject) => Object.assign(widgets.get(id), { resolve, reject })); } };
        const type = new URL(location.href).searchParams.get('type');
        window.fieldName = type==='hcaptcha'?'h-captcha-response':type==='turnstile'?'cf-turnstile-response':'g-recaptcha-response';
        window.api = type==='hcaptcha'?(window.hcaptcha=api):type==='turnstile'?(window.turnstile=api):(window.grecaptcha=api);
      })();`);
    return;
  }
  if (url.pathname === '/page.js') {
    res.setHeader('Content-Type', 'application/javascript');
    // Page-load renders retain closure callbacks before any solver dispatch.
    res.end(`window.renderWidget = () => {
      let accepted = 0;
      const mode = new URL(location.href).searchParams.get('mode');
      const fieldMode = mode?.startsWith('field');
      const complete = token => {
        if (token !== 'fixture-token' || (!fieldMode && api.getResponse(window.renderedWidget) !== token)) throw new Error('app state was not updated');
        document.querySelector('#next').disabled=false;
        document.querySelector('#challenge').hidden=true;
        document.querySelector('#result').textContent='accepted:'+ (++accepted);
        if (mode === 'field-remove') { document.querySelector('#challenge').remove(); document.querySelector('#other').remove(); }
      };
      const asyncMode = new URL(location.href).searchParams.get('mode')==='async';
      const widget=api.render('widget', {sitekey:${JSON.stringify(sitekey)}, ...(asyncMode || fieldMode?{}:{callback:complete})});
      window.renderedWidget = widget;
      if(fieldMode)document.querySelector('#answer-'+widget).addEventListener('change',event=>complete(event.target.value));
      api.render('other', {sitekey:${JSON.stringify(sitekey)},callback:()=>{throw new Error('wrong widget');}});
      if(asyncMode)api.execute(widget,{async:true}).then(({response})=>complete(response));
    };
    window.renderWidgetDelayed = ms => setTimeout(() => window.renderWidget(), ms);
    if(new URL(location.href).searchParams.get('render')!=='late')window.renderWidget();`);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  const widgetClass = url.searchParams.get('type')==='hcaptcha'?'h-captcha':url.searchParams.get('type')==='turnstile'?'cf-turnstile':'g-recaptcha';
  res.end(`<!doctype html><script src="/sdk.js"></script><div id="challenge" role="dialog" aria-label="Security verification"><div id="widget" class="${widgetClass}" data-sitekey="${sitekey}"></div></div><div id="other" class="${widgetClass}" data-sitekey="${sitekey}"></div><button id="next" disabled>Continue</button><output id="result"></output><script src="/page.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const scenarios = [['hcaptcha','callback'],['hcaptcha','async'],['turnstile','callback'],['recaptcha_v2','callback'],['hcaptcha','field'],['turnstile','field-remove']];
const payload = type => ({fieldName:type==='hcaptcha'?'h-captcha-response':type==='turnstile'?'cf-turnstile-response':'g-recaptcha-response',token:'fixture-token',
  target:{frameId:0,websiteKey:sitekey,type,responseFieldId:'answer-widget-1'}});
const probe = `JSON.stringify({early:bridgeAtFirstScript,bridge:!!window.__webbrainCaptchaCallbacks,enabled:!document.querySelector('#next').disabled,result:document.querySelector('#result').textContent,hidden:document.querySelector('#challenge')?.hidden ?? true})`;
async function verifyGate(tabId, input, api) {
  const { Agent } = await import(api.runtime.getURL('src/agent/agent.js'));
  const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
  agent._captchaGateStates.set(tabId, {
    pageUrl: input.target.frameUrl, status: 'verification_pending',
    publicGate: { status: 'verification_pending', solveAttempted: true },
    captchaCandidateIdentity: { ...input.target },
  });
  const observation = await agent._observeCaptchaChallenge(tabId, 'get_accessibility_tree',
    { pageUrl: input.target.frameUrl, pageContent: 'button Continue' }, {});
  return observation.gate;
}
const assertProgress = (build, type, mode, result, state) => {
  assert.equal(result.success, true, `${build} ${type} ${mode}: ${JSON.stringify(result)}`);
  assert.equal(result.calledCallback, !mode.startsWith('field'), JSON.stringify(result));
  assert.equal(result.callbackCandidates, mode.startsWith('field') ? 0 : 1);
  assert.equal(result.callbackBridgeAvailable, true);
  assert.deepEqual(state, {early:true,bridge:true,enabled:true,result:'accepted:1',hidden:true});
  console.log(`PASS ${build}: ${type} ${mode}, page-load capture, single completion${mode === 'field-remove' ? ' after widget removal' : ' and gate clearance'}`);
};
try {
  const profile = await mkdtemp(join(tmpdir(),'webbrain-captcha-chrome-'));
  let context;
  try {
    const extension = resolve('src/chrome');
    context = await chromium.launchPersistentContext(profile, {headless:true,channel:'chromium',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('http**://**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const control = await context.newPage();
    await control.goto(new URL('/src/ui/settings.html', worker.url()).href);
    const page = await context.newPage();
    await page.goto(`${origin}/fixture?type=turnstile&mode=callback&registration-probe=disabled`);
    assert.equal(JSON.parse(await page.evaluate(probe)).early, false, 'bridge should stay absent when no provider is enabled');
    await control.evaluate(async () => {
      await chrome.storage.local.set({ twoCaptchaApiKey: '00000000000000000000000000000000', twoCaptchaEnabled: true });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [bridge] = await chrome.scripting.getRegisteredContentScripts({ ids: ['webbrain-captcha-callback-bridge'] });
        if (bridge) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('CAPTCHA callback bridge was not registered after enabling a provider');
    });
    for (const [type, mode] of scenarios) {
      await page.goto(`${origin}/fixture?type=${type}&mode=${mode}`);
      const input = payload(type);input.target.frameUrl=page.url();
      assert.equal(await page.evaluate('!!window.__webbrainCaptchaCallbacks'), true, 'bridge must capture widgets before the solve');
      const outcome = await control.evaluate(async ({input}) => {
        const tabs = await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===input.target.frameUrl);
        const {injectToken}=await import(chrome.runtime.getURL('src/agent/captcha-solver.js'));
        const injection = await injectToken(tab.id,input);
        const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
        const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
        agent._captchaGateStates.set(tab.id, { pageUrl: input.target.frameUrl, status: 'verification_pending',
          publicGate: { status: 'verification_pending', solveAttempted: true }, captchaCandidateIdentity: { ...input.target } });
        const { gate } = await agent._observeCaptchaChallenge(tab.id, 'get_accessibility_tree',
          {pageUrl:input.target.frameUrl,pageContent:'button Continue'}, {});
        return {injection,gate};
      },{input});
      if (mode !== 'field-remove') assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
      assertProgress('chrome',type,mode,outcome.injection,JSON.parse(await page.evaluate(probe)));
    }
    {
      // Remediation proof: the widget renders 1200ms after injection starts,
      // so only the settle retry can capture its closure.
      const type = 'hcaptcha', mode = 'callback';
      await page.goto(`${origin}/fixture?type=${type}&mode=${mode}&render=late`);
      const input = payload(type);input.target.frameUrl=page.url();
      await page.evaluate('window.renderWidgetDelayed(1200)');
      const outcome = await control.evaluate(async ({input}) => {
        const tabs = await chrome.tabs.query({});const tab=tabs.find(tab=>tab.url===input.target.frameUrl);
        const {injectToken}=await import(chrome.runtime.getURL('src/agent/captcha-solver.js'));
        const injection = await injectToken(tab.id,input);
        const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
        const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
        agent._captchaGateStates.set(tab.id, { pageUrl: input.target.frameUrl, status: 'verification_pending',
          publicGate: { status: 'verification_pending', solveAttempted: true }, captchaCandidateIdentity: { ...input.target } });
        const { gate } = await agent._observeCaptchaChallenge(tab.id, 'get_accessibility_tree',
          {pageUrl:input.target.frameUrl,pageContent:'button Continue'}, {});
        return {injection,gate};
      },{input});
      if (mode !== 'field-remove') assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
      assert.equal(outcome.injection.calledCallback, true, JSON.stringify(outcome.injection));
      assert.equal(outcome.injection.bridgeSettleRetried, true, 'late render must be captured by the settle retry');
      assertProgress('chrome',type,mode+'+late-render',outcome.injection,JSON.parse(await page.evaluate(probe)));
    }
    await control.evaluate(async () => {
      await chrome.storage.local.set({ twoCaptchaEnabled: false });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [bridge] = await chrome.scripting.getRegisteredContentScripts({ ids: ['webbrain-captcha-callback-bridge'] });
        if (!bridge) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('CAPTCHA callback bridge stayed registered after disabling the provider');
    });
    await page.goto(`${origin}/fixture?type=turnstile&mode=callback&registration-probe=disabled-again`);
    assert.equal(JSON.parse(await page.evaluate(probe)).early, false, 'bridge should be removed when no provider is enabled');
  } finally {await context?.close();await rm(profile,{recursive:true,force:true});}

  const firefoxExecutable = process.env.FIREFOX_BINARY || (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');
  const firefoxProbe = spawnSync(firefoxExecutable, ['--version'], { stdio: 'ignore', timeout: 5000 });
  if (firefoxProbe.error?.code === 'ENOENT' && !process.env.FIREFOX_BINARY) {
    console.log('SKIP firefox CAPTCHA bridge UI test: Firefox is not installed or FIREFOX_BINARY is not on PATH');
  } else {
    if (firefoxProbe.error) throw firefoxProbe.error;
    if (firefoxProbe.status !== 0) throw new Error(`Firefox version check failed with status ${firefoxProbe.status}`);
    const profile2 = await mkdtemp(join(tmpdir(),'webbrain-captcha-firefox-'));
    const child = spawn(firefoxExecutable, ['--headless','--remote-allow-system-access','--no-remote','--profile',profile2,'--remote-debugging-port','0'], {stdio:['ignore','pipe','pipe']});
    let session;
    try {
      const port = await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Firefox BiDi did not start')),20000);let output='';
        child.stderr.on('data',data=>{output+=data;const match=output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
        child.on('error',reject);
      });
      session=new BidiSession();await session.connect(port);
      await session.send('webExtension.install',{extensionData:{type:'path',path:resolve('src/firefox')}});
      let control;
      for(let i=0;i<50&&!control;i++){
        const tree=await session.send('browsingContext.getTree',{});control=tree.contexts.find(item=>item.url.startsWith('moz-extension://'));
        if(!control)await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(control,'extension onboarding context must exist');
      const {context:page}=await session.send('browsingContext.create',{type:'tab'});
      const evaluate=async(context,expression)=>{
        const result=await session.send('script.evaluate',{target:{context},expression,awaitPromise:true});
        if(result.type==='exception')throw Error(result.exceptionDetails.text);
        return result.result.value;
      };
      await session.send('browsingContext.navigate',{context:page,url:`${origin}/fixture?type=turnstile&mode=callback&registration-probe=disabled`,wait:'complete'});
      assert.equal(JSON.parse(await evaluate(page,probe)).early,false,'bridge should stay absent when no provider is enabled');
      await evaluate(control.context, `(async()=>{
        await browser.storage.local.set({twoCaptchaApiKey:'00000000000000000000000000000000',twoCaptchaEnabled:true});
        return true;
      })()`);
      let bridgeReady=false;
      for(let attempt=0;attempt<30&&!bridgeReady;attempt++){
        await session.send('browsingContext.navigate',{context:page,url:`${origin}/fixture?type=turnstile&mode=callback&registration-probe=${attempt}`,wait:'complete'});
        bridgeReady=JSON.parse(await evaluate(page,probe)).early;
        if(!bridgeReady)await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(bridgeReady,'CAPTCHA callback bridge should register after enabling a provider');
      for(const [type,mode] of scenarios){
        const url=`${origin}/fixture?type=${type}&mode=${mode}`;
        await session.send('browsingContext.navigate',{context:page,url,wait:'complete'});
        const input=payload(type);input.target.frameUrl=url;
        assert.equal(await evaluate(page,'!!window.__webbrainCaptchaCallbacks'), true, 'bridge must capture widgets before the solve');
        const outcome=JSON.parse(await evaluate(control.context,`(async()=>{
          const tabs=await browser.tabs.query({});const tab=tabs.find(tab=>tab.url===${JSON.stringify(url)});
          const {injectToken}=await import(browser.runtime.getURL('src/agent/captcha-solver.js'));
          const input=${JSON.stringify(input)};
          const injection=await injectToken(tab.id,input);
          const gate=await (${verifyGate.toString()})(tab.id,input,browser);
          return JSON.stringify({injection,gate});
        })()`));
        if (mode !== 'field-remove') assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
        assertProgress('firefox',type,mode,outcome.injection,JSON.parse(await evaluate(page,probe)));
      }
      {
        // Remediation proof: the widget renders 1200ms after injection starts,
        // so only the settle retry can capture its closure.
        const type = 'hcaptcha', mode = 'callback';
        const url=`${origin}/fixture?type=${type}&mode=${mode}&render=late`;
        await session.send('browsingContext.navigate',{context:page,url,wait:'complete'});
        const input=payload(type);input.target.frameUrl=url;
        await evaluate(page,'window.renderWidgetDelayed(1200)');
        const outcome=JSON.parse(await evaluate(control.context,`(async()=>{
          const tabs=await browser.tabs.query({});const tab=tabs.find(tab=>tab.url===${JSON.stringify(url)});
          const {injectToken}=await import(browser.runtime.getURL('src/agent/captcha-solver.js'));
          const input=${JSON.stringify(input)};
          const injection=await injectToken(tab.id,input);
          const gate=await (${verifyGate.toString()})(tab.id,input,browser);
          return JSON.stringify({injection,gate});
        })()`));
        if (mode !== 'field-remove') assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
        assert.equal(outcome.injection.calledCallback, true, JSON.stringify(outcome.injection));
        assert.equal(outcome.injection.bridgeSettleRetried, true, 'late render must be captured by the settle retry');
        assertProgress('firefox',type,mode+'+late-render',outcome.injection,JSON.parse(await evaluate(page,probe)));
      }
      {
        const url = `${origin}/fixture?type=hcaptcha&mode=callback&render=late`;
        await session.send('browsingContext.navigate',{context:page,url,wait:'complete'});
        await evaluate(page, `(async () => {
          const outer = document.createElement('iframe'); outer.name = 'outer';
          outer.srcdoc = '<iframe name="inner" srcdoc="&lt;div id=widget data-sitekey=${sitekey}&gt;&lt;/div&gt;"></iframe>';
          const loaded = new Promise(resolve => outer.onload = resolve);
          document.body.append(outer); await loaded;
          const inner = outer.contentDocument.querySelector('iframe');
          const child = window.descendant = inner.contentWindow;
          child.resetFixture = () => {
            // Simulate a document that never had the bridge, including its SDK
            // property watchers, so reinstalling cannot reuse old registrations.
            delete child.__webbrainCaptchaCallbacks;
            delete child.hcaptcha; delete child.turnstile; delete child.grecaptcha;
            child.document.getElementById('widget').replaceChildren();
            child.accepted = null;
            child.hcaptcha = {
              render(id, params) {
                const field = child.document.createElement('textarea');
                field.name = 'h-captcha-response'; field.id = 'descendant-answer';
                child.document.getElementById(id).append(field); return 'descendant-widget';
              }, getResponse: () => ''
            };
          };
          child.resetFixture();
          child.renderFixture = () => child.hcaptcha.render('widget', {
            sitekey: '${sitekey}', callback: token => { child.accepted = token; }
          });
        })()`);
        const input = {fieldName:'h-captcha-response',token:'fixture-token',target:{
          frameId:0,frameUrl:'about:srcdoc',websiteKey:sitekey,type:'hcaptcha',
          responseFieldId:'descendant-answer',framePath:[
            {index:0,frameUrl:'about:srcdoc',frameName:'outer'},
            {index:0,frameUrl:'about:srcdoc',frameName:'inner'}
          ]}};
        for (const fallback of [false, true]) {
          // Exercise MAIN scripting and the MV2 fallback in the actual descendant.
          if (fallback) await evaluate(page, 'descendant.resetFixture()');
          const installed = await evaluate(control.context, `(async () => {
            const tab = (await browser.tabs.query({})).find(tab => tab.url === ${JSON.stringify(url)});
            const {ensureCaptchaCallbackBridge} = await import(browser.runtime.getURL('src/agent/captcha-solver.js'));
            const api = ${fallback ? '{runtime:browser.runtime,tabs:browser.tabs}' : 'browser'};
            return ensureCaptchaCallbackBridge(tab.id, ${JSON.stringify(input.target)}, api);
          })()`);
          assert.equal(installed, true, `descendant bridge installation (fallback=${fallback})`);
          assert.equal(await evaluate(page, '!!descendant.__webbrainCaptchaCallbacks'), true);
          await evaluate(page, 'descendant.renderFixture()');
          const result = JSON.parse(await evaluate(control.context, `(async () => {
            const tab = (await browser.tabs.query({})).find(tab => tab.url === ${JSON.stringify(url)});
            const {injectToken} = await import(browser.runtime.getURL('src/agent/captcha-solver.js'));
            return JSON.stringify(await injectToken(tab.id, ${JSON.stringify(input)}));
          })()`));
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.calledCallback, true, JSON.stringify(result));
          assert.equal(await evaluate(page, 'descendant.accepted'), 'fixture-token');
        }
        console.log('PASS firefox: inherited-origin descendant bridge, MAIN and MV2 fallback, selected closure completion');
      }
      await evaluate(control.context, `(async()=>{await browser.storage.local.set({twoCaptchaEnabled:false});return true;})()`);
      let bridgeRemoved=false;
      for(let attempt=0;attempt<30&&!bridgeRemoved;attempt++){
        await session.send('browsingContext.navigate',{context:page,url:`${origin}/fixture?type=turnstile&mode=callback&registration-probe=disabled-again-${attempt}`,wait:'complete'});
        bridgeRemoved=!JSON.parse(await evaluate(page,probe)).early;
        if(!bridgeRemoved)await new Promise(resolve=>setTimeout(resolve,100));
      }
      assert.ok(bridgeRemoved,'CAPTCHA callback bridge should be removed when no provider is enabled');
    } finally {
      session?.socket?.close();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      await rm(profile2,{recursive:true,force:true});
    }
  }
} finally {server.close();}
