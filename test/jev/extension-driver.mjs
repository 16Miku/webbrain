import { chromium } from 'playwright';
import { BidiSession } from '../../firefox-companion/session.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
const delay = ms => new Promise(r=>setTimeout(r,ms));
export async function launchDriver(build) {
  const profile = await mkdtemp(join(tmpdir(),'jev-benchmark-'));
  let context,child,session,extensionPage,extensionContext,extensionOrigin;
  try {
    if (build==='chrome') {
      const extension=resolve('src/chrome');
      context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
      extensionOrigin=worker.url().split('/').slice(0,3).join('/');
      extensionPage=await context.newPage();await extensionPage.goto(`${extensionOrigin}/src/ui/settings.html`);
    } else {
      child=spawn(process.env.FIREFOX_BINARY||'/Applications/Firefox.app/Contents/MacOS/firefox',['--headless','--remote-allow-system-access','--no-remote','--profile',profile,'--remote-debugging-port','0'],{stdio:['ignore','pipe','pipe']});
      const port=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('Firefox BiDi startup timeout '+output.slice(-400))),20000);let output='';const outputChunk=chunk=>{output+=chunk;const m=output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);res(+m[1]);}};child.stderr.on('data',outputChunk);child.stdout.on('data',outputChunk);child.on('exit',code=>{clearTimeout(timer);rej(Error('Firefox exited: '+code+' '+output.slice(-400)));});child.on('error',error=>{clearTimeout(timer);rej(error);});});
      session=new BidiSession();await session.connect(port);await session.send('webExtension.install',{extensionData:{type:'path',path:resolve('src/firefox')}});
      for(let i=0;i<40;i++){const tree=await session.send('browsingContext.getTree',{});const ext=tree.contexts.find(c=>c.url?.startsWith('moz-extension://'));if(ext){extensionContext=ext.context;extensionOrigin=ext.url.split('/').slice(0,3).join('/');break;}await delay(100);}
      if(!extensionContext)throw Error('Firefox extension page unavailable');
    }
    const evaluate=async expression=>{
      if(extensionPage)return extensionPage.evaluate(expression);
      const response=await session.send('script.evaluate',{target:{context:extensionContext},expression:`(async()=>JSON.stringify(await (${expression})))()`,awaitPromise:true});
      if(response.type==='exception')throw Error(response.exceptionDetails.text);
      return JSON.parse(response.result.value ?? 'null');
    };
    const invoke=(action,data={})=>evaluate(`(globalThis.browser||chrome).runtime.sendMessage(${JSON.stringify({target:'background',action,...data})})`);
    return {
      invoke,evaluate,
      async configure(config,settings){
        await evaluate(`(globalThis.browser||chrome).storage.local.set(${JSON.stringify(settings)})`);
        await invoke('update_provider',{providerId:'openai',config:{...config,enabled:true,type:'openai',category:'cloud',providerName:'openai-compatible',apiProtocol:'chat_completions',supportsVision:false}});
        await invoke('set_active_provider',{providerId:'openai'});
        await evaluate(`(globalThis.browser||chrome).runtime.onMessage.addListener(msg=>{if(msg.action!=='agent_update')return;if(msg.type==='plan_review')(globalThis.browser||chrome).runtime.sendMessage({target:'background',action:'plan_response',tabId:msg.tabId,planId:msg.data.planId,decision:'approve'});})`);
      },
      async trial({url,prompt,locale,variant,budgetUsd}){
        const api='(globalThis.browser||chrome)';
        await evaluate(`${api}.storage.local.set(${JSON.stringify({systemOneFastBrowser:variant==='jev',systemOneFastClassifications:variant==='jev',wbLocale:locale,costAllowanceTotalUsd:budgetUsd,meteredProviderCostSpentUsd:0})})`);
        const tab=await evaluate(`${api}.tabs.create({url:${JSON.stringify(url)},active:true})`);
        try {
          await delay(300);
          await evaluate(`(async()=>{const trace=await import(${JSON.stringify(extensionOrigin+'/src/trace/recorder.js')});await trace.clearAllRuns();window.__jevTrial={done:false};${api}.runtime.sendMessage(${JSON.stringify({target:'background',action:'chat',tabId:tab.id,text:prompt,mode:'act',foreground:true})}).then(result=>{window.__jevTrial={done:true,result}},error=>{window.__jevTrial={done:true,error:String(error)}});return true;})()`);
          const start=Date.now();let status;
          while(Date.now()-start<180000){status=await evaluate('window.__jevTrial');if(status?.done)break;await delay(250);}
          if(!status?.done)await invoke('abort',{tabId:tab.id});
          const elapsedMs=Date.now()-start;
          const metrics=await evaluate(`(async()=>{const trace=await import(${JSON.stringify(extensionOrigin+'/src/trace/recorder.js')});const runs=await trace.listRuns({limit:10});const events=(await Promise.all(runs.map(r=>trace.getRunEvents(r.runId)))).flat();const notes=events.filter(e=>e.kind==='note'&&e.data.note==='system_one').map(e=>e.data.extra);const cost=await ${api}.storage.local.get('meteredProviderCostSpentUsd');return {llmCalls:events.filter(e=>e.kind==='llm_request').length,jevCalls:notes.filter(n=>n?.decision==='usage').length,fallbacks:notes.filter(n=>n?.decision==='fallback').length,modelCostUsd:cost.meteredProviderCostSpentUsd||0};})()`);
          const fixture=build==='chrome'
            ? (await evaluate(`${api}.scripting.executeScript({target:{tabId:${tab.id}},func:()=>JSON.parse(document.documentElement.dataset.fixtureResult||'{}')}).then(results=>results[0]?.result)`))
            : await evaluate(`${api}.tabs.executeScript(${tab.id},{code:"document.documentElement.dataset.fixtureResult||'{}'"}).then(results=>JSON.parse(results[0]))`);
          const doneUpdates=(status?.result?.updates||[]).filter(u=>u.type==='tool_result'&&u.data?.name==='done'&&u.data.result?.done===true);
          const reportedOutcome=doneUpdates.at(-1)?.data.result.outcome;
          const success=!!fixture?.success&&!status?.error&&status?.done&&reportedOutcome==='success';
          return {...metrics,elapsedMs,success,reportedOutcome,fixtureSuccess:!!fixture?.success,wrong:fixture?.wrong||0,duplicates:Math.max(0,(fixture?.actions||0)-1),error:status?.error||(!status?.done?'timeout':null)};
        } finally {await evaluate(`${api}.tabs.remove(${tab.id})`).catch(()=>{});}
      },
      async close(){await context?.close();await session?.close();child?.kill();await rm(profile,{recursive:true,force:true});},
    };
  } catch(error){await context?.close();await session?.close();child?.kill();await rm(profile,{recursive:true,force:true});throw error;}
}
