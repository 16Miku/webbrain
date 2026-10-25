import assert from 'node:assert/strict';
import test from 'node:test';

const model = 'minimax/h3/text-to-video';
const config = { provider: 'fal', apiKey: 'private-fal-key', videoModel: model };
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const schema = properties => ({
  openapi: '3.0.4',
  paths: { '/model': { post: { requestBody: { content: {
    'application/json': { schema: { $ref: '#/components/schemas/Input' } },
  } } } } },
  components: { schemas: { Input: { type: 'object', properties: { prompt: { type: 'string' }, ...properties } } } },
});
const bounded = schema({ duration: { type: 'integer', minimum: 5, maximum: 15 } });
const listing = openapi => json({ models: [{ endpoint_id: model, openapi }] });

// Only metadata and a simulated single-clip queue are available. No real
// request or generated media download can escape this injected fetch.
function api({ catalog = () => listing(bounded), direct = () => json(bounded) } = {}) {
  const calls = { catalog: 0, direct: 0, submits: [] };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    if (parsed.origin === 'https://api.fal.ai') {
      assert.equal(parsed.pathname, '/v1/models');
      assert.equal(parsed.searchParams.get('endpoint_id'), model);
      assert.equal(parsed.searchParams.get('expand'), 'openapi-3.0');
      assert.equal(init.headers.Authorization, `Key ${config.apiKey}`);
      calls.catalog += 1;
      return catalog(init);
    }
    if (parsed.origin === 'https://fal.ai') {
      assert.equal(parsed.pathname, '/api/openapi/queue/openapi.json');
      assert.deepEqual([...parsed.searchParams], [['endpoint_id', model]]);
      assert.equal(init.headers, undefined, 'the public schema never receives credentials');
      calls.direct += 1;
      return direct(init);
    }
    assert.equal(parsed.origin, 'https://queue.fal.run', 'never follow a schema reference or returned host');
    assert.equal(init.headers.Authorization, `Key ${config.apiKey}`);
    if (init.method === 'POST') {
      calls.submits.push(JSON.parse(init.body));
      return json({ request_id: 'one',
        status_url: `https://queue.fal.run/${model}/requests/one/status`,
        response_url: `https://queue.fal.run/${model}/requests/one`,
      });
    }
    if (parsed.pathname.endsWith('/status')) return json({ status: 'COMPLETED' });
    return json({ video: { url: 'https://v3b.fal.media/generated.mp4' } });
  };
  return { calls, fetchImpl };
}

const comfyConfig = { provider: 'comfyrouter', apiKey: 'private-comfy-key', videoModel: 'minimax/hailuo-02' };
function comfyApi(metadata) {
  const calls = { schemas: 0, submits: [] };
  const base = `https://api.comfy.org/v2/models/${comfyConfig.videoModel}`;
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['X-API-Key'], comfyConfig.apiKey);
    if (url === `${base}/openapi.json`) { calls.schemas += 1; return metadata(init); }
    assert.ok(url.startsWith(`${base}/requests`), 'Comfy metadata has no external fallback');
    if (init.method === 'POST') {
      calls.submits.push(JSON.parse(init.body));
      return json({ request_id: 'one' });
    }
    if (url.endsWith('/status')) return json({ status: 'COMPLETED' });
    return json({ video: { url: 'https://media.example/generated.mp4' } });
  };
  return { calls, fetchImpl };
}

