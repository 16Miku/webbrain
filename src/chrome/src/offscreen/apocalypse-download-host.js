/**
 * Offscreen owner for Apocalypse Mode archive downloads.
 *
 * manager.processNext() writes multi-GB ZIM archives into OPFS. The durable
 * write path needs a FileSystemSyncAccessHandle, which is only reachable from
 * a dedicated Worker -- and `Worker` is undefined in an MV3 service worker.
 * Running the pass there meant openSyncWriter() always threw and every wake
 * fell back to createWritable({ keepExistingData: true }), which copies the
 * whole archive into a fresh `.crswap` file each time. Hosting it here, where
 * the archive writer worker can be created, keeps writes durable and O(1).
 *
 * chrome.alarms is not exposed to offscreen documents, so scheduling stays in
 * background.js: `schedule` is a no-op here and the service worker calls
 * syncDownloadSchedule() once this pass resolves.
 */
import { createApocalypseController } from '../agent/apocalypse-mode.js';

const TARGET = 'offscreen-apocalypse-download';
const CONTROL_COMMANDS = new Set(['pause', 'delete', 'disable']);

const controller = createApocalypseController(chrome, {
  schedule: () => {},
});

async function handleArchiveCommand(command, payload = {}) {
  if (command === 'processNext') return await controller.manager.processNext();
  if (!CONTROL_COMMANDS.has(command)) throw new Error(`Unsupported archive host command: ${command}`);
  if (command === 'disable') return await controller.handle('enable', { enabled: false });
  return await controller.handle(command, payload);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET) return false;
  const command = String(message.command || '');
  const run = handleArchiveCommand(command, message.payload);
  run.then(
    result => sendResponse({ ok: true, result: result ?? null }),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});
