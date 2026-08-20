/**
 * Dedicated-worker OPFS writer for Apocalypse Wikipedia archives.
 *
 * FileSystemSyncAccessHandle is only available here (not in the extension
 * service worker or page). Random writes + flush stay O(1) on a 40 GB+ file;
 * createWritable({ keepExistingData: true }) does not.
 */

const ARCHIVE_DIRECTORY = 'webbrain-apocalypse';

let access = null;

function requireAccess() {
  if (!access) throw new Error('Archive writer is not open.');
  return access;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'open') {
      if (access) {
        try { access.flush(); } catch { /* close below */ }
        try { access.close(); } catch { /* reopen below */ }
        access = null;
      }
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(ARCHIVE_DIRECTORY, { create: true });
      const file = await dir.getFileHandle(String(payload?.key || ''), { create: true });
      access = await file.createSyncAccessHandle();
      self.postMessage({ id, ok: true, size: access.getSize() });
      return;
    }
    const handle = requireAccess();
    if (type === 'write') {
      const source = payload?.bytes;
      const bytes = source instanceof Uint8Array
        ? source
        : new Uint8Array(source);
      const offset = Number(payload?.offset) || 0;
      let written = 0;
      while (written < bytes.byteLength) {
        written += handle.write(bytes.subarray(written), { at: offset + written });
      }
      handle.flush();
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'truncate') {
      handle.truncate(Number(payload?.size) || 0);
      handle.flush();
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'close' || type === 'abort') {
      try { if (type === 'close') handle.flush(); } catch { /* still close */ }
      handle.close();
      access = null;
      self.postMessage({ id, ok: true });
      return;
    }
    throw new Error(`Unknown archive writer message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
