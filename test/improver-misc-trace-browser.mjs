// The real trace recorder (IndexedDB) mints run ids that Cloud payment-card
// redaction cannot rewrite, even when the clock reads a Luhn-valid 13-digit
// millisecond timestamp. Chromium hosts both builds' recorder source: the
// recorder is byte-identical across builds and only needs IndexedDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// 2026-10-15T12:00:00Z — 13 digits that pass the Luhn check.
const LUHN_VALID_MS = 1792065600000;

for (const build of ['chrome', 'firefox']) {
  test(`${build}: recorder startRun stores a base36 run id for a Luhn-valid clock`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const root = resolve(`src/${build}`);
      await page.route('http://trace-run-id.local/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
        const file = resolve(root, '.' + pathname);
        if (!file.startsWith(root + sep)) return route.abort();
        await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) });
      });
      await page.goto('http://trace-run-id.local/');
      const result = await page.evaluate(async (now) => {
        globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ tracingEnabled: true }) } } };
        const trace = await import('/src/trace/recorder.js');
        const realNow = Date.now;
        Date.now = () => now;
        let runId;
        try {
          runId = await trace.startRun({ conversationId: 'session' });
        } finally {
          Date.now = realNow;
        }
        const stored = await trace.getRun(runId);
        return { runId, storedRunId: stored?.runId, startedAt: stored?.startedAt };
      }, LUHN_VALID_MS);
      assert.equal(result.startedAt, LUHN_VALID_MS, 'the stubbed clock must reach the recorder');
      assert.equal(result.storedRunId, result.runId);
      assert.match(result.runId, new RegExp(`^run_${LUHN_VALID_MS.toString(36)}_[0-9a-z]{8}$`));
      assert.doesNotMatch(result.runId, /\d{9,}/);
    } finally {
      await browser.close();
    }
  });
}
