import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Independent request fixtures cover the provider-specific contracts most
// likely to be confused by a shared adapter. Never send these to live services.
const url = 'https://example.test/challenge';
const fixtures = [
  ['capsolver','AntiCloudflareTask',{websiteURL:url,proxy:'http:proxy.test:8080'}, {type:'AntiCloudflareTask',websiteURL:url,proxy:'http:proxy.test:8080'}],
  ['capsolver','GeeTestTaskProxyLess',{websiteURL:url,captchaId:'v4-id'}, {type:'GeeTestTaskProxyLess',websiteURL:url,captchaId:'v4-id'}],
  ['capsolver','ReCaptchaV3EnterpriseM1TaskProxyLess',{websiteURL:url,websiteKey:'site',pageAction:'login'}, {type:'ReCaptchaV3EnterpriseM1TaskProxyLess',websiteURL:url,websiteKey:'site',pageAction:'login'}],
  ['capsolver','AwsWafClassification',{images:['image'],question:'car'}, {type:'AwsWafClassification',images:['image'],question:'car'}],
  ['2captcha','GeeTestTaskProxyless',{websiteURL:url,version:4,initParameters:{captcha_id:'v4'}}, {type:'GeeTestTaskProxyless',websiteURL:url,version:4,initParameters:{captcha_id:'v4'}}],
  ['2captcha','TemuImageTask',{image:'base64',parts:['piece']},{type:'TemuImageTask',image:'base64',parts:['piece']}],
  ['2captcha','VKCaptchaImageTask',{image:'base64',steps:[5,19]}, {type:'VKCaptchaImageTask',image:'base64',steps:[5,19]}],
  ['2captcha','PazlCaptchaTask',{image:'base64',task:'[1,2]'}, {type:'PazlCaptchaTask',image:'base64',task:'[1,2]'}],
  ['capmonster','CustomTask:TenDI',{websiteURL:url,websiteKey:'site',metadata:{captchaUrl:'https://t.captcha.qq.com/'}}, {type:'CustomTask',class:'TenDI',websiteURL:url,websiteKey:'site',metadata:{captchaUrl:'https://t.captcha.qq.com/'}}],
  ['capmonster','ComplexImageTask:recognition:shein',{imagesBase64:['image']}, {type:'ComplexImageTask',class:'recognition',imagesBase64:['image'],metadata:{Task:'shein'}}],
  ['capmonster','ComplexImageTask:recaptcha',{imagesBase64:['image'],metadata:{Task:'Select cars',Grid:'3x3'}}, {type:'ComplexImageTask',class:'recaptcha',imagesBase64:['image'],metadata:{Task:'Select cars',Grid:'3x3'}}],
  ['capmonster','TurnstileTask:token:1',{websiteURL:url,websiteKey:'site',pageAction:'managed',data:'data',pageData:'page',userAgent:'UA'}, {type:'TurnstileTask',cloudflareTaskType:'token',websiteURL:url,websiteKey:'site',pageAction:'managed',data:'data',pageData:'page',userAgent:'UA'}],
  ['capmonster','TurnstileTask:wait_room',{websiteURL:url,websiteKey:'site',htmlPageBase64:'html',userAgent:'UA',proxyType:'http',proxyAddress:'proxy.test',proxyPort:8080}, {type:'TurnstileTask',cloudflareTaskType:'wait_room',websiteURL:url,websiteKey:'site',htmlPageBase64:'html',userAgent:'UA',proxyType:'http',proxyAddress:'proxy.test',proxyPort:8080}],
  ['anti-captcha','AntiGateTask',{websiteURL:url,templateName:'template',variables:{input:'challenge'},proxyAddress:'proxy.test',proxyPort:8080}, {type:'AntiGateTask',websiteURL:url,templateName:'template',variables:{input:'challenge'},proxyAddress:'proxy.test',proxyPort:8080}],
  ['anti-captcha','AltchaTaskProxyless',{websiteURL:url,challengeJSON:'{"algorithm":"SHA-256"}'}, {type:'AltchaTaskProxyless',websiteURL:url,challengeJSON:'{"algorithm":"SHA-256"}'}],
  ['solvecaptcha','geetest_v4',{captcha_id:'captcha',pageurl:url}, {method:'geetest_v4',captcha_id:'captcha',pageurl:url}],
  ['solvecaptcha','text',{textcaptcha:'What is two plus two?'}, {textcaptcha:'What is two plus two?'}],
  ['solvecaptcha','recaptcha_v3:enterprise',{googlekey:'site',pageurl:url,action:'login'}, {method:'userrecaptcha',version:'v3',enterprise:1,googlekey:'site',pageurl:url,action:'login'}],
  ['nopecha','recognition/recaptcha',{task:'Select cars',image_data:['image'],grid:'3x3'}, {task:'Select cars',image_data:['image'],grid:'3x3'}],
  ['nopecha','token/recaptcha2:enterprise',{sitekey:'site',url,data:{s:'observed'}}, {sitekey:'site',url,data:{s:'observed',enterprise:true}}],
  ['nonecap','hcaptcha_enterprise',{sitekey:'site',url,rqdata:'observed',proxy:'http://proxy.test:8080'}, {type:'hcaptcha_enterprise',sitekey:'site',url,rqdata:'observed',proxy:'http://proxy.test:8080'}],
];
function mockApi(t, responder) {
  const calls=[];
  t.mock.method(globalThis,'setTimeout',(callback)=>{queueMicrotask(callback);return 0;});
  t.mock.method(globalThis,'fetch',async (raw,options={})=>{
    const url=new URL(raw),body=options.body instanceof URLSearchParams?Object.fromEntries(options.body):options.body?JSON.parse(options.body):null;
    const call={url,options,body}; calls.push(call);
    const answer=responder(call,calls.length);
    return answer instanceof Response?answer:Response.json(answer);
  });return calls;
}
for (const browser of ['chrome','firefox']) {
  const native=await import(`../src/${browser}/src/agent/captcha-native-providers.js`);
  const {CAPTCHA_CATALOG:catalog}=await import(`../src/${browser}/src/agent/captcha-catalog.js`);
  const apply=await import(`../src/${browser}/src/agent/captcha-solution-application.js`);
  const providers=['capsolver','2captcha','capmonster','solvecaptcha','anti-captcha','nopecha','nonecap'].map((id,index)=>({id,apiKey:`secret-${id}`,weight:100-index}));
  for (const [provider,method,parameters,expected] of fixtures) test(`${browser}: native ${provider}/${method} matches its wire contract`,()=>{
    assert.deepEqual(native.buildNativeCaptchaTask({provider,method,parameters}).task,expected);
  });
  test(`${browser}: every CapMonster recognition model uses the documented wire discriminator`,()=>{
    const names={bills_audio:'bills_audio',shein:'shein',bls:'bls_3x3',baidu:'baidu',betpunch_3x3_rotate:'betpunch_3x3_rotate',oocl_rotate_double_new:'oocl_rotate_double_new',oocl_rotate_new:'oocl_rotate_new',dli_ensemble:'dli',mathsum:'MathSum',portugal_text_find_icon:'portugal_text_find_icon'};
    for(const [id,Task] of Object.entries(names)) {
      const parameters={imagesBase64:['base64'],...(['bls','portugal_text_find_icon'].includes(id)?{metadata:{TaskArgument:'observed'}}:{})};
      const task=native.buildNativeCaptchaTask({provider:'capmonster',method:`ComplexImageTask:recognition:${id}`,parameters}).task;
      assert.equal(task.metadata.Task,Task);assert.equal(task.class,'recognition');
      if(id==='bills_audio')assert.equal(task.metadata.PayloadType,'Audio');
    }
  });
  test(`${browser}: catalogs cover seven vendors without resurrecting draft hCaptcha methods`,()=>{
    assert.equal(catalog.length,197);
    for(const provider of providers) assert.ok(catalog.some(c=>c.provider===provider.id));
    assert.deepEqual([...new Set(catalog.filter(c=>c.family==='hcaptcha').map(c=>c.provider))].sort(),['nonecap','nopecha']);
    const cm=new Set(catalog.filter(c=>c.provider==='capmonster').map(c=>c.family));
    for(const family of ['recaptcha_v2','recaptcha_v3','recaptcha_v2_enterprise','recaptcha_v3_enterprise','geetest','turnstile','cloudflare_challenge','cloudflare_waiting_room','datadome','tencent','aws_waf','basilisk','imperva','prosopo','image_to_text','yidun','mtcaptcha','altcha','funcaptcha','tspd','hunt','alibaba','friendly','complex_image','binance','recaptcha_recognition']) assert.ok(cm.has(family),family);
    const discovery=native.getCaptchaCapabilities(providers);
    assert.equal(discovery.providers.length,7);assert.equal(JSON.stringify(discovery).includes('secret-'),false);
    assert.equal(native.getCaptchaCapabilities([{id:'capsolver',useCloudBroker:true}]).providers.length,0);
  });
  test(`${browser}: validation prevents spend on malformed, unsupported, disabled, duplicated, or incompatible tasks`,()=>{
    const entry={provider:'capsolver',method:'AntiCloudflareTask',parameters:{websiteURL:url,proxy:'http:p:80'}};
    for(const parameters of [{websiteURL:url},{...entry.parameters,callbackUrl:'https://evil.test'},{...entry.parameters,type:'UnknownTask'},JSON.parse('{"__proto__":{"polluted":true}}')]) assert.throws(()=>native.prepareNativeCaptchaTasks(providers,[{...entry,parameters}]));
    assert.throws(()=>native.prepareNativeCaptchaTasks(providers,[entry,entry]),/one method/);
    assert.throws(()=>native.prepareNativeCaptchaTasks([], [entry]),/enabled/);
    assert.throws(()=>native.prepareNativeCaptchaTasks([{id:'capsolver',useCloudBroker:true}], [entry]),/personal/);
    assert.throws(()=>native.prepareNativeCaptchaTasks(providers,[entry,{provider:'nonecap',method:'hcaptcha',parameters:{sitekey:'site',url}}]),/same CAPTCHA/);
    assert.throws(()=>native.buildNativeCaptchaTask({provider:'2captcha',method:'GeeTestTaskProxyless',parameters:{websiteURL:url,gt:'gt'}}),/fresh challenge/);
    assert.throws(()=>native.buildNativeCaptchaTask({provider:'nopecha',method:'token/turnstile',parameters:{sitekey:'site',url}}),/proxy/);
    assert.throws(()=>native.buildNativeCaptchaTask({provider:'capmonster',method:'ComplexImageTask:recaptcha',parameters:{metadata:{Grid:'3x3',Task:'cars'}}}),/imageUrls or imagesBase64/);
  });
  test(`${browser}: weighted JSON fallback preserves structured answers and synchronous results`,async t=>{
    const calls=mockApi(t,c=>c.url.hostname==='api.capsolver.com'?{errorId:1,errorDescription:'failed'}:{status:'ready',solution:{captcha_id:'id',lot_number:'lot',pass_token:'pass',gen_time:'time',captcha_output:'out'}});
    const entries=[{provider:'2captcha',method:'GeeTestTaskProxyless',parameters:{websiteURL:url,version:4,initParameters:{captcha_id:'id'}}},{provider:'capsolver',method:'GeeTestTaskProxyLess',parameters:{websiteURL:url,captchaId:'id'}}];
    const result=await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,entries));
    assert.equal(result.provider,'2captcha');assert.equal(result.solution.lot_number,'lot');
    assert.deepEqual(calls.map(c=>c.url.hostname),['api.capsolver.com','api.2captcha.com']);
    assert.equal(calls[0].body.task.captchaId,'id');assert.equal(calls[1].body.task.initParameters.captcha_id,'id');
  });
  test(`${browser}: recognition keeps false selections and zero coordinates`,async t=>{
    const calls=mockApi(t,c=>c.options.method==='POST'?{data:'job'}:{data:[false,false,false]});
    const result=await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,[{provider:'nopecha',method:'recognition/recaptcha',parameters:{task:'cars',grid:'3x3',image_data:['base64']}}]));
    assert.deepEqual(result.solution,[false,false,false]);assert.equal(calls[0].url.pathname,'/v1/recognition/recaptcha');assert.equal(calls[1].options.method,'GET');assert.equal(calls[0].options.headers.Authorization,'Basic secret-nopecha');
    assert.equal(calls.some(c=>c.url.href.includes('secret-')),false);
  });
  test(`${browser}: SolveCaptcha form polling decodes object results, without flattening them into token strings`,async t=>{
    const calls=mockApi(t,c=>c.url.pathname==='/in.php'?{status:1,request:'123'}:{status:1,request:'{"captcha_id":"id","lot_number":"lot"}'});
    const result=await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,[{provider:'solvecaptcha',method:'geetest_v4',parameters:{pageurl:url,captcha_id:'id'}}]));
    assert.equal(calls[0].body.method,'geetest_v4');assert.equal(calls[0].body.key,'secret-solvecaptcha');assert.equal(result.solution.lot_number,'lot');assert.equal(calls.length,2);
  });
  test(`${browser}: solution binding preserves structured callback values and blocks arbitrary scripts/prototype paths`,()=>{
    const solution={token:'answer',cookie:'clearance',structured:{lot:'x'},coordinates:[{x:0,y:0}]};
    assert.deepEqual(apply.prepareCaptchaApplication(solution,{fields:[{selector:'#response',path:'token'}],cookies:[{name:'cf_clearance',path:'cookie'}],callback:{name:'captcha.done',path:'structured'}}),{fields:[{selector:'#response',value:'answer'}],cookies:[{name:'cf_clearance',value:'clearance'}],callback:{name:'captcha.done',value:{lot:'x'}}});
    assert.throws(()=>apply.prepareCaptchaApplication(solution,{fields:[{selector:'#r',path:'constructor'}]}));
    assert.throws(()=>apply.prepareCaptchaApplication(solution,{callback:{name:'eval',path:'token'}}));
    assert.throws(()=>apply.prepareCaptchaApplication(solution,{fields:[{selector:'#r',path:'structured'}]}),/encoding/);
    assert.throws(()=>apply.prepareCaptchaApplication({cookie:'a; Domain=evil.test'},{cookies:[{name:'cf_clearance',path:'cookie'}]}),/cookie/);
  });
}
test('native CAPTCHA modules stay mirrored',async()=>{
  for(const name of ['captcha-catalog.js','captcha-native-providers.js','captcha-solution-application.js','captcha-hcaptcha-providers.js','captcha-json-api.js']) assert.equal(await readFile(`src/chrome/src/agent/${name}`,'utf8'),await readFile(`src/firefox/src/agent/${name}`,'utf8'),name);
});

