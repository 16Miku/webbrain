// Real extension worlds, local pages only; no solver keys or paid requests.
// Requires installed Firefox with BiDi (or FIREFOX_BINARY); Playwright's
// patched Firefox does not reliably support native extension BiDi sessions.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
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
    res.end(`(() => {
      let accepted = 0;
      const complete = token => {
        if (token !== 'fixture-token' || api.getResponse(widget) !== token) throw new Error('app state was not updated');
        document.querySelector('#next').disabled=false;
        document.querySelector('#challenge').hidden=true;
        document.querySelector('#result').textContent='accepted:'+ (++accepted);
      };
      const asyncMode = new URL(location.href).searchParams.get('mode')==='async';
      const widget=api.render('widget', {sitekey:${JSON.stringify(sitekey)}, ...(asyncMode?{}:{callback:complete})});
      api.render('other', {sitekey:${JSON.stringify(sitekey)},callback:()=>{throw new Error('wrong widget');}});
      if(asyncMode)api.execute(widget,{async:true}).then(({response})=>complete(response));
    })();`);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  const widgetClass = url.searchParams.get('type')==='hcaptcha'?'h-captcha':url.searchParams.get('type')==='turnstile'?'cf-turnstile':'g-recaptcha';
  res.end(`<!doctype html><script src="/sdk.js"></script><div id="challenge" role="dialog" aria-label="Security verification"><div id="widget" class="${widgetClass}" data-sitekey="${sitekey}"></div></div><div id="other" class="${widgetClass}" data-sitekey="${sitekey}"></div><button id="next" disabled>Continue</button><output id="result"></output><script src="/page.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const scenarios = [['hcaptcha','callback'],['hcaptcha','async'],['turnstile','callback'],['recaptcha_v2','callback']];
const payload = type => ({fieldName:type==='hcaptcha'?'h-captcha-response':type==='turnstile'?'cf-turnstile-response':'g-recaptcha-response',token:'fixture-token',
  target:{frameId:0,websiteKey:sitekey,type,responseFieldId:'answer-widget-1'}});
const probe = `JSON.stringify({early:bridgeAtFirstScript,enabled:!document.querySelector('#next').disabled,result:document.querySelector('#result').textContent,hidden:document.querySelector('#challenge').hidden})`;
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
  assert.equal(result.calledCallback, true, `${build} ${type} ${mode}: ${JSON.stringify(result)}`);
  assert.equal(result.callbackCandidates, 1);
  assert.equal(result.callbackBridgeAvailable, true);
  assert.deepEqual(state, {early:true,enabled:true,result:'accepted:1',hidden:true});
  console.log(`PASS ${build}: ${type} ${mode}, document-start capture, exact widget callback, page continuation and gate clearance`);
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
    for (const [type, mode] of scenarios) {
      await page.goto(`${origin}/fixture?type=${type}&mode=${mode}`);
      const input = payload(type);input.target.frameUrl=page.url();
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
      assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
      assertProgress('chrome',type,mode,outcome.injection,JSON.parse(await page.evaluate(probe)));
    }
  } finally {await context?.close();await rm(profile,{recursive:true,force:true});}

  const profile2 = await mkdtemp(join(tmpdir(),'webbrain-captcha-firefox-'));
  const child = spawn(process.env.FIREFOX_BINARY || (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox'), ['--headless','--remote-allow-system-access','--no-remote','--profile',profile2,'--remote-debugging-port','0'], {stdio:['ignore','pipe','pipe']});
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
    for(const [type,mode] of scenarios){
      const url=`${origin}/fixture?type=${type}&mode=${mode}`;
      await session.send('browsingContext.navigate',{context:page,url,wait:'complete'});
      const input=payload(type);input.target.frameUrl=url;
      const outcome=JSON.parse(await evaluate(control.context,`(async()=>{
        const tabs=await browser.tabs.query({});const tab=tabs.find(tab=>tab.url===${JSON.stringify(url)});
        const {injectToken}=await import(browser.runtime.getURL('src/agent/captcha-solver.js'));
        const input=${JSON.stringify(input)};
        const injection=await injectToken(tab.id,input);
        const gate=await (${verifyGate.toString()})(tab.id,input,browser);
        return JSON.stringify({injection,gate});
      })()`));
      assert.equal(outcome.gate?.status, 'cleared', JSON.stringify(outcome));
      assertProgress('firefox',type,mode,outcome.injection,JSON.parse(await evaluate(page,probe)));
    }
  } finally {session?.socket?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));await rm(profile2,{recursive:true,force:true});}
} finally {server.close();}
