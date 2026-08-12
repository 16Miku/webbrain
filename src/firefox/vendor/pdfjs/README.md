# pdfjs-dist (vendored)

Mozilla PDF.js, used by `src/agent/pdf-tools.js` to extract text from
PDFs the user is viewing in Firefox. Firefox's built-in PDF viewer is
itself a privileged page that our content scripts can't inject into,
so instead of scraping the viewer's DOM we fetch the PDF binary and
parse it with pdfjs in the background page.

## Source

- Package: `pdfjs-dist` v5.7.284
- Files: `legacy/build/pdf.mjs` + `legacy/build/pdf.worker.mjs`
- Origin: <https://github.com/mozilla/pdf.js>
- Upstream license: Apache-2.0 (see `LICENSE` in this folder)

## Store-review patch

The upstream legacy files split the strings `<script>`, `</script>`, and
`javascript:` across constants in an old `core-js` null-prototype fallback.
Chrome Web Store classifies that string splitting as obfuscation. Our vendored
copies spell those strings directly; the resulting values and fallback logic
are unchanged.

## Why the legacy build

The legacy build targets older JS runtimes than the default modern
build. The MV2 background page in Firefox supports modern JS but the
legacy bundle's polyfills smooth over surprises in extension contexts
(URL.createObjectURL etc.). Worth the size for the resilience and to
keep parity with the Chrome extension build.

## How it's loaded

`pdf-tools.js` does a lazy dynamic import on the first PDF read:

```js
const pdfjs = await import(browser.runtime.getURL('vendor/pdfjs/pdf.mjs'));
```

The worker URL is resolved the same way:

```js
pdfjs.GlobalWorkerOptions.workerSrc =
  browser.runtime.getURL('vendor/pdfjs/pdf.worker.mjs');
```

Both files are listed in `manifest.json`'s `web_accessible_resources`
so `browser.runtime.getURL` returns a fetchable URL.

## Updating

1. `npm pack pdfjs-dist@latest` (in any scratch directory).
2. `tar xzf pdfjs-dist-*.tgz package/legacy/build/pdf.mjs
    package/legacy/build/pdf.worker.mjs package/LICENSE`
3. Move them over `pdf.mjs`, `pdf.worker.mjs`, `LICENSE` here.
4. Reapply the store-review patch described above to both JavaScript files.
5. Update the version line at the top of this README.
6. Smoke-test by opening a real PDF tab in the loaded extension and
   running a `read_pdf` from the side panel.

Keep parity with `src/chrome/vendor/pdfjs/` — both extensions ship the
same pdfjs files. Don't try to bundle pdfjs through any build step;
the project ships extension source as-is.