for (const browser of ['chrome', 'firefox']) {
  const native = await import(`../src/${browser}/src/agent/captcha-native-providers.js`);
  const { prepareCaptchaApplication, applyNativeCaptchaSolution } = await import(`../src/${browser}/src/agent/captcha-solution-application.js`);
  test(`${browser}: documented cookie responses bind only the requested host-only value`, () => {
    const result = prepareCaptchaApplication({ cookie: 'datadome=ANSWER==; Path=/; Secure; Domain=.other.test; SameSite=Lax' }, { cookies: [{ name: 'datadome', path: 'cookie' }] });
    assert.deepEqual(result.cookies, [{ name: 'datadome', value: 'ANSWER==' }]);
    for (const cookie of ['other=ANSWER; Path=/', 'datadome=ANSWER\r\nSet-Cookie: other=x']) {
      assert.throws(() => prepareCaptchaApplication({ cookie }, { cookies: [{ name: 'datadome', path: 'cookie' }] }), /Invalid CAPTCHA cookie/);
    }
  });
  test(`${browser}: a failed read or first cookie write keeps the paid answer reusable`, async () => {
    for (const failure of ['tab-read', 'cookie-write']) {
      const record = { pageUrl: url, createdAt: Date.now(), applied: false,
        documents: [{ frameId: 0, url, timeOrigin: 1000 }], solution: { cookie: 'clearance' } };
      let tabReads = 0;
      let cookieWrites = 0;
      let pageMutations = 0;
      const api = {
        tabs: {
          get: async () => {
            if (failure === 'tab-read' && ++tabReads === 2) throw new Error('Temporary tab read failure');
            return { url };
          },
          executeScript: async (_tabId, options) => {
            if (/false\]\)$/.test(options.code)) pageMutations++;
            return [{ success: true }];
          },
        },
        scripting: browser === 'chrome' ? { executeScript: async options => {
          if (options.args.at(-1) === false) pageMutations++;
          return [{ frameId: 0, result: { success: true } }];
        } } : undefined,
        webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
        cookies: {
          getAllCookieStores: async () => [{ id: 'store', tabIds: [1] }],
          set: async value => {
            if (failure === 'cookie-write' && ++cookieWrites === 1) return null;
            return value;
          },
        },
      };
      const binding = { frameId: 0, frameUrl: url, cookies: [{ name: 'cf_clearance', path: 'cookie' }] };
      await assert.rejects(applyNativeCaptchaSolution(1, record, binding, api), /Temporary tab read failure|cookie could not be set/);
      assert.equal(record.applied, false, failure);
      assert.equal(pageMutations, 0, failure);
      assert.equal((await applyNativeCaptchaSolution(1, record, binding, api)).success, true, failure);
      assert.equal(record.applied, true, failure);
      assert.equal(pageMutations, 1, failure);
    }
  });
  test(`${browser}: a successful first cookie write consumes the answer before later failures`, async () => {
    const record = { pageUrl: url, createdAt: Date.now(), applied: false,
      documents: [{ frameId: 0, url, timeOrigin: 1000 }], solution: { first: 'one', second: 'two' } };
    let writes = 0;
    const api = {
      tabs: { get: async () => ({ url }), executeScript: async () => [{ success: true }] },
      scripting: browser === 'chrome' ? { executeScript: async () => [{ frameId: 0, result: { success: true } }] } : undefined,
      webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
      cookies: { getAllCookieStores: async () => [{ id: 'store', tabIds: [1] }],
        set: async value => ++writes === 1 ? value : null },
    };
    await assert.rejects(applyNativeCaptchaSolution(1, record, { frameId: 0, frameUrl: url,
      cookies: [{ name: 'first', path: 'first' }, { name: 'second', path: 'second' }] }, api), /cookie could not be set/);
    assert.equal(record.applied, true);
    assert.equal(writes, 2);
  });
  test(`${browser}: a non-cookie answer survives a second pre-mutation frame check`, async () => {
    const record = { pageUrl: url, createdAt: Date.now(), applied: false,
      documents: [{ frameId: 0, url, timeOrigin: 1000 }], solution: { token: 'answer' } };
    let attempts = 0;
    const result = () => ++attempts === 2
      ? { success: false, error: 'Observed CAPTCHA callback is unavailable.' }
      : { success: true };
    const api = {
      tabs: { get: async () => ({ url }), executeScript: async () => [result()] },
      scripting: browser === 'chrome' ? { executeScript: async () => [{ frameId: 0, result: result() }] } : undefined,
      webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
    };
    const binding = { frameId: 0, frameUrl: url, fields: [{ selector: '#response', path: 'token' }] };
    assert.equal((await applyNativeCaptchaSolution(1, record, binding, api)).success, false);
    assert.equal(record.applied, false);
    assert.equal((await applyNativeCaptchaSolution(1, record, binding, api)).success, true);
    assert.equal(record.applied, true);
  });
  test(`${browser}: an indeterminate non-cookie application consumes the answer`, async () => {
    const record = { pageUrl: url, createdAt: Date.now(), applied: false,
      documents: [{ frameId: 0, url, timeOrigin: 1000 }], solution: { token: 'answer' } };
    let attempts = 0;
    const result = () => { if (++attempts === 2) throw new Error('Frame execution failed'); return { success: true }; };
    const api = {
      tabs: { get: async () => ({ url }), executeScript: async () => [result()] },
      scripting: browser === 'chrome' ? { executeScript: async () => [{ frameId: 0, result: result() }] } : undefined,
      webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
    };
    await assert.rejects(applyNativeCaptchaSolution(1, record, { frameId: 0, frameUrl: url,
      fields: [{ selector: '#response', path: 'token' }] }, api), /Frame execution failed/);
    assert.equal(record.applied, true);
  });
  for (const [method, answer, expected, binding] of [
    ['grid', 'click:3/a/g/', [3, 10, 16], { mode: 'grid', rows: 4, columns: 4 }],
    ['coordinates', 'coordinate:x=0,y=59;x=252,y=72', [{ x: 0, y: 59 }, { x: 252, y: 72 }], { mode: 'coordinates', sourceWidth: 300, sourceHeight: 300 }],
  ]) test(`${browser}: ${method} paid answer can be applied without another solve`, async t => {
    const calls = mockApi(t, call => call.url.pathname === '/in.php' ? { status: 1, request: 'job' } : { status: 1, request: answer });
    const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks([{ id: 'solvecaptcha', apiKey: 'key' }], [{ provider: 'solvecaptcha', method, parameters: { body: 'image' } }]));
    assert.deepEqual(result.solution, expected);
    const application = prepareCaptchaApplication(result.solution, { clicks: [{ selector: '#grid', path: '', ...binding }] });
    assert.equal(application.clicks[0].points.length, expected.length);
    assert.equal(calls.length, 2);
  });
  test(`${browser}: NoneCap Enterprise without rqdata and fractional SolveCaptcha scores are accepted`, () => {
    assert.equal(native.buildNativeCaptchaTask({ provider: 'nonecap', method: 'hcaptcha_enterprise', parameters: { sitekey: 'site', url } }).task.type, 'hcaptcha_enterprise');
    for (const method of ['recaptcha_v3', 'recaptcha_v3:enterprise']) assert.equal(native.buildNativeCaptchaTask({ provider: 'solvecaptcha', method, parameters: { googlekey: 'site', pageurl: url, min_score: 0.5 } }).task.min_score, 0.5);
  });
  const pairs = [
    ['atb', ['2captcha', 'AtbCaptchaTaskProxyless', { websiteURL: url, appId: 'A', apiServer: 'https://api.test' }], ['solvecaptcha', 'atb_captcha', { pageurl: url, app_id: 'A', api_server: 'https://api.test' }], 'app_id'],
    ['cutcaptcha', ['2captcha', 'CutCaptchaTaskProxyless', { websiteURL: url, miseryKey: 'A', apiKey: 'site-key' }], ['solvecaptcha', 'cutcaptcha', { pageurl: url, misery_key: 'A', api_key: 'site-key' }], 'misery_key'],
    ['tencent', ['2captcha', 'TencentTaskProxyless', { websiteURL: url, appId: 'A' }], ['solvecaptcha', 'tencent', { pageurl: url, app_id: 'A' }], 'app_id'],
    ['lemin', ['2captcha', 'LeminTaskProxyless', { websiteURL: url, captchaId: 'A', divId: 'div' }], ['solvecaptcha', 'lemin', { pageurl: url, captcha_id: 'A', div_id: 'div' }], 'captcha_id'],
    ['aws_waf', ['2captcha', 'AmazonTaskProxyless', { websiteURL: url, websiteKey: 'A', iv: 'iv', context: 'context' }], ['capsolver', 'AntiAwsWafTaskProxyLess', { websiteURL: url, awsKey: 'A', awsIv: 'iv', awsContext: 'context' }], 'awsKey'],
    ['geetest', ['2captcha', 'GeeTestTaskProxyless', { websiteURL: url, gt: 'A', challenge: 'fresh' }], ['solvecaptcha', 'geetest', { pageurl: url, gt: 'A', challenge: 'fresh' }], 'challenge'],
    ['text_captcha', ['2captcha', 'TextCaptchaTask', { comment: '2+2?' }], ['solvecaptcha', 'text', { textcaptcha: '2+2?' }], 'textcaptcha'],
    ['captchafox', ['2captcha', 'CaptchaFoxTask', { websiteURL: url, websiteKey: 'site', apiServer: 'https://api.test', userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080 }], ['solvecaptcha', 'captchafox', { pageurl: url, sitekey: 'site', api_server: 'https://api.test', proxy: 'proxy.test:8080', proxytype: 'http', useragent: 'browser-UA' }], 'api_server'],
    ['altcha', ['2captcha', 'AltchaTaskProxyless', { websiteURL: url, challengeURL: 'https://example.test/challenge.json' }], ['solvecaptcha', 'altcha', { pageurl: url, challenge_url: 'https://example.test/challenge.json' }], 'challenge_url'],
    ['friendly', ['2captcha', 'FriendlyCaptchaTaskProxyless', { websiteURL: url, websiteKey: 'site', version: 'v2' }], ['solvecaptcha', 'friendly_captcha', { pageurl: url, sitekey: 'site', version: 'v2' }], 'version'],
  ];
  for (const [family, a, b, changed] of pairs) test(`${browser}: ${family} identifier aliases agree before any paid request`, async t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [a,b].map(([provider, method, parameters]) => ({ provider, method, parameters }));
    const providers = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(providers, entries).length, 2);
    entries[1].parameters = { ...entries[1].parameters, [changed]: 'different' };
    await assert.rejects(async () => native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers, entries)), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  const actionBoundPairs = [
    ['reCAPTCHA v2 data-s', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', recaptchaDataSValue: 'observed' }], ['solvecaptcha', 'recaptcha_v2', { pageurl: url, googlekey: 'site', 'data-s': 'observed' }], 'data-s'],
    ['reCAPTCHA v2 enterprise data-s', ['2captcha', 'RecaptchaV2EnterpriseTaskProxyless', { websiteURL: url, websiteKey: 'site', enterprisePayload: { s: 'observed' } }], ['solvecaptcha', 'recaptcha_v2_enterprise', { pageurl: url, googlekey: 'site', 'data-s': 'observed' }], 'data-s'],
    ['reCAPTCHA v2 nested data-s', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', recaptchaDataSValue: 'observed' }], ['nopecha', 'token/recaptcha2', { url, sitekey: 'site', data: { s: 'observed' } }], 'data.s'],
    ['reCAPTCHA v3 action', ['2captcha', 'RecaptchaV3TaskProxyless', { websiteURL: url, websiteKey: 'site', minScore: 0.3, pageAction: 'login' }], ['solvecaptcha', 'recaptcha_v3', { pageurl: url, googlekey: 'site', action: 'login' }], 'action'],
    ['reCAPTCHA v3 enterprise action', ['capsolver', 'ReCaptchaV3EnterpriseTaskProxyLess', { websiteURL: url, websiteKey: 'site', pageAction: 'login' }], ['nopecha', 'token/recaptcha3:enterprise', { url, sitekey: 'site', data: { action: 'login' } }], 'data.action'],
    ['Turnstile action', ['capsolver', 'AntiTurnstileTaskProxyLess', { websiteURL: url, websiteKey: 'site', metadata: { action: 'login', cdata: 'widget' } }], ['anti-captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', cData: 'widget' }], 'action'],
    ['Turnstile cData', ['2captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', data: 'widget' }], ['anti-captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', cData: 'widget' }], 'cData'],
    ['Turnstile page data', ['2captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', pagedata: 'page' }], ['solvecaptcha', 'turnstile', { pageurl: url, sitekey: 'site', pagedata: 'page' }], 'pagedata'],
    ['Turnstile nested metadata', ['capmonster', 'TurnstileTask', { websiteURL: url, websiteKey: 'site', pageAction: 'login', data: 'widget' }], ['nopecha', 'token/turnstile', { url, sitekey: 'site', proxy: { scheme: 'http', host: 'proxy.test', port: 8080 }, data: { action: 'login', cdata: 'widget' } }], 'data.cdata'],
  ];
  for (const [label, a, b, changed] of actionBoundPairs) test(`${browser}: ${label} mismatch cannot spend`, async t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [a, b].map(([provider, method, parameters]) => ({ provider, method, parameters: structuredClone(parameters) }));
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    const path = changed.split('.');
    let target = entries[1].parameters;
    for (const part of path.slice(0, -1)) target = target[part];
    target[path.at(-1)] = 'different';
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  for (const [label, entries] of [
    ['reCAPTCHA v2 omitted data-s', [
      { provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', recaptchaDataSValue: 'observed' } },
      { provider: 'solvecaptcha', method: 'recaptcha_v2', parameters: { pageurl: url, googlekey: 'site' } },
    ]],
    ['reCAPTCHA v2 enterprise omitted data-s', [
      { provider: '2captcha', method: 'RecaptchaV2EnterpriseTaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', enterprisePayload: { s: 'observed' } } },
      { provider: 'solvecaptcha', method: 'recaptcha_v2_enterprise', parameters: { pageurl: url, googlekey: 'site' } },
    ]],
    ['reCAPTCHA v3 omitted action', [
      { provider: '2captcha', method: 'RecaptchaV3TaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', minScore: 0.3, pageAction: 'delete' } },
      { provider: 'solvecaptcha', method: 'recaptcha_v3', parameters: { pageurl: url, googlekey: 'site' } },
    ]],
    ['Turnstile omitted cData', [
      { provider: '2captcha', method: 'TurnstileTaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', data: 'observed-cdata' } },
      { provider: 'anti-captcha', method: 'TurnstileTaskProxyless', parameters: { websiteURL: url, websiteKey: 'site' } },
    ]],
  ]) test(`${browser}: ${label} cannot spend`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    assert.throws(() => native.prepareNativeCaptchaTasks(entries.map(entry => ({ id: entry.provider, apiKey: 'key' })), entries), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  const recognitionPairs = [
    ['coordinates body', ['2captcha', 'CoordinatesTask', { body: 'image-A' }], ['solvecaptcha', 'coordinates', { body: 'image-A' }], task => { task.body = 'image-B'; }],
    ['image-to-text array alias', ['2captcha', 'ImageToTextTask', { body: 'image-A' }], ['nopecha', 'recognition/textcaptcha', { image_data: ['image-A'] }], task => { task.image_data = ['image-B']; }],
    ['Temu parts', ['2captcha', 'TemuImageTask', { image: 'background', parts: ['one', 'two', 'three'] }], ['solvecaptcha', 'temuimage', { body: 'background', part1: 'one', part2: 'two', part3: 'three' }], task => { task.part2 = 'different'; }],
  ];
  for (const [label, a, b, change] of recognitionPairs) test(`${browser}: ${label} must match before paid fallback`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [a, b].map(([provider, method, parameters]) => ({ provider, method, parameters: structuredClone(parameters) }));
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    change(entries[1].parameters);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed challenge media/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: image and audio AWS recognition cannot share a fallback`, () => {
    assert.throws(() => native.prepareNativeCaptchaTasks(
      [{ id: 'capsolver', apiKey: 'key' }, { id: 'nopecha', apiKey: 'key' }],
      [
        { provider: 'capsolver', method: 'AwsWafClassification', parameters: { images: ['same-bytes'], question: 'cars' } },
        { provider: 'nopecha', method: 'recognition/awscaptcha', parameters: { audio_data: ['same-bytes'] } },
      ],
    ), /same observed challenge media/);
  });
}
