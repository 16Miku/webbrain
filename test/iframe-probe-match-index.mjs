// iframe_click and iframe_type act on the matchIndex-th match of their
// selector in a frame. The submit probe reads that same element, so the card
// never describes another control, and it reads none when the frame has no
// such match, so no card asks about a click that cannot run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureControlEffectReading, probeWithReadings } from './semantic-decision-stub.mjs';

const pageUrl = 'https://orders.example/widget';

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: the iframe submit probe reads the indexed match`, async t => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
      const page = await context.newPage();
      await page.goto(pageUrl);
      const source = Agent._submitActionProbe.toString();
      const runProbe = (tool, args) => page.evaluate(({ source, tool, args }) => (0, eval)(`(${source})`)(tool, args), { source, tool, args });
      const probe = (tool, args) => probeWithReadings(runProbe, tool, args, fixtureControlEffectReading);
      const click = matchIndex => probe('iframe_click', { urlFilter: 'orders.example', selector: 'button', ...(matchIndex === undefined ? {} : { matchIndex }) });
      try {
        await page.setContent('<form method="post" action="/orders"><input name="ref" aria-label="Order reference" value="WB-QA-1">'
          + '<button type="submit" name="op" value="lookup">Look up</button>'
          + '<button type="submit" name="op" value="delete">Delete order</button></form>');
        await t.test('the second match is the one the card describes', async () => {
          const second = await click(1);
          assert.equal(second?.isSubmit, true);
          assert.equal(second.mutationKind, 'delete', 'matchIndex 1 is Delete order, not Look up');
          const first = await click(0);
          assert.equal(first?.isSubmit, true);
          assert.notEqual(first.mutationKind, 'delete', 'matchIndex 0 is Look up');
          assert.notEqual((await click())?.mutationKind, 'delete', 'no matchIndex is the first match');
        });
        await t.test('a match the frame does not have describes nothing', async () => {
          assert.notEqual((await click(2))?.isSubmit, true);
          assert.notEqual((await click(-1))?.isSubmit, true);
        });
      } finally {
        await browser.close();
      }
    });
  }
}
