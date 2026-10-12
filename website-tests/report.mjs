import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function sourceRevision(cwd) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return 'unknown'; }
}
export function sourceIsDirty(cwd) {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true }).trim().length > 0; }
  catch { return null; }
}
export function failureCategory(row) {
  if (row.status === 'passed') return undefined;
  if (row.status === 'unsupported') return 'backend_or_verification_capability';
  const code = String(row.code || '');
  if (/account|identity|login|recipient_not_authorized|mutations_disabled|action_not_authorized|destination_not_authorized/i.test(code)) return 'authentication_or_authorization';
  if (row.stage === 'preflight' || /configuration|session|backend|readiness|BUILD|READY|API_KEY/i.test(code)) return 'setup_or_backend';
  if (/observer|immutable|canonical|capture|proof|iframe|not_confirmed/i.test(code)) return 'verification_or_site_layout';
  return 'behavior_or_effect_verification';
}
export function summarize(results, metadata = {}) {
  const counts = { passed: 0, failed: 0, blocked: 0, unsupported: 0, needs_user_input: 0 };
  for (const row of results) counts[row.status] = (counts[row.status] || 0) + 1;
  return { schema: 'authenticated-summary/1', createdAt: new Date().toISOString(), ...metadata, counts,
    results: results.map(row => ({ scenario: row.scenario, site: row.site, target: row.target, backend: row.backend,
      status: row.status, code: row.code, repetition: row.repetition, stage: row.stage, durationMs: row.durationMs, cleanup: row.cleanup,
      layer: row.layer, coverage: row.coverage, failureCategory: failureCategory(row),
      stages: row.stages?.map(s => ({ id: s.id, status: s.status, code: s.code, durationMs: s.durationMs,
        delivery: s.delivery, effect: s.effect, intervention: s.intervention, verificationSource: s.verificationSource,
        runtimeMs: s.runtimeMs, observationMs: s.observationMs, retries: s.retries, dispatchCount: s.dispatchCount, events: s.events })) })) };
}
export async function writeSummary(directory, summary) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  const rows = summary.results.map(r => `| ${r.scenario} | ${r.target} | ${r.backend} | ${r.status} | ${r.stage || '-'} | ${r.code || '-'} | ${r.durationMs ?? '-'} |`);
  await fs.writeFile(path.join(directory, 'summary.md'), `# Authenticated workflow tests\n\nSource: ${summary.sourceRevision || 'unknown'}\n\n| Scenario | Target | Backend | Result | Stage | Code | ms |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nBlocked and unsupported cases are not passes. Fixture results do not attest live-site behavior.\n`, { mode: 0o600 });
}
