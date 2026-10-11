import assert from 'node:assert/strict';
import test from 'node:test';

const url = 'https://example.test/auth/sign_up?accept=owned-one-use-value';
const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: storage, session: storage },
  runtime: { getURL: value => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${value}` },
  scripting: {}, tabs: {}, webNavigation: {} };
globalThis.chrome = api;
globalThis.browser = api;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  function agent() {
    const result = Object.create(Agent.prototype);
    result._isPdfTabCache = new Map();
    return result;
  }
  async function probe(run, metadata = { url, contentType: 'text/html' }, currentFrame = { url, documentId: 'current-document' }) {
    const previousFetch = globalThis.fetch;
    const previousScript = api.scripting.executeScript;
    const previousFirefoxScript = api.tabs.executeScript;
    const previousFrame = api.webNavigation.getFrame;
    let fetches = 0, scripts = 0;
    globalThis.fetch = async () => {
      fetches++;
      return { headers: new Headers({ 'content-type': 'application/pdf' }) };
    };
    api.scripting.executeScript = async options => {
      assert.equal(build, 'chrome', 'Firefox MV2 must use browser.tabs.executeScript.');
      scripts++;
      assert.deepEqual(options.target, { tabId: 37, frameIds: [0] }, 'Read only the current top-level document, never an embedded PDF.');
      if (metadata instanceof Error) throw metadata;
      return [{ frameId: 0, result: typeof metadata === 'function' ? metadata() : metadata }];
    };
    api.tabs.executeScript = async (tabId, options) => {
      assert.equal(build, 'firefox');
      assert.equal(tabId, 37);
      assert.equal(options.frameId, 0, 'Firefox must inspect only the top-level document.');
      assert.match(options.code, /document\.contentType/);
      scripts++;
      if (metadata instanceof Error) throw metadata;
      return [typeof metadata === 'function' ? metadata() : metadata];
    };
    api.webNavigation.getFrame = async target => {
      assert.deepEqual(target, { tabId: 37, frameId: 0 });
      return typeof currentFrame === 'function' ? currentFrame() : currentFrame;
    };
    try { await run({ fetches: () => fetches, scripts: () => scripts }); }
    finally { globalThis.fetch = previousFetch; api.scripting.executeScript = previousScript; api.tabs.executeScript = previousFirefoxScript; api.webNavigation.getFrame = previousFrame; }
  }
  const response = (overrides = {}) => ({ tabId: 37, frameId: 0, type: 'main_frame', url,
    timeStamp: 100, documentId: 'current-document',
    responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }], ...overrides });

  test(`${build}: normal HTML detection never re-fetches a one-use acceptance URL`, async () => {
    await probe(async counts => {
      const target = agent();
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(counts.fetches(), 0);
      assert.equal(counts.scripts(), 2, 'Available browser-owned document MIME remains authoritative.');
    });
  });
  test(`${build}: extensionless native PDF uses browser-owned document MIME without a request`, async () => {
    await probe(async counts => {
      assert.equal(await agent()._isPdfTab(37, url), true);
      assert.equal(counts.fetches(), 0);
    }, { url, contentType: ' Application/PDF; charset=binary ' });
  });
  test(`${build}: navigation during MIME inspection cannot cache another document's answer`, async () => {
    let reads = 0;
    await probe(async counts => {
      const target = agent();
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(target._isPdfTabCache.has(37), false);
      assert.equal(await target._isPdfTab(37, url), true);
      assert.equal(counts.fetches(), 0);
      assert.equal(counts.scripts(), 2);
    }, () => ({ url: ++reads === 1 ? 'https://example.test/previous' : url, contentType: 'application/pdf' }));
  });
  test(`${build}: unavailable document inspection is retried without consuming server state`, async () => {
    await probe(async counts => {
      const target = agent();
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(target._isPdfTabCache.has(37), false);
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(counts.fetches(), 0);
      assert.equal(counts.scripts(), 2);
    }, new Error('Document is not yet accessible'));
  });
  test(`${build}: empty document MIME is not cached or replaced by a network probe`, async () => {
    await probe(async counts => {
      const target = agent();
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(target._isPdfTabCache.has(37), false);
      assert.equal(counts.fetches(), 0);
    }, { url, contentType: '' });
  });
  test(`${build}: explicit PDF URLs and owned MIME handlers retain their fast path`, async () => {
    await probe(async counts => {
      const target = agent();
      assert.equal(await target._isPdfTab(37, 'https://example.test/document.pdf'), true);
      assert.equal(await target._isPdfTab(37, api.runtime.getURL(`src/ui/pdf-handler.html?url=${encodeURIComponent(url)}`)), true);
      assert.equal(await target._isPdfTab(37, 'chrome://settings/'), false);
      assert.equal(counts.fetches(), 0);
      assert.equal(counts.scripts(), 0);
    });
  });

  test(`${build}: observed PDF response identifies an inaccessible native viewer without HEAD`, async () => {
    await probe(async counts => {
      const target = agent();
      assert.equal(target.noteDocumentMime(response()), true);
      assert.equal(await target._isPdfTab(37, url), true);
      assert.equal(counts.fetches(), 0);
    }, new Error('Cannot inject into native PDF viewer'));
  });
  test(`${build}: actual HTML MIME wins over stale same-URL PDF response evidence`, async () => {
    await probe(async counts => {
      const target = agent();
      target.noteDocumentMime(response());
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(counts.fetches(), 0);
    });
  });
  test(`${build}: same-URL new HTML response replaces PDF evidence and late old responses cannot restore it`, async () => {
    await probe(async () => {
      const target = agent();
      target.noteDocumentMime(response());
      assert.equal(target.noteDocumentMime(response({ timeStamp: 200, documentId: 'new-document',
        responseHeaders: [{ name: 'content-type', value: 'text/html' }] })), true);
      assert.equal(target.noteDocumentMime(response({ timeStamp: 150 })), false);
      assert.equal(await target._isPdfTab(37, url), false);
    }, new Error('Unavailable document'));
  });
  test(`${build}: observed response cannot identify a different current document or URL`, async () => {
    for (const frame of [{ url, documentId: 'different-document' }, { url: 'https://example.test/elsewhere', documentId: 'current-document' }]) {
      await probe(async () => {
        const target = agent();
        target.noteDocumentMime(response());
        assert.equal(await target._isPdfTab(37, url), false);
      }, new Error('Unavailable document'), frame);
    }
  });
  test(`${build}: embedded PDF, missing MIME, and non-navigation responses provide no fallback proof`, async () => {
    await probe(async counts => {
      const target = agent();
      for (const fields of [{ frameId: 2 }, { type: 'xmlhttprequest' }, { tabId: -1 }, { url: 'about:blank' }, { responseHeaders: [] }])
        assert.equal(target.noteDocumentMime(response(fields)), false);
      assert.equal(await target._isPdfTab(37, url), false);
      assert.equal(counts.fetches(), 0);
    }, new Error('Unavailable document'));
  });
  test(`${build}: MIME replacement during current-frame binding cannot use stale PDF proof`, async () => {
    const target = agent();
    await probe(async () => {
      target.noteDocumentMime(response());
      assert.equal(await target._isPdfTab(37, url), false);
    }, new Error('Unavailable document'), () => {
      target.noteDocumentMime(response({ timeStamp: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html' }] }));
      return { url, documentId: 'current-document' };
    });
  });
}
