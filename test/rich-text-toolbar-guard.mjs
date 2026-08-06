import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RichTextToolbarGuard as ChromeGuard,
  normalizeRichTextToolbarAudit,
  richTextToolbarDecision,
  richTextToolbarDispatchBindingReady,
  richTextToolbarEditorIdentityMatches,
  richTextToolbarPresetMatch,
  richTextToolbarTextShape,
} from '../src/chrome/src/agent/rich-text-toolbar-guard.js';
import { RichTextToolbarGuard as FirefoxGuard } from '../src/firefox/src/agent/rich-text-toolbar-guard.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function editorIdentity(overrides = {}) {
  return {
    tag: 'textarea',
    id: 'editor-body',
    name: 'Body',
    role: 'textbox',
    pageX: 40,
    pageY: 120,
    w: 500,
    h: 240,
    ...overrides,
  };
}

function wrongTarget(overrides = {}) {
  return {
    toolName: 'set_field',
    args: { ref_id: 'ref_12', text: 'Requested prose', clear: true },
    candidate: {
      associatedEditorRef: 'ref_40',
      associatedEditorIdentity: editorIdentity(),
      relatedRefs: ['ref_13'],
      regionRef: 'ref_10',
      regionKey: 'toolbar:10',
    },
    decision: { source: 'structural_fallback', targetKind: 'font_size' },
    identity: {
      documentToken: 'doc-1',
      refScopeUrl: 'https://example.test/editor',
      frameId: 0,
    },
    ...overrides,
  };
}

function editorProbe(overrides = {}) {
  return {
    resolved: true,
    refId: 'ref_40',
    documentToken: 'doc-1',
    refScopeUrl: 'https://example.test/editor',
    frameId: 0,
    rect: { pageX: 40, pageY: 120, w: 500, h: 240 },
    fieldMeta: {
      tag: 'textarea',
      id: 'editor-body',
      name: 'Body',
      role: 'textbox',
      contentEditable: false,
    },
    toolbarContext: false,
    ...overrides,
  };
}

function frameWrongTarget(frameId, documentToken) {
  return wrongTarget({
    toolName: 'iframe_type',
    args: {
      selector: `#font-size-${frameId}`,
      text: `Requested prose for frame ${frameId}`,
      clear: true,
    },
    candidate: {
      ...wrongTarget().candidate,
      associatedEditorRef: `ref_${frameId}0`,
      associatedEditorIdentity: editorIdentity({
        id: `editor-${frameId}`,
        pageY: frameId * 100,
      }),
      relatedRefs: [`ref_${frameId}1`],
      regionRef: `ref_${frameId}2`,
      regionKey: `toolbar:${frameId}`,
    },
    identity: {
      frameId,
      documentToken,
      refScopeUrl: 'https://frame.example.test/editor',
    },
  });
}

console.log('\nrich-text toolbar guard');

await test('Chrome and Firefox ship the byte-identical guard', () => {
  const chrome = fs.readFileSync(path.join(root, 'src/chrome/src/agent/rich-text-toolbar-guard.js'));
  const firefox = fs.readFileSync(path.join(root, 'src/firefox/src/agent/rich-text-toolbar-guard.js'));
  assert.deepEqual(chrome, firefox);
});

await test('normalization and formatting-value decisions stay pure', () => {
  assert.deepEqual(normalizeRichTextToolbarAudit({
    region_kind: 'RICH_TEXT_TOOLBAR',
    target_kind: 'FONT_SIZE',
    confidence: 0.92,
  }), { regionKind: 'rich_text_toolbar', targetKind: 'font_size', confidence: 0.92 });
  assert.equal(normalizeRichTextToolbarAudit({ regionKind: 'toolbar', targetKind: 'font_size', confidence: 1 }), null);
  assert.equal(richTextToolbarPresetMatch(' Heading 1 ', ['Paragraph', 'Heading 1']), true);
  const prose = richTextToolbarTextShape('A complete paragraph for the editor body.');
  const preset = richTextToolbarTextShape('11');
  assert.equal(richTextToolbarDecision({
    score: 8,
    reasons: ['semantic_toolbar', 'numeric_preset_value'],
    attemptedTextShape: prose,
  }, null).wrongTarget, true);
  assert.equal(richTextToolbarDecision({
    score: 8,
    reasons: ['semantic_toolbar', 'numeric_preset_value'],
    attemptedTextShape: preset,
  }, null).wrongTarget, false);
});

