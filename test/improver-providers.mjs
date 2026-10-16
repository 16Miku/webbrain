// Provider rate-limit typing and model-retry policy, both builds, against the
// real provider classes with fetch stubbed by real Response objects. A 429/529
// must reach model-retry's long cooldowns whether a provider returns it as an
// HTTP status or (after HTTP 200 is committed) inside the stream or body; the
// cooldowns are lengthened by a random spread but never shorter than the base schedule or the provider's Retry-After.
// Billing exhaustion on HTTP 429 is not a rate limit and is never retried.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sse = (...events) => new Response(
  events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const text = content => ({ choices: [{ index: 0, delta: { content } }] });
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
// OpenRouter's documented mid-stream error: the 200 headers are already sent.
const openRouterLimit = {
  id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', provider: 'OpenAI',
  error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } },
  choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
};
const anthropicText = content => [
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const noWait = { sleep: async () => {}, random: () => 0 };

async function withFetch(respond, run) {
  const native = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return respond(requests.length, requests.at(-1));
  };
  try { return await run(requests); } finally { globalThis.fetch = native; }
}
async function drain(stream) {
  const events = [];
  try { for await (const event of stream) events.push(event); return { events, error: null }; }
  catch (error) { return { events, error }; }
}
async function failure(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('Expected the provider call to fail');
}

test('model-retry stays byte-identical across builds', () => {
  const read = browser => fs.readFileSync(new URL(`../src/${browser}/src/providers/model-retry.js`, import.meta.url), 'utf8');
  assert.equal(read('chrome'), read('firefox'));
});

