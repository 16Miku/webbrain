import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const base = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/semantic-navigation-matrix');
for (const scenario of ['delayed', 'same-url', 'before-capture']) {
  const { stdout } = await execute(process.execPath, ['test/quality/mastodon-deletion-navigation-mv3.mjs'], {
    windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env,
      WEBBRAIN_QUALITY_DELETE_VERDICT: 'succeeded',
      WEBBRAIN_QUALITY_DELETE_NAV_CASE: scenario === 'before-capture' ? 'ordinary' : scenario,
      WEBBRAIN_QUALITY_DELETE_NAV_INTERRUPT: scenario === 'before-capture' ? scenario : '',
      WEBBRAIN_QUALITY_ARTIFACTS: path.join(base, scenario) },
  });
  process.stdout.write(stdout);
}
