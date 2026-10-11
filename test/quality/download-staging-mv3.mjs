import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root=path.resolve(process.env.WEBBRAIN_TEST_ROOT || '.');
const out=path.resolve(process.env.WEBBRAIN_TEST_OUT || 'ci/artifacts/download-staging-'+crypto.randomUUID());
const extension=path.join(out,'extension'),profile=path.join(out,'profile'),pins={};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function copy(relative) {
  if(pins[relative])return;
  const bytes=await fs.readFile(path.join(root,'src/chrome',relative));pins[relative]=hash(bytes);
  const dest=path.join(extension,relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,bytes,{flag:'wx'});
  for(const m of bytes.toString().matchAll(/^import\s+(?:[\s\S]*?)\sfrom\s+['"]([^'"]+)['"];?/gm)) {
    assert.ok(m[1].startsWith('.'));await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative),m[1])));
  }
}
await fs.mkdir(out,{recursive:false});await copy('src/network/network-tools.js');await copy('src/download-directory.js');await copy('src/offscreen/skill-download.js');
await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Owned staged download fixture',version:'1.0',
  permissions:['downloads','storage','webRequest','scripting','offscreen'],host_permissions:['<all_urls>'],background:{service_worker:'src/background.js',type:'module'}}),{flag:'wx'});
