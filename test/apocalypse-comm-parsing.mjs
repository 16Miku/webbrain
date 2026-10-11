import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

function boundedParser(moduleURL) {
  const script = `const {isRenderableMarkup}=await import(process.argv[1]);
    process.stdout.write('ready\\n');
    const start=performance.now();
    const unfinished='<!--'+'--><!--'.repeat(16_000)+'x';
    const finished='<!--x-->'.repeat(15_000);
    if(!isRenderableMarkup(unfinished)||isRenderableMarkup(finished))throw Error('classification_changed');
    console.log(JSON.stringify({finished:true,elapsedMS:performance.now()-start}));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleURL.href],
      {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errors = '', parserTimer = null, ready = false;
    const loadingTimer = setTimeout(() => {child.kill(); reject(Error('bulletin_child_load_deadline'));}, 5000);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (!ready && output.startsWith('ready\n')) {
        ready = true;
        clearTimeout(loadingTimer);
        parserTimer = setTimeout(() => {child.kill(); reject(Error('bulletin_parser_deadline'));}, 500);
      }
    });
    child.stderr.on('data', bytes => {errors += bytes;});
    child.once('error', error => {clearTimeout(loadingTimer); clearTimeout(parserTimer); reject(error);});
    child.once('close', exit => {
      clearTimeout(loadingTimer); clearTimeout(parserTimer);
      try {
        assert.equal(exit, 0, errors);
        assert.equal(ready, true);
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.finished, true);
        assert.ok(result.elapsedMS < 500);
        resolve();
      } catch (error) {reject(error);}
    });
  });
}

for (const browser of ['chrome', 'firefox']) {
  const moduleURL = new URL(`../src/${browser}/src/ui/apocalypse-comm.js`, import.meta.url);
  const {isRenderableMarkup, communicationDocument} = await import(moduleURL.href);
  test(`${browser}: blank bulletins preserve whitespace, BOM, doctype and comment handling`, () => {
    for (const input of ['', ' \t\r\n\v\f\u00a0\uFEFF', '<!DOCTYPE html>', '<!-- one\r\ntwo -->',
      '\uFEFF<!DoCtYpE html>\n<!--first--><!--second-->\u00a0']) {
      assert.equal(isRenderableMarkup(input), false, JSON.stringify(input));
    }
  });
  test(`${browser}: content and incomplete comments are not discarded as blank`, () => {
    for (const input of ['text', '<p>Bulletin</p>', '<!--one-->actual text', '<!--unterminated',
      '<!doctype html', '<!--outer<!--inner-->visible-->', '<!-->visible']) {
      assert.equal(isRenderableMarkup(input), true, JSON.stringify(input));
    }
    for (const value of [null, undefined, {}, 0]) assert.equal(isRenderableMarkup(value), false);
  });
  test(`${browser}: the existing size boundary and safe base attributes remain intact`, () => {
    assert.equal(isRenderableMarkup(' '.repeat(127_999) + 'x'), true);
    assert.equal(isRenderableMarkup('x'.repeat(128_001)), false);
    const output = communicationDocument('<head></head><p>Bulletin</p>',
      {href: 'https://webbrain.one/"?first=1&second=2'});
    assert.ok(output.includes('href="https://webbrain.one/&quot;?first=1&amp;second=2"'));
    assert.ok(output.includes('content="no-referrer"'));
    assert.ok(output.endsWith('<p>Bulletin</p>'));
  });
  test(`${browser}: ambiguous comment repetitions finish within an owned subprocess deadline`, async () => {
    await boundedParser(moduleURL);
  });
}
