import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAccessibilityTreeDescriptors as parseChromeAccessibilityTreeDescriptors } from '../../../src/chrome/src/agent/workflows.js';
import { parseAccessibilityTreeDescriptors as parseFirefoxAccessibilityTreeDescriptors } from '../../../src/firefox/src/agent/workflows.js';
import {
  FORMAT_IDS,
  assertPagination,
  assertRoundTrip,
  compareRefReuse,
  parse,
  serialize,
  validateSelection,
  validateTreeNodes,
} from './accessibility-tree-formats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/accessibility-tree-benchmark.json'),
  'utf8',
));

test('all benchmark trees satisfy the AX invariants and round-trip in every format', () => {
  for (const tree of fixture.trees) {
    validateTreeNodes(tree.nodes);
    for (const format of FORMAT_IDS) {
      assert.doesNotThrow(() => assertRoundTrip(format, tree.nodes), `${tree.id}/${format}`);
      assert.equal(parse(format, serialize(format, tree.nodes)).length, tree.nodes.length);
    }
  }
});

test('selection targets and stable refs survive every candidate representation', () => {
  for (const tree of fixture.trees) {
    for (const task of tree.selectionTasks) {
      for (const format of FORMAT_IDS) {
        const result = validateSelection(format, tree.nodes, task);
        assert.equal(result.pass, true, `${tree.id}/${task.id}/${format}`);
      }
    }
  }

  for (const reuse of fixture.refReuse) {
    const tree = fixture.trees.find((candidate) => candidate.id === reuse.tree);
    assert.ok(tree, `missing reuse tree ${reuse.tree}`);
    for (const format of FORMAT_IDS) {
      const result = compareRefReuse(format, tree.nodes, tree.nodes, reuse.before);
      assert.deepEqual(result, {
        expected: reuse.before.length,
        preserved: reuse.before.length,
        pass: true,
        missingBefore: [],
        missingAfter: [],
      }, `${reuse.id}/${format}`);
    }
  }
});

test('pagination is record-safe, preserves hierarchy depth, and terminates exactly', () => {
  for (const tree of fixture.trees) {
    for (const format of FORMAT_IDS) {
      const pages = assertPagination(format, tree.nodes, tree.continuation.maxChars, {
        filter: tree.continuation.filter,
        maxDepth: tree.continuation.maxDepth,
        maxChars: tree.continuation.maxChars,
      });
      assert.ok(pages.length > 1, `${tree.id}/${format} should exercise pagination`);
      assert.equal(pages[0].page, 1);
      assert.equal(pages.at(-1).hasMore, false);
      assert.equal(pages.at(-1).continuationArgs, null);
      assert.deepEqual(pages.slice(0, -1).map((page) => page.continuationArgs), pages.slice(0, -1).map((_, index) => ({
        filter: tree.continuation.filter,
        maxDepth: tree.continuation.maxDepth,
        maxChars: tree.continuation.maxChars,
        page: index + 2,
      })));
    }
  }
});

test('the existing workflow consumer still parses the current line format', () => {
  const tree = fixture.trees[0];
  const line = serialize('line', tree.nodes);
  const descriptors = parseChromeAccessibilityTreeDescriptors(line);
  const firefoxDescriptors = parseFirefoxAccessibilityTreeDescriptors(line);
  assert.equal(descriptors.length, tree.nodes.length);
  assert.deepEqual(firefoxDescriptors, descriptors);
  assert.deepEqual(descriptors[3], {
    refId: 'ref_170',
    role: 'textbox',
    name: 'Name',
    type: 'text',
    placeholder: 'Product name',
  });
});

test('compact and full JSON remain opt-in and do not accidentally become line-parser input', () => {
  const tree = fixture.trees[0];
  assert.equal(parseChromeAccessibilityTreeDescriptors(serialize('compact-ndjson', tree.nodes)).length, 0);
  assert.equal(parseChromeAccessibilityTreeDescriptors(serialize('full-json', tree.nodes)).length, 0);
});

test('compact parsing fails closed on unknown or incomplete records', () => {
  assert.throws(() => parse('compact-ndjson', '{"d":0,"r":"button","i":"ref_1","unsafe":true}'), /unknown key/);
  assert.throws(() => parse('compact-ndjson', '{"d":0,"r":"button"}'), /missing d\/r\/i/);
});
