import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const base = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/dropdown-menu-matrix');
for (const scenario of ['positive', 'anchored', 'dom', 'route', 'document']) {
  const { stdout } = await execute(process.execPath, ['test/quality/dropdown-menu-mv3.mjs'], {
    windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, WEBBRAIN_QUALITY_MENU_INTERRUPT: ['positive', 'anchored'].includes(scenario) ? '' : scenario,
      WEBBRAIN_QUALITY_MENU_ANCHORED: scenario === 'anchored' ? '1' : '',
      WEBBRAIN_QUALITY_ARTIFACTS: path.join(base, scenario) },
  });
  process.stdout.write(stdout);
}
