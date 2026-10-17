const pw = (() => { try { return require('playwright'); } catch { return require('/usr/lib/node_modules/playwright'); } })();
(async () => {
  const b = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => pw.chromium.launch());
  const p = await b.newPage();
  p.on('response', (r) => { if (r.status() >= 400) console.log(r.status(), r.url()); });
  await p.goto('http://localhost:8769/index.html'); await p.waitForTimeout(1500); await b.close();
})();