for (const build of ['chrome', 'firefox']) {
  const { runMediaGeneration } = await import(`../src/${build}/src/agent/generative-media.js`);
  const run = (mock, extra = {}) => runMediaGeneration({
    prompt: 'A leaf moves across a grid.', video: { duration: 8 }, config,
    fetchImpl: mock.fetchImpl, pollIntervalMs: 1, ...extra,
  });

  test(`${build}: bounded fal catalog avoids a redundant schema request`, async () => {
    const mock = api({ direct: () => assert.fail('public schema is unnecessary') });
    await run(mock);
    assert.deepEqual([mock.calls.catalog, mock.calls.direct, mock.calls.submits[0].duration], [1, 0, 8]);
  });

  test(`${build}: fal public schema recovers missing, failed and unbounded catalog expansion`, async () => {
    const cases = [
      () => json({ models: [] }),
      () => listing({ error: { code: 'expansion_failed', message: 'Schema lookup failed' } }),
      () => listing(schema({ duration: { type: 'integer', default: 5 } })),
      () => json({ error: { message: 'Not found' } }, 404),
      () => json({ error: { message: 'Temporarily unavailable' } }, 503),
      () => { throw new TypeError('Network read failed'); },
      () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
      () => listing(schema({ duration: { $ref: 'https://untrusted.example/Duration' } })),
    ];
    for (const catalog of cases) {
      const mock = api({ catalog, direct: () => json(schema({ duration: { type: 'string', enum: ['5', '15'] } })) });
      await run(mock, { video: { duration: 15 } });
      assert.equal(mock.calls.direct, 1);
      assert.equal(mock.calls.submits[0].duration, '15', 'use the public schema duration encoding');
    }
  });

  test(`${build}: an incomplete public schema retains catalog constraints`, async () => {
    const catalog = () => listing(schema({
      duration: { type: 'integer', default: 8 },
      resolution: { type: 'string', enum: ['720p'] },
    }));
    for (const direct of [
      () => json(schema({ duration: { type: 'integer' } })),
      () => json({ error: { message: 'Not found' } }, 404),
      () => json({ error: { message: 'Unavailable' } }, 503),
      () => { throw new TypeError('Public metadata unavailable'); },
    ]) {
      const mock = api({ catalog, direct });
      await assert.rejects(run(mock, { video: { duration: 8, resolution: '1080p' } }), /Supported: 720p/);
      assert.equal(mock.calls.direct, 1);
      assert.equal(mock.calls.submits.length, 0);
    }
    const defaultOnly = api({
      catalog: () => listing(schema({ duration: { type: 'string', default: '5' } })),
      direct: () => json({}, 404),
    });
    await run(defaultOnly, { video: { estimated_duration: 5 } });
    assert.equal(defaultOnly.calls.submits[0].duration, '5', 'retain the catalog default and its encoding');
  });

  test(`${build}: absent fal metadata does not prevent an explicit clip duration`, async () => {
    const mock = api({ catalog: () => json({}, 404), direct: () => json({}, 404) });
    await run(mock);
    assert.equal(mock.calls.direct, 1);
    assert.equal(mock.calls.submits[0].duration, 8);
  });

  test(`${build}: fal schema authorization failures remain errors`, async () => {
    for (const status of [401, 403]) {
      const mock = api({ catalog: () => json({ error: { message: 'Access denied' } }, status) });
      await assert.rejects(run(mock), error => error.status === status);
      assert.equal(mock.calls.submits.length, 0);
      assert.equal(mock.calls.direct, 0);
    }
  });

  test(`${build}: public fal schema access denial permits the default clip fallback`, async () => {
    for (const status of [401, 403]) {
      const mock = api({
        catalog: () => listing({ error: { code: 'expansion_failed', message: 'Schema lookup failed' } }),
        direct: () => json({ error: { message: 'Public metadata access denied' } }, status),
      });
      const result = await run(mock, { video: { estimated_duration: 8 } });
      assert.equal(mock.calls.direct, 1);
      assert.equal(mock.calls.submits[0].duration, 8);
      assert.equal(result.fallbackClipSeconds, 8);
    }
  });

  test(`${build}: Stop during either fal schema source prevents generation`, async () => {
    for (const source of ['catalog', 'direct']) {
      const controller = new AbortController();
      const reason = new DOMException('Stopped by user', 'AbortError');
      const cancelled = () => { controller.abort(reason); return json(bounded); };
      const mock = api(source === 'catalog' ? { catalog: cancelled }
        : { catalog: () => listing(null), direct: cancelled });
      await assert.rejects(run(mock, { signal: controller.signal }), error => error === reason);
      assert.equal(mock.calls.submits.length, 0);
      assert.equal(mock.calls.direct, source === 'catalog' ? 0 : 1);
    }
    const controller = new AbortController();
    controller.abort();
    const mock = api();
    await assert.rejects(run(mock, { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(mock.calls, { catalog: 0, direct: 0, submits: [] });
  });

  test(`${build}: a fal metadata timeout exhausts one lookup budget and permits explicit duration`, async () => {
    const mock = api({ catalog: init => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }) });
    await run(mock, { timeoutMs: 50 });
    assert.equal(mock.calls.direct, 0, 'do not start a fresh metadata deadline');
    assert.equal(mock.calls.submits[0].duration, 8);
  });

  test(`${build}: Comfy Router metadata failures allow the default clip fallback`, async () => {
    for (const metadata of [
      () => json({}, 404),
      () => json({ error: { message: 'Unavailable' } }, 503),
      () => { throw new TypeError('Network read failed'); },
      () => new Response('{broken'),
    ]) {
      const mock = comfyApi(metadata);
      const result = await run(mock, { config: comfyConfig, video: { estimated_duration: 8 } });
      assert.equal(mock.calls.schemas, 1);
      assert.equal(mock.calls.submits[0].duration, 8);
      assert.equal(result.fallbackClipSeconds, 8);
    }
  });

  test(`${build}: Comfy Router metadata authorization and cancellation still stop generation`, async () => {
    for (const status of [401, 403]) {
      const mock = comfyApi(() => json({ error: { message: 'Access denied' } }, status));
      await assert.rejects(run(mock, { config: comfyConfig }), error => error.status === status);
      assert.equal(mock.calls.submits.length, 0);
    }
    const controller = new AbortController();
    const reason = new DOMException('Stopped by user', 'AbortError');
    const mock = comfyApi(() => { controller.abort(reason); return json(bounded); });
    await assert.rejects(run(mock, { config: comfyConfig, signal: controller.signal }), error => error === reason);
    assert.equal(mock.calls.submits.length, 0);
  });
}
