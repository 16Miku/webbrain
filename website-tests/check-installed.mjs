import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['--test', fileURLToPath(new URL('./local.test.mjs', import.meta.url))], {
  env: { ...process.env, WEBBRAIN_LOCAL_SMOKE: '1' }, stdio: 'inherit', windowsHide: true,
});
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
