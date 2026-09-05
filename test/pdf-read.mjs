#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfExtractionModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-extraction.js');
const pdfToolsModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-tools.js');
const pdfExtractionHostPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'pdf-extraction-host.js');
const offscreenHtmlPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'offscreen.html');

async function testMv3PdfExtractionUsesTheSharedOffscreenHost() {
  const pdfTools = await readFile(pdfToolsModulePath, 'utf8');
  const host = await readFile(pdfExtractionHostPath, 'utf8');
  const offscreenHtml = await readFile(offscreenHtmlPath, 'utf8');
  assert.match(pdfTools, /ensureOffscreen\(\)/);
  assert.match(pdfTools, /type: PDF_EXTRACTION_MESSAGE/);
  assert.doesNotMatch(
    pdfTools,
    /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\/pdf\.mjs'\)\)/,
    'MV3 service workers reject dynamic import() at runtime',
  );
  assert.match(host, /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\/pdf\.mjs'\)\)/);
  assert.match(host, /extractPdfTextFromBytes/);
  assert.match(offscreenHtml, /<script type="module" src="pdf-extraction-host\.js"><\/script>/);
}

async function testPdfExtractionPreservesBoundedPageMetadataAndTruncation() {
  const { extractPdfTextFromBytes } = await import(pathToFileURL(pdfExtractionModulePath).href);
  const cleanedPages = [];
  const pageTexts = new Map([
    [1, ['First', 'page']],
    [2, ['x'.repeat(1200)]],
  ]);
  const pdfjs = {
    getDocument({ data, verbosity }) {
      assert.deepEqual(Array.from(data), [1, 2, 3]);
      assert.equal(verbosity, 0);
      return {
        promise: Promise.resolve({
          numPages: 2,
          getMetadata: async () => ({ info: { Title: 'Fixture PDF' } }),
          getPage: async pageNumber => ({
            getTextContent: async () => ({
              items: pageTexts.get(pageNumber).map(str => ({ str })),
            }),
            cleanup: () => cleanedPages.push(pageNumber),
          }),
        }),
      };
    },
  };

  const result = await extractPdfTextFromBytes(pdfjs, new Uint8Array([1, 2, 3]), {
    fromPage: 1,
    toPage: 2,
    maxChars: 1000,
  });
  assert.equal(result.title, 'Fixture PDF');
  assert.equal(result.totalPages, 2);
  assert.equal(result.fromPage, 1);
  assert.equal(result.toPage, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.byteLength, 3);
  assert.match(result.pages[1], /page truncated/);
  assert.deepEqual(cleanedPages, [1, 2]);
}

async function testPdfFacadeRequestsOffscreenExtractionAndPreservesClaudeBytes() {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: async message => {
        messages.push(message);
        return {
          ok: true,
          result: {
            success: true,
            title: 'Facade fixture',
            totalPages: 1,
            fromPage: 1,
            toPage: 1,
            pageCount: 1,
            pages: ['fixture text'],
            hasExtractableText: true,
            truncated: false,
            byteLength: 3,
          },
        };
      },
    },
  };
  globalThis.fetch = async () => new Response(new Uint8Array([4, 5, 6]), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
  try {
    const { extractPdfText } = await import(pathToFileURL(pdfToolsModulePath).href);
    const plainResult = await extractPdfText('https://example.test/document.pdf', {
      fromPage: 2,
      toPage: 4,
      maxChars: 5000,
    });
    assert.equal(plainResult.title, 'Facade fixture');
    assert.equal(plainResult._pdfBytes, undefined);

    const claudeResult = await extractPdfText('https://example.test/document.pdf', {
      includeBytes: true,
    });
    assert.deepEqual(Array.from(claudeResult._pdfBytes), [4, 5, 6]);
    assert.deepEqual(messages, [
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: 2, toPage: 4, maxChars: 5000 },
      },
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: undefined, toPage: undefined, maxChars: undefined },
      },
    ]);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
}

const tests = [
  ['MV3 PDF extraction uses the shared offscreen host', testMv3PdfExtractionUsesTheSharedOffscreenHost],
  ['PDF extraction preserves bounded page metadata and truncation', testPdfExtractionPreservesBoundedPageMetadataAndTruncation],
  ['PDF facade delegates extraction and preserves Claude bytes', testPdfFacadeRequestsOffscreenExtractionAndPreservesClaudeBytes],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}
console.log(`\n${tests.length - failed} PDF read tests passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
