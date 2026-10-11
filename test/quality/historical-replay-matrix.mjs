import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Build a reviewable inventory from privacy-minimized reports and local
// verification artifacts. This never executes traces or copies user content.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07');
const original = JSON.parse(fs.readFileSync(path.join(out, 'historical-regressions.json'), 'utf8'));
const unit = (...files) => ({ executable: 'node', args: ['--test', ...files] });
const script = (...args) => ({ executable: 'node', args });
const filtered = pattern => ({ executable: 'node', args: ['test/run.js'], env: { WEBBRAIN_TEST_FILTER: pattern } });
const familyReplay = filtered('terminal runtime outbox|cloud bridge|cloud conversation|saved.workflow|workflow.*compile|workflow.*parameter|clarification.*(research|timeout|resume)|bulk.*progress|progress.*(reconcile|verified|placeholder)|response language|language.*follow|plain.*final|silent.*(done|final)');

const plans = {
  'recipient-composer-and-batch-state': {
    commands: [unit('test/message-recipient-whatsapp.mjs', 'test/social-publish-contract.mjs'), script('test/message-recipient-upload.mjs'), script('test/fixtures/run.mjs')],
    evidence: ['whatsapp-guard-after-pull.log', 'fixtures-final.log', 'queued-composer-regressions.log'],
    remaining: ['Authenticated WhatsApp self-chat has one exact current-version QA message and a native read receipt. Other-recipient delivery and active-thread swaps in an authenticated service remain separately unverified.'],
  },
  'telegram-whatsapp-native-chat': {
    commands: [unit('test/native-telegram-recipient.mjs', 'test/native-telegram-chat.mjs', 'test/native-whatsapp-chat.mjs', 'test/native-whatsapp-contact.mjs', 'test/whatsapp-chat-completion.mjs', 'test/whatsapp-chat-restart.mjs', 'test/cdp-worker-restart.mjs', 'test/chat-goal-lifecycle.mjs', 'test/chat-completion.mjs', 'test/chat-recovery-protocol.mjs', 'test/chat-resume-chain.mjs', 'test/chat-resume-completion.mjs', 'test/chat-reply-dedup-race.mjs', 'test/native-chat-execution-ledger.mjs', 'test/context-live-tool-group.mjs', 'test/provider-message-privacy.mjs', 'test/integration-races.mjs'), script('test/quality/native-chat-mv3.mjs'), script('test/quality/whatsapp-contact-matrix.mjs'), script('test/quality/cdp-worker-restart-mv3.mjs')],
    evidence: ['runtime-peer-review-chat.log', 'integration-races-final.log', 'recovery-steering-final.log', 'native-chat-all-five-final.log', 'native-chat-mv3/summary.json', 'native-chat-soak-one-hour/summary.json', 'native-chat-soak-finite-64k-seeded/summary.json', 'native-chat-soak-finite-64k-final/summary.json', 'context-first-request-schemas-green.log', 'whatsapp-durable-source-final.log', 'whatsapp-production-stop-final.log', 'whatsapp-observer-generic-main-final.log', 'whatsapp-contact-mv3-worker-restored-final-pass/evidence.json', 'whatsapp-contact-mv3-stop-pending-final/evidence.json', 'whatsapp-contact-matrix/summary.json', 'cdp-worker-restart-final-green.log', 'cdp-worker-restart-mv3/evidence.json'],
    optionalCommands: [
      { ...script('test/quality/native-chat-soak.mjs'), env: { WEBBRAIN_SOAK_MINUTES: '60' }, scope: 'One real wall-clock hour; owned provider and native application, not authenticated service chat.' },
      { ...script('test/quality/native-chat-soak.mjs'), env: { WEBBRAIN_SOAK_MINUTES: '3', WEBBRAIN_SOAK_CONTEXT_WINDOW: '64000', WEBBRAIN_SOAK_PROMPT_TIER: 'full', WEBBRAIN_SOAK_MAX_OUTPUT_TOKENS: '512', WEBBRAIN_SOAK_SEED_PRIOR_HISTORY: '1' }, scope: 'Actual restoration and compaction of seeded complete prior tool groups; character-estimated finite context, not vendor tokenization.' },
    ],
    live: ['native-chat-generated-replies'],
    remaining: ['One authenticated current-version WhatsApp self-chat message is independently verified; authenticated general-contact delivery, Telegram and prolonged external-service conversations remain unverified.', 'The earlier-source real wall-clock installed-MV3 hour verifies 59 replies exactly once, alarms, two worker restarts and Stop/Continue in an isolated Telegram-shaped application; it does not establish the later WhatsApp implementation or unattended external service use.', 'Separate seeded 64K full-tier three-minute runs verify four compactions before, and five after, exact first-request schema accounting; 32K Full and near-window Mid request estimates remain a configuration limitation, not vendor-tokenizer rejection evidence.', 'Native one-to-one WhatsApp contact binding and same-document worker recovery have owned installed proofs. Stop, new tasks even with identical wording, provider changes and document/baseline loss remain conservative pending boundaries. WhatsApp groups, attachment-only authored messages and Telegram topics/saved-dialog views are outside the proved contract.'],
  },
  'telegram-whatsapp-thread-classification': {
    commands: [unit('test/native-telegram-chat.mjs', 'test/native-whatsapp-chat.mjs', 'test/native-whatsapp-contact.mjs'), filtered('Telegram.*route|communication.*thread|recommend.*chat')],
    evidence: ['runtime-peer-review-chat.log', 'whatsapp-durable-source-final.log', 'whatsapp-production-stop-final.log'],
    remaining: ['Actual linked WhatsApp chat-list/self-conversation transitions were observed. Other authenticated thread types and Telegram login transitions remain unverified.'],
  },
  'trusted-model-identity': {
    commands: [unit('test/runtime-model-identity.mjs')],
    evidence: ['calculator-runtime-regressions.log'],
    live: ['followup-language-and-model-identity'],
    remaining: ['Live same-conversation provider switching and trusted route identity passed; every supported provider and assistive-model combination is not verified.'],
  },
  'active-run-steering': {
    commands: [unit('test/chat-steering.mjs', 'test/chat-steering-ui.mjs', 'test/text-write-cancellation.mjs', 'test/agent-lifecycle.mjs')],
    evidence: ['runtime-regressions-final.log', 'recovery-steering-final.log'],
    live: ['mid-run-steering', 'stop-during-model-request'],
    remaining: ['Multiple live corrections during native typing, completion verification, and worker reload are not all exercised by the owned live scenario.'],
  },
  'passive-page-feedback-starvation': {
    commands: [unit('test/page-monitor-ui.mjs', 'test/page-monitor-passive-progress.mjs', 'test/page-feedback-progress.mjs', 'test/page-feedback-policy.mjs', 'test/page-feedback-transport-races.mjs', 'test/page-feedback-recovery.mjs'), script('test/quality/integration-mv3.mjs', '--full-form')],
    evidence: ['page-monitor-sampling-final.log', 'integration-mv3-sampling-final.log'],
    live: ['form-passive-updates'],
    remaining: ['Unrelated animations, live inbox notifications, and image download churn across external websites still require service-level checks.'],
  },
  'terminal-handoff-and-plain-final': {
    commands: [unit('test/agent-lifecycle.mjs', 'test/cloud-run-outcomes.mjs', 'test/chat-recovery-protocol.mjs'), filtered('plain.*final|terminal.*delivery|planner.only|silent.*final')],
    evidence: ['historical-family-replays.log', 'integration-mv3-sampling-final.log', 'recovery-steering-final.log', 'native-chat-all-five-final.log', 'native-chat-mv3/summary.json', 'native-chat-soak-one-hour/summary.json'],
    live: ['form-passive-updates', 'stop-during-model-request'],
    remaining: ['The owned run verifies a successful final and prompt stop; exhaustive non-cooperative live-provider finals are not established.'],
  },
  'completion-evidence': {
    commands: [unit('test/completion-verifier.mjs', 'test/completion-document.mjs', 'test/completion-submit-acknowledgement.mjs', 'test/runtime-task-authority.mjs', 'test/mastodon-publication.mjs', 'test/completion-iframe-submit.mjs', 'test/completion-semantic-commit.mjs', 'test/native-confirmation-visibility.mjs'), script('test/quality/integration-mv3.mjs', '--full-form'), script('test/quality/mastodon-publication-mv3.mjs'), script('test/quality/mastodon-deletion-mv3.mjs'), script('test/quality/mastodon-deletion-navigation-mv3.mjs'), script('test/quality/semantic-navigation-matrix.mjs'), script('test/quality/literal-frame-mv3.mjs')],
    evidence: ['historical-independent-family-replays.log', 'authority-completion-root-final.log', 'integration-mv3-sampling-final.log', 'mastodon-publication-tests.log', 'mastodon-publication-mv3-final.log', 'mastodon-publication-mv3-profile.log', 'completion-iframe-submit-green.log', 'completion-iframe-mv3-green.log', 'literal-frame-empty-caret-final/summary.json', 'native-confirmation-visibility-green.log', 'native-confirmation-existing-completion-green.log', 'native-confirmation-deletion-mv3-green.log', 'live-mastoturk-native-navigation-final/summary.json', 'semantic-navigation-neighbors.log', 'semantic-navigation-mv3-after.log', 'semantic-navigation-mv3-uncertain.log', 'semantic-navigation-mv3-document.log', 'semantic-native-navigation-peer-final.log', 'semantic-navigation-matrix/delayed/evidence.json', 'semantic-navigation-matrix/same-url/evidence.json', 'semantic-navigation-matrix/before-capture/evidence.json'],
    live: ['form-passive-updates', 'mastoturk-demo-publication'],
    remaining: ['The latest authenticated authorized Mastoturk QA post and its native cleanup both reach successful done/completed after same-origin verification navigation; no general authenticated chat coverage is implied.', 'External document saved-state verification, every decision model, strict-secret completion, and changed evidence during a real judge request are only partially exercised.'],
  },
  'bounded-bulk-progress': {
    commands: [unit('test/collection-read-progress.mjs', 'test/runtime-progress-continuation.mjs'), filtered('bulk.*progress|progress.*(reconcile|verified|placeholder)'), script('test/quality/bulk-resume-mv3.mjs')],
    evidence: ['historical-family-replays.log', 'runtime-regressions-final.log', 'runtime-progress-continuation-green.log', 'peer-continuation-after.log'],
    remaining: ['An installed-MV3 twenty-row owned side-effect fixture verifies Stop, app-owned Continue, one blocked row retry, real HTTP429 cooldown and exactly-once receipts. Equivalent authenticated service behavior remains unverified.'],
  },
  'clarification-routing-and-resume': {
    commands: [unit('test/cloud-run-outcomes.mjs', 'test/integration-races.mjs'), filtered('clarif.*(research|timeout|resume|ordinary|consent)')],
    evidence: ['historical-independent-family-replays.log', 'integration-races-final.log', 'historical-family-replays.log'],
    remaining: ['Actual clarification UI with research disabled, late harmless answer, and consequential consent timeout needs an end-to-end provider/UI run.'],
  },
  'click-target-stale-ref-and-overlay': {
    commands: [script('test/fixtures/run.mjs'), unit('test/page-monitor-ui.mjs', 'test/page-monitor-passive-progress.mjs', 'test/pdf-detection.mjs'), script('test/browser-dialogs-e2e.mjs'), script('test/quality/pdf-detection-mv3.mjs')],
    evidence: ['fixtures-final.log', 'page-monitor-sampling-final.log', 'browser-dialogs-real.log', 'pdf-detection-final.log', 'pdf-detection-mv3.log', 'mastoturk-click-diagnosis-after.log'],
    live: ['mastoturk-signup-and-email'],
    remaining: ['Controlled real-browser fixtures cover ambiguity, overlays and stale dispatch; arbitrary external modal/navigation variants are not exhaustively tested.'],
  },
  'rich-editor-literal-write': {
    commands: [script('test/ui-content-lifecycle.mjs', '--dom'), unit('test/text-write-cancellation.mjs', 'test/contenteditable-literal.mjs', 'test/native-chat-empty-editor.mjs'), script('test/rich-text-toolbar-guard.mjs'), script('test/quality/literal-frame-mv3.mjs')],
    evidence: ['historical-rich-editor-dom.log', 'new-regressions-combined.log', 'literal-frame-empty-caret-final-console.log', 'literal-frame-empty-caret-final/summary.json'],
    remaining: ['Installed-MV3 rich editors preserve exact Unicode and authored blank lines through real application input, one POST and preview; the require-trusted-types-for script / trusted-types none case also passes.', 'Plaintext-only multiline editors, Monaco/CodeMirror documents and writes in each externally hosted application remain unverified.'],
  },
  'iframe-shadow-canvas': {
    commands: [script('test/fixtures/run.mjs'), unit('test/firefox-bidi.mjs', 'test/page-feedback-transport-races.mjs', 'test/iframe-preparation-focus.mjs', 'test/completion-iframe-submit.mjs'), script('test/firefox-bidi-e2e.mjs'), script('test/quality/literal-frame-mv3.mjs')],
    evidence: ['fixtures-final.log', 'page-monitor-sampling-final.log', 'webmcp-real.log', 'completion-iframe-submit-green.log', 'literal-frame-empty-caret-final/summary.json'],
    remaining: ['The installed-MV3 three-origin nested iframe write saves exact authored bytes once and completes from fresh frame-bound evidence; arbitrary cross-origin sandbox policies and canvas-only semantic controls remain unverified.', 'The isolated Chromium extension flow does not establish an actual Firefox BiDi service connection.'],
  },
  'complete-thread-source-coverage': {
    commands: [unit('test/read-continuation-schema.mjs', 'test/read-continuation-browser.mjs', 'test/collection-read-progress.mjs'), script('test/selection-scope-restoration.mjs'), script('test/fixtures/run.mjs')],
    evidence: ['read-continuation-schema-final.log', 'read-continuation-browser.log', 'historical-independent-family-replays.log', 'fixtures-final.log'],
    remaining: ['Actual collapsed authenticated mail/chat threads and rapidly changing full-thread history remain unverified.'],
  },
  'downloads-pdf-and-attachments': {
    commands: [script('test/pdf-read.mjs'), script('test/pdf-selection.mjs'), script('test/pdf-mime-handler-e2e.mjs'), unit('test/pdf-detection.mjs'), script('test/quality/pdf-detection-mv3.mjs'), script('test/quality/download-upload-mv3.mjs'), script('test/attachment-drop.mjs'), unit('test/media-download-binding.mjs', 'test/media-download-capture-integration.mjs'), script('test/message-recipient-upload.mjs')],
    evidence: ['baseline-stage-23.log', 'baseline-stage-24.log', 'baseline-stage-28.log', 'fixtures-final.log', 'pdf-detection-final.log', 'pdf-detection-native-e2e.log', 'pdf-detection-mv3.log', 'download-upload-mv3.log'],
    remaining: ['Controlled real-Chrome PDF extraction and native extensionless routing pass; installed-MV3 PNG/PDF downloads are hash-checked against actual file bytes and uploaded once to the owned receiver.', 'Arbitrary external image/file permission recovery and authenticated attachment delivery remain unverified.'],
  },
  'provider-retry-and-budget': {
    commands: [unit('test/model-retry.mjs', 'test/network-lifecycle.mjs', 'test/compass-quota.mjs', 'test/completion-verifier.mjs', 'test/context-live-tool-group.mjs', 'test/provider-message-privacy.mjs'), script('test/provider-model-limits.mjs'), script('test/quality/bulk-resume-mv3.mjs')],
    evidence: ['historical-independent-family-replays.log', 'calculator-mode-regressions.log', 'native-chat-soak-finite-64k-seeded/summary.json', 'native-chat-soak-finite-64k-final/summary.json', 'context-first-request-schemas-green.log', 'context-first-request-main-green2.log', 'coverage-final-40-0-8.log'],
    remaining: ['An owned installed-MV3 HTTP429 after a browser side effect preserves exactly-once receipts; equivalent remote vendor outage/quota responses and every supported provider remain unverified.', 'The seeded 64K full-tier case fits its conservative measured request plus 512 output reserve after real compaction. Small default-tier windows can still be too small for fixed prompts and tools; no vendor-tokenizer compatibility or implicit capability downgrade is claimed.'],
  },
  'cloud-continuation-and-isolation': {
    commands: [unit('test/cloud-bridge-approval.mjs', 'test/cloud-conversation-isolation.mjs', 'test/cloud-run-outcomes.mjs', 'test/integration-races.mjs', 'test/runtime-peer-review.mjs'), familyReplay],
    evidence: ['cloud-bridge-envelope-after.log', 'historical-family-replays.log', 'runtime-peer-review-unit.log', 'peer-continuation-after.log'],
    remaining: ['A real authenticated cloud session across worker restart and at least one hour of scheduled chat remains unverified.'],
  },
  'trace-export-and-research-attribution': {
    commands: [unit('test/trace-full-export.mjs', 'test/feedback-traces.mjs'), filtered('terminal runtime outbox|Cloud.*terminal|trace.*export|research.*attribution')],
    evidence: ['historical-family-replays.log'],
    remaining: ['Acquisition of both recent trace dumps succeeded, but a fresh product-to-backend full export and consented research attribution upload are not verified.'],
  },
  'language-output-integrity-and-grounding': {
    commands: [unit('test/markdown-render.mjs', 'test/calculator.mjs'), script('test/selection-scope-restoration.mjs'), script('test/security/injection-corpus.mjs')],
    evidence: ['historical-independent-family-replays.log', 'calculator-unit.log'],
    live: ['table-reading'],
    remaining: ['Turkish/English/Chinese live follow-ups passed; arbitrary large structured output completeness remains unverified.', 'Model arithmetic remains variable when it ignores the deterministic tool or uses incorrect source operands; retain the original failing provider artifact.'],
  },
  'unsupported-claims-and-capability': {
    commands: [filtered('Chrome Web Store gallery|capability.*unavailable|unsupported.*surface|count.*scope'), unit('test/calculator.mjs', 'test/runtime-model-identity.mjs'), script('test/security/injection-corpus.mjs')],
    evidence: ['historical-read-recovery-replays.log', 'calculator-mode-regressions.log', 'calculator-unit.log'],
    live: ['table-reading'],
    remaining: ['Live filtered-inbox counts, research eligibility judgements and unavailable desktop/privileged operations remain only partially verified.'],
  },
};

