import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || (process.platform === 'darwin'
  ? join(homedir(), 'Library/Application Support/Mozilla/NativeMessagingHosts')
  : process.platform === 'linux' ? join(homedir(), '.mozilla/native-messaging-hosts') : null);
if (!target) throw new Error('On Windows, pass an installation directory and register its manifest under HKCU\\Software\\Mozilla\\NativeMessagingHosts\\one.webbrain.bidi');
await mkdir(target, { recursive: true });
const wrapper = resolve(target, process.platform === 'win32' ? 'webbrain-bidi.cmd' : 'webbrain-bidi');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
await writeFile(wrapper, process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${join(root, 'host.mjs')}"\r\n`
  : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'host.mjs'))}\n`, { mode: 0o700 });
const manifest = { name: 'one.webbrain.bidi', description: 'WebBrain Firefox BiDi companion', path: wrapper, type: 'stdio', allowed_extensions: ['webbrain@esokullu.com'] };
const path = resolve(target, 'one.webbrain.bidi.json');
await writeFile(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(`Installed companion manifest: ${path}`);
