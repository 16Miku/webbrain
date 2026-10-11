import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {test} from 'node:test';
import {chromium,firefox} from 'playwright';
import {CDPClient} from '../src/chrome/src/cdp/cdp-client.js';
import {Agent as ChromeAgent} from '../src/chrome/src/agent/agent.js';
import {Agent as FirefoxAgent} from '../src/firefox/src/agent/agent.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=','base64');
const html=Buffer.from('<!doctype html><html><body>viewer</body></html>');
const payload=(bytes=png,name='image.png',mime='image/png')=>({base64:bytes.toString('base64'),filename:name,mimeType:mime});
for(const kind of ['chrome','firefox'])test(`${kind}: actual byte policy respects accept OR and renamed content`,async t=>{
 const context=vm.createContext({atob,TextDecoder,Uint8Array,URL});
 vm.runInContext(await fs.readFile(new URL(`../src/${kind}/src/content/file-upload-policy.js`,import.meta.url),'utf8'),context);
 const {validateUploadFile:v,observedFileViewerResource:resolve}=context.__wbFileUploadPolicy;
 const cases=[
  ['empty accepts HTML','',payload(html,'page.html','text/html'),true],['any accepts HTML','*/*',payload(html),true],
  ['image wildcard PNG','image/*',payload(),true],['uppercase MIME','IMAGE/PNG',payload(),true],['extension PNG','.png',payload(),true],
  ['OR MIME/extension','.pdf,image/png',payload(),true],['HTML wildcard','text/*',payload(html,'page.html','image/png'),true],
  ['HTML own extension','.html',payload(html,'page.html','image/png'),true],['claimed PNG is HTML','image/*',payload(html),false],
  ['renamed PNG extension','.png',payload(html),false],['renamed JPEG','image/jpeg',payload(png,'image.jpg','image/jpeg'),false],
  ['unknown binary image MIME unverified','image/*',payload(Buffer.from([0,1,2,3]),'image.png','image/png'),false],
  ['unknown binary image extension unverified','.png',payload(Buffer.from([0,1,2,3]),'image.png','image/png'),false],
  ['unknown binary PDF MIME unverified','application/pdf',payload(Buffer.from([0,1,2,3]),'file.pdf','application/pdf'),false],
  ['invalid accept only','nonsense',payload(),false],['oversized accept','image/png,'.repeat(1000),payload(),false],
  ['SVG XML','image/*',payload(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'),'drawing.svg','application/octet-stream'),true],
  ['CSV MIME','text/csv',payload(Buffer.from('a,b\n1,2\n'),'table.csv','text/csv'),true],
  ['ZIP renamed PNG extension','.png',payload(Buffer.from([80,75,3,4,0,0,0,0]),'image.png','image/png'),false],
  ['ZIP renamed PNG MIME','image/png',payload(Buffer.from([80,75,3,4,0,0,0,0]),'image.png','image/png'),false],
  ['ZIP OOXML MIME','application/vnd.openxmlformats-officedocument.wordprocessingml.document',payload(Buffer.from([80,75,3,4,0,0,0,0]),'document.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),true],
  ['ZIP container MIME despite OOXML metadata','application/zip',payload(Buffer.from([80,75,3,4,0,0,0,0]),'document.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),true],
  ['PNG alias','image/x-png',payload(),true],
  ['commented SVG','image/svg+xml',payload(Buffer.from('<!--comment--><?xml version="1.0"?><svg></svg>'),'drawing.svg','image/svg+xml'),true],
  ['HTML renamed OOXML package','.docx',payload(html,'document.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),false],
  ['opaque claimed plain MIME','text/plain',payload(Buffer.from([0,1,2,3]),'file.txt','text/plain'),false],
  ['opaque claimed OOXML MIME','application/vnd.openxmlformats-officedocument.wordprocessingml.document',payload(Buffer.from([0,1,2,3]),'file.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document'),false],
  ['opaque claimed ZIP MIME','application/zip',payload(Buffer.from([0,1,2,3]),'file.zip','application/zip'),false],
  ['opaque claimed ZIP alias','application/x-zip-compressed',payload(Buffer.from([0,1,2,3]),'file.zip','application/x-zip-compressed'),false],
  ['JSON textual MIME preserved','application/json',payload(Buffer.from('{\"ok\":true}'),'data.json','application/json'),true],
  ['XML textual MIME preserved','application/xml',payload(Buffer.from('<?xml version=\"1.0\"?><root>value</root>'),'data.xml','application/xml'),true],
  ['JavaScript textual MIME preserved','application/javascript',payload(Buffer.from('const value = 1;'),'code.js','application/javascript'),true],
  ['opaque custom MIME preserved','application/x-custom',payload(Buffer.from([0,1,2,3]),'file.abc','application/x-custom'),true],
  ['opaque custom media MIME preserved','video/x-custom',payload(Buffer.from([0,1,2,3]),'file.bin','video/x-custom'),true],
  ['AVIF aligned native brand','image/*',payload(Buffer.from('000000146674797061766966000000006d696631','hex'),'image.avif','application/octet-stream'),true],
  ['AVIF brand outside declared box','image/*',payload(Buffer.from('000000146674797069736f6d0000000069736f6d61766966','hex'),'image.avif','image/avif'),false],
  ['AVIF unaligned brand','image/*',payload(Buffer.from('000000186674797069736f6d000000007861766966000000','hex'),'image.avif','image/avif'),false],
  ['missing observed image bytes','.png',{filename:'image.png',mimeType:'image/png'},false],
  ['malformed accept constructor','constructor',payload(),false],
  ['malformed accept toString','toString',payload(),false],
  ['malformed accept prototype','__proto__',payload(),false],
  ['malformed declared MIME','text/plain',payload(Buffer.from([0,1,2,3]),'file.txt','constructor'),false],
  ['HTML custom extension','.abc',payload(html,'file.abc','text/html'),true],
  ['custom opaque extension','.abc',payload(Buffer.from([0,1,2,3]),'file.abc','application/octet-stream'),true],
  ['CSV extension','.csv',payload(Buffer.from('a,b\n1,2\n'),'table.csv','text/csv'),true],
  ['text MIME','text/plain',payload(Buffer.from('plain\n'),'file.txt','text/plain'),true],['PDF MIME','application/pdf',payload(Buffer.from('%PDF-1.4\n'),'file.pdf','text/plain'),true],
  ['empty text extension','.txt',payload(Buffer.alloc(0),'empty.txt','text/plain'),true],['empty image mismatch','image/*',payload(Buffer.alloc(0)),false],
  ['empty PNG extension mismatch','.png',payload(Buffer.alloc(0)),false],
  ['plain server error renamed PNG','.png',payload(Buffer.from('error: authentication failed'),'image.png','image/png'),false],
  ['plain server error claiming image MIME','image/png',payload(Buffer.from('error: authentication failed'),'image.png','image/png'),false],
  ['HTML fragment renamed PNG','.png',payload(Buffer.from('<div>Access denied</div>'),'image.png','image/png'),false],
 ];
 for(const [label,accept,data,expected] of cases)await t.test(label,()=>{const r=v(accept,data);assert.equal(r.success,expected);if(!expected){assert.equal(r.noDispatch,true);assert.equal(r.dispatched,false);assert.equal(r.outcomeUnknown,false);}if(expected && ['ZIP container MIME despite OOXML metadata','JSON textual MIME preserved','XML textual MIME preserved','JavaScript textual MIME preserved','ZIP OOXML MIME','CSV MIME','opaque custom MIME preserved','opaque custom media MIME preserved','custom opaque extension','CSV extension','text MIME','empty text extension'].includes(label))assert.equal(r.contentTypeVerified,false);});
 const source='https://github.com/owner/repo/blob/main/assets/logo.png',raw='https://github.com/owner/repo/raw/refs/heads/main/assets/logo.png';
 const observed=Buffer.from('<html>'+ 'x'.repeat(98_200)+JSON.stringify({rawBlobUrl:raw})).toString('base64');
 await t.test('observed raw candidate past98KB stays bounded and exact',()=>{const r=resolve(observed,source);assert.equal(r.url,raw);assert.equal(r.fromSavedBytes,true);});
 for(const [label,rawUrl,original] of [['evil hostname','https://evil.example/owner/repo/raw/main/assets/logo.png',source],['other owner','https://github.com/other/repo/raw/main/assets/logo.png',source],['other ref','https://github.com/owner/repo/raw/refs/heads/other/assets/logo.png',source],['credentials','https://x@y.github.com/owner/repo/raw/main/assets/logo.png',source],['query','https://github.com/owner/repo/raw/main/assets/logo.png?token=x',source],['not viewer',raw,'https://github.com/owner/repo/tree/main/assets/logo.png']])await t.test(label,()=>assert.equal(resolve(Buffer.from(JSON.stringify({rawBlobUrl:rawUrl})).toString('base64'),original),null));
 await t.test('ambiguous observed candidates rejected',()=>assert.equal(resolve(Buffer.from(JSON.stringify({rawBlobUrl:raw})+JSON.stringify({rawBlobUrl:raw})).toString('base64'),source),null));
});

test('actual Chromium native upload rejects mismatches before any page attachment',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'webbrain-upload-type-'));const realPath=path.join(dir,'image.png');await fs.writeFile(realPath,html);
 const browser=await chromium.launch({args:['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
 try{
 const page=await browser.newPage();await page.setContent('<input id="file" type="file" accept="image/*"><script>window.events=[];for(const n of ["input","change"])document.addEventListener(n,e=>events.push(e.type));</script>');
 const native=await page.context().newCDPSession(page);const c=new CDPClient();c.sendCommand=(_tab,m,p={})=>native.send(m,p);
 const object=async()=>(await native.send('Runtime.evaluate',{expression:'document.querySelector("#file")'})).result.objectId;
 const state=()=>page.evaluate(()=>({events:events.slice(),count:document.querySelector('#file').files.length}));
 await t.test('HTML masquerading as PNG local path',async()=>{let dispatch=0;const r=await c.setFileInputFiles(71,await object(),[realPath],{beforeDispatch:()=>dispatch++});assert.equal(r.success,false);assert.equal(r.reasonCode,'file_type_mismatch');assert.equal(dispatch,0);assert.deepEqual(await state(),{events:[],count:0});});
 await t.test('in-memory HTML masquerading as PNG',async()=>{let dispatch=0;const r=await c.setFileInputData(71,await object(),payload(html),{beforeDispatch:()=>dispatch++});assert.equal(r.noDispatch,true);assert.equal(dispatch,0);assert.deepEqual(await state(),{events:[],count:0});});
 await t.test('actual HTML saved metadata provides observed raw recovery',async()=>{const raw='https://github.com/owner/repo/raw/refs/heads/main/assets/logo.png';await fs.writeFile(realPath,'<!doctype html>'+ 'x'.repeat(98_200)+JSON.stringify({rawBlobUrl:raw}));const r=await c.setFileInputFiles(71,await object(),[realPath],{sourceUrl:'https://github.com/owner/repo/blob/main/assets/logo.png'});assert.equal(r.sourceResolution.url,raw);assert.equal(r.sourceResolution.fromSavedBytes,true);assert.deepEqual(await state(),{events:[],count:0});});
 await t.test('actual PNG attaches once',async()=>{await fs.writeFile(realPath,png);const r=await c.setFileInputFiles(71,await object(),[realPath]);assert.equal(r.success,true);assert.deepEqual(await state(),{events:['input','change'],count:1});});
 await page.evaluate(()=>{document.querySelector('#file').value='';events=[];});
 await t.test('accept change during preparation prevents dispatch',async()=>{const original=c.probeLocalFile.bind(c);c.probeLocalFile=async(...args)=>{const r=await original(...args);await page.evaluate(()=>document.querySelector('#file').accept='application/pdf');return r;};const r=await c.setFileInputFiles(71,await object(),[realPath]);assert.equal(r.noDispatch,true);assert.deepEqual(await state(),{events:[],count:0});c.probeLocalFile=original;});
 await page.evaluate(()=>document.querySelector('#file').accept='image/*');
 await t.test('saved path replacement after initial inspection prevents attachment',async()=>{await fs.writeFile(realPath,png);const original=c.probeLocalFile.bind(c);let probes=0;c.probeLocalFile=async(...args)=>{const r=await original(...args);if(++probes===1)await fs.writeFile(realPath,html);return r;};try{const r=await c.setFileInputFiles(71,await object(),[realPath]);assert.equal(r.noDispatch,true);assert.equal(r.reasonCode,'file_identity_changed');assert.equal(r.outcomeUnknown,false);assert.deepEqual(await state(),{events:[],count:0});}finally{c.probeLocalFile=original;await fs.writeFile(realPath,png);}});
 await t.test('Stop during saved-byte read prevents dispatch',async()=>{const stop=new AbortController(),original=c.probeLocalFile.bind(c);c.probeLocalFile=async(...args)=>{const r=await original(...args);stop.abort(Error('Stopped'));return r;};const id=await object();await assert.rejects(()=>c.setFileInputFiles(71,id,[realPath],{abortSignal:stop.signal}),/Stopped/);assert.deepEqual(await state(),{events:[],count:0});c.probeLocalFile=original;});
 }finally{await browser.close();const real=await fs.realpath(dir);assert.ok(real.startsWith(path.resolve(os.tmpdir())+path.sep+'webbrain-upload-type-'));await fs.rm(real,{recursive:true,force:true});}
});