function logEvidence(file) {
  const target = path.join(out, file);
  if (!fs.existsSync(target)) return { file, available: false };
  const text = fs.readFileSync(target, 'utf8');
  let structured = null;
  if (file.endsWith('.json')) {
    try { structured = JSON.parse(text); } catch {}
  }
  const structuredCases = Array.isArray(structured?.results) ? structured.results : [];
  const runtimeDone = structured?.result?.updates?.filter(event => event.type === 'tool_result' && event.data?.name === 'done').at(-1)?.data?.result;
  const structuredCounts = structuredCases.length ? {
    passed: structuredCases.filter(result => result.passed === true).length,
    failed: structuredCases.filter(result => result.passed === false).length,
  } : null;
  const node = text.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
  const custom = [...text.matchAll(/(\d+) passed, (\d+) failed \((\d+) total\)/g)].at(-1);
  const dom = text.match(/(\d+) UI\/content lifecycle checks passed/);
  const coverage = Object.fromEntries([...text.matchAll(/^(Statements|Branches|Functions|Lines)\s*:\s*([\d.]+)%\s*\(\s*(\d+)\/(\d+)\s*\)/gm)]
    .map(([, metric, percent, covered, total]) => [metric.toLowerCase(), { percent: Number(percent), covered: Number(covered), total: Number(total) }]));
  const passed = structuredCounts?.passed ?? (node ? Number(node[1]) : custom ? Number(custom[1]) : dom ? Number(dom[1]) : null);
  const failed = structuredCounts?.failed ?? (node ? Number(node[2]) : custom ? Number(custom[2]) : dom ? 0 : null);
  return { file, available: true, modifiedAt: fs.statSync(target).mtime.toISOString(),
    passed, failed, ownedMv3Passed: structured ? structured.passed === true : text.includes('"passed":true'),
    ...(Object.keys(coverage).length ? { coverageSnapshot: coverage,
      coverageCaveat: 'Coverage belongs to the referenced completed run; a later generated source digest does not retroactively cover intervening source changes.' } : {}),
    ...(structured ? { observedStructuredEvidence: {
      declaredPassed: typeof structured.passed === 'boolean' ? structured.passed : null, elapsedMs: structured.elapsedMs ?? null,
      observedDone: runtimeDone?.done ?? null, observedDoneOutcome: runtimeDone?.outcome ?? null,
      nativeDeletionCount: Array.isArray(structured.deletes) ? structured.deletes.length : null,
      independentJudgeCalls: structured.judgeCalls ?? null,
      questions: structured.questions ?? null, repliesExactlyOnce: structured.repliesExactlyOnce ?? null,
      scheduledWaits: structured.scheduleCalls ?? null,
      genuineWorkerRestarts: structured.workerRestarts?.filter(restart => restart.passed === true && restart.actualStopped === true && restart.freshWorkerGlobal === true).length ?? null,
      stopBoundaryPassed: structured.stopBoundary ? structured.stopBoundary.passed === true : null,
      contextWindow: structured.contextWindow ?? null, requestedOutputTokens: structured.maxOutputTokens ?? null,
      actualHistoryCompactions: structured.contextCompactions?.length ?? null,
      estimatedMaximumPromptTokens: structured.maxMeasuredPromptTokens ?? null,
      authenticatedServiceTested: structured.authenticatedServiceTested === true,
      externalMessages: structured.externalMessages ?? null,
      cases: structuredCases.map(result => ({ case: result.path || result.kind || null, passed: result.passed === true,
        replies: result.replies ?? null, saves: result.saves ?? null, origins: result.origins ?? null,
        externalMessages: result.externalMessages ?? null })),
    } } : {}),
    baselineOnly: file.startsWith('baseline-stage-'),
    interpretation: passed === null && failed === null ? 'Inspect the referenced executable result; no test count inferred.'
      : structuredCounts ? 'Counts are the explicit cases in the referenced owned summary.'
        : 'Counts identify one reported test summary in this log; a multi-command log may contain other suites and is not assigned a summed total here.' };
}
function liveEvidence(names) {
  if (!names?.length) return [];
  const evidence = [];
  for (const folder of fs.readdirSync(out).filter(folder => folder.startsWith('live-'))) {
    const file = path.join(out, folder, 'summary.json');
    if (!fs.existsSync(file)) continue;
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [index, result] of (summary.results || []).entries()) {
      if (!names.includes(result.name)) continue;
      const artifact = path.join(folder, `quality-${index + 1}.json`);
      const target = path.join(out, artifact);
      const artifactContent = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
      // Public UI events intentionally summarize tool results. Prefer the real
      // background tool return for its successful done contract when present.
      const events = [...(artifactContent.events || []), ...(artifactContent.result?.updates || [])];
      const status = events.filter(event => event.type === 'run_complete').at(-1)?.data?.status || null;
      const successfulDone = events.some(event => event.type === 'tool_result'
        && event.data?.name === 'done' && event.data?.result?.outcome === 'success');
      const calculateCalls = events.filter(event => event.type === 'tool_call' && event.data?.name === 'calculate').length;
      evidence.push({ case: result.name, summary: path.join(folder, 'summary.json').replaceAll('\\', '/'),
        artifact: fs.existsSync(target) ? artifact.replaceAll('\\', '/') : null,
        harnessPassed: result.passed === true, elapsedMs: result.elapsedMs,
        observedRuntimeStatus: status, observedSuccessfulDone: successfulDone, observedCalculateCalls: calculateCalls,
        interpretation: result.passed === false && status === 'completed' && successfulDone
          ? 'Successful runtime evidence exists; the harness assertion failed. Preserve both and rerun the corrected harness.'
          : result.passed === true ? 'Live-provider case passed; any specifically authenticated service flow is recorded separately under authenticatedServiceScopesVerified.'
            : 'Unresolved live case or harness failure; this is not counted as a passing practical replay.' });
    }
  }
  return evidence;
}
function authenticatedMastoturkEvidence() {
  const folder = 'live-mastoturk-native-navigation-final';
  const summaryFile = `${folder}/summary.json`, ledgerFile = 'external-activity-current.json';
  const summary = JSON.parse(fs.readFileSync(path.join(out, summaryFile), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(out, ledgerFile), 'utf8'));
  const result = summary.results.find(result => result.name === 'mastoturk-demo-publication');
  const operations = ['publication', 'cleanup'].map((operation, index) => {
    const file = `${folder}/quality-${index + 1}.json`;
    const artifact = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
    const events = [...(artifact.events || []), ...(artifact.result?.updates || [])];
    const completed = events.filter(event => event.type === 'run_complete').at(-1)?.data?.status === 'completed';
    const successfulDone = events.some(event => event.type === 'tool_result' && event.data?.name === 'done'
      && event.data?.result?.done === true && event.data.result.outcome === 'success');
    assert.equal(completed && successfulDone, true, `Authenticated owned ${operation} did not complete.`);
    return { operation, file, completed, successfulDone };
  });
  assert.equal(result?.passed, true); assert.equal(result.evidence.postAttempts, 1); assert.equal(result.evidence.deleteAttempts, 1);
  assert.equal(ledger.allKnownPosts404, true); assert.equal(ledger.activePostCount, 0); assert.equal(ledger.externalDirectMessagesRecorded, 0);
  return { service: 'mastoturk', scope: 'One explicitly authorized QA public post and its exact native deletion; every known audit post independently verified absent.',
    summary: summaryFile, elapsedMs: result.elapsedMs, operations, activityLedger: ledgerFile,
    activityVerifiedAt: ledger.verifiedAt, distinctCreatedPosts: ledger.distinctCreatedPostCount,
    allKnownPosts404: ledger.allKnownPosts404, activePosts: ledger.activePostCount,
    externalDirectMessagesRecorded: ledger.externalDirectMessagesRecorded,
    interpretation: 'This authenticated native flow does not establish authenticated Telegram/WhatsApp, arbitrary posts, or all external completion surfaces.' };
}
const authenticatedMastoturk = authenticatedMastoturkEvidence();
function authenticatedWhatsappSelfEvidence() {
  const proofFile = 'auth-whatsapp-40-0-8-self-native-proof.json';
  const summaryFile = 'auth-whatsapp-40-0-8-self-summary.json';
  const proof = JSON.parse(fs.readFileSync(path.join(out, proofFile), 'utf8'));
  const summary = JSON.parse(fs.readFileSync(path.join(out, summaryFile), 'utf8'));
  assert.equal(summary.exportVersion, '40.0.8');
  assert.equal(summary.run.status, 'done');
  assert.equal(proof.self && proof.observerSuccess && proof.nativeQaVerifiedOutgoing && proof.composerEmpty, true);
  assert.equal(proof.nativeQaEvents, 1);
  assert.equal(proof.bodies.length, 1);
  assert.equal(proof.bodies[0].exact && proof.bodies[0].read, true);
  assert.equal(proof.bodies[0].sha256, summary.expectedQaBody.sha256Utf8);
  return { service: 'whatsapp', scope: 'One authenticated current-version owned self-chat QA message, exact Unicode bytes and native read receipt.',
    proof: proofFile, summary: summaryFile, messageCount: 1, nativeRead: true,
    interpretation: 'The first write reported an error; later sending and terminal completion succeeded. Separate send-nothing retakes exposed editor cancellation/feedback bugs. This receipt does not certify those fixes, general-contact chat or external-service endurance.' };
}
const authenticatedWhatsappSelf = authenticatedWhatsappSelfEvidence();
function nativeWhatsappMatrixEvidence() {
  const artifact = 'whatsapp-contact-matrix/summary.json', filename = path.join(out, artifact);
  const scenarios = ['positive', 'bootstrap_native', 'postwrite_debt', 'stop', 'stop_pending', 'steering', 'peer_switch', 'virtual_floor',
    'restart_pending', 'restart_same_prompt', 'worker_resume', 'document_resume', 'late_drawer', 'native_scroll_latest', 'native_prepared_repair'];
  const base = { feature: 'native-whatsapp-contact', artifact,
    command: script('test/quality/whatsapp-contact-matrix.mjs'), plannedCases: scenarios,
    interpretation: 'Owned intercepted one-to-one native application and local provider; no authenticated contact or WhatsApp endurance claim.',
    priorSourceEvidence: { artifact: 'whatsapp-contact-matrix-final-source/summary.json', cases: 12,
      interpretation: 'Archived source before the authenticated native-header bootstrap correction; it does not establish the added bootstrap_native case.' },
    priorBootstrapSourceEvidence: { artifact: 'whatsapp-contact-matrix-bootstrap-final-source/summary.json', cases: 13,
      interpretation: 'Archived source before native drawer presentation-change handling and explicit current-transcript scroll repair; it does not establish native_scroll_latest.' },
    priorLatestSourceEvidence: { artifact: 'whatsapp-contact-matrix-drawer-latest-final-source/summary.json', cases: 14,
      interpretation: 'Archived source before automatic pre-inference certification of exact private native read-repair targets; it does not establish native_prepared_repair.' } };
  if (!fs.existsSync(filename)) return { ...base, passed: false, status: 'not-yet-verified',
    reason: 'The complete final fifteen-case installed summary has not been generated. Earlier twelve-, thirteen- and fourteen-case source snapshots and individual worker/Stop proofs remain separately listed.' };
  const evidence = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(evidence.passed, true, 'Final native WhatsApp matrix must pass.');
  assert.equal(evidence.sourceStable, true, 'Native WhatsApp matrix must retain its exact source snapshot.');
  assert.equal(evidence.installedMV3, true); assert.equal(evidence.externalMessages, 0);
  assert.deepEqual(evidence.accountsCreated, []); assert.equal(evidence.cases.length, scenarios.length);
  assert.deepEqual([...evidence.plannedCases].sort(), [...scenarios].sort());
  for (const scenario of scenarios) {
    const result = evidence.cases.find(item => item.scenario === scenario);
    assert.equal(result?.passed, true, `Missing final native WhatsApp case ${scenario}.`);
    if (['positive','bootstrap_native','postwrite_debt','worker_resume','late_drawer','native_scroll_latest','native_prepared_repair'].includes(scenario)) {
      assert.equal(result.replies, 1); assert.equal(result.successfulDone, true); assert.equal(result.durablePending, false);
    } else {
      assert.equal(result.successfulDone, false, `${scenario} cannot claim successful delivery/completion.`);
      if (['stop_pending','virtual_floor','restart_pending','restart_same_prompt','document_resume'].includes(scenario)) {
        assert.equal(result.replies, 1); assert.equal(result.durablePending, true);
      } else assert.equal(result.replies, 0);
    }
    if (['worker_resume','restart_pending','restart_same_prompt','document_resume'].includes(scenario)) assert.equal(result.workerRestart, true);
    if (scenario === 'document_resume') assert.equal(result.documentReplaced, true);
  }
  return { ...base, passed: true, status: 'verified-owned-installed-matrix', sourceStable: true,
    elapsedMs: evidence.elapsedMs, cases: evidence.cases.map(item => ({ scenario:item.scenario, passed:item.passed,
      replies:item.replies, successfulDone:item.successfulDone, durablePending:item.durablePending,
      workerRestart:item.workerRestart, documentReplaced:item.documentReplaced })) };
}
function ownedDebuggerEvidence() {
  const artifact = 'cdp-worker-restart-mv3/evidence.json';
  const evidence = JSON.parse(fs.readFileSync(path.join(out, artifact), 'utf8'));
  assert.equal(evidence.passed, true); assert.equal(evidence.installedMV3, true);
  assert.equal(evidence.externalMessages, 0); assert.equal(evidence.ownWorkerRecovery.emptyBefore, true);
  assert.equal(evidence.ownWorkerRecovery.adopted, true); assert.equal(evidence.ownWorkerRecovery.nativeCommandSucceeded, true);
  assert.equal(evidence.foreignOnlyProbe.accepted, false); assert.equal(evidence.foreignStillAttached, true);
  return { feature:'worker-owned-debugger', artifact, command:script('test/quality/cdp-worker-restart-mv3.mjs'),
    passed:true, elapsedMs:evidence.elapsedMs, foreignDebuggerPreserved:true,
    interpretation:'Actual native worker reboot and separate extension namespaces. A harmless native protocol read proves ownership; no foreign debugger is detached.' };
}
function additionalPracticalEvidence() {
  const workflowFile = 'workflow-replay-mv3-final/evidence.json';
  const mediaFile = 'generative-media-mv3-source-ready/evidence.json';
  const watchFile = 'watch-mv3-terminal-final/evidence.json';
  const workflow = JSON.parse(fs.readFileSync(path.join(out, workflowFile), 'utf8'));
  const media = JSON.parse(fs.readFileSync(path.join(out, mediaFile), 'utf8')).summary;
  const watch = JSON.parse(fs.readFileSync(path.join(out, watchFile), 'utf8')).metrics;
  assert.equal(workflow.passed, true);
  assert.ok(workflow.cases.length >= 4 && workflow.cases.every(item => item.passed));
  assert.equal(workflow.privateConfigExported || workflow.runtimeValuesPersisted, false);
  assert.equal(media.passed, true);
  assert.equal(media.cases.length, 3);
  assert.ok(media.cases.every(item => item.passed));
  assert.equal(media.externalRequests.length, 0);
  assert.equal(watch.passed && watch.installedMV3, true);
  assert.ok(watch.elapsedMs >= 150000);
  assert.equal(watch.externalMessages, 0);
  assert.deepEqual(watch.accountsCreated, []);
  return [
    { feature: 'saved-workflow', artifact: workflowFile, command: script('test/quality/workflow-replay-mv3.mjs'),
      passed: true, cases: workflow.cases.map(item => item.name), elapsedMs: workflow.durationMs },
    { feature: 'generative-media', artifact: mediaFile, command: script('test/quality/generative-media-mv3.mjs'),
      passed: true, cases: media.cases.map(item => item.name), interpretation: 'Owned loopback provider and actual installed browser/download/storage; no paid generation or GPU.' },
    { feature: 'watch', artifact: watchFile, command: script('test/quality/watch-mv3.mjs'),
      passed: true, elapsedMs: watch.elapsedMs, intervalSeconds: watch.realIntervalSeconds,
      interpretation: 'Actual native alarms, background restart and owned application; no external messages or accounts.' },
  ];
}
const additionalPracticalChecks = additionalPracticalEvidence();
const nativeWhatsappMatrix = nativeWhatsappMatrixEvidence();
additionalPracticalChecks.push(nativeWhatsappMatrix, ownedDebuggerEvidence());
if (!nativeWhatsappMatrix.passed) plans['telegram-whatsapp-native-chat'].remaining.push(nativeWhatsappMatrix.reason);
for (const scenario of ['delayed', 'same-url', 'before-capture']) {
  const artifact = JSON.parse(fs.readFileSync(path.join(out, `semantic-navigation-matrix/${scenario}/evidence.json`), 'utf8'));
  const done = artifact.result.updates.filter(event => event.type === 'tool_result' && event.data?.name === 'done').at(-1)?.data?.result;
  assert.equal(artifact.deletes.length, 1); assert.equal(done?.done, true);
  if (scenario === 'before-capture') {
    assert.equal(done.outcome, 'partial'); assert.equal(artifact.judgeCalls, 0);
    assert.equal(artifact.diagnostic.submit.semanticCommit.invalidated, true);
    assert.equal(artifact.diagnostic.submit.semanticCommit.verificationNavigation, undefined);
  } else {
    assert.equal(done.outcome, 'success'); assert.ok(artifact.judgeCalls > 0);
    assert.ok(artifact.diagnostic.submit.semanticCommit.verificationNavigation);
    assert.equal(done.verification.completionWarning, null);
  }
}
assert.equal(original.candidates.length, 20);
const requiredOwnedSummaries = Object.fromEntries([
  'native-chat-mv3/summary.json', 'native-chat-soak-one-hour/summary.json',
  'native-chat-soak-finite-64k-seeded/summary.json', 'literal-frame-empty-caret-final/summary.json',
  'native-chat-soak-finite-64k-final/summary.json',
].map(file => [file, JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'))]));
const hour = requiredOwnedSummaries['native-chat-soak-one-hour/summary.json'];
assert.equal(hour.passed, true); assert.ok(hour.elapsedMs >= 60 * 60 * 1000);
assert.equal(hour.questions, hour.repliesExactlyOnce); assert.ok(hour.questions > 0);
assert.equal(hour.workerRestarts.filter(restart => restart.actualStopped && restart.freshWorkerGlobal && restart.passed).length, 2);
assert.equal(hour.stopBoundary.passed, true); assert.equal(hour.externalMessages, 0);
const finite = requiredOwnedSummaries['native-chat-soak-finite-64k-seeded/summary.json'];
assert.equal(finite.passed, true); assert.equal(finite.questions, finite.repliesExactlyOnce);
assert.ok(finite.contextCompactions.length > 0); assert.equal(finite.priorHistorySeed.genuineTaskAndIdPreserved, true);
assert.ok(finite.maxMeasuredPromptTokens + finite.maxOutputTokens <= finite.contextWindow);
const latestFinite = requiredOwnedSummaries['native-chat-soak-finite-64k-final/summary.json'];
assert.equal(latestFinite.passed, true); assert.equal(latestFinite.questions, latestFinite.repliesExactlyOnce);
assert.ok(latestFinite.contextCompactions.length > 0); assert.equal(latestFinite.priorHistorySeed.genuineTaskAndIdPreserved, true);
assert.equal(latestFinite.workerRestarts.filter(restart => restart.actualStopped && restart.freshWorkerGlobal && restart.passed).length, 2);
assert.equal(latestFinite.stopBoundary.passed, true); assert.equal(latestFinite.externalMessages, 0);
assert.ok(latestFinite.maxMeasuredPromptTokens + latestFinite.maxOutputTokens <= latestFinite.contextWindow);
const installedChat = requiredOwnedSummaries['native-chat-mv3/summary.json'];
assert.equal(installedChat.passed, true);
for (const caseName of ['structured', 'generic', 'generic_submit', 'structured_prefill', 'same_body_race']) {
  const result = installedChat.results.find(result => result.path === caseName);
  assert.equal(result?.passed, true, `Missing successful installed chat path ${caseName}`);
  assert.equal(result.externalMessages, 0);
}
const literal = requiredOwnedSummaries['literal-frame-empty-caret-final/summary.json'];
assert.equal(literal.passed, true);
for (const kind of ['rich', 'rich-trusted-types', 'frame']) {
  const result = literal.results.find(result => result.kind === kind);
  assert.equal(result?.passed, true); assert.equal(result.saves, 1);
  assert.equal(result.externalMessages, 0); if (kind === 'frame') assert.equal(result.origins, 3);
}
const families = original.candidates.map(candidate => {
  const plan = plans[candidate.id];
  assert.ok(plan, `Missing replay mapping for ${candidate.id}`);
  return { family: candidate.id, priority: candidate.priority, originalReportReferences: candidate.reportEvidence,
    originalStatus: candidate.status, sourceSummary: candidate.summary,
    executableRegressions: plan.commands, executedEvidence: plan.evidence.map(logEvidence),
    optionalPracticalRegressions: plan.optionalCommands || [],
    ownedLiveProviderEvidence: liveEvidence(plan.live), practicalRequirements: candidate.practicalReplay,
    authenticatedServiceScopesVerified: candidate.id === 'completion-evidence' ? [authenticatedMastoturk, authenticatedWhatsappSelf]
      : ['recipient-composer-and-batch-state', 'telegram-whatsapp-native-chat', 'telegram-whatsapp-thread-classification'].includes(candidate.id) ? [authenticatedWhatsappSelf] : [],
    remainingUnverified: plan.remaining, authenticatedServicesVerified: false,
    authenticatedCoverageInterpretation: 'Exhaustive authenticated coverage of this entire family remains false; any bounded verified service scope is listed separately.',
    coverageInterpretation: 'Regression execution, controlled browser behavior, and authenticated practical coverage are separate claims.' };
}).sort((a, b) => a.priority.localeCompare(b.priority));

const corpusFile = path.join(out, 'production-two-dates-inventory.json');
const corpus = fs.existsSync(corpusFile) ? JSON.parse(fs.readFileSync(corpusFile, 'utf8')) : [];
const schemaReplay = JSON.parse(fs.readFileSync(path.join(out, 'production-schema-replay.json'), 'utf8'));
for (const family of families) {
  for (const command of [...family.executableRegressions, ...family.optionalPracticalRegressions]) for (const argument of command.args) {
    if (/\.(?:mjs|js)$/.test(argument)) assert.ok(fs.existsSync(argument), `Missing executable regression ${argument}`);
  }
  family.recentTraceEvidence = schemaReplay.replays.filter(replay =>
    family.family === 'complete-thread-source-coverage'
      && ['expanded_tree_continuation', 'oversized_prose_window'].includes(replay.reason))
    .map(({ date, case: ordinal, tool, reason, result }) => ({ date, caseOrdinal: ordinal, tool, reason, replayResult: result }));
  family.recentTraceInterpretation = family.recentTraceEvidence.length
    ? 'Original failing call shapes were replayed locally; no production actions were repeated.'
    : 'This row is grounded in the referenced historical report and executable scenario; no exact recent production trace replay is claimed.';
}
let traceCount = 0;
for (const day of corpus) {
  const index = JSON.parse(fs.readFileSync(path.resolve('../webbrain-improver/state/quality-audit-2026-10-07', day.date, 'sessions/journeys/index.json'), 'utf8'));
  const rows = Array.isArray(index) ? index : index.journeys || index.sessions || [];
  traceCount += rows.reduce((sum, row) => sum + (row.traceCount || 0), 0);
}
const matrix = { schema: 'webbrain-quality-historical-replay-matrix/1', generatedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  agentSourceSha256: createHash('sha256').update(fs.readFileSync('src/chrome/src/agent/agent.js')).digest('hex'),
  privacy: 'Only report date/line references, case ordinals, tool/family names, counts and verification artifacts are retained. No user transcripts, raw session IDs, credentials or trace filenames.',
  traceAcquisition: { outcome: 'recent-local-corpora-available', dates: corpus.map(day => day.date),
    journeys: corpus.reduce((sum, day) => sum + day.journeys, 0), traceCount,
    renderedToolSections: corpus.reduce((sum, day) => sum + day.tools, 0),
    parseableToolResults: corpus.reduce((sum, day) => sum + day.parsed, 0),
    explicitFailureResults: corpus.reduce((sum, day) => sum + day.failures, 0),
    interpretation: 'Failure results include expected safety refusals and old product versions; they are not all current defects.' },
  historicalSchemaReplay: { count: schemaReplay.historicalSchemaFailuresReplayed, outcomes: schemaReplay.counts,
    artifact: 'production-schema-replay.json' },
  additionalPracticalChecks,
  currentAdditionalDefects: [
    { family:'telegram-whatsapp-native-chat', issue:'Current native contacts had no strong canonical peer binding, and opaque historical same-body rows could clear a restored pending send.', status:nativeWhatsappMatrix.passed ? 'fixed-fresh-private-contact-and-mounted-floor-installed-matrix-tested' : 'fixed-paired-and-individual-installed-tested-final-matrix-not-yet-verified', proof:['whatsapp-kernel-opaque-remount-red.log','whatsapp-durable-source-final.log','whatsapp-contact-mv3-worker-restored-final-pass/evidence.json','whatsapp-contact-matrix/summary.json'], limitation:'Only fresh guarded one-to-one contact drawers and exact original document/baseline nodes authorize canonical restoration. New tasks, changed providers, lost documents, remounts and groups do not inherit proof.' },
    { family:'active-run-steering', issue:'A native conversation result arriving after task/provider ownership changed could reconcile an earlier pending send; production monitor Stop used a different message than the private observer expected.', status:'fixed-awaited-owner-and-production-monitor-stop-paired-browser-tested', proof:['whatsapp-durable-source-final.log','whatsapp-production-stop-final.log','whatsapp-contact-mv3-stop-pending-final/evidence.json'], limitation:'The actual monitor stop revokes the parked floor; stale ignored old-run stops preserve a newer active run. Genuine same-task Continue after explicit Stop remains uncertain and never resends.' },
    { family:'long-chat-resume', issue:'Chrome retained the extension-owned debugger across worker heap loss, causing done verification to fail attaching before it could inspect a valid restored delivery.', status:'fixed-native-owned-debugger-worker-and-namespace-tested', proof:['whatsapp-contact-mv3-worker-cdp-diagnostic/evidence.json','cdp-worker-restart-final-green.log','cdp-worker-restart-mv3/evidence.json','whatsapp-contact-mv3-worker-restored-final-pass/evidence.json'], limitation:'Recovery proves this extension owns the debugger through a harmless protocol read and does not detach or adopt another extension debugger. Prior delivery still requires independent current native evidence and every completion gate.' },
    { family: 'completion-evidence', issue: 'Native confirmation controls and modal copies with opacity zero or hidden ancestors could supply semantic commit evidence or incorrectly make the visible native control ambiguous.', status: 'fixed-local-bounded-native-visibility-paired-browser-tested', proof: ['native-confirmation-visibility-red.log', 'native-confirmation-visibility-green.log', 'native-confirmation-existing-completion-green.log', 'native-confirmation-deletion-mv3-green.log'], limitation: 'Only nativeConfirmationCommit uses the stricter rendered ancestry checks; actual selector and production AX references pass in both engines. This offline visibility defect does not establish the cause of a separate authenticated deletion failure.' },
    { family: 'provider-retry-and-budget', issue: 'Compaction could summarize the latest completed tool group before the model saw its newly consumed native incoming delta.', status: 'fixed-preserved-fresh-complete-group-and-hard-output-reserve-tested', proof: ['native-chat-soak-finite-mid/failure.json', 'native-chat-soak-finite-64k-seeded/summary.json', 'coverage-final-40-0-8.log'], limitation: 'The separate installed64K seeded case answers all three fresh questions and witnesses four actual compactions. Fixed prompt/schema capacity in smaller contexts remains distinct; character estimates do not prove vendor tokenizer compatibility.' },
    { family: 'provider-retry-and-budget', issue: 'The first request or restored conversation without provider usage underestimated actual tool schemas; a small window can also be too small for fixed prompts, tools and requested output.', status: 'fixed-exact-first-request-schema-estimate-paired-and-installed64k-tested-small-fixed-config-limit-remains', proof: ['context-first-request-schemas-red2.log', 'context-first-request-schemas-green.log', 'context-first-request-main-green2.log', 'native-chat-soak-finite-full/failure.json', 'native-chat-soak-finite-mid-fixed/failure.json', 'native-chat-soak-finite-64k-final/summary.json'], limitation: 'Exact assembled schemas count once when usage is absent, provider-reported usage is not counted twice, and a tool-free list counts zero. Earlier Full32K reached41453 estimated prompt tokens; Mid32K reached32663 plus512 output. No character-proxy hard reject or implicit Compact downgrade is used.' },
    { family: 'native-chat-recovery', issue: 'Native editor Delete left an empty caret BR and nested chat_send replaced the actual noDispatch recovery cause with a generic delivery error.', status: 'fixed-paired-native-input-and-installed-draft-recovery-tested', proof: ['literal-frame-empty-caret-final-console.log', 'native-chat-all-paths-final.log', 'live-gpt54mini-native-chat-empty-fixed-final/quality-1.json'], limitation: 'Only exact native composer/node/peer receipts accept the caret; generic editors and authored line breaks remain strict.' },
    { family: 'provider-private-metadata', issue: 'Private application resume and steering metadata appeared in external provider message payloads.', status: 'fixed-shared-chat-and-responses-message-projection-tested', proof: ['coverage-final-40-0-8.log'], limitation: 'Local persisted metadata remains available for task and completion ownership.' },
    { family: 'completion-evidence', issue: 'A native owned Delete lost its exact dispatch proof during a subsequent successful same-origin verification navigation or a committed URL observed before its readiness flag settled.', status: 'fixed-native-navigation-ownership-readiness-and-fresh-independent-verdict-authenticated-retake-passed', proof: ['semantic-navigation-before.log', 'semantic-navigation-neighbors.log', 'semantic-navigation-mv3-after.log', 'semantic-navigation-mv3-uncertain.log', 'semantic-navigation-mv3-document.log', 'live-mastoturk-native-navigation-final/summary.json', 'external-activity-current.json'], limitation: 'The owned installed navigation matrix covers delayed readiness, same-URL reload and a replacement before capture. An uncertain judge, an unowned document or an interrupted capture cannot certify deletion. Latest authenticated publication/cleanup both complete successfully; all known QA posts are404.' },
    { family: 'active-run-steering', issue: 'Selection shortcut key releases escaped to the page after the popup closed on keydown.', status: 'fixed-physical-key-release-paired-browser-tested', proof: ['selection-key-containment.log', 'selection-physical-key-release.log'] },
    { family: 'credential-and-account-lifecycle', issue: 'Stale MemCode OAuth, refresh, queued storage and recall results could undo a new account, Disconnect or recall opt-out.', status: 'fixed-45-paired-real-controller-race-tests', proof: ['memcode-final.log'], limitation: 'These use deferred service and storage responses; external MemCode account creation was not required.' },
    { family: 'planner-task-authority', issue: 'Strict GPT intent schema failed, and a user-role protocol repair replaced the genuine send request with a request to output JSON.', status: 'strict-schemas-and-system-role-repair-tested', proof: ['live-gpt54mini-native-intent-diagnosis/quality-1-intent-diagnostic.json', 'planner-focused-after-repair.log'], limitation: 'Real model chat terminal verification is recorded separately from these planner tests.' },
    { family: 'completion-evidence', issue: 'Generic chat Enter submissions delivered replies, but later exact native receipts did not update execution counts or the six-reply progress ledger.', status: 'fixed-installed-generic-submit-and-ledger-tested', proof: ['live-gpt54mini-native-chat-repaired/quality-1.json', 'native-chat-all-paths-final.log', 'native-chat-submit-assertions-final.log', 'native-chat-execution-ledger.log'], limitation: 'Automatic ledger reconciliation is restricted to unique, field-free ordinal replies in one authorized native conversation; ordinary bulk item evidence remains required.' },
    { family: 'long-chat-resume', issue: 'A running chat-resume job deduplicated away its own next alarm, and a new resumed run lost independently verified prior delivery proof.', status: 'fixed-actual-one-hour-alarm-worker-restart-tested', proof: ['native-chat-soak-harness-check-v8-console.log', 'native-chat-soak-one-hour/summary.json', 'native-chat-soak-finite-64k-seeded/summary.json'], limitation: 'The real hour answered 59 questions exactly once with two worker restarts and Stop/Continue; the separate 64K seeded run exercised four actual compactions. Provider and native application were isolated fixtures; authenticated service chat remains unverified.' },
    { family: 'completion-evidence', issue: 'Rendered native Mastodon privacy SVGs with aria-hidden were treated as invisible and prevented binding a real public post.', status: 'fixed-native-decoration-and-hidden-parent-safety-tested', proof: ['mastodon-publication-native-icon-red.log', 'mastodon-publication-native-visibility.log', 'mastodon-publication-permalink.log', 'live-mastoturk-publication-and-deletion-final/native-publication-capture.json'], limitation: 'Actual authenticated terminal success after this fix is a separate live retake.' },
    { family: 'complete-thread-source-coverage', issue: 'Expanded AX nested continuation schema rejected exact returned 12000-character pages.', status: 'fixed', historicalInstances: 8, proof: ['read-continuation-schema-final.log', 'read-continuation-browser.log'] },
    { family: 'complete-thread-source-coverage', issue: 'Oversized declared prose read requests wasted a repair turn instead of preserving offset at the supported bound.', status: 'bounded-repair-tested', historicalInstances: 15, proof: ['read-continuation-schema-final.log', 'read-continuation-browser.log'] },
    { family: 'passive-page-feedback-starvation', issue: 'Periodic sampling reclassified an already observed own value setter during its asynchronous verification wait.', status: 'fixed', proof: ['page-monitor-own-sample-before.log', 'page-monitor-sampling-final.log'] },
    { family: 'cloud-continuation-and-isolation', issue: 'Valid JSON null bridge envelopes caused an unhandled rejection and no protocol reply.', status: 'fixed', proof: ['cloud-bridge-envelope-before.log', 'cloud-bridge-envelope-after.log'] },
    { family: 'language-output-integrity-and-grounding', issue: 'A supported live model read all rows correctly but computed the derived total incorrectly.', status: 'deterministic-calculation-mitigation-live-rerun-passed', proof: ['live-gpt54mini/quality-1.json', 'calculator-unit.log', 'calculator-mode-regressions.log', 'live-gpt54mini-calculator/summary.json', 'live-gpt54mini-calculator/quality-1.json'], limitation: 'The repeated original task passed using calculate twice; models can still choose wrong operands or ignore the tool.' },
    { family: 'terminal-handoff-and-plain-final', issue: 'Tool-free Act chat recovery displayed raw MiniMax native tool transport instead of a useful partial result or concise blocker.', status: 'recovery-only-filter-regression-tested', proof: ['live-native-chat-completion-fixed/quality-1.json', 'chat-recovery-protocol-before.log', 'chat-recovery-protocol-after.log'], limitation: 'Paired actual Agent recovery tests preserve ordinary Ask and literal code; a live run need not enter this fallback.' },
    { family: 'active-run-steering', issue: 'A correction accepted during terminal recovery was lost when both outer callers persisted the obsolete answer and finished.', status: 'fixed-and-paired-chat-stream-callers-tested', proof: ['chat-recovery-steering-before.log', 'recovery-steering-final.log'] },
    { family: 'terminal-handoff-and-plain-final', issue: 'Long unmatched code delimiters made recovery display processing block service-worker commands for seconds.', status: 'linear-delimiter-scan-tested', proof: ['chat-recovery-steering-before.log', 'recovery-steering-final.log'] },
    { family: 'click-target-stale-ref-and-overlay', issue: 'Credentialed HEAD probes used to classify ordinary HTML as PDF rotated Mastoturk acceptance tokens before the displayed link was followed.', status: 'fixed-public-read-only-and-installed-mv3-tested', proof: ['mastoturk-click-diagnosis-before.json', 'mastoturk-click-diagnosis-after.json', 'pdf-detection-before.log', 'pdf-detection-final.log', 'pdf-detection-mv3.log', 'pdf-detection-native-e2e.log'], limitation: 'The public read-only checks reach the details form once with zero registration POSTs; account creation and email confirmation are a separate practical run.' },
    { family: 'completion-evidence', issue: 'An exact native Mastodon post was delivered once but the persistent compose form made generic submit completion reject the result; explicit full navigation to the active account profile also lost the native proof.', status: 'native-task-run-dispatch-and-current-profile-navigation-proof-installed-mv3-tested', proof: ['live-mastoturk-publication/quality-1.json', 'live-mastoturk-publication-verified/quality-1.json', 'mastodon-publication-mv3-before.log', 'mastodon-publication-tests.log', 'mastodon-publication-mv3-final.log', 'mastodon-publication-mv3-profile.log'], limitation: 'Only one exact source-anchored plain public post has this deterministic native receipt. Generated, ambiguous, private, media, poll and reply tasks continue through normal completion verification. Authenticated service retries remain separately recorded, including prior terminal failures.' },
    { family: 'completion-evidence', issue: 'A nested cross-origin save had one successful POST and a fresh child receipt but no parent-page generic terminal submission proof.', status: 'exact-frame-native-submit-proof-installed-mv3-tested', proof: ['completion-iframe-submit-red.log', 'completion-iframe-submit-green.log', 'completion-iframe-mv3-green.log'], limitation: 'Evidence remains bound to the dispatched frame document and newly observed child acknowledgement; unrelated frame statuses do not certify a save.' },
  ],
  familyCount: families.length, families,
  releaseClaim: 'These results do not establish a bug-free product, universal model correctness, exhaustive authenticated Telegram/WhatsApp coverage, or uninterrupted hours of external service use. One authenticated WhatsApp self-chat message and one real wall-clock hour in the isolated installed-MV3 fixture are separately verified.' };
fs.writeFileSync(path.join(out, 'historical-replay-matrix.json'), JSON.stringify(matrix, null, 2));
const csv = ['priority,family,report_references,executed_evidence,remaining_unverified', ...families.map(row =>
  [row.priority, row.family, row.originalReportReferences.join(' | '), row.executedEvidence.map(e => e.file).join(' | '), row.remainingUnverified.join(' | ')]
    .map(value => `"${String(value).replaceAll('"', '""')}"`).join(','))];
fs.writeFileSync(path.join(out, 'historical-replay-matrix.csv'), csv.join('\n') + '\n');
console.log(JSON.stringify({ families: families.length, reports: original.reports.length,
  journeys: matrix.traceAcquisition.journeys, historicalSchemaFailuresReplayed: schemaReplay.historicalSchemaFailuresReplayed,
  artifact: path.relative(process.cwd(), path.join(out, 'historical-replay-matrix.json')) }));
