import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, firefox } from 'playwright';
import vm from 'node:vm';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { exportRecordedSession } = await import(`../src/${build}/src/trace/session-export.js`);
  const { observeAwsWafChallengeInPage } = await import(`../src/${build}/src/agent/captcha-frame-runtime.js`);
  test(`${build}: AWS observer captures SDK inputs and distinguishes visible shadow widgets from hidden remnants`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://aws-fixture.local/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
          <div id="amzn-captcha-old" style="display:none">Old widget</div><div id="shadow"></div>
          <script src="https://site.captcha-sdk.awswaf.com/jsapi.js"></script>` });
        await route.fulfill({ contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
      });
      await page.goto('http://aws-fixture.local/');
      await page.evaluate(async () => {
        window.gokuProps = { key: 'old-key', iv: 'old-iv', context: 'old-context' };
        document.cookie = 'aws-waf-token=existing-cookie';
        document.querySelector('#shadow').attachShadow({ mode: 'open' }).innerHTML = '<div id="amzn-captcha-current" style="width:200px;height:100px">Challenge</div>';
        await (await fetch('https://site.captcha.awswaf.com/ait/problem?kind=visual&api_key=observed-sdk-key')).text();
      });
      const observed = await page.evaluate(observeAwsWafChallengeInPage);
      assert.equal(observed.active, true); assert.equal(observed.inspectionComplete, true);
      assert.equal(observed.apiKey, 'observed-sdk-key'); assert.equal(observed.existingToken, 'existing-cookie');
      assert.equal(observed.jsapiScript, 'https://site.captcha-sdk.awswaf.com/jsapi.js');
      await page.evaluate(() => { document.querySelector('#shadow').style.display = 'none'; });
      assert.equal((await page.evaluate(observeAwsWafChallengeInPage)).active, false);
      await page.evaluate(() => {
        document.querySelector('#shadow').style.display = '';
        document.querySelector('#shadow').shadowRoot.querySelector('div').style.height = '0px';
      });
      assert.equal((await page.evaluate(observeAwsWafChallengeInPage)).active, false);
    } finally { await browser.close(); }
  });
  test(`${build}: full JSON preserves all session runs, large results and portable screenshots`, async () => {
    const content = 'complete-result-'.repeat(1000);
    const exported = await exportRecordedSession({
      listRuns: async options => {
        assert.equal(options.limit, Number.MAX_SAFE_INTEGER);
        return Array.from({ length: 501 }, (_, index) => ({ runId: String(index), conversationId: 'session', startedAt: 501 - index }));
      },
      getRunEvents: async () => [{ seq: 1, kind: 'tool', data: { name: 'extract_data', result: { content } } },
        { seq: 2, kind: 'screenshot', data: { caption: 'page' } }],
      getScreenshot: async () => ({ blob: new Blob(['screenshot-bytes'], { type: 'image/png' }) }),
    }, 'session', 'test');
    const payload = JSON.parse(exported.json);
    assert.equal(payload.schema, 'webbrain-trace/1'); assert.equal(payload.session.sessionId, 'session');
    assert.equal(payload.runs.length, 501); assert.equal(payload.runs[0].run.runId, '500');
    assert.equal(payload.runs[0].events[0].data.result.content, content);
    assert.equal(payload.runs[0].events[1].data.screenshot_base64, 'data:image/png;base64,' + btoa('screenshot-bytes'));
    assert.equal(exported.recordingTruncated, false);
  });

  test(`${build}: full export reports old recording omissions instead of concealing them`, async () => {
    const result = await exportRecordedSession({ listRuns: async () => [{ conversationId: 's', runId: 'r' }],
      getRunEvents: async () => [{ kind: 'tool', data: { result: { _truncated: true, head: 'budget reached' } } }],
    }, 's');
    assert.equal(result.recordingTruncated, true);
    assert.equal(JSON.parse(result.json).runs[0].events[0].data.result._truncated, true);
    await assert.rejects(exportRecordedSession({ listRuns: async () => [{ conversationId: 's' }],
      getRunEvents: async () => { throw new Error('Unreadable log'); } }, 's'), /Unreadable log/);
  });

  test(`${build}: --full requires --traces and cannot combine with --config`, async () => {
    const source = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
    const metadataStart = source.indexOf("    value: '/export',");
    const metadataEnd = source.indexOf("    value: '/import',", metadataStart);
    const metadata = source.slice(metadataStart, metadataEnd).replace(/\s*},\s*\{\s*$/, '');
    // Exercise the actual parser with just the export command metadata.
    const parserStart = source.indexOf('function parseSlashInvocation(');
    const parserEnd = source.indexOf('\nfunction ', parserStart + 10);
    const helpers = ['findSlashCommand', 'slashCommandOptions'].map(name => {
      const start = source.indexOf(`function ${name}(`); return source.slice(start, source.indexOf('\nfunction ', start + 10));
    }).join('\n');
    const context = vm.createContext({});
    vm.runInContext(`const SLASH_HELP_OPTION = { value: '--help' }; const SLASH_COMMANDS = [{${metadata}}];\n` + helpers + '\n' + source.slice(parserStart, parserEnd) + '\nglobalThis.parse = parseSlashInvocation;', context);
    for (const command of ['/export --traces --full', '/export --full --traces']) {
      const result = context.parse(command);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.action, 'traces'); assert.equal(result.optionValues.has('--full'), true);
    }
    for (const command of ['/export --full', '/export --config --full', '/export --traces --full extra']) assert.ok(context.parse(command).error, command);
  });

  test(`${build}: exhausted recording budget retains solver outcome and exports it as JSON`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('http://trace-test.local/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        const file = resolve(`src/${build}`, '.' + path);
        if (!file.startsWith(resolve(`src/${build}`) + '/')) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto('http://trace-test.local/');
      const result = await page.evaluate(async () => {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ tracingEnabled: true, losslessTrace: true }) } } };
        const trace = await import('/src/trace/recorder.js');
        const { exportRecordedSession } = await import('/src/trace/session-export.js');
        const runId = await trace.startRun({ conversationId: 'session' });
        for (let step = 0; step < 30; step++) await trace.recordLLMRequest(runId, step, {}, {
          messages: [{ role: 'user', content: 'large context '.repeat(40_000) }], tools: [],
        });
        for (let step = 30; step < 33; step++) await trace.recordToolCall(runId, step, { name: 'get_accessibility_tree', args: {}, result: { pageContent: 'page '.repeat(50_000) } });
        await trace.recordToolCall(runId, 33, { name: 'solve_captcha', args: { type: 'aws_waf', websiteKey: 'must-not-be-in-summary' },
          result: { success: false, dispatched: false, noDispatch: true, error: 'All compatible AWS providers have already been attempted.', solution: { cookie: 'must-not-be-in-summary'.repeat(30000) } } });
        const events = await trace.getRunEvents(runId);
        const exported = await exportRecordedSession(trace, 'session', 'test');
        return { budget: (await trace.getRun(runId)).losslessBytes, tool: events.find(event => event.kind === 'tool' && event.data.name === 'solve_captcha'), payload: JSON.parse(exported.json), recordingTruncated: exported.recordingTruncated };
      });
      assert.equal(result.tool.data.losslessBudgetOmitted, true, JSON.stringify({ budget: result.budget, keys: Object.keys(result.tool.data), resultKeys: Object.keys(result.tool.data.result || {}) }));
      assert.equal(result.tool.data.result.success, false);
      assert.equal(result.tool.data.result.noDispatch, true);
      assert.match(result.tool.data.result.error, /already been attempted/);
      assert.equal(result.tool.data.outcome.request.type, 'aws_waf');
      assert.doesNotMatch(JSON.stringify(result.tool.data.outcome), /must-not-be-in-summary/);
      assert.equal(result.recordingTruncated, true);
      assert.equal(result.payload.runs[0].events.at(-1).data.outcome.noDispatch, true);
    } finally { await browser.close(); }
  });
}