const foreignExtension=path.join(out,'foreign-extension');await fs.mkdir(foreignExtension);
await fs.writeFile(path.join(foreignExtension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Owned foreign download fixture',version:'1.0',permissions:['downloads'],host_permissions:['<all_urls>'],background:{service_worker:'foreign.js',type:'module'}}),{flag:'wx'});
await fs.writeFile(path.join(foreignExtension,'foreign.js'),'globalThis.ready=true;', {flag:'wx'});
await fs.writeFile(path.join(extension,'src/background.js'),`import * as network from './network/network-tools.js';import * as directory from './download-directory.js';globalThis.network=network;
  directory.installDownloadDirectoryRouting?.(chrome);globalThis.legacyFilenameListenerInstalled=chrome.downloads.onDeterminingFilename.hasListeners();
  globalThis.nativeCalls=[];const nativeDownload=chrome.downloads.download.bind(chrome.downloads);
  chrome.downloads.download=(options,callback)=>{nativeCalls.push({...options});return nativeDownload(options,callback);};`,{flag:'wx'});
await fs.writeFile(path.join(extension,'src/offscreen/offscreen.html'),'<script src="skill-download.js"></script>',{flag:'wx'});
await fs.writeFile(path.join(extension,'status.html'),'<!doctype html><title>Owned stage status</title>',{flag:'wx'});
const body=Buffer.from('owned authenticated staged download bytes\n'),large=Buffer.alloc(32*1024*1024,37),hits=[];
let port;
const server=http.createServer((req,res)=>{
  hits.push({host:req.headers.host,path:req.url,cookie:req.headers.cookie||''});
  if(req.url==='/private-redirect'){res.writeHead(302,{Location:`http://127.0.0.1:${port}/private`});return res.end();}
  if(req.url==='/same-redirect'){res.writeHead(302,{Location:'/auth?exact=owned'});return res.end();}
  if(req.url==='/public-redirect'){res.writeHead(302,{Location:`http://cdn.download.test:${port}/auth?exact=owned`});return res.end();}
  if(req.url==='/cycle'){res.writeHead(302,{Location:'/cycle'});return res.end();}
  if(req.url==='/error'){res.writeHead(403);return res.end('owned fixture denial');}
  if(req.url==='/broken'){res.writeHead(200,{'Content-Length':100000});res.write(Buffer.alloc(1000));return setTimeout(()=>res.destroy(),30);}
  if(req.url==='/slow'){res.writeHead(200,{'Content-Type':'application/octet-stream'});const timer=setInterval(()=>res.write(Buffer.alloc(65536)),30);res.on('close',()=>clearInterval(timer));return;}
  if(req.url==='/large'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':large.length});let n=0;
    const write=()=>{while(n<large.length){const next=n+65536;if(!res.write(large.subarray(n,next))){n=next;return res.once('drain',write);}n=next;}res.end();};return write();}
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename=fallback.bin; filename*=UTF-8''r%C3%A9sum%C3%A9.bin",'Content-Length':body.length});res.end(body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
let context,ownedBrowser,ownedProcess;const evidence={startedAt:new Date().toISOString(),sourcePins:pins,actualUserBrowserTouched:false,rows:[]};
try{
  const downloads=path.join(out,'downloads');await fs.mkdir(downloads);await fs.mkdir(path.join(profile,'Default'),{recursive:true});
  await fs.writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false,directory_upgrade:true}}),{flag:'wx'});
  ownedProcess=spawn(chromium.executablePath(),['--headless=new','--no-sandbox','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-proxy-server',
    `--user-data-dir=${profile}`,'--remote-debugging-port=0',`--disable-extensions-except=${extension},${foreignExtension}`,`--load-extension=${extension},${foreignExtension}`,
    '--host-resolver-rules=MAP public.download.test 127.0.0.1, MAP cdn.download.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1','about:blank'],{windowsHide:true,stdio:'ignore'});
  let endpoint;for(let n=0;n<100;n++){try{const [p,u]=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);endpoint=`ws://127.0.0.1:${p}${u}`;break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(endpoint,'owned disposable browser endpoint');ownedBrowser=await chromium.connectOverCDP(endpoint);context=ownedBrowser.contexts()[0];
  const browserCDP=await ownedBrowser.newBrowserCDPSession();await browserCDP.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  const worker=context.serviceWorkers().find(w=>w.url().endsWith('/src/background.js'))||await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/src/background.js')});
  let ready=false;for(let n=0;n<100&&!ready;n++){ready=await worker.evaluate(()=>Boolean(globalThis.network));if(!ready)await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  evidence.legacyFilenameListenerInstalled=await worker.evaluate(()=>legacyFilenameListenerInstalled);
  await context.addCookies([{name:'owned_auth',value:'present',domain:'public.download.test',path:'/'},{name:'owned_auth',value:'present',domain:'cdn.download.test',path:'/'}]);
  const base=`http://public.download.test:${port}`,cdn=`http://cdn.download.test:${port}`;
  const call=(url,filename)=>worker.evaluate(({url,filename})=>network.downloadFiles({urls:[url],...(filename?{filename}:{})}),{url,filename});
  const record=async(name,fn)=>{const begin=hits.length,callsBefore=await worker.evaluate(()=>nativeCalls.length);const details=await fn();evidence.rows.push({name,details,hits:hits.slice(begin),nativeCalls:(await worker.evaluate(()=>nativeCalls)).slice(callsBefore)});};
  await record('authenticated direct exact bytes and one remote GET',async()=>{
    const result=await call(base+'/auth?exact=owned');assert.equal(result.succeeded,1);const d=result.downloads[0];assert.equal(d.state,'complete');assert.equal((await worker.evaluate(()=>nativeCalls.at(-1))).filename,'résumé.bin');
    const bytes=await fs.readFile(d.filename);assert.equal(hash(bytes),hash(body));assert.equal(path.basename(d.filename),'résumé.bin');assert.ok(hits.at(-1).cookie.includes('owned_auth=present'));
    assert.ok((await worker.evaluate(()=>nativeCalls.at(-1))).url.startsWith('blob:'));return{result,fileSHA256:hash(bytes)};
  });assert.equal(evidence.rows.at(-1).hits.length,1);
  await record('same authorized origin redirect',async()=>{const result=await call(base+'/same-redirect','explicit.bin');assert.equal(result.succeeded,1);assert.equal((await worker.evaluate(()=>nativeCalls.at(-1))).filename,'explicit.bin');return{result};});
  assert.deepEqual(evidence.rows.at(-1).hits.map(h=>h.path),['/same-redirect','/auth?exact=owned']);
  await record('private redirect never contacted',async()=>{const result=await call(base+'/private-redirect');assert.equal(result.failed,1);assert.equal(result.downloads[0].blocked,true);return{result};});
  assert.equal(evidence.rows.at(-1).hits.length,1);assert.equal(evidence.rows.at(-1).nativeCalls.length,0);
  await record('public cross-origin requires separate authorized call',async()=>{const result=await call(base+'/public-redirect');assert.equal(result.failed,1);assert.equal(result.downloads[0].redirectUrl,cdn+'/auth?exact=owned');assert.equal(result.downloads[0].redirectRequiresPermission,true);return{result};});
  assert.equal(evidence.rows.at(-1).hits.length,1);assert.equal(evidence.rows.at(-1).nativeCalls.length,0);
  await record('fresh public destination succeeds',async()=>{const result=await call(cdn+'/auth?exact=owned');assert.equal(result.succeeded,1);assert.ok(hits.at(-1).cookie.includes('owned_auth=present'));return{result};});
  await record('disk streamed 32 MiB exact bytes',async()=>{const result=await call(base+'/large');assert.equal(result.succeeded,1);const bytes=await fs.readFile(result.downloads[0].filename);assert.equal(bytes.length,large.length);assert.equal(hash(bytes),hash(large));return{bytes:bytes.length,SHA256:hash(bytes),result};});
  assert.equal(evidence.rows.at(-1).hits.length,1);
  await record('Stop aborts an active stream before native save',async()=>{
    const result=await worker.evaluate(async url=>{const c=new AbortController();setTimeout(()=>c.abort(),150);return await network.downloadFiles({urls:[url]},{signal:c.signal});},base+'/slow');
    assert.equal(result.failed,1);assert.equal(result.downloads[0].cancelled,true);return{result};
  });assert.equal(evidence.rows.at(-1).nativeCalls.length,0);
  for(const endpoint of ['/error','/broken','/cycle'])await record('failure cleanup '+endpoint,async()=>{const result=await call(base+endpoint);assert.equal(result.failed,1);return{result};});
  const extensionId=worker.url().split('/')[2],status=await context.newPage();await status.goto(`chrome-extension://${extensionId}/status.html`);
  await worker.evaluate(()=>chrome.storage.local.set({downloadDirectory:''}));
  await record('empty directory preserves exact explicit native name',async()=>{const result=await call(base+'/auth?empty','chosen.bin');assert.equal(result.succeeded,1);assert.equal(path.basename(result.downloads[0].filename),'chosen.bin');assert.equal(hash(await fs.readFile(result.downloads[0].filename)),hash(body));return{result};});
  await worker.evaluate(()=>chrome.storage.local.set({downloadDirectory:'Owned/Files'}));
  await record('custom directory preserves exact explicit native name',async()=>{const result=await call(base+'/auth?custom','custom.bin');assert.equal(result.succeeded,1);assert.ok(result.downloads[0].filename.replace(/\\/g,'/').endsWith('/Owned/Files/custom.bin'));return{result};});
  await record('concurrent different URLs preserve their distinct names',async()=>{const results=await Promise.all([call(base+'/auth?one','one.bin'),call(base+'/auth?two','two.bin')]);assert.deepEqual(results.map(r=>path.basename(r.downloads[0].filename)),['one.bin','two.bin']);for(const r of results){assert.equal(r.succeeded,1);assert.equal(hash(await fs.readFile(r.downloads[0].filename)),hash(body));}return{results};});
  await record('native uniquify preserves both exact saved bodies',async()=>{const results=await Promise.all([call(base+'/auth?dup1','duplicate.bin'),call(base+'/auth?dup2','duplicate.bin')]);assert.deepEqual(results.map(r=>path.basename(r.downloads[0].filename)).sort(),['duplicate (1).bin','duplicate.bin'].sort());for(const r of results)assert.equal(hash(await fs.readFile(r.downloads[0].filename)),hash(body));return{results};});
  await record('another extension explicit filename is not routed by our preference',async()=>{const foreign=context.serviceWorkers().find(w=>w.url().endsWith('/foreign.js'))||await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/foreign.js')});const id=await foreign.evaluate(url=>chrome.downloads.download({url,filename:'foreign.bin',conflictAction:'uniquify'}),base+'/auth?foreign');let d;for(let n=0;n<100;n++){d=await foreign.evaluate(async id=>(await chrome.downloads.search({id}))[0],id);if(d?.state==='complete')break;await new Promise(r=>setTimeout(r,50));}assert.equal(d.state,'complete');assert.equal(path.basename(d.filename),'foreign.bin');assert.equal(path.dirname(d.filename),path.join(out,'downloads'));assert.equal(hash(await fs.readFile(d.filename)),hash(body));return{downloadId:id,filename:d.filename};});
  await record('configured directory cannot rescue a native-invalid parent path',async()=>{const result=await call(base+'/auth?parent','../escape.bin');assert.equal(result.failed,1);assert.match(result.downloads[0].error,/filename/i);return{result};});
  await record('configured directory cannot rescue a native-invalid absolute path',async()=>{const result=await call(base+'/auth?absolute','C:/escape.bin');assert.equal(result.failed,1);assert.match(result.downloads[0].error,/filename/i);return{result};});
  await worker.evaluate(()=>chrome.storage.local.set({downloadDirectory:'../unsafe'}));
  await record('invalid directory keeps safe requested filename',async()=>{const result=await call(base+'/auth?invalid','invalid-pref.bin');assert.equal(result.succeeded,1);assert.equal(path.basename(result.downloads[0].filename),'invalid-pref.bin');return{result};});
  await record('foreign extension page cannot start authenticated staging',async()=>{
    const result=await status.evaluate(url=>chrome.runtime.sendMessage({type:'authenticated-download-start',jobId:crypto.randomUUID(),url}),base+'/auth');
    assert.equal(result.success,false);assert.ok(result.error.includes('background sender'));return{result};
  });assert.equal(evidence.rows.at(-1).hits.length,0);
  await new Promise(r=>setTimeout(r,100));
  const remaining=await status.evaluate(async()=>{const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('authenticated-downloads');let n=0;for await(const key of dir.keys())n++;return n;});
  assert.equal(remaining,0);evidence.remainingOPFSFiles=remaining;
  evidence.savedBasenameProof='Exact native saved basename and byte hashes qualified in this disposable profile using browser-default filename determination. No user browser touched; earlier GUID/allow-mode limitations remain historical.';
  evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);process.exitCode=1;}
finally{await ownedBrowser?.close();if(ownedProcess&&!ownedProcess.killed)ownedProcess.kill();await new Promise(r=>server.close(r));evidence.finishedAt=new Date().toISOString();for(const[p,s]of Object.entries(pins))assert.equal(hash(await fs.readFile(path.join(root,'src/chrome',p))),s);
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(evidence,null,2),{flag:'wx'});console.log(JSON.stringify({passed:evidence.passed,rows:evidence.rows.length,error:evidence.error,output:out}));}
