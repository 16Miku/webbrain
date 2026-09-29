import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const keys = { nopecha: 'nopecha_subscription_key', nonecap: 'nc_live_' + 'a'.repeat(32) };
const params = { type: 'hcaptcha', websiteURL: 'https://example.com/form', websiteKey: 'f5ab1c2d-7e8f-4a9b-b1c2-d3e4f5a6b7c8' };
function api(t, respond) {
  let now = 0;
  const calls = [];
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => { now += delay; fn(); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    const call = { url, path: parsed.pathname, query: parsed.searchParams, host: parsed.hostname, options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const result = respond(call, calls.length);
    return result instanceof Response ? result : Response.json(result);
  });
  return calls;
}
for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/captcha-provider-config.js`);
  const solver = await import(`../src/${build}/src/agent/captcha-solver.js`);
  const h = await import(`../src/${build}/src/agent/captcha-hcaptcha-providers.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const stored = Object.fromEntries(config.CAPTCHA_PROVIDERS.flatMap(p => [[p.key, keys[p.id] || (p.id === 'capsolver' ? 'CAP-0123456789abcdefghij' : 'a'.repeat(32))], [p.enabled, true]]));
  test(`${build}: seven-provider consent, weights, capabilities, key formats, and import`, () => {
    assert.deepEqual(config.getCaptchaProviders(stored).map(p => p.id), ['capsolver','2captcha','capmonster','solvecaptcha','anti-captcha','nopecha','nonecap']);
    assert.equal(config.getCaptchaProviders({...stored, nonecapWeight: 200})[0].id, 'nonecap');
    assert.equal(config.getCaptchaProviders({...stored, nopechaEnabled: false}).some(p => p.id === 'nopecha'), false);
    for (const id of ['nopecha','nonecap']) {
      assert.equal(config.captchaProviderSupportsType(id,'hcaptcha'), true);
      for (const type of ['recaptcha_v2','recaptcha_v2_enterprise','recaptcha_v3','recaptcha_v3_enterprise','turnstile','image_to_text','funcaptcha']) assert.equal(config.captchaProviderSupportsType(id,type), false);
      assert.equal(config.isValidCaptchaApiKey(id, '  '+keys[id]+'  '), true);
      for (const key of ['', 'bad key', '\r\n']) assert.equal(config.isValidCaptchaApiKey(id,key), false);
      const p = config.CAPTCHA_PROVIDERS.find(p => p.id === id);
      const imported = transfer.parseConfigImport(JSON.stringify(transfer.createConfigExport({[p.key]:keys[id],[p.enabled]:true,[p.weight]:123}))).settings;
      assert.equal(imported[p.key],keys[id]); assert.equal(imported[p.enabled],true); assert.equal(imported[p.weight],123);
      const keyOnly = transfer.parseConfigImport(JSON.stringify({schema:transfer.CONFIG_SCHEMA,settings:{[p.key]:keys[id]}})).settings;
      assert.equal(keyOnly[p.enabled],false);
    }
    assert.equal(config.isValidCaptchaApiKey('nonecap','a'.repeat(32)),false);
    assert.deepEqual(config.getCaptchaProviders({...stored,webbrainCloudManaged:true,webbrainCloudCapsolverBrokerEnabled:true}),[{id:'capsolver',apiKey:'',useCloudBroker:true}]);
  });
  test(`${build}: hCaptcha task mapping preserves observed rqdata and browser identity rules`, () => {
    const options = {...params,isEnterprise:true,rqdata:'observed-rqdata',userAgent:'browser-agent'};
    assert.deepEqual(h.buildHcaptchaTask('nopecha',options),{sitekey:params.websiteKey,url:params.websiteURL,data:{rqdata:'observed-rqdata'},useragent:'browser-agent'});
    assert.deepEqual(h.buildHcaptchaTask('nonecap',options),{type:'hcaptcha_enterprise',sitekey:params.websiteKey,url:params.websiteURL,rqdata:'observed-rqdata'});
    for (const invalid of [{...params,websiteKey:'invalid'},{...params,websiteURL:'file:///secret'}]) assert.ok(h.hcaptchaParamError(invalid));
    assert.equal(h.hcaptchaParamError(params),null);
    assert.equal(h.hcaptchaParamError({...params,isEnterprise:true}),null);
    assert.deepEqual(h.buildHcaptchaTask('nonecap',{...params,isEnterprise:true}),{type:'hcaptcha_enterprise',sitekey:params.websiteKey,url:params.websiteURL});
  });
  test(`${build}: NopeCHA v1 polls incomplete jobs without re-creating them or leaking keys in URLs`, async t => {
    const calls=api(t,(call,n)=> n===1 ? {data:'job/id'} : n===2 ? Response.json({code:14,message:'Incomplete job'},{status:409}) : {data:'hcaptcha-token'});
    const result=await solver.solveCaptchaWithProviders(config.getCaptchaProviders(stored),params);
    assert.equal(result.provider,'nopecha'); assert.equal(result.token,'hcaptcha-token'); assert.equal(result.fieldName,'h-captcha-response'); assert.equal(result.alsoSet,'g-recaptcha-response');
    assert.equal(calls.length,3); assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[1].query.get('id'),'job/id'); assert.equal(calls[1].options.method,'GET');
    for (const c of calls) { assert.equal(c.host,'api.nopecha.com'); assert.equal(c.path,'/v1/token/hcaptcha'); assert.equal(c.options.headers.Authorization,`Basic ${keys.nopecha}`); assert.equal(c.url.includes(keys.nopecha),false); }
  });
  test(`${build}: hCaptcha fallback skips the original five services and accepts NoneCap metadata`, async t => {
    const calls=api(t,call=>call.host==='api.nopecha.com' ? Response.json({code:16,message:'Out of credit'},{status:403}) : call.options.method==='POST' ? {id:'solve_1',status:'pending'} : {id:'solve_1',status:'solved',token:'P1_token',resp_key:'E0_key',user_agent:'solver-agent'});
    const result=await solver.solveCaptchaWithProviders(config.getCaptchaProviders(stored),params);
    assert.equal(result.provider,'nonecap'); assert.equal(result.token,'P1_token'); assert.equal(result.solution.respKey,'E0_key'); assert.equal(result.solution.userAgent,'solver-agent');
    assert.deepEqual(calls.map(c=>c.host),['api.nopecha.com','api.nonecap.com','api.nonecap.com']);
    assert.equal(calls[1].options.headers.Authorization,`Bearer ${keys.nonecap}`); assert.equal(calls[1].path,'/v1/solves'); assert.equal(calls[2].path,'/v1/solves/solve_1');
  });
  for (const id of ['nopecha','nonecap']) {
    test(`${build}: ${id} reports credits and validates balance responses`,async t=>{
      const calls=api(t,()=>id==='nopecha'?{credit:250}:{credits_balance:250});
      assert.deepEqual(await h.getHcaptchaProviderBalance(id,keys[id]),{balance:250,unit:'credits'});
      assert.equal(calls[0].path,id==='nopecha'?'/v1/status':'/v1/me');
      t.mock.method(globalThis,'fetch',async()=>Response.json({}));
      await assert.rejects(h.getHcaptchaProviderBalance(id,keys[id]),/missing credit balance/);
    });
    test(`${build}: ${id} timeout uses one creation then the next provider`,async t=>{
      const calls=api(t,c=>{
        if(c.host===`api.${id}.com`) return id==='nopecha' ? c.options.method==='POST'?{data:'job'}:Response.json({code:14},{status:409}) : {id:'solve_slow',status:'solving'};
        return id==='nonecap' ? {data:c.options.method==='POST'?'job':'solved'} : {id:'solve_fast',status:'solved',token:'solved'};
      });
      const p=config.CAPTCHA_PROVIDERS.find(p=>p.id===id);
      const result=await solver.solveCaptchaWithProviders(config.getCaptchaProviders({...stored,[p.weight]:200}),params);
      assert.equal(result.token,'solved');assert.notEqual(result.provider,id);
      assert.equal(calls.filter(c=>c.options.method==='POST').length,2);
    });
    test(`${build}: ${id} rejects invalid parameters before HTTP and respects explicit disablement`,async t=>{
      const calls=api(t,()=>{throw new Error('unexpected request');});
      await assert.rejects(h.solveWithHcaptchaProvider(id,keys[id],{...params,websiteKey:'bad'}),/UUID/);
      const disabled={...stored,nopechaEnabled:false,nonecapEnabled:false};
      await assert.rejects(solver.solveCaptchaWithProviders(config.getCaptchaProviders(disabled),params),/No enabled provider supports/);
      assert.equal(calls.length,0);
    });
  }
  test(`${build}: NoneCap terminal errors, mismatched IDs, malformed tokens and HTTP failures never create a second job`,async t=>{
    for(const failure of [Response.json({error:{message:'No credits'}},{status:402}),{id:'different',status:'solved',token:'wrong'}, {id:'solve_1',status:'failed',error:{message:'unsolvable'}},{id:'solve_1',status:'expired'}, {id:'solve_1',status:'cancelled'},{id:'solve_1',status:'solved',token:''},{id:'solve_1',status:'mystery'}]) {
      const calls=api(t,c=>c.options.method==='POST'?{id:'solve_1',status:'pending'}:failure);
      await assert.rejects(h.solveWithHcaptchaProvider('nonecap',keys.nonecap,params));
      assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
    }
  });
  test(`${build}: NopeCHA rejects creation errors, malformed JSON and empty answers`,async t=>{
    for(const response of [Response.json({code:14},{status:409}),Response.json({code:11},{status:429}),new Response('invalid'),Response.json({})]) {
      const calls=api(t,()=>response);
      await assert.rejects(h.solveWithHcaptchaProvider('nopecha',keys.nopecha,params));assert.equal(calls.length,1);
    }
    const calls=api(t,c=>c.options.method==='POST'?{data:'job'}:{data:''});
    await assert.rejects(h.solveWithHcaptchaProvider('nopecha',keys.nopecha,params),/missing solution/);assert.equal(calls.length,2);
  });
}
test('hCaptcha adapter is shared across Chrome and Firefox', async()=>{
  assert.equal(await readFile('src/chrome/src/agent/captcha-hcaptcha-providers.js','utf8'),await readFile('src/firefox/src/agent/captcha-hcaptcha-providers.js','utf8'));
});
