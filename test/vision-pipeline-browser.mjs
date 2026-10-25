// Vision mode capture pipeline in real Chromium at device pixel ratios 1, 2
// and 3, on a scrolled page and with an element changing: the planned image
// size is what the model receives, a point mapped image → CSS hits the
// element it shows, trusted pointer events land there, and the diff finds
// exactly the changed control. Browser zoom runs through the extension in
// test/quality/vision-mode-mv3.mjs (chrome.tabs.setZoom). Uses the same CDP calls as the extension's
// _visionPlatformCapture / _visionDispatchClick and the shared modules.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AGENT_DIR = path.join(ROOT, 'src/chrome/src/agent');

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Vision fixture</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  .spacer { height: 600px; background: linear-gradient(#fff, #eef); }
  #target { position: absolute; left: 240px; top: 760px; width: 180px; height: 48px; background: rgb(20, 120, 220); color: #fff; border: 0; }
  #other { position: absolute; left: 700px; top: 900px; width: 120px; height: 40px; background: rgb(220, 60, 40); color: #fff; border: 0; }
  #status { position: absolute; left: 240px; top: 840px; width: 360px; height: 24px; }
  .tall { height: 2400px; }
</style>
<div class="spacer"></div><div class="tall"></div>
<button id="target">Target</button><button id="other">Other</button><div id="status"></div>
<script>
  window.clicks = [];
  for (const id of ['target', 'other']) document.getElementById(id).addEventListener('click', event => {
    window.clicks.push({ id, trusted: event.isTrusted, x: event.clientX, y: event.clientY });
    document.getElementById('status').textContent = id + ' clicked ' + window.clicks.length;
  });
</script>`;

function serve() {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/agent/')) {
      const file = path.join(AGENT_DIR, path.basename(request.url));
      if (!file.startsWith(AGENT_DIR) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(fs.readFileSync(file));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(FIXTURE);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

for (const dpr of [1, 2, 3]) {
  test(`DPR ${dpr}: planned size, exact mapping, trusted clicks and diffs on a scrolled page`, async () => {
    // No viewport emulation: --force-device-scale-factor is what a retina
    // screen looks like to Chrome (page DPR and compositor scale agree).
    const browser = await chromium.launch({ channel: 'chromium', args: [`--force-device-scale-factor=${dpr}`, '--window-size=1280,860'] });
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(`${origin}/fixture`);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const cdp = await context.newCDPSession(page);
      const pageDpr = await page.evaluate(() => devicePixelRatio);
      assert.equal(pageDpr, dpr, 'the page sees the forced device pixel ratio');

      // Probe exactly like _visionPlatformProbe.
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const probe = {
        cssWidth: metrics.cssVisualViewport.clientWidth,
        cssHeight: metrics.cssVisualViewport.clientHeight,
        scrollX: metrics.cssVisualViewport.pageX,
        scrollY: metrics.cssVisualViewport.pageY,
        devicePixelRatio: pageDpr,
      };
      assert.equal(probe.scrollY, 600);

      const plan = await page.evaluate(async ({ probe }) => {
        const budget = await import('/agent/vision-budget.js');
        return budget.planVisionImageSize({ cssWidth: probe.cssWidth, cssHeight: probe.cssHeight, profile: budget.VISION_PROFILES.anthropic, quality: 'economy' });
      }, { probe });
      assert.ok(plan.width < probe.cssWidth, `economy downscales: ${JSON.stringify(plan)} for ${probe.cssWidth}`);

      // Capture exactly like _visionPlatformCapture.
      const capture = async () => {
        const scale = plan.width / (probe.cssWidth * probe.devicePixelRatio);
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality: 90, fromSurface: true,
          clip: { x: probe.scrollX, y: probe.scrollY, width: probe.cssWidth, height: probe.cssHeight, scale },
        });
        return `data:image/jpeg;base64,${shot.data}`;
      };
      const first = await capture();
      const analysis = await page.evaluate(async ({ dataUrl, plan, probe }) => {
        const encoder = await import('/agent/vision-encoder.js');
        const raster = await encoder.rasterizeFrame(dataUrl, plan.width, plan.height);
        window.__visionFirst = raster.pixels;
        // A point on the target button (left of its label) in CSS px → image px.
        const rect = document.getElementById('target').getBoundingClientRect();
        const centre = { x: rect.left + 14, y: rect.top + 12 };
        const img = { x: Math.round(centre.x * plan.width / probe.cssWidth), y: Math.round(centre.y * plan.height / probe.cssHeight) };
        const i = (img.y * plan.width + img.x) * 4;
        const webp = await encoder.encodeCanvasRegion(raster.canvas, null, { mimeType: 'image/webp', quality: 0.8 });
        const jpeg = await encoder.encodeCanvasRegion(raster.canvas, null, { mimeType: 'image/jpeg', quality: 0.8 });
        return {
          decoded: { width: raster.sourceWidth, height: raster.sourceHeight },
          size: { width: raster.width, height: raster.height },
          img,
          rgb: [raster.pixels[i], raster.pixels[i + 1], raster.pixels[i + 2]],
          webp: { bytes: webp.bytes, mime: webp.mimeType, width: webp.width },
          jpeg: { bytes: jpeg.bytes, mime: jpeg.mimeType },
        };
      }, { dataUrl: first, plan, probe });
      // The compositor honoured the DPR-divided scale (or the runtime resampled).
      assert.deepEqual(analysis.size, { width: plan.width, height: plan.height });
      assert.ok(Math.abs(analysis.decoded.width - plan.width) <= 2, `capture came back at the planned size: ${JSON.stringify(analysis.decoded)} vs ${plan.width}`);
      // The pixel at the mapped point is the blue target, not white page: the
      // clip used document coordinates of the scrolled viewport.
      const [r, g, b] = analysis.rgb;
      assert.ok(b > 180 && r < 80 && g > 80 && g < 170, `mapped pixel is the target button: ${analysis.rgb}`);
      assert.equal(analysis.webp.mime, 'image/webp');
      assert.ok(analysis.webp.bytes < analysis.jpeg.bytes, `WebP is smaller than JPEG (${analysis.webp.bytes} vs ${analysis.jpeg.bytes})`);

      // Model point (image px) → CSS like VisionSession, then a trusted click
      // exactly like _visionDispatchClick.
      const css = { x: analysis.img.x * probe.cssWidth / plan.width, y: analysis.img.y * probe.cssHeight / plan.height };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: css.x, y: css.y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: css.x, y: css.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: css.x, y: css.y, button: 'left', buttons: 0, clickCount: 1 });
      const clicks = await page.evaluate(() => window.clicks);
      assert.equal(clicks.length, 1);
      assert.equal(clicks[0].id, 'target');
      assert.equal(clicks[0].trusted, true);
      assert.ok(Math.abs(clicks[0].x - css.x) <= 1 && Math.abs(clicks[0].y - css.y) <= 1, 'the event carries the exact point');

      // The status line changed; the diff finds that one region.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const second = await capture();
      const change = await page.evaluate(async ({ dataUrl, plan, probe }) => {
        const encoder = await import('/agent/vision-encoder.js');
        const diff = await import('/agent/vision-diff.js');
        const raster = await encoder.rasterizeFrame(dataUrl, plan.width, plan.height);
        const result = diff.diffFrames(window.__visionFirst, raster.pixels, plan.width, plan.height);
        const status = document.getElementById('status').getBoundingClientRect();
        const update = diff.planFrameUpdate(result, { width: plan.width, height: plan.height });
        return {
          regions: result.regions,
          ratio: result.regionAreaRatio,
          kind: update.kind,
          status: { x: status.left * plan.width / probe.cssWidth, y: status.top * plan.height / probe.cssHeight, w: status.width * plan.width / probe.cssWidth },
        };
      }, { dataUrl: second, plan, probe });
      assert.equal(change.kind, 'patch', JSON.stringify(change));
      assert.ok(change.ratio < 0.1, `the patch is a small part of the frame: ${change.ratio}`);
      assert.ok(change.regions.some(region => region.x <= change.status.x + 2 && region.y <= change.status.y + 2
        && region.y + region.height >= change.status.y + 8), `a region covers the status line: ${JSON.stringify(change)}`);
    } finally {
      await browser.close();
    }
  });
}

test('content-script vision input (Firefox path) clicks, double-clicks, focuses, scrolls and drags at the exact point', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0}#box{position:absolute;left:100px;top:100px;width:200px;height:80px;background:#08f}
      #field{position:absolute;left:100px;top:220px;width:300px;height:30px}#pane{position:absolute;left:500px;top:100px;width:300px;height:200px;overflow:auto}
      #slider{position:absolute;left:100px;top:320px;width:400px;height:30px;background:#ddd}</style>
      <div id="box"></div><input id="field" value="hello world"><div id="pane"><div style="height:2000px">pane</div></div><div id="slider"></div>
      <script>window.log=[];for(const t of ['mousedown','mouseup','click','dblclick','contextmenu'])document.getElementById('box').addEventListener(t,e=>log.push([t,e.clientX,e.clientY,e.detail,e.button]));
      const s=document.getElementById('slider');let drag=null;s.addEventListener('mousedown',e=>drag={x:e.clientX});document.addEventListener('mousemove',e=>{if(drag)window.dragTo=e.clientX});document.addEventListener('mouseup',()=>{drag=null;window.dragDone=true});</script>`);
    // Load the exact content-script function bodies from content.js.
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const start = source.indexOf('  function _visionTargetAt(');
    const end = source.indexOf('  let _lastClickIdent = null;');
    assert.ok(start > 0 && end > start, 'vision input block present in the Firefox content script');
    const block = source.slice(start, end);
    await page.evaluate(code => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }\n${code}\nreturn visionInput;`)();
    }, block);
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    let result = await run({ type: 'click', x: 150, y: 130 });
    assert.equal(result.success, true);
    result = await run({ type: 'click', x: 160, y: 140, clickCount: 2 });
    assert.equal(result.clicks, 2);
    result = await run({ type: 'click', x: 170, y: 150, button: 'right' });
    const log = await page.evaluate(() => window.log);
    assert.deepEqual(log[0], ['mousedown', 150, 130, 1, 0]);
    assert.ok(log.some(entry => entry[0] === 'dblclick'));
    assert.ok(log.some(entry => entry[0] === 'contextmenu' && entry[4] === 2));
    // A press focuses the field under it; three clicks select its text.
    await run({ type: 'click', x: 150, y: 235, clickCount: 3 });
    const focus = await page.evaluate(() => ({ active: document.activeElement.id, selected: document.activeElement.selectionEnd - document.activeElement.selectionStart }));
    assert.deepEqual(focus, { active: 'field', selected: 11 });
    // The wheel scrolls the pane under the point, not the page.
    result = await run({ type: 'wheel', x: 600, y: 200, deltaY: 300 });
    assert.equal(result.moved, true);
    assert.equal(await page.evaluate(() => document.getElementById('pane').scrollTop), 300);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    // A drag moves the pressed pointer to the end point.
    result = await run({ type: 'drag', x: 120, y: 335, toX: 420, toY: 335, steps: 6 });
    assert.equal(result.success, true);
    assert.deepEqual(await page.evaluate(() => [window.dragTo, window.dragDone]), [420, true]);
    // Points outside the viewport are refused without dispatch.
    result = await run({ type: 'click', x: 5000, y: 10 });
    assert.equal(result.noDispatch, true);
  } finally {
    await browser.close();
  }
});
