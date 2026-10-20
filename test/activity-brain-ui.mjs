import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the activity indicator module is identical in both builds', () => {
  assert.equal(read('chrome', 'src/ui/activity-brain.js'), read('firefox', 'src/ui/activity-brain.js'));
});

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  // The real activity bar markup and stylesheet, with the module run as a classic script.
  async function openBar({ theme = 'dark', reducedMotion = 'no-preference', deviceScaleFactor = 1 } = {}) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 380, height: 200 }, deviceScaleFactor, reducedMotion });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const html = read(build, 'src/ui/sidepanel.html');
    const start = html.indexOf('<div id="agent-activity"');
    const end = html.indexOf('<!-- Act Mode Warning Banner -->', start);
    assert.ok(start >= 0 && end > start, 'activity bar markup missing');
    await page.setContent(`<!doctype html><html data-theme="${theme}"><head><style>${read(build, 'styles/sidepanel.css')}</style></head>`
      + `<body>${html.slice(start, end)}</body></html>`);
    await page.addScriptTag({ content: `
      window.__frames = 0;
      const nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => nativeRaf((now) => { window.__frames += 1; callback(now); });
      window.__ink = () => {
        const canvas = document.querySelector('#agent-activity canvas.activity-brain');
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let ink = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 24) ink += 1;
        return ink;
      };
      window.__pixels = () => {
        const canvas = document.querySelector('#agent-activity canvas.activity-brain');
        return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data).join(',');
      };
      ${read(build, 'src/ui/activity-brain.js').replace(/^export function /m, 'function ')}
      window.__brain = mountActivityBrain(document.getElementById('agent-activity'));
    ` });
    return { browser, page, errors };
  }
  const show = (page) => page.evaluate(() => document.getElementById('agent-activity').classList.remove('hidden'));
  const hide = (page) => page.evaluate(() => document.getElementById('agent-activity').classList.add('hidden'));

  test(`${build}: the indicator animates only while the activity bar is shown`, async () => {
    const { browser, page, errors } = await openBar({ deviceScaleFactor: 2 });
    try {
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => window.__frames), 0, 'no frames while the bar is hidden');
      assert.equal(await page.evaluate(() => window.__ink()), 0, 'nothing drawn while the bar is hidden');

      await show(page);
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => window.__frames) > 5, 'frames run once the bar is shown');
      assert.ok(await page.evaluate(() => window.__ink()) > 200, 'the brain is drawn');
      assert.equal(await page.evaluate(() => document.querySelector('canvas.activity-brain').width), 44, 'backed for a 2x screen');
      const before = await page.evaluate(() => window.__pixels());
      await page.waitForTimeout(350);
      assert.notEqual(await page.evaluate(() => window.__pixels()), before, 'the circuit keeps moving');

      await hide(page);
      await page.waitForTimeout(50);
      const stopped = await page.evaluate(() => window.__frames);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__frames), stopped, 'frames stop once the bar is hidden');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });

  test(`${build}: the 22px indicator keeps the bar's height and the label's place`, async () => {
    const { browser, page } = await openBar();
    try {
      await show(page);
      const box = await page.evaluate(() => {
        const bar = document.getElementById('agent-activity');
        const canvas = bar.querySelector('canvas.activity-brain');
        const label = document.getElementById('activity-text');
        const withIndicator = { height: bar.getBoundingClientRect().height, label: label.getBoundingClientRect().left - bar.getBoundingClientRect().left };
        canvas.style.display = 'none';
        const withoutIndicator = bar.getBoundingClientRect().height;
        canvas.style.display = '';
        const rect = canvas.getBoundingClientRect();
        return { ...withIndicator, withoutIndicator, width: rect.width, canvasHeight: rect.height };
      });
      assert.equal(box.width, 22);
      assert.equal(box.canvasHeight, 22);
      assert.equal(box.height, box.withoutIndicator, 'the indicator does not make the bar taller');
      // 14px padding + the old 14px spinner + the 8px gap.
      assert.equal(Math.round(box.label), 36, 'the label starts where it did next to the old spinner');
    } finally { await browser.close(); }
  });

  test(`${build}: reduced motion holds a still frame, light theme included`, async () => {
    const { browser, page, errors } = await openBar({ theme: 'light', reducedMotion: 'reduce', deviceScaleFactor: 2 });
    try {
      await show(page);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__frames), 0, 'no animation loop under reduced motion');
      const still = await page.evaluate(() => window.__ink());
      assert.ok(still > 200, `a still brain is drawn (${still} inked pixels)`);
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate(() => window.__ink()) > 200, 'a theme switch redraws the still frame');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
