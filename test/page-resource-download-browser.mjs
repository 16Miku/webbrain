// download_resource_from_page reads the element's resource in the page
// (network-tools.js readPageResourceForDownload), in real Chromium for both
// builds' copies: a blob is read up to a size limit and its reader cancelled
// past it, and a streaming playlist is refused rather than saved as media.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';

const api = { runtime: { getURL: value => value, onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }, downloads: { onChanged: { addListener() {} } } };
globalThis.chrome ??= api;
globalThis.browser ??= api;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>Resources</title><body></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

for (const build of ['chrome', 'firefox']) {
  test(`${build}: a page resource is read within its limit, and a streaming playlist is not saved as media`, async () => {
    const { readPageResourceForDownload } = await import(`../src/${build}/src/network/network-tools.js`);
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${origin}/page`);
      await page.evaluate(() => {
        const add = (id, url, tag = 'video') => { const el = document.createElement(tag); el.id = id; el.src = url; document.body.append(el); };
        add('small', URL.createObjectURL(new Blob([new Uint8Array(2048)], { type: 'video/mp4' })));
        add('large', URL.createObjectURL(new Blob([new Uint8Array(300 * 1024)], { type: 'video/mp4' })));
        add('hls-blob', URL.createObjectURL(new Blob(['#EXTM3U\n'], { type: 'application/vnd.apple.mpegurl' })));
        add('hls', '/stream/master.m3u8?token=1');
        add('dash', '/stream/manifest.mpd');
        add('file', '/media/clip.mp4');
      });
      const read = (selector, maxBytes) => page.evaluate(({ source, selector, maxBytes }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`return (${source})`)();
        return fn(selector, maxBytes);
      }, { source: readPageResourceForDownload.toString(), selector, maxBytes });
      const small = await read('#small', 100 * 1024);
      assert.equal(small.ok, true, JSON.stringify(small).slice(0, 200));
      assert.equal(small.size, 2048);
      assert.match(small.url, /^data:video\/mp4;base64,/);
      const large = await read('#large', 100 * 1024);
      assert.deepEqual({ ok: large.ok, tooLarge: large.tooLarge }, { ok: false, tooLarge: true });
      for (const selector of ['#hls-blob', '#hls', '#dash']) {
        const playlist = await read(selector, 100 * 1024);
        assert.equal(playlist.ok, false, selector);
        assert.equal(playlist.streamingPlaylist, true, selector);
        assert.match(playlist.error, /streaming playlist/);
      }
      const file = await read('#file', 100 * 1024);
      assert.deepEqual({ ok: file.ok, isBlob: file.isBlob, crossOrigin: file.crossOrigin }, { ok: true, isBlob: false, crossOrigin: false });
    } finally {
      await browser.close();
    }
  });
}
