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
  test(`${browser}: observed AWS WAF challenge yields fallback tasks only for cookie-returning providers`, async () => {
    const runtime = await import(`../src/${browser}/src/agent/captcha-frame-runtime.js`);
    const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
    const challengeScript = 'https://abc.edge.token.awswaf.com/abc/def/challenge.js';
    globalThis.window = { gokuProps: { key: 'AQIDAHjc', iv: 'CgAH', context: 'ctx' } };
    globalThis.document = {
      scripts: [{ src: challengeScript }, { src: 'https://evil.test/awswaf.com/challenge.js' }],
      querySelector: selector => selector.includes('amzn-captcha') ? {} : null,
    };
    globalThis.location = { href: 'https://site.test/join' };
    let observed;
    try { observed = runtime.observeAwsWafChallengeInPage(); }
    finally { Object.assign(globalThis, saved); }
    assert.deepEqual(observed, { pageUrl: 'https://site.test/join', websiteKey: 'AQIDAHjc', iv: 'CgAH', context: 'ctx',
      challengeScript, captchaScript: null, jsapiScript: null, widgetPresent: true });

    const providers = ['capsolver', '2captcha', 'capmonster', 'solvecaptcha', 'anti-captcha', 'nopecha'].map(id => ({ id, apiKey: `key-${id}` }));
    const described = native.describeAwsWafObservation(providers, observed);
    // 2Captcha and SolveCaptcha return a voucher, not an applicable cookie.
    assert.deepEqual(described.providerTasks.map(task => task.provider), ['capsolver', 'capmonster', 'anti-captcha']);
    assert.deepEqual(described.application.cookiePathByProvider, { capsolver: 'cookie', capmonster: 'cookies.aws-waf-token', 'anti-captcha': 'token' });
    const prepared = native.prepareNativeCaptchaTasks(providers, described.providerTasks);
    assert.equal(prepared.length, 3);
    assert.equal(prepared.find(entry => entry.provider.id === 'capmonster').task.cookieSolution, true);
    for (const [provider, path, solution] of [['capsolver', 'cookie', { cookie: 'tok' }],
      ['capmonster', 'cookies.aws-waf-token', { cookies: { 'aws-waf-token': 'tok' } }], ['anti-captcha', 'token', { token: 'tok' }]]) {
      const application = apply.prepareCaptchaApplication(solution, { frameId: 0, frameUrl: observed.pageUrl, cookies: [{ name: 'aws-waf-token', path }] });
      assert.deepEqual(application.cookies, [{ name: 'aws-waf-token', value: 'tok' }], provider);
    }

    assert.deepEqual(native.describeAwsWafObservation(providers, { ...observed, iv: null }).missing, ['iv']);
    assert.equal(native.describeAwsWafObservation(providers.filter(p => ['2captcha', 'solvecaptcha'].includes(p.id)), observed).providerTasks, undefined);
    assert.equal(native.describeAwsWafObservation(providers, { pageUrl: observed.pageUrl }), null);
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
  test(`${browser}: Cloudflare fallback requires the same mode and page snapshot before dispatch`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const html = '<html><body>Fresh challenge ✓</body></html>';
    const capsolver = { provider: 'capsolver', method: 'AntiCloudflareTask', parameters: {
      websiteURL: url, proxy: 'http:proxy.test:8080', userAgent: 'browser-UA', html,
    } };
    const capmonster = { provider: 'capmonster', method: 'TurnstileTask:cf_clearance:2', parameters: {
      websiteURL: url, websiteKey: 'site', htmlPageBase64: Buffer.from(html, 'utf8').toString('base64'),
      userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080,
    } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [capsolver, capmonster]).length, 2);
    for (const changed of [
      { ...capsolver, parameters: { ...capsolver.parameters, html: '<html>Previous challenge</html>' } },
      { ...capsolver, parameters: { websiteURL: url, proxy: 'http:proxy.test:8080', userAgent: 'browser-UA' } },
    ]) assert.throws(() => native.prepareNativeCaptchaTasks(providers, [changed, capmonster]), /same observed page snapshot|same challenge mode/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [capsolver, {
      ...capmonster, parameters: { ...capmonster.parameters, htmlPageBase64: 'not base64' },
    }]), /valid page snapshot/);
    const token = { provider: 'capmonster', method: 'TurnstileTask:token:1', parameters: {
      websiteURL: url, websiteKey: 'site', pageAction: 'managed', data: 'data', pageData: 'page',
      userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080,
    } };
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [capsolver, token]), /same challenge mode/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: reCAPTCHA fallback preserves observed session cookies across provider formats`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const twoCaptcha = { provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: {
      websiteURL: url, websiteKey: 'site', cookies: 'SID=A; PREF=one=two',
    } };
    const solveCaptcha = { provider: 'solvecaptcha', method: 'recaptcha_v2', parameters: {
      pageurl: url, googlekey: 'site', cookies: 'PREF:one=two; SID:A;',
    } };
    const capsolver = { provider: 'capsolver', method: 'ReCaptchaV2TaskProxyLess', parameters: {
      websiteURL: url, websiteKey: 'site', cookies: [
        { name: 'PREF', value: 'one=two' }, { name: 'SID', value: 'A' },
      ],
    } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [twoCaptcha, solveCaptcha, capsolver]).length, 3);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      ...solveCaptcha, parameters: { ...solveCaptcha.parameters, cookies: 'SID:B; PREF:one=two' },
    }]), /same observed cookie set/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      ...solveCaptcha, parameters: { pageurl: url, googlekey: 'site' },
    }]), /same observed cookie set/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      provider: 'nopecha', method: 'token/recaptcha2', parameters: { sitekey: 'site', url,
        cookie: [{ name: 'SID', value: 'A', domain: 'example.test', path: '/',
          hostOnly: true, httpOnly: false, secure: true, session: true }] },
    }]), /same observed cookie set/);
    assert.throws(() => native.buildNativeCaptchaTask({ ...capsolver,
      parameters: { ...capsolver.parameters, cookies: 'SID=A' } }), /must be array/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: hCaptcha fallback rejects cookies that a later provider cannot preserve`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const nopecha = { provider: 'nopecha', method: 'token/hcaptcha', parameters: {
      sitekey: 'site', url,
      cookie: [{ name: 'SID', value: 'session', domain: 'example.test', path: '/',
        hostOnly: true, httpOnly: false, secure: true, session: true }],
    } };
    const nonecap = { provider: 'nonecap', method: 'hcaptcha', parameters: { sitekey: 'site', url } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [
      { ...nopecha, parameters: { sitekey: 'site', url } }, nonecap,
    ]).length, 2);
    assert.equal(native.prepareNativeCaptchaTasks(providers, [nopecha]).length, 1);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [nopecha, nonecap]),
      /cannot preserve the observed cookie set/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: GeeTest fallback matches provider-specific API service hosts`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const twoCaptcha = { provider: '2captcha', method: 'GeeTestTaskProxyless', parameters: {
      websiteURL: url, gt: 'site', challenge: 'fresh', geetestApiServerSubdomain: 'api-na.geetest.com',
    } };
    const solveCaptcha = { provider: 'solvecaptcha', method: 'geetest', parameters: {
      pageurl: url, gt: 'site', challenge: 'fresh', api_server: 'https://API-NA.GEETEST.COM/',
    } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [twoCaptcha, solveCaptcha]).length, 2);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      ...solveCaptcha, parameters: { ...solveCaptcha.parameters, api_server: 'api-eu.geetest.com' },
    }]), /same observed service host/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      ...solveCaptcha, parameters: { pageurl: url, gt: 'site', challenge: 'fresh' },
    }]), /same observed service host/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, {
      ...solveCaptcha, parameters: { ...solveCaptcha.parameters, api_server: 'https://api-na.geetest.com/other' },
    }]), /comparable service hosts/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: AWS WAF fallback compares API, challenge, and CAPTCHA scripts before dispatch`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const twoCaptcha = { provider: '2captcha', method: 'AmazonTaskProxyless', parameters: {
      websiteURL: url, websiteKey: 'key', jsapiScript: 'https://a.test/jsapi.js',
      challengeScript: 'https://a.test/challenge.js',
    } };
    const capsolver = { provider: 'capsolver', method: 'AntiAwsWafTaskProxyLess', parameters: {
      websiteURL: url, awsKey: 'key', awsApiJs: 'https://a.test/jsapi.js',
      awsChallengeJS: 'https://a.test/challenge.js',
    } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [twoCaptcha, capsolver]).length, 2);
    for (const parameters of [
      { ...capsolver.parameters, awsApiJs: 'https://b.test/jsapi.js' },
      { ...capsolver.parameters, awsChallengeJS: 'https://b.test/challenge.js' },
    ]) assert.throws(() => native.prepareNativeCaptchaTasks(providers, [twoCaptcha, { ...capsolver, parameters }]), /same observed challenge/);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [
      { ...twoCaptcha, parameters: { ...twoCaptcha.parameters, captchaScript: 'https://a.test/captcha.js' } }, capsolver,
    ]), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: enumerated nested task fields reject undocumented data before paid dispatch`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entry = { provider: 'capmonster', method: 'CustomTask:alibaba', parameters: {
      websiteURL: url, metadata: { sceneId: 'scene', prefix: 'prefix', secret: 'page-provided-secret' },
    } };
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [entry]), /undocumented field metadata.secret/);
    assert.equal(calls.length, 0);
    const allowed = { ...entry, parameters: { ...entry.parameters,
      metadata: { sceneId: 'scene', prefix: 'prefix' } } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [allowed]).length, 1);
    // Provider-documented option objects remain open where their schemas say so.
    assert.equal(native.buildNativeCaptchaTask({ provider: 'nopecha', method: 'token/recaptcha2:enterprise',
      parameters: { url, sitekey: 'site', data: { s: 'observed' } } }).task.data.s, 'observed');
    const cookie = { name: 'SID', value: 'x', domain: 'example.test', path: '/',
      hostOnly: true, httpOnly: false, secure: true, session: true };
    const token = { provider: 'nopecha', method: 'token/recaptcha2', parameters: {
      url, sitekey: 'site', cookie: [cookie],
    } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [token]).length, 1);
    for (const item of [{ ...cookie, undocumentedSecret: 'page data' }, { name: 'SID', value: 'x' }]) {
      assert.throws(() => native.prepareNativeCaptchaTasks(providers, [{ ...token,
        parameters: { ...token.parameters, cookie: [item] },
      }]), /invalid array element/);
    }
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [{
      provider: 'nopecha', method: 'recognition/textcaptcha', parameters: { image_data: [{ secret: 'page data' }] },
    }]), /invalid array element/);
    const hcaptcha = { provider: 'nopecha', method: 'recognition/hcaptcha', parameters: { data: {
      request_type: 'image_drag_drop', requester_question: { en: 'Match the objects' },
      tasklist: [{ task_key: 'task', datapoint_uri: 'data:image/jpeg;base64,a', entities: [{
        entity_id: 'entity', entity_uri: 'data:image/png;base64,b', coords: [10, 20], size: [30, 40],
      }] }],
    } } };
    assert.equal(native.prepareNativeCaptchaTasks(providers, [hcaptcha]).length, 1);
    assert.throws(() => native.prepareNativeCaptchaTasks(providers, [{ ...hcaptcha,
      parameters: { data: { ...hcaptcha.parameters.data, tasklist: [{
        ...hcaptcha.parameters.data.tasklist[0], entities: [{
          ...hcaptcha.parameters.data.tasklist[0].entities[0], secret: 'page data',
        }],
      }] } },
    }]), /invalid array element/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: weighted JSON fallback preserves structured answers and synchronous results`,async t=>{
    const calls=mockApi(t,c=>c.url.hostname==='api.capsolver.com'?{errorId:1,errorDescription:'failed'}:{status:'ready',solution:{captcha_id:'id',lot_number:'lot',pass_token:'pass',gen_time:'time',captcha_output:'out'}});
    const entries=[{provider:'2captcha',method:'GeeTestTaskProxyless',parameters:{websiteURL:url,version:4,initParameters:{captcha_id:'id'}}},{provider:'capsolver',method:'GeeTestTaskProxyLess',parameters:{websiteURL:url,captchaId:'id'}}];
    const result=await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,entries));
    assert.equal(result.provider,'2captcha');assert.equal(result.solution.lot_number,'lot');
    assert.deepEqual(calls.map(c=>c.url.hostname),['api.capsolver.com','api.2captcha.com']);
    assert.equal(calls[0].body.task.captchaId,'id');assert.equal(calls[1].body.task.initParameters.captcha_id,'id');
  });
  for (const id of ['capsolver', '2captcha', 'capmonster', 'anti-captcha']) {
    test(`${browser}: native ${id} waits for its pending job before considering fallback`, async t => {
      const [, method, parameters] = fixtures.find(([provider]) => provider === id);
      const calls = mockApi(t, (call, n) => n === 1 ? { errorId: 0, taskId: 'one-job' }
        : n < 4 ? { errorId: 0, status: id === 'capsolver' && n === 2 ? 'idle' : 'processing' }
        : { errorId: 0, status: 'ready', solution: { token: 'answer' } });
      const result = await native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,
        [{ provider: id, method, parameters }]));
      assert.equal(result.provider, id);
      assert.equal(result.solution.token, 'answer');
      assert.equal(calls.filter(c => c.url.pathname === '/createTask').length, 1);
      assert.deepEqual(calls.slice(1).map(c => c.body.taskId), ['one-job', 'one-job', 'one-job']);
    });
  }
  test(`${browser}: native JSON pending compatibility does not swallow terminal errors`, async t => {
    const calls = mockApi(t, (call, n) => n === 1 ? { taskId: 'one-job' }
      : { errorId: 1, errorCode: 'ERROR_ZERO_BALANCE', status: 'idle' });
    await assert.rejects(native.solveNativeCaptchaTasks(native.prepareNativeCaptchaTasks(providers,
      [{ provider: 'capsolver', method: 'GeeTestTaskProxyLess', parameters: { websiteURL: url, captchaId: 'id' } }])), /ERROR_ZERO_BALANCE/);
    assert.equal(calls.length, 2);
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
  test(`${browser}: Alibaba fallback preserves verification mode, region and script identity`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const enabled = ['2captcha', 'capmonster'].map(id => ({ id, apiKey: 'key' }));
    const twoCaptcha = { provider: '2captcha', method: 'AlibabaTaskProxyless', parameters: {
      websiteURL: url, sceneId: 'scene', prefix: 'prefix', verifyType: 'slide',
      region: 'cn', apiGetLib: 'https://g.test/lib.js',
    } };
    const capmonster = { provider: 'capmonster', method: 'CustomTask:alibaba', parameters: {
      websiteURL: url, metadata: { sceneId: 'scene', prefix: 'prefix', verifyType: 'slide',
        region: 'cn', apiGetLib: 'https://g.test/lib.js' },
    } };
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, capmonster]).length, 2);
    for (const [key, value] of [
      ['verifyType', 'click'], ['region', 'sg'], ['apiGetLib', 'https://other.test/lib.js'],
    ]) assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, {
      ...capmonster, parameters: { ...capmonster.parameters,
        metadata: { ...capmonster.parameters.metadata, [key]: value } },
    }]), /same observed challenge/);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, {
      ...capmonster, parameters: { ...capmonster.parameters,
        metadata: { sceneId: 'scene', prefix: 'prefix' } },
    }]), /same observed challenge/);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, {
      ...capmonster, parameters: { ...capmonster.parameters,
        metadata: { ...capmonster.parameters.metadata, cookieRequired: true } },
    }]), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: Lemin fallback compares normalized provider API hosts`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const enabled = ['2captcha', 'solvecaptcha'].map(id => ({ id, apiKey: 'key' }));
    const twoCaptcha = { provider: '2captcha', method: 'LeminTaskProxyless', parameters: {
      websiteURL: url, captchaId: 'captcha', divId: 'container',
      leminApiServerSubdomain: 'api.leminnow.com',
    } };
    const solveCaptcha = { provider: 'solvecaptcha', method: 'lemin', parameters: {
      pageurl: url, captcha_id: 'captcha', div_id: 'container',
      api_server: 'https://API.LEMINNOW.COM/',
    } };
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, solveCaptcha]).length, 2);
    for (const api_server of ['b.example', 'https://api.leminnow.com/other']) {
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, {
        ...solveCaptcha, parameters: { ...solveCaptcha.parameters, api_server },
      }]), /service host/);
    }
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [twoCaptcha, {
      ...solveCaptcha, parameters: { pageurl: url, captcha_id: 'captcha', div_id: 'container' },
    }]), /same observed service host/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: session-bound native fallbacks reject providers that cannot carry cookies`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const enabled = ['2captcha', 'capmonster'].map(id => ({ id, apiKey: 'key' }));
    const proxy = { proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080 };
    const datadome = [
      { provider: '2captcha', method: 'DataDomeSliderTask', parameters: {
        websiteURL: url, captchaUrl: 'https://captcha.test/widget', userAgent: 'browser-UA', ...proxy,
      } },
      { provider: 'capmonster', method: 'CustomTask:DataDome', parameters: {
        websiteURL: url, metadata: { captchaUrl: 'https://captcha.test/widget', datadomeCookie: 'datadome=session' },
        userAgent: 'browser-UA', ...proxy,
      } },
    ];
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [datadome[0]]).length, 1);
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [datadome[1]]).length, 1);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, datadome), /same observed challenge/);
    const funcaptcha = [
      { provider: '2captcha', method: 'FunCaptchaTask', parameters: {
        websiteURL: url, websitePublicKey: 'site', ...proxy,
      } },
      { provider: 'capmonster', method: 'FunCaptchaTask', parameters: {
        websiteURL: url, websitePublicKey: 'site', cookies: 'SID=session', ...proxy,
      } },
    ];
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [funcaptcha[1]]).length, 1);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, funcaptcha), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: GeeTest v4 fallback preserves risk type aliases`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const enabled = ['capsolver', '2captcha'].map(id => ({ id, apiKey: 'key' }));
    const capsolver = { provider: 'capsolver', method: 'GeeTestTaskProxyLess', parameters: {
      websiteURL: url, captchaId: 'captcha', riskType: 'slide',
    } };
    const twoCaptcha = { provider: '2captcha', method: 'GeeTestTaskProxyless', parameters: {
      websiteURL: url, version: 4, initParameters: { captcha_id: 'captcha' }, risk_type: 'slide',
    } };
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [capsolver, twoCaptcha]).length, 2);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [capsolver, {
      ...twoCaptcha, parameters: { ...twoCaptcha.parameters, risk_type: 'match' },
    }]), /same observed challenge/);
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [capsolver, {
      ...twoCaptcha, parameters: { websiteURL: url, version: 4, initParameters: { captcha_id: 'captcha' } },
    }]), /same observed challenge/);
    assert.equal(calls.length, 0);
  });
  const actionBoundPairs = [
    ['DataDome User-Agent', ['2captcha', 'DataDomeSliderTask', { websiteURL: url, captchaUrl: 'https://example.test/captcha', userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080 }], ['solvecaptcha', 'datadome', { pageurl: url, captcha_url: 'https://example.test/captcha', userAgent: 'browser-UA', proxy: 'proxy.test:8080', proxytype: 'http' }], 'userAgent'],
    ['DataDome proxy', ['2captcha', 'DataDomeSliderTask', { websiteURL: url, captchaUrl: 'https://example.test/captcha', userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080 }], ['solvecaptcha', 'datadome', { pageurl: url, captcha_url: 'https://example.test/captcha', userAgent: 'browser-UA', proxy: 'proxy.test:8080', proxytype: 'http' }], 'proxy'],
    ['Tencent script', ['2captcha', 'TencentTaskProxyless', { websiteURL: url, appId: 'A', captchaScript: 'https://a.test/tcaptcha.js' }], ['solvecaptcha', 'tencent', { pageurl: url, app_id: 'A', captcha_script: 'https://a.test/tcaptcha.js' }], 'captcha_script'],
    ['Tencent metadata script', ['2captcha', 'TencentTaskProxyless', { websiteURL: url, appId: 'A', captchaScript: 'https://a.test/tcaptcha.js' }], ['capmonster', 'CustomTask:TenDI', { websiteURL: url, websiteKey: 'A', metadata: { captchaUrl: 'https://a.test/tcaptcha.js' } }], 'metadata.captchaUrl'],
    ['reCAPTCHA v2 data-s', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', recaptchaDataSValue: 'observed' }], ['solvecaptcha', 'recaptcha_v2', { pageurl: url, googlekey: 'site', 'data-s': 'observed' }], 'data-s'],
    ['reCAPTCHA v2 enterprise data-s', ['2captcha', 'RecaptchaV2EnterpriseTaskProxyless', { websiteURL: url, websiteKey: 'site', enterprisePayload: { s: 'observed' } }], ['solvecaptcha', 'recaptcha_v2_enterprise', { pageurl: url, googlekey: 'site', 'data-s': 'observed' }], 'data-s'],
    ['reCAPTCHA v2 nested data-s', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', recaptchaDataSValue: 'observed' }], ['nopecha', 'token/recaptcha2', { url, sitekey: 'site', data: { s: 'observed' } }], 'data.s'],
    ['reCAPTCHA v2 API domain alias', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', apiDomain: 'recaptcha.net' }], ['solvecaptcha', 'recaptcha_v2', { pageurl: url, googlekey: 'site', domain: 'recaptcha.net' }], 'domain'],
    ['reCAPTCHA v3 action', ['2captcha', 'RecaptchaV3TaskProxyless', { websiteURL: url, websiteKey: 'site', minScore: 0.3, pageAction: 'login' }], ['solvecaptcha', 'recaptcha_v3', { pageurl: url, googlekey: 'site', action: 'login', min_score: 0.3 }], 'action'],
    ['reCAPTCHA v3 API domain', ['2captcha', 'RecaptchaV3TaskProxyless', { websiteURL: url, websiteKey: 'site', minScore: 0.3, apiDomain: 'recaptcha.net' }], ['anti-captcha', 'RecaptchaV3TaskProxyless', { websiteURL: url, websiteKey: 'site', minScore: 0.3, apiDomain: 'recaptcha.net' }], 'apiDomain'],
    ['reCAPTCHA v3 score', ['2captcha', 'RecaptchaV3TaskProxyless', { websiteURL: url, websiteKey: 'site', minScore: 0.9, pageAction: 'login' }], ['solvecaptcha', 'recaptcha_v3', { pageurl: url, googlekey: 'site', action: 'login', min_score: 0.9 }], 'min_score'],
    ['reCAPTCHA v3 enterprise score', ['2captcha', 'RecaptchaV3TaskProxyless:enterprise', { websiteURL: url, websiteKey: 'site', minScore: 0.9, pageAction: 'login' }], ['solvecaptcha', 'recaptcha_v3:enterprise', { pageurl: url, googlekey: 'site', action: 'login', min_score: 0.9 }], 'min_score'],
    ['TSPD page snapshot', ['2captcha', 'TspdTask', { websiteURL: url, tspdCookie: 'cookie', htmlPageBase64: 'PAGE-A', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080, userAgent: 'browser-UA' }], ['capmonster', 'CustomTask:tspd', { websiteURL: url, metadata: { tspdCookie: 'cookie', htmlPageBase64: 'PAGE-A' }, proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080, userAgent: 'browser-UA' }], 'metadata.htmlPageBase64'],
    ['reCAPTCHA v3 enterprise action', ['capsolver', 'ReCaptchaV3EnterpriseTaskProxyLess', { websiteURL: url, websiteKey: 'site', pageAction: 'login' }], ['nopecha', 'token/recaptcha3:enterprise', { url, sitekey: 'site', data: { action: 'login' } }], 'data.action'],
    ['Turnstile action', ['capsolver', 'AntiTurnstileTaskProxyLess', { websiteURL: url, websiteKey: 'site', metadata: { action: 'login', cdata: 'widget' } }], ['anti-captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', cData: 'widget' }], 'action'],
    ['Turnstile cData', ['2captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', data: 'widget' }], ['anti-captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', action: 'login', cData: 'widget' }], 'cData'],
    ['Turnstile page data', ['2captcha', 'TurnstileTaskProxyless', { websiteURL: url, websiteKey: 'site', pagedata: 'page' }], ['solvecaptcha', 'turnstile', { pageurl: url, sitekey: 'site', pagedata: 'page' }], 'pagedata'],
    ['Turnstile nested metadata', ['capmonster', 'TurnstileTask', { websiteURL: url, websiteKey: 'site', pageAction: 'login', data: 'widget' }], ['nopecha', 'token/turnstile', { url, sitekey: 'site', proxy: { scheme: 'http', host: 'proxy.test', port: 8080 }, data: { action: 'login', cdata: 'widget' } }], 'data.cdata'],
    ['Yidun API host', ['2captcha', 'YidunTaskProxyless', { websiteURL: url, websiteKey: 'site', challenge: 'challenge', yidunApiServerSubdomain: 'c.dun.163.com' }], ['capmonster', 'YidunTask', { websiteURL: url, websiteKey: 'site', challenge: 'challenge', yidunApiServerSubdomain: 'c.dun.163.com' }], 'yidunApiServerSubdomain'],
    ['Yidun library', ['2captcha', 'YidunTaskProxyless', { websiteURL: url, websiteKey: 'site', challenge: 'challenge', yidunGetLib: 'https://c.dun.163.com/lib.js' }], ['capmonster', 'YidunTask', { websiteURL: url, websiteKey: 'site', challenge: 'challenge', yidunGetLib: 'https://c.dun.163.com/lib.js' }], 'yidunGetLib'],
  ];
  for (const [label, a, b, changed] of actionBoundPairs) test(`${browser}: ${label} mismatch cannot spend`, async t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [a, b].map(([provider, method, parameters]) => ({ provider, method, parameters: structuredClone(parameters) }));
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    const path = changed.split('.');
    let target = entries[1].parameters;
    for (const part of path.slice(0, -1)) target = target[part];
    target[path.at(-1)] = changed === 'proxy' ? 'other.test:8080' : changed === 'min_score' ? 0.3 : 'different';
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed challenge|same proxy identity/);
    assert.equal(calls.length, 0);
  });
  for (const [label, entries] of [
    ['DataDome proxy credentials mismatch', [
      { provider: '2captcha', method: 'DataDomeSliderTask', parameters: { websiteURL: url, captchaUrl: 'https://example.test/captcha', userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080, proxyLogin: 'alice' } },
      { provider: 'capmonster', method: 'CustomTask:DataDome', parameters: { websiteURL: url, metadata: { datadomeCookie: 'observed', captchaUrl: 'https://example.test/captcha' }, userAgent: 'browser-UA', proxyType: 'http', proxyAddress: 'proxy.test', proxyPort: 8080, proxyLogin: 'bob' } },
    ]],
    ['reCAPTCHA v2 omitted User-Agent', [
      { provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', userAgent: 'browser-UA' } },
      { provider: 'solvecaptcha', method: 'recaptcha_v2', parameters: { pageurl: url, googlekey: 'site' } },
    ]],
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
      { provider: 'solvecaptcha', method: 'recaptcha_v3', parameters: { pageurl: url, googlekey: 'site', min_score: 0.3 } },
    ]],
    ['reCAPTCHA v3 omitted score', [
      { provider: '2captcha', method: 'RecaptchaV3TaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', minScore: 0.9, pageAction: 'login' } },
      { provider: 'solvecaptcha', method: 'recaptcha_v3', parameters: { pageurl: url, googlekey: 'site', action: 'login' } },
    ]],
    ['Turnstile omitted cData', [
      { provider: '2captcha', method: 'TurnstileTaskProxyless', parameters: { websiteURL: url, websiteKey: 'site', data: 'observed-cdata' } },
      { provider: 'anti-captcha', method: 'TurnstileTaskProxyless', parameters: { websiteURL: url, websiteKey: 'site' } },
    ]],
  ]) test(`${browser}: ${label} cannot spend`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    assert.throws(() => native.prepareNativeCaptchaTasks(entries.map(entry => ({ id: entry.provider, apiKey: 'key' })), entries), /same observed challenge|same proxy identity/);
    assert.equal(calls.length, 0);
  });
  for (const [family, first, second] of [
    ['v2', ['2captcha', 'RecaptchaV2TaskProxyless', { websiteURL: url, websiteKey: 'site', isInvisible: true }], ['solvecaptcha', 'recaptcha_v2', { pageurl: url, googlekey: 'site', invisible: 1 }]],
    ['v2 enterprise', ['2captcha', 'RecaptchaV2EnterpriseTaskProxyless', { websiteURL: url, websiteKey: 'site', isInvisible: true }], ['solvecaptcha', 'recaptcha_v2_enterprise', { pageurl: url, googlekey: 'site', invisible: 1 }]],
  ]) test(`${browser}: reCAPTCHA ${family} visibility agrees before fallback`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [first, second].map(([provider, method, parameters]) => ({ provider, method, parameters: structuredClone(parameters) }));
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    entries[1].parameters.invisible = 0;
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed reCAPTCHA visibility mode/);
    delete entries[1].parameters.invisible;
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed reCAPTCHA visibility mode/);
    assert.equal(calls.length, 0);
  });
  test(`${browser}: FunCaptcha service host agrees across subdomain and URL formats`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const entries = [
      { provider: '2captcha', method: 'FunCaptchaTaskProxyless', parameters: { websiteURL: url, websitePublicKey: 'site', funcaptchaApiJSSubdomain: 'sample-api.arkoselabs.com' } },
      { provider: 'solvecaptcha', method: 'funcaptcha', parameters: { pageurl: url, publickey: 'site', surl: 'https://sample-api.arkoselabs.com' } },
    ];
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    entries[1].parameters.surl = 'https://other-api.arkoselabs.com';
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed service host/);
    delete entries[1].parameters.surl;
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed service host/);
    assert.equal(calls.length, 0);
  });
  const recognitionPairs = [
    ['coordinates body', ['2captcha', 'CoordinatesTask', { body: 'image-A' }], ['solvecaptcha', 'coordinates', { body: 'image-A' }], task => { task.body = 'image-B'; }],
    ['image-to-text array alias', ['2captcha', 'ImageToTextTask', { body: 'image-A' }], ['nopecha', 'recognition/textcaptcha', { image_data: ['image-A'] }], task => { task.image_data = ['image-B']; }],
    ['Temu parts', ['2captcha', 'TemuImageTask', { image: 'background', parts: ['one', 'two', 'three'] }], ['solvecaptcha', 'temuimage', { body: 'background', part1: 'one', part2: 'two', part3: 'three' }], task => { task.part2 = 'different'; }],
    ['FunCaptcha instruction', ['2captcha', 'GridTask:funcaptcha_recognition', { body: 'image-A', comment: 'cars' }], ['nopecha', 'recognition/funcaptcha', { image_data: ['image-A'], task: 'cars' }], task => { task.task = 'bicycles'; }],
    ['reCAPTCHA recognition instruction', ['capsolver', 'ReCaptchaV2Classification', { image: 'image-A', question: 'cars' }], ['nopecha', 'recognition/recaptcha', { image_data: ['image-A'], grid: '3x3', task: 'cars' }], task => { task.task = 'bicycles'; }],
    ['coordinate text instruction', ['2captcha', 'CoordinatesTask', { body: 'image-A', comment: 'cars' }], ['solvecaptcha', 'coordinates', { body: 'image-A', textinstructions: 'cars' }], task => { task.textinstructions = 'bicycles'; }],
    ['coordinate lowercase image instruction', ['2captcha', 'CoordinatesTask', { body: 'image-A', imgInstructions: 'cars' }], ['solvecaptcha', 'coordinates', { body: 'image-A', imginstructions: 'cars' }], task => { task.imginstructions = 'bicycles'; }],
  ];
  test(`${browser}: recognition fallback preserves both text and image instructions`, () => {
    const entries = [
      { provider: '2captcha', method: 'CoordinatesTask', parameters: {
        body: 'challenge-image', comment: 'Click matching objects', imgInstructions: 'instruction-image',
      } },
      { provider: 'solvecaptcha', method: 'coordinates', parameters: {
        body: 'challenge-image', textinstructions: 'Click matching objects', imginstructions: 'instruction-image',
      } },
    ];
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    for (const changed of [
      { textinstructions: 'Click different objects' }, { imginstructions: 'another-image' },
      { textinstructions: undefined }, { imginstructions: undefined },
    ]) {
      const pair = structuredClone(entries);
      Object.assign(pair[1].parameters, changed);
      for (const [key, value] of Object.entries(changed)) if (value === undefined) delete pair[1].parameters[key];
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, pair), /same observed challenge.*instructions/);
    }
    // Matching bytes do not make a text prompt equivalent to an image prompt.
    delete entries[0].parameters.comment;
    delete entries[1].parameters.imginstructions;
    entries[1].parameters.textinstructions = 'instruction-image';
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, entries), /same observed challenge.*instructions/);
  });
  test(`${browser}: AWS fallback compares SolveCaptcha CAPTCHA script aliases`, () => {
    const entries = [
      { provider: '2captcha', method: 'AmazonTaskProxyless', parameters: {
        websiteURL: url, websiteKey: 'site', iv: 'iv', context: 'context', captchaScript: 'https://challenge.test/captcha.js',
      } },
      { provider: 'solvecaptcha', method: 'amazon_waf', parameters: {
        pageurl: url, sitekey: 'site', iv: 'iv', context: 'context', captcha_script: 'https://challenge.test/captcha.js',
      } },
    ];
    const enabled = entries.map(entry => ({ id: entry.provider, apiKey: 'key' }));
    assert.equal(native.prepareNativeCaptchaTasks(enabled, entries).length, 2);
    const changed = structuredClone(entries);
    changed[1].parameters.captcha_script = 'https://other.test/captcha.js';
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, changed), /same observed challenge/);
    for (const [index, key] of [[0, 'captchaScript'], [1, 'captcha_script']]) {
      const missing = structuredClone(entries);
      delete missing[index].parameters[key];
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, missing), /same observed challenge/);
    }
  });
  test(`${browser}: reCAPTCHA fallback compares the effective Enterprise mode`, async t => {
    const calls = mockApi(t, () => ({ status: 'ready', solution: { token: 'paid-answer' } }));
    const enabled = ['2captcha', 'anti-captcha', 'capmonster', 'nopecha', 'solvecaptcha'].map(id => ({ id, apiKey: 'key' }));
    const params = { websiteURL: url, websiteKey: 'site', minScore: 0.3, pageAction: 'login' };
    const first = { provider: '2captcha', method: 'RecaptchaV3TaskProxyless', parameters: { ...params, isEnterprise: true } };
    for (const provider of ['anti-captcha', 'capmonster']) {
      for (const flag of [false, undefined]) {
        const second = { provider, method: 'RecaptchaV3TaskProxyless', parameters: { ...params } };
        if (flag !== undefined) second.parameters.isEnterprise = flag;
        assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [first, second]), /same CAPTCHA family/);
        second.parameters.isEnterprise = true;
        assert.equal(native.prepareNativeCaptchaTasks(enabled, [first, second]).length, 2);
      }
    }
    const explicit = { provider: 'anti-captcha', method: 'RecaptchaV3TaskProxyless:enterprise', parameters: params };
    const prepared = native.prepareNativeCaptchaTasks(enabled, [first, explicit]);
    const plain = { provider: '2captcha', method: 'RecaptchaV2TaskProxyless', parameters: { websiteURL: url, websiteKey: 'site' } };
    const nopecha = { provider: 'nopecha', method: 'token/recaptcha2', parameters: { url, sitekey: 'site', data: { enterprise: true } } };
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [plain, nopecha]), /same CAPTCHA family/);
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [{ ...plain, method: 'RecaptchaV2EnterpriseTaskProxyless' }, nopecha]).length, 2);
    nopecha.parameters.data.enterprise = false;
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [plain, nopecha]).length, 2);
    const solveCaptcha = { provider: 'solvecaptcha', method: 'recaptcha_v2_enterprise', parameters: {
      pageurl: url, googlekey: 'site', version: 'v3', action: 'login', min_score: 0.3,
    } };
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [{ ...plain, method: 'RecaptchaV2EnterpriseTaskProxyless' }, solveCaptcha]), /same CAPTCHA family/);
    assert.equal(native.prepareNativeCaptchaTasks(enabled, [first, solveCaptcha]).length, 2);
    assert.equal(calls.length, 0, 'validation must not contact a provider');
    assert.equal((await native.solveNativeCaptchaTasks(prepared)).family, 'recaptcha_v3_enterprise');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.task.isEnterprise, true);
  });
  test(`${browser}: recognition fallback compares click counts, text classes, and answer lengths`, t => {
    const calls = mockApi(t, () => { throw new Error('Must not dispatch'); });
    const enabled = ['2captcha', 'solvecaptcha', 'nopecha'].map(id => ({ id, apiKey: 'key' }));
    const coordinates = [
      { provider: '2captcha', method: 'CoordinatesTask', parameters: { body: 'image-A', minClicks: 1, maxClicks: 1 } },
      { provider: 'solvecaptcha', method: 'coordinates', parameters: { body: 'image-A', min_clicks: 1, max_clicks: 1 } },
    ];
    assert.equal(native.prepareNativeCaptchaTasks(enabled, coordinates).length, 2);
    for (const changed of [{ min_clicks: 5 }, { max_clicks: 5 }, { min_clicks: undefined }]) {
      const parameters = { ...coordinates[1].parameters, ...changed };
      if (changed.min_clicks === undefined) delete parameters.min_clicks;
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [coordinates[0],
        { ...coordinates[1], parameters }]), /same minClicks|same maxClicks/);
    }
    const textTasks = [
      { provider: '2captcha', method: 'ImageToTextTask', parameters: { body: 'image-A',
        case: true, phrase: false, math: false, numeric: 2, minLength: 4, maxLength: 6 } },
      { provider: 'solvecaptcha', method: 'base64', parameters: { body: 'image-A',
        regsense: 1, phrase: 0, calc: 0, numeric: 2, min_len: 4, max_len: 6 } },
    ];
    assert.equal(native.prepareNativeCaptchaTasks(enabled, textTasks).length, 2);
    for (const changed of [{ regsense: 0 }, { numeric: 1 }, { min_len: 5 }, { max_len: 8 }, { calc: 1 }, { phrase: 1 }]) {
      assert.throws(() => native.prepareNativeCaptchaTasks(enabled, [textTasks[0],
        { ...textTasks[1], parameters: { ...textTasks[1].parameters, ...changed } }]), /same .* constraint/);
    }
    const grids = [
      { provider: '2captcha', method: 'GridTask:recaptcha_recognition', parameters: { body: 'image-A', rows: 3, columns: 3, comment: 'cars' } },
      { provider: 'nopecha', method: 'recognition/recaptcha', parameters: { image_data: ['image-A'], grid: '4x4', task: 'cars' } },
    ];
    assert.throws(() => native.prepareNativeCaptchaTasks(enabled, grids), /same grid dimensions/);
    assert.equal(calls.length, 0);
  });
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
