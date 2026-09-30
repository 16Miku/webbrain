import { chromium, firefox } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve('web');
const output='/tmp/webbrain-captcha-review';await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/fixture') { res.setHeader('Content-Type','text/html');res.end('<!doctype html><input id="response"><div id="grid" style="width:300px;height:200px;background:#ddd"></div><script>window.answers=[];window.clickPoints=[];window.captcha={done(value){answers.push(value)}};document.querySelector("#grid").addEventListener("click",e=>clickPoints.push([e.clientX,e.clientY]));</script>');return; }
    let pathname=new URL(req.url,'http://localhost').pathname;if(pathname.endsWith('/'))pathname+='index.html';
    const file=resolve(root,'.'+pathname);if(!file.startsWith(root+'/'))throw Error();
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'})[extname(file)]||'application/octet-stream');res.end(await readFile(file));
  }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
 for(const [name,engine] of [['chrome',chromium],['firefox',firefox]]) {
  const { applyNativeCaptchaSolution, prepareCaptchaApplication } = await import(`../src/${name}/src/agent/captcha-solution-application.js`);
  const browser=await engine.launch();
  try {
   const page=await browser.newPage();
   await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await page.goto(origin+'/fixture');
   const cookies=[];const calls=[];
   const api={tabs:{get:async()=>({url:page.url()})},webNavigation:{getAllFrames:async()=>[{frameId:0,url:page.url()}]},cookies:{getAllCookieStores:async()=>[{id:'isolated-store',tabIds:[1]}],set:async value=>{cookies.push(value);return value;}}};
   if(name==='chrome')api.scripting={executeScript:async spec=>{calls.push(spec);return [{frameId:0,result:await page.evaluate(({fn,args})=>window.eval(`(${fn})`)(...args),{fn:spec.func.toString(),args:spec.args})}];}};
   else api.tabs.executeScript=async(tabId,spec)=>{calls.push(spec);return [await page.evaluate(spec.code)];};
   globalThis.chrome=name==='chrome'?api:undefined;globalThis.browser=name==='firefox'?api:undefined;
   const documents=[{frameId:0,url:page.url(),timeOrigin:await page.evaluate(()=>performance.timeOrigin)}];
   const record={documents,pageUrl:page.url(),createdAt:Date.now(),solution:{token:'solved',cookie:'cf_clearance=clearance; Domain=.unrelated.test; Path=/other; Secure',geetest:{lot_number:'lot'},click:[1,6]}};
   const result=await applyNativeCaptchaSolution(1,record,{frameId:0,frameUrl:page.url(),fields:[{selector:'#response',path:'token'}],cookies:[{name:'cf_clearance',path:'cookie'}],callback:{name:'captcha.done',path:'geetest'},clicks:[{selector:'#grid',path:'click',mode:'grid',rows:2,columns:3}]});
   assert.equal(result.success,true);assert.equal(result.clicksApplied,2);
   assert.equal(await page.locator('#response').inputValue(),'solved');assert.deepEqual(await page.evaluate(()=>answers),[{lot_number:'lot'}]);
   assert.equal(cookies[0].storeId,'isolated-store');assert.equal(cookies[0].url,origin+'/fixture');assert.equal(cookies[0].domain,undefined);assert.equal(cookies[0].value,'clearance');assert.equal(cookies[0].path,'/');
   const points=await page.evaluate(()=>({points:clickPoints,rect:document.querySelector('#grid').getBoundingClientRect().toJSON()}));
   assert.deepEqual(points.points,[[points.rect.left+50,points.rect.top+50],[points.rect.left+250,points.rect.top+150]]);
   await assert.rejects(applyNativeCaptchaSolution(1,record,{frameId:0,frameUrl:page.url()}),/unapplied/);
   const awsRecord={documents,pageUrl:page.url(),createdAt:Date.now(),solution:{cookie:'aws-answer'}};
   const aws=await applyNativeCaptchaSolution(1,awsRecord,{frameId:0,frameUrl:page.url(),fields:[],clicks:[],cookies:[{name:'aws-waf-token',path:'cookie',encoding:'text'}],callback:{name:'',path:''}});
   assert.equal(aws.success,true);assert.equal(aws.cookiesUpdated,1);assert.equal(aws.calledCallback,false);
   assert.equal(cookies.at(-1).name,'aws-waf-token');assert.equal(cookies.at(-1).value,'aws-answer');
   assert.deepEqual(await page.evaluate(()=>answers),[{lot_number:'lot'}]);
   const base={documents,pageUrl:page.url(),createdAt:Date.now(),solution:{token:'x'}};
   const ambiguous=await applyNativeCaptchaSolution(1,{...base},{frameId:0,frameUrl:page.url(),fields:[{selector:'input, #grid',path:'token'}]});assert.equal(ambiguous.success,false);
   const rejectedNative=await applyNativeCaptchaSolution(1,{...base},{frameId:0,frameUrl:page.url(),callback:{name:'setTimeout',path:'token'}});assert.equal(rejectedNative.success,false);
   await assert.rejects(applyNativeCaptchaSolution(1,{...base,pageUrl:origin+'/old'},{frameId:0,frameUrl:page.url()}),/page changed/);
   await assert.rejects(applyNativeCaptchaSolution(1,{...base,createdAt:Date.now()-181000},{frameId:0,frameUrl:page.url()}),/expired/);
   const stale=await applyNativeCaptchaSolution(1,{...base,documents:[{...documents[0],timeOrigin:0}]},{frameId:0,frameUrl:page.url(),fields:[{selector:'#response',path:'token'}]});assert.equal(stale.success,false);
   assert.throws(()=>prepareCaptchaApplication({points:[{x:301,y:0}]},{clicks:[{selector:'#grid',path:'points',mode:'coordinates',sourceWidth:300,sourceHeight:200}]}),/outside/);
   console.log(`PASS ${name}: frame-bound application, structured callback, scoped cookies, scaled grid clicks, replay/staleness/native-code rejection`);
   for(const width of [390,1280]) {
    await page.setViewportSize({width,height:1000});await page.goto(origin+'/docs/captcha/');
    assert.equal(await page.locator('tbody tr').count(),7);assert.equal(await page.locator('tbody tr td').count(),21);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:`${output}/guide-${name}-${width}.png`,fullPage:true});
    console.log(`PASS ${name} ${width}: public CAPTCHA guide layout and seven provider rows`);
   }
   await page.close();
  } finally {await browser.close();delete globalThis.chrome;delete globalThis.browser;}
 }
} finally {server.close();}