for (const browser of ['chrome', 'firefox']) {
  const { isBillingQuotaError, isRateLimitClass, rateLimitStatusOf, retryModelCall, retryModelStream } = await import(`../src/${browser}/src/providers/model-retry.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { AnthropicProvider } = await import(`../src/${browser}/src/providers/anthropic.js`);
  const { VertexAnthropicProvider } = await import(`../src/${browser}/src/providers/vertex-anthropic.js`);
  const { AzureOpenAIProvider } = await import(`../src/${browser}/src/providers/azure-openai.js`);
  const { LlamaCppProvider } = await import(`../src/${browser}/src/providers/llamacpp.js`);
  const { AwsBedrockProvider } = await import(`../src/${browser}/src/providers/aws-bedrock.js`);
  const status = (code, extra = {}) => Object.assign(new Error(`HTTP ${code}`), { httpStatus: code, ...extra });
  const router = () => new OpenAICompatibleProvider({
    providerName: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', supportsAskStreaming: true,
  });

  test(`${browser}: only 429 and 529 are rate-limit class`, () => {
    assert.equal(isRateLimitClass(status(429)), true);
    assert.equal(isRateLimitClass(status(529)), true);
    for (const other of [status(503), status(500), status(400), new Error('network'), null,
      Object.assign(new Error('upstream'), { code: 'webbrain_cloud_upstream_error' })]) {
      assert.equal(isRateLimitClass(other), false);
    }
  });

  test(`${browser}: error objects received after HTTP 200 map to their 429/529 class`, () => {
    assert.equal(rateLimitStatusOf(openRouterLimit.error), 429);
    assert.equal(rateLimitStatusOf({ code: 'server_error', message: 'x', metadata: { error_type: 'rate_limit_exceeded' } }), 429);
    for (const code of ['rate_limit_exceeded', 'rate_limited', 'too_many_requests', '429', 'RATE_LIMIT_EXCEEDED']) {
      assert.equal(rateLimitStatusOf({ code, message: 'busy' }), 429, code);
    }
    assert.equal(rateLimitStatusOf({ type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' }), 429);
    assert.equal(rateLimitStatusOf({ type: 'overloaded_error', message: 'Overloaded' }), 529);
    assert.equal(rateLimitStatusOf({ code: 529, message: 'Overloaded' }), 529);
    assert.equal(rateLimitStatusOf({ code: 'server_error', message: 'Rate limit reached for gpt-4o on tokens per min' }), 429);
    assert.equal(rateLimitStatusOf({ message: 'Too Many Requests' }), 429);
    // OpenRouter maps provider_overloaded to 503, which keeps its own handling.
    for (const other of [{ code: 503, message: 'Provider overloaded', metadata: { error_type: 'provider_overloaded' } },
      { code: 'server_error', message: 'The model failed' }, { type: 'api_error', message: 'Internal error' },
      { code: 'insufficient_quota', message: 'You exceeded your current quota' }, 'Rate limit exceeded', null]) {
      assert.equal(rateLimitStatusOf(other), null, JSON.stringify(other));
    }
  });

  test(`${browser}: an overloaded 529 gets the rate-limit cooldowns while 503 keeps one short retry`, async () => {
    let calls = 0; const waits = [];
    const result = await retryModelCall(status(529), async () => {
      if (++calls < 3) throw status(calls === 1 ? 429 : 529);
      return 'recovered';
    }, { ...noWait, sleep: async ms => waits.push(ms) });
    assert.equal(result, 'recovered'); assert.deepEqual(waits, [5000, 15000, 30000]);
    calls = 0; waits.length = 0;
    await assert.rejects(retryModelCall(status(503), async () => { calls++; throw status(503); },
      { ...noWait, sleep: async ms => waits.push(ms) }), /HTTP 503/);
    assert.equal(calls, 1); assert.deepEqual(waits, [2000]);
  });

  test(`${browser}: stream startup retries an overloaded 529 but never a 503`, async () => {
    let starts = 0;
    const recovered = await drain(retryModelStream(() => (async function* () {
      if (++starts === 1) throw status(529);
      yield { type: 'text', content: 'OK' };
    })(), noWait));
    assert.equal(recovered.error, null); assert.equal(starts, 2);
    assert.deepEqual(recovered.events, [{ type: 'text', content: 'OK' }]);
    starts = 0;
    const failed = await drain(retryModelStream(() => (async function* () { starts++; throw status(503); })(),
      { sleep: async () => assert.fail('A 503 is not retried at stream startup') }));
    assert.match(failed.error?.message || '', /HTTP 503/); assert.equal(starts, 1);
  });

  test(`${browser}: rate-limit cooldowns are lengthened by at most 20% and never undercut the schedule or Retry-After`, async () => {
    const schedule = async (random, error = status(429)) => {
      const waits = [];
      await assert.rejects(retryModelCall(error, async () => { throw status(429); },
        { random, sleep: async ms => waits.push(ms) }), /HTTP 429/);
      return waits;
    };
    assert.deepEqual(await schedule(() => 0), [5000, 15000, 30000]);
    // The longest jittered schedule is exactly the 60 s budget and still runs.
    assert.deepEqual(await schedule(() => 1), [6000, 18000, 36000]);
    for (const value of [0.01, 0.25, 0.5, 0.73, 0.999]) {
      const waits = await schedule(() => value);
      [5000, 15000, 30000].forEach((base, index) => {
        assert.ok(waits[index] >= base && waits[index] <= base * 1.2, `${value}: ${waits[index]}`);
      });
    }
    // A provider cooldown above the jittered delay is honored exactly.
    const hinted = []; let calls = 0;
    await retryModelCall(status(429, { retryAfterMs: 5500 }), async () => {
      if (++calls === 1) throw status(429, { retryAfterMs: 20000 });
      return 'OK';
    }, { random: () => 0, sleep: async ms => hinted.push(ms) });
    assert.deepEqual(hinted, [5500, 20000]);
    // Other recovery classes are not jittered.
    const cloud = Object.assign(new Error('upstream'), { httpStatus: 400, code: 'webbrain_cloud_upstream_error' });
    const fixed = [];
    await assert.rejects(retryModelCall(cloud, async () => { throw cloud; }, { random: () => 0, sleep: async ms => fixed.push(ms) }));
    await assert.rejects(retryModelCall(new Error('offline'), async () => { throw new Error('offline'); },
      { random: () => 1, sleep: async ms => fixed.push(ms) }));
    assert.deepEqual(fixed, [2000, 5000, 2000]);
  });

  test(`${browser}: a retry that already streamed text to the user is not generated again`, async () => {
    let calls = 0;
    const shown = status(429, { webbrainOutputEmitted: true });
    await assert.rejects(retryModelCall(status(429), async () => { calls++; throw shown; }, noWait), e => e === shown);
    assert.equal(calls, 1);
  });

  test(`${browser}: an OpenRouter rate limit inside an HTTP 200 stream is typed as a terminal 429`, async () => {
    await withFetch(() => sse(openRouterLimit), async () => {
      const { events, error } = await drain(router().chatStream([{ role: 'user', content: 'hello' }]));
      assert.deepEqual(events, []);
      assert.match(error.message, /Chat Completions stream error: Rate limit exceeded/);
      assert.equal(error.httpStatus, 429);
      assert.equal(error.code, undefined, 'a numeric provider code is not copied as the error code');
      assert.equal(error.isAskStreamTerminalError, true);
      assert.equal(error.isChatCompletionsStreamError, true);
      assert.notEqual(error.isAskStreamFallbackSafe, true, 'still no non-streaming fallback for an explicit error');
    });
  });

  test(`${browser}: in-stream provider codes are kept and only rate-limit classes gain a status`, async () => {
    const cases = [
      [{ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } }, 'rate_limit_exceeded', 429],
      [{ error: { code: 'webbrain_cloud_upstream_error', message: 'Compass upstream unavailable' } }, 'webbrain_cloud_upstream_error', undefined],
      [{ error: { code: 'server_error', message: 'The model failed' } }, 'server_error', undefined],
      [{ error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, 529],
      [{ error: 'Too many requests', code: 'rate_limited' }, 'rate_limited', 429],
    ];
    for (const [frame, code, httpStatus] of cases) {
      await withFetch(() => sse(frame, '[DONE]'), async () => {
        const { error } = await drain(router().chatStream([{ role: 'user', content: 'hello' }]));
        assert.equal(error.isAskStreamTerminalError, true, JSON.stringify(frame));
        assert.equal(error.code, code, JSON.stringify(frame));
        assert.equal(error.httpStatus, httpStatus, JSON.stringify(frame));
      });
    }
  });

  test(`${browser}: Act stream startup retries a first-event in-stream 429 without replaying output`, async () => {
    await withFetch(attempt => attempt === 1 ? sse(openRouterLimit) : sse(text('Recovered'), stop, '[DONE]'), async requests => {
      const waits = [], notes = [];
      const { events, error } = await drain(retryModelStream(() => router().chatStream([{ role: 'user', content: 'hello' }]),
        { random: () => 0, sleep: async ms => waits.push(ms), onRetry: async note => notes.push(note.error.httpStatus) }));
      assert.equal(error, null);
      assert.equal(requests.length, 2); assert.deepEqual(requests[0].body, requests[1].body);
      assert.deepEqual(waits, [5000]); assert.deepEqual(notes, [429]);
      assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', content: 'Recovered' }]);
    });
    await withFetch(() => sse(text('Already shown'), openRouterLimit), async requests => {
      const { events, error } = await drain(retryModelStream(() => router().chatStream([{ role: 'user', content: 'hello' }]),
        { sleep: async () => assert.fail('Output was emitted; the stream must not restart') }));
      assert.equal(error.httpStatus, 429); assert.equal(requests.length, 1);
      assert.deepEqual(events, [{ type: 'text', content: 'Already shown' }]);
    });
  });

  test(`${browser}: Responses API failures keep their rate-limit class in streams and bodies`, async () => {
    const official = () => new OpenAICompatibleProvider({ category: 'cloud', providerName: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' });
    for (const [event, httpStatus, code] of [
      [{ type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } }, 429, 'rate_limit_exceeded'],
      [{ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached', param: null, sequence_number: 1 }, 429, 'rate_limit_exceeded'],
      [{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The model failed' } } }, undefined, 'server_error'],
    ]) {
      await withFetch(() => sse(event), async () => {
        const { error } = await drain(official().chatStream([{ role: 'user', content: 'hello' }], { maxTokens: 10 }));
        assert.equal(error.isResponsesStreamError, true);
        assert.equal(error.isAskStreamTerminalError, true);
        assert.equal(error.httpStatus, httpStatus, event.type);
        assert.equal(error.code, code, event.type);
      });
    }
    assert.throws(() => official()._parseResponsesData({ status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Slow down' } }),
      error => error.httpStatus === 429 && /Slow down/.test(error.message));
  });

  test(`${browser}: an error-only HTTP 200 chat body is retried as the rate limit it reports`, async () => {
    await withFetch(attempt => attempt === 1
      ? Response.json({ error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } } })
      : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }), async requests => {
      const provider = router();
      const first = await failure(provider.chat([{ role: 'user', content: 'hello' }]));
      assert.match(first.message, /error: Rate limit exceeded/); assert.equal(first.httpStatus, 429);
      const waits = [];
      const result = await retryModelCall(first, () => provider.chat([{ role: 'user', content: 'hello' }]),
        { random: () => 0, sleep: async ms => waits.push(ms) });
      assert.equal(result.content, 'OK'); assert.deepEqual(waits, [5000]); assert.equal(requests.length, 2);
    });
  });

  test(`${browser}: OpenAI-compatible HTTP 529 carries Retry-After like a 429`, async () => {
    await withFetch(() => new Response('{"error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529, headers: { 'Retry-After': '9' } }), async () => {
      const error = await failure(router().chat([{ role: 'user', content: 'hello' }]));
      assert.equal(error.httpStatus, 529); assert.equal(error.retryAfterMs, 9000);
    });
  });

  test(`${browser}: Anthropic and Vertex HTTP errors keep their messages and gain status and cooldown`, async () => {
    const anthropic = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-5' });
    await withFetch(() => new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
      { status: 429, headers: { 'retry-after': '7' } }), async () => {
      const error = await failure(anthropic.chat([{ role: 'user', content: 'hello' }]));
      assert.match(error.message, /^Anthropic error 429: /); assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 7000);
    });
    await withFetch(() => new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }), async () => {
      const { error } = await drain(anthropic.chatStream([{ role: 'user', content: 'hello' }]));
      assert.match(error.message, /^Anthropic stream error 529: /); assert.equal(error.httpStatus, 529);
      assert.equal(isRateLimitClass(error), true);
    });
    await withFetch(() => new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 }), async () => {
      const error = await failure(anthropic.chat([{ role: 'user', content: 'hello' }]));
      // The OAuth subclass refreshes its token by matching this exact message.
      assert.match(error.message, /Anthropic error 401/); assert.equal(error.httpStatus, 401);
      assert.equal('retryAfterMs' in error, false);
    });
    const vertex = new VertexAnthropicProvider({ project: 'my-project-1', location: 'us-east5', apiKey: 'key', model: 'claude-sonnet-5' });
    await withFetch(() => new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429, headers: { 'retry-after': '3' } }), async () => {
      const { error } = await drain(vertex.chatStream([{ role: 'user', content: 'hello' }]));
      assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 3000);
    });
  });

  test(`${browser}: Anthropic in-stream rate_limit_error and overloaded_error are retried at stream startup`, async () => {
    const anthropic = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-5' });
    for (const [type, httpStatus] of [['rate_limit_error', 429], ['overloaded_error', 529], ['api_error', undefined]]) {
      const failed = { type: 'error', error: { type, message: type } };
      await withFetch(attempt => attempt === 1
        ? sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }, failed)
        : sse(...anthropicText('Recovered')), async requests => {
        const { events, error } = await drain(retryModelStream(() => anthropic.chatStream([{ role: 'user', content: 'hello' }]), noWait));
        if (httpStatus) {
          assert.equal(error, null, type); assert.equal(requests.length, 2, type);
          assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', content: 'Recovered' }]);
        } else {
          assert.equal(requests.length, 1); assert.equal(error.httpStatus, undefined);
          assert.equal(error.isAskStreamTerminalError, true); assert.match(error.message, /Anthropic stream error: api_error/);
        }
      });
    }
  });

  test(`${browser}: Azure OpenAI and llama.cpp HTTP errors carry their status`, async () => {
    const azure = new AzureOpenAIProvider({ baseUrl: 'https://example.openai.azure.com', model: 'gpt-4o', apiKey: 'key' });
    await withFetch(() => new Response('{"error":{"code":"429","message":"Rate limit is exceeded."}}', { status: 429, headers: { 'retry-after': '2' } }), async () => {
      const error = await failure(azure.chat([{ role: 'user', content: 'hello' }]));
      assert.match(error.message, /error 429: /); assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, 2000);
      const { error: streamError } = await drain(azure.chatStream([{ role: 'user', content: 'hello' }]));
      assert.match(streamError.message, /stream error 429: /); assert.equal(streamError.httpStatus, 429); assert.equal(streamError.retryAfterMs, 2000);
    });
    const llama = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:8080' });
    await withFetch(() => new Response('{"error":{"code":503,"message":"Loading model"}}', { status: 503, headers: { 'retry-after': '1' } }), async () => {
      const error = await failure(llama.chat([{ role: 'user', content: 'hello' }]));
      assert.match(error.message, /^llama\.cpp error 503: /); assert.equal(error.httpStatus, 503);
      assert.equal('retryAfterMs' in error, false, 'only rate-limit classes read a cooldown');
    });
    await withFetch(() => new Response('Too Many Requests', { status: 429 }), async () => {
      const { error } = await drain(llama.chatStream([{ role: 'user', content: 'hello' }]));
      assert.match(error.message, /^llama\.cpp stream error 429: /); assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterMs, null);
    });
  });

  test(`${browser}: a Bedrock ThrottlingException gets the rate-limit retry`, async () => {
    const bedrock = new AwsBedrockProvider({ model: 'anthropic.claude-sonnet-5', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' });
    await withFetch(attempt => attempt === 1
      ? new Response('{"message":"Too many requests, please wait before trying again."}', { status: 429, headers: { 'x-amzn-ErrorType': 'ThrottlingException' } })
      : Response.json({ output: { message: { content: [{ text: 'OK' }] } }, stopReason: 'end_turn' }), async requests => {
      const first = await failure(bedrock.chat([{ role: 'user', content: 'hello' }]));
      assert.match(first.message, /error 429: /); assert.equal(first.httpStatus, 429);
      const waits = [];
      const result = await retryModelCall(first, () => bedrock.chat([{ role: 'user', content: 'hello' }]),
        { random: () => 0, sleep: async ms => waits.push(ms) });
      assert.equal(result.content, 'OK'); assert.deepEqual(waits, [5000]); assert.equal(requests.length, 2);
    });
  });

  test(`${browser}: billing exhaustion on HTTP 429 is not a rate limit and is never retried`, async () => {
    const quota = status(429, { code: 'insufficient_quota' });
    assert.equal(isBillingQuotaError(quota), true);
    assert.equal(isRateLimitClass(quota), false);
    for (const code of ['billing_hard_limit_reached', 'billing_not_active', 'INSUFFICIENT_QUOTA']) {
      assert.equal(isRateLimitClass(status(429, { code })), false, code);
    }
    for (const code of ['rate_limit_exceeded', 'webbrain_cloud_upstream_error', undefined]) {
      assert.equal(isRateLimitClass(status(429, code ? { code } : {})), true, String(code));
    }
    await assert.rejects(retryModelCall(quota, async () => assert.fail('not retried'),
      { sleep: async () => assert.fail('no cooldown') }), error => error === quota);
    // A rate limit that turns into billing exhaustion stops the cooldowns.
    let calls = 0; const waits = [];
    await assert.rejects(retryModelCall(status(429), async () => { calls++; throw quota; },
      { ...noWait, sleep: async ms => waits.push(ms) }), error => error === quota);
    assert.equal(calls, 1); assert.deepEqual(waits, [5000]);
    const official = () => new OpenAICompatibleProvider({ category: 'cloud', providerName: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    await withFetch(() => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }), { status: 429 }), async requests => {
      const { error } = await drain(retryModelStream(() => official().chatStream([{ role: 'user', content: 'hello' }]),
        { sleep: async () => assert.fail('billing exhaustion is not waited out') }));
      assert.equal(error.httpStatus, 429); assert.equal(error.code, 'insufficient_quota'); assert.equal(requests.length, 1);
    });
    // WebBrain Cloud allowance codes arrive on HTTP 402 and keep their quota metadata.
    const cloud = new OpenAICompatibleProvider({ providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1', model: 'compass' });
    const tier = cloud._httpError(402, JSON.stringify({ error: { code: 'webbrain_cloud_free_tier_exceeded', message: 'Weekly free WebBrain Compass allowance used.' } }), 'webbrain-cloud error 402');
    assert.equal(tier.code, 'webbrain_cloud_free_tier_exceeded'); assert.equal(tier.quota.code, 'webbrain_cloud_free_tier_exceeded');
    assert.equal(isRateLimitClass(tier), false); assert.equal(isBillingQuotaError(tier), false);
  });

  test(`${browser}: stream startup holds reasoning so a rate limit after it is retried without replaying it`, async () => {
    const reasoning = content => ({ type: 'reasoning', content });
    const isOutput = event => event.type !== 'reasoning';
    let starts = 0;
    const recovered = await drain(retryModelStream(() => (async function* () {
      starts++;
      yield reasoning(`thoughts ${starts}`);
      if (starts === 1) throw status(429);
      yield { type: 'text', content: 'OK' };
    })(), { ...noWait, isOutput }));
    assert.equal(recovered.error, null); assert.equal(starts, 2);
    assert.deepEqual(recovered.events, [reasoning('thoughts 2'), { type: 'text', content: 'OK' }]);
    // Output ends startup: a later rate limit is never retried.
    starts = 0;
    const shown = await drain(retryModelStream(() => (async function* () {
      starts++; yield reasoning('thoughts'); yield { type: 'text', content: 'Partial' }; throw status(429);
    })(), { isOutput, sleep: async () => assert.fail('no restart after output') }));
    assert.equal(shown.error.httpStatus, 429); assert.equal(starts, 1);
    assert.deepEqual(shown.events, [reasoning('thoughts'), { type: 'text', content: 'Partial' }]);
    // Without isOutput the first event still ends startup.
    starts = 0;
    const plain = await drain(retryModelStream(() => (async function* () { starts++; yield reasoning('thoughts'); throw status(429); })(),
      { sleep: async () => assert.fail('the default keeps the first event as output') }));
    assert.equal(plain.error.httpStatus, 429); assert.equal(starts, 1); assert.deepEqual(plain.events, [reasoning('thoughts')]);
    // A stream of reasoning only still delivers it when it ends.
    const quiet = await drain(retryModelStream(() => (async function* () { yield reasoning('only thoughts'); })(), { isOutput }));
    assert.deepEqual(quiet, { events: [reasoning('only thoughts')], error: null });
    // Real providers: OpenRouter reasoning, then Anthropic thinking, interrupted by a limit.
    await withFetch(attempt => attempt === 1
      ? sse({ choices: [{ index: 0, delta: { reasoning: 'stale' } }] }, openRouterLimit)
      : sse({ choices: [{ index: 0, delta: { reasoning: 'fresh' } }] }, text('Recovered'), stop, '[DONE]'), async requests => {
      const { events, error } = await drain(retryModelStream(() => router().chatStream([{ role: 'user', content: 'hello' }]), { ...noWait, isOutput }));
      assert.equal(error, null); assert.equal(requests.length, 2);
      assert.deepEqual(events.filter(event => event.type === 'reasoning'), [{ type: 'reasoning', content: 'fresh' }]);
    });
    const anthropic = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-5' });
    const thinking = content => [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: content } },
    ];
    await withFetch(attempt => attempt === 1
      ? sse({ type: 'message_start', message: { usage: { input_tokens: 3 } } }, ...thinking('stale'),
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
      : sse(...anthropicText('Recovered')), async requests => {
      const { events, error } = await drain(retryModelStream(() => anthropic.chatStream([{ role: 'user', content: 'hello' }]), { ...noWait, isOutput }));
      assert.equal(error, null); assert.equal(requests.length, 2);
      assert.deepEqual(events.filter(event => event.type === 'reasoning'), []);
      assert.deepEqual(events.filter(event => event.type === 'text'), [{ type: 'text', content: 'Recovered' }]);
    });
  });

  test(`${browser}: Azure OpenAI and llama.cpp errors inside the stream keep their code and rate-limit class`, async () => {
    const azure = new AzureOpenAIProvider({ baseUrl: 'https://example.openai.azure.com', model: 'gpt-4o', apiKey: 'key' });
    const llama = new LlamaCppProvider({ baseUrl: 'http://127.0.0.1:8080' });
    for (const [provider, frame, code, httpStatus] of [
      [azure, { error: { code: '429', message: 'Rate limit is exceeded. Try again in 1 seconds.' } }, '429', 429],
      [azure, { error: { code: 'content_filter', message: 'The response was filtered' } }, 'content_filter', undefined],
      [azure, { error: 'Rate limit is exceeded.' }, undefined, 429],
      [llama, { error: { code: 429, message: 'Too many requests', type: 'rate_limit_error' } }, undefined, 429],
      [llama, { error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' } }, undefined, undefined],
    ]) {
      await withFetch(() => sse(frame), async () => {
        const { error } = await drain(provider.chatStream([{ role: 'user', content: 'hello' }]));
        assert.match(error.message, /stream error: /, JSON.stringify(frame));
        assert.equal(error.isAskStreamTerminalError, true, JSON.stringify(frame));
        assert.equal(error.code, code, JSON.stringify(frame));
        assert.equal(error.httpStatus, httpStatus, JSON.stringify(frame));
      });
    }
  });
}