await test('dispatch bindings are neutral and match each execution strategy', () => {
  assert.equal(richTextToolbarDispatchBindingReady('click', {}, { token: 'click-token' }), true);
  assert.equal(richTextToolbarDispatchBindingReady('iframe_type', {}, { token: 'frame-token', frameId: 7 }), true);
  assert.equal(richTextToolbarDispatchBindingReady('type_text', { selector: '#editor' }, { backendNodeId: 177 }), true);
  assert.equal(richTextToolbarDispatchBindingReady('type_text', { selector: '#editor' }, {}), false);
  assert.equal(richTextToolbarDispatchBindingReady('press_keys', {}, { backendNodeId: 177 }), false);
});

for (const [label, Guard] of [['chrome', ChromeGuard], ['firefox', FirefoxGuard]]) {
  await test(`${label}: one ledger owns recording, deduplication, and completion state`, () => {
    let now = 100;
    const guard = new Guard({ now: () => now++ });
    const first = guard.recordWrongTarget(7, wrongTarget());
    const duplicate = guard.recordWrongTarget(7, wrongTarget({
      args: { ref_id: 'ref_14', text: 'Requested prose', clear: true },
      candidate: {
        ...wrongTarget().candidate,
        relatedRefs: ['ref_12'],
      },
    }));
    assert.equal(first.obligationCount, 1);
    assert.equal(duplicate.obligationCount, 1);
    assert.deepEqual(new Set(guard.obligations(7)[0].blockedRefs), new Set(['ref_12', 'ref_13', 'ref_14']));
    assert.equal(guard.completionAction(7).targetKind, 'font_size');
    assert.equal(guard.hasPending(7), true);
  });

  await test(`${label}: navigation demotes every obligation without parallel state`, () => {
    const guard = new Guard({ now: () => 200 });
    guard.recordWrongTarget(8, wrongTarget());
    guard.recordWrongTarget(8, wrongTarget({
      args: { ref_id: 'ref_22', text: 'Second edit', clear: true },
      candidate: {
        ...wrongTarget().candidate,
        associatedEditorRef: 'ref_50',
        associatedEditorIdentity: editorIdentity({ pageY: 500 }),
      },
    }));
    const navigated = guard.navigate(8);
    assert.equal(navigated.length, 2);
    assert.ok(navigated.every(obligation => obligation.recoveryOnly === true));
    assert.ok(navigated.every(obligation => obligation.associatedEditorRef === ''));
    assert.ok(navigated.every(obligation => obligation.documentToken === '' && obligation.frameId === null));
    assert.equal(guard.hasPending(8), true);
  });

  await test(`${label}: sibling frame documents keep independent obligations`, () => {
    const guard = new Guard({ now: () => 250 });
    for (const [frameId, documentToken] of [[7, 'frame-doc-a'], [8, 'frame-doc-b']]) {
      guard.recordWrongTarget(8, wrongTarget({
        toolName: 'iframe_type',
        args: { selector: '#font-size', text: 'Shared iframe edit', clear: true },
        identity: {
          frameId,
          documentToken,
          refScopeUrl: 'https://frame.example.test/editor',
        },
      }));
    }
    assert.equal(guard.obligations(8).length, 2);
    assert.deepEqual(new Set(guard.obligations(8).map(obligation => obligation.frameId)), new Set([7, 8]));
  });

  await test(`${label}: a sibling frame reload demotes only that frame obligation`, () => {
    const guard = new Guard({ now: () => 275 });
    guard.recordWrongTarget(8, frameWrongTarget(7, 'frame-doc-a'));
    guard.recordWrongTarget(8, frameWrongTarget(8, 'frame-doc-b'));

    const reloaded = guard.evaluateProbe(8, 'iframe_click', { selector: '#editor-7' }, {
      frameId: 7,
      documentToken: 'frame-doc-a-reloaded',
      refScopeUrl: 'https://frame.example.test/editor',
      toolbarContext: false,
    });
    assert.equal(reloaded.navigated, true);
    assert.equal(reloaded.guarded, false);

    const frameA = guard.obligations(8)
      .find(obligation => obligation.blockedToolbarSelector === '#font-size-7');
    const frameB = guard.obligations(8)
      .find(obligation => obligation.blockedToolbarSelector === '#font-size-8');
    assert.equal(frameA.recoveryOnly, true);
    assert.equal(frameA.frameId, null);
    assert.equal(frameA.documentToken, '');
    assert.equal(frameB.recoveryOnly, false);
    assert.equal(frameB.frameId, 8);
    assert.equal(frameB.documentToken, 'frame-doc-b');
    assert.equal(frameB.associatedEditorRef, 'ref_80');
    assert.deepEqual(frameB.blockedRefs, ['ref_81']);
    assert.equal(frameB.regionRef, 'ref_82');

    const siblingRetry = guard.evaluateProbe(8, 'iframe_click', { selector: '#font-size-8' }, {
      frameId: 8,
      documentToken: 'frame-doc-b',
      refScopeUrl: 'https://frame.example.test/editor',
      toolbarContext: false,
    });
    assert.equal(siblingRetry.block?.wrongTarget, true);
  });

  await test(`${label}: recording a replacement frame document preserves live siblings`, () => {
    const guard = new Guard({ now: () => 280 });
    guard.recordWrongTarget(8, frameWrongTarget(7, 'frame-doc-a'));
    guard.recordWrongTarget(8, frameWrongTarget(8, 'frame-doc-b'));
    guard.recordWrongTarget(8, frameWrongTarget(7, 'frame-doc-a-reloaded'));

    assert.equal(guard.obligations(8).length, 2);
    const frameA = guard.obligations(8).find(obligation => obligation.frameId === 7);
    const frameB = guard.obligations(8).find(obligation => obligation.frameId === 8);
    assert.equal(frameA.documentToken, 'frame-doc-a-reloaded');
    assert.equal(frameA.recoveryOnly, false);
    assert.equal(frameB.documentToken, 'frame-doc-b');
    assert.equal(frameB.recoveryOnly, false);
    assert.equal(frameB.associatedEditorRef, 'ref_80');
    assert.deepEqual(frameB.blockedRefs, ['ref_81']);
    assert.equal(frameB.regionRef, 'ref_82');
  });

  await test(`${label}: a stale direct ref demotes only its own obligation`, () => {
    const guard = new Guard({ now: () => 285 });
    guard.recordWrongTarget(8, wrongTarget({
      args: { ref_id: 'ref_70', text: 'Frame A prose', clear: true },
      identity: { frameId: 7, documentToken: 'frame-doc-a', refScopeUrl: 'https://frame.example.test/editor' },
    }));
    guard.recordWrongTarget(8, wrongTarget({
      args: { ref_id: 'ref_70', text: 'Frame B prose', clear: true },
      candidate: {
        ...wrongTarget().candidate,
        associatedEditorRef: 'ref_90',
        associatedEditorIdentity: editorIdentity({ id: 'editor-8', pageY: 800 }),
        regionRef: 'ref_82',
        regionKey: 'toolbar:8',
      },
      identity: { frameId: 8, documentToken: 'frame-doc-b', refScopeUrl: 'https://frame.example.test/editor' },
    }));

    assert.equal(
      guard.blockRef(8, 'set_field', { ref_id: 'ref_70' }, 'frame-doc-b')?.wrongTarget,
      true,
    );
    const frameA = guard.obligations(8)
      .find(obligation => obligation.blockedAttemptedText === 'Frame A prose');
    const frameB = guard.obligations(8)
      .find(obligation => obligation.blockedAttemptedText === 'Frame B prose');
    assert.equal(frameA.recoveryOnly, true);
    assert.equal(frameB.recoveryOnly, false);
    assert.equal(frameB.frameId, 8);
    assert.equal(frameB.documentToken, 'frame-doc-b');
    assert.equal(frameB.associatedEditorRef, 'ref_90');
  });

  await test(`${label}: persisted recoveryObligations restore into the same ledger`, () => {
    const guard = new Guard({ now: () => 300 });
    guard.recordWrongTarget(9, wrongTarget());
    const persisted = guard.persist(9);
    assert.equal(persisted.recoveryObligations.length, 1);
    const restored = new Guard({ now: () => 400 });
    assert.equal(restored.restore(9, persisted), true);
    assert.deepEqual(restored.persist(9), persisted);
    assert.equal(restored.restore(10, { recoveryObligations: [{ blockedAttemptedText: 12 }] }), false);
  });

  await test(`${label}: retries fail closed for blocked refs, selectors, and toolbar regions`, () => {
    const guard = new Guard();
    guard.recordWrongTarget(10, wrongTarget());
    assert.equal(guard.blockRef(10, 'set_field', { ref_id: 'ref_13' }, 'doc-1')?.wrongTarget, true);
    assert.equal(guard.evaluateProbe(10, 'click', { selector: '#font-size' }, {
      ...editorProbe(),
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
      toolbarRegionKey: 'toolbar:10',
    }).block?.wrongTarget, true);
    assert.equal(guard.evaluateProbe(10, 'click', { selector: '#editor-body' }, editorProbe()).block, null);
  });

  await test(`${label}: top-frame ref collisions do not bind iframe obligations`, () => {
    const guard = new Guard();
    guard.recordWrongTarget(10, wrongTarget({
      toolName: 'iframe_type',
      args: { selector: '#font-size', text: 'Requested prose', clear: true },
      identity: {
        frameId: 7,
        documentToken: 'frame-doc',
        refScopeUrl: 'https://frame.example.test/editor',
      },
    }));
    const evaluation = guard.evaluateProbe(10, 'click', { selector: '#font-size' }, {
      ...editorProbe(),
      documentToken: 'top-doc',
      refScopeUrl: 'https://example.test/editor',
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    assert.equal(evaluation.block, null);
    assert.equal(evaluation.guarded, false);
    assert.equal(guard.hasPending(10), true);
  });

  await test(`${label}: only a positive verified semantic editor edit discharges one obligation`, () => {
    const guard = new Guard();
    guard.recordWrongTarget(11, wrongTarget());
    const base = {
      toolName: 'set_field',
      args: { ref_id: 'ref_40', text: 'Requested prose', clear: true },
      probe: editorProbe(),
    };
    assert.equal(guard.recover(11, { ...base, result: { success: true } }), null);
    assert.equal(guard.recover(11, {
      ...base,
      result: { success: true, verified: true },
      probe: editorProbe({
        refId: 'ref_99',
        fieldMeta: { tag: 'input', contentEditable: false, toolbarCandidate: { score: 8 } },
        toolbarContext: true,
      }),
    }), null);
    const recovered = guard.recover(11, { ...base, result: { success: true, verified: true } });
    assert.equal(recovered.remainingCount, 0);
    assert.equal(guard.hasPending(11), false);
  });

  await test(`${label}: recovery strategy accepts and rejects the complete semantic matrix`, () => {
    const rows = [
      ['associated editor ref', {}, editorProbe(), 'set_field', { ref_id: 'ref_40', text: 'Requested prose', clear: true }, { success: true, verified: true }, true],
      ['different ref despite matching geometry', {}, editorProbe({ refId: 'ref_99' }), 'set_field', { ref_id: 'ref_99', text: 'Requested prose', clear: true }, { success: true, verified: true }, false],
      ['geometry when no ref was captured', { associatedEditorRef: '' }, editorProbe({ refId: 'ref_99' }), 'set_field', { ref_id: 'ref_99', text: 'Requested prose', clear: true }, { success: true, verified: true }, true],
      ['mismatched geometry', { associatedEditorRef: '' }, editorProbe({
        refId: 'ref_99',
        rect: { pageX: 900, pageY: 900, w: 120, h: 40 },
        fieldMeta: { tag: 'textarea', id: 'other-editor', role: 'textbox' },
      }), 'set_field', { ref_id: 'ref_99', text: 'Requested prose', clear: true }, { success: true, verified: true }, false],
      ['different text', {}, editorProbe(), 'set_field', { ref_id: 'ref_40', text: 'Different prose', clear: true }, { success: true, verified: true }, false],
      ['append for a blocked replacement', {}, editorProbe(), 'type_text', { ref_id: 'ref_40', text: 'Requested prose' }, { success: true, verified: true }, false],
      ['replacement through another typing tool', {}, editorProbe(), 'type_text', { ref_id: 'ref_40', text: 'Requested prose', clear: true }, { success: true, verified: true }, true],
      ['unverified edit', {}, editorProbe(), 'set_field', { ref_id: 'ref_40', text: 'Requested prose', clear: true }, { success: true }, false],
      ['failed edit', {}, editorProbe(), 'set_field', { ref_id: 'ref_40', text: 'Requested prose', clear: true }, { success: false, verified: true }, false],
      ['toolbar control', {}, editorProbe({
        refId: 'ref_41',
        fieldMeta: { tag: 'input', contentEditable: false },
        toolbarContext: true,
      }), 'set_field', { ref_id: 'ref_41', text: 'Requested prose', clear: true }, { success: true, verified: true }, false],
      ['ordinary input', {}, editorProbe({
        refId: 'ref_77',
        fieldMeta: { tag: 'input', contentEditable: false },
      }), 'set_field', { ref_id: 'ref_77', text: 'Requested prose', clear: true }, { success: true, verified: true }, false],
      ['different document', {}, editorProbe({
        documentToken: 'doc-2',
        refScopeUrl: 'https://example.test/other',
      }), 'set_field', { ref_id: 'ref_40', text: 'Requested prose', clear: true }, { success: true, verified: true }, false],
      ['non-typing tool', {}, editorProbe(), 'click_ax', { ref_id: 'ref_40', text: 'Requested prose' }, { success: true, verified: true }, false],
    ];

    for (const [rowLabel, candidateOverrides, probe, toolName, args, result, discharges] of rows) {
      const guard = new Guard();
      guard.recordWrongTarget(12, wrongTarget({
        candidate: { ...wrongTarget().candidate, ...candidateOverrides },
      }));
      const recovery = guard.recover(12, { toolName, args, result, probe });
      assert.equal(!!recovery, discharges, rowLabel);
      assert.equal(guard.hasPending(12), !discharges, rowLabel);
    }
  });

  await test(`${label}: a live retry replaces its navigation-demoted copy`, () => {
    const guard = new Guard();
    const candidate = associatedEditorRef => ({
      ...wrongTarget().candidate,
      associatedEditorRef,
      associatedEditorIdentity: editorIdentity({ tag: 'div', role: 'textbox' }),
    });
    guard.recordWrongTarget(13, wrongTarget({
      toolName: 'type_text',
      args: { ref_id: 'ref_12', text: 'Append once' },
      candidate: candidate('ref_40'),
      identity: { documentToken: 'doc-1', refScopeUrl: 'https://example.test/editor', frameId: 0 },
    }));
    guard.navigate(13);
    guard.recordWrongTarget(13, wrongTarget({
      toolName: 'type_text',
      args: { ref_id: 'ref_13', text: 'Append once' },
      candidate: candidate('ref_41'),
      identity: { documentToken: 'doc-2', refScopeUrl: 'https://example.test/editor', frameId: 0 },
    }));
    const obligations = guard.obligations(13);
    assert.equal(obligations.length, 1);
    assert.equal(obligations[0].recoveryOnly, false);
    assert.equal(obligations[0].associatedEditorRef, 'ref_41');
    assert.equal(obligations[0].documentToken, 'doc-2');
  });

  await test(`${label}: a ref-only editor becomes unknown but recoverable after navigation`, () => {
    const guard = new Guard();
    guard.recordWrongTarget(15, wrongTarget({
      candidate: {
        ...wrongTarget().candidate,
        associatedEditorIdentity: { tag: 'div', id: 'editor-body', role: 'textbox' },
      },
    }));
    guard.navigate(15);
    const obligation = guard.obligations(15)[0];
    assert.equal(obligation.associatedEditorRef, '');
    assert.equal(obligation.recoveryTargetUnknown, true);
    const recovery = guard.recover(15, {
      toolName: 'set_field',
      args: { ref_id: 'ref_91', text: 'Requested prose', clear: true },
      result: { success: true, verified: true },
      probe: editorProbe({
        refId: 'ref_91',
        documentToken: 'doc-2',
        fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      }),
    });
    assert.ok(recovery?.verifiedUnknownEditor);
    assert.equal(guard.hasPending(15), false);
  });

  await test(`${label}: duplicate editor ids at different geometry remain separate`, () => {
    const guard = new Guard();
    for (const [refId, editorRef, pageX] of [['ref_12', 'ref_40', 20], ['ref_13', 'ref_41', 520]]) {
      guard.recordWrongTarget(14, wrongTarget({
        args: { ref_id: refId, text: 'Shared editor text', clear: true },
        candidate: {
          ...wrongTarget().candidate,
          associatedEditorRef: editorRef,
          associatedEditorIdentity: editorIdentity({ pageX }),
        },
      }));
    }
    assert.equal(guard.obligations(14).length, 2);
  });

  await test(`${label}: identity recovery requires tag, role, stable attributes, and geometry`, () => {
    const identity = editorIdentity();
    assert.equal(richTextToolbarEditorIdentityMatches(identity, {
      tag: 'textarea', id: 'editor-body', name: 'Body', role: 'textbox',
    }, { pageX: 44, pageY: 124, w: 504, h: 236 }), true);
    assert.equal(richTextToolbarEditorIdentityMatches(identity, {
      tag: 'textarea', id: 'other-editor', name: 'Body', role: 'textbox',
    }, { pageX: 44, pageY: 124, w: 504, h: 236 }), false);
  });
}

console.log(`\n${passed} rich-text toolbar guard tests passed`);
