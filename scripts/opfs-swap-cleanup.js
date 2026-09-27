/**
 * WebBrain — OPFS swap-file cleanup (manual, one-off).
 *
 * Chrome writes FileSystemWritableFileStream data to a sibling `.crswap` file
 * and only renames it into place on close(). A stream that never closes leaks
 * its swap file forever, and with `keepExistingData: true` each swap is a full
 * copy of the file it was writing.
 *
 * HOW TO RUN
 *   1. chrome://extensions → WebBrain → "Inspect views: service worker"
 *   2. Paste this whole file into the Console.
 *   3. await WEBBRAIN_OPFS.report()      // read-only inventory
 *   4. await WEBBRAIN_OPFS.sweepSwap()   // delete every orphaned *.crswap
 *   5. await WEBBRAIN_OPFS.dedupe()      // dry run: show redundant full copies
 *      await WEBBRAIN_OPFS.dedupe({ dryRun: false })   // keep one, delete the rest
 *
 * sweepSwap() never touches a completed archive. dedupe() only ever removes a
 * file when another copy of the same archive survives.
 */
(() => {
  const BUCKETS = [
    'webbrain-apocalypse',
    'webbrain-emergency-box',
    'webbrain-offline-rag',
    'webbrain-webgpu-models',
  ];
  const SWAP = '.crswap';
  const gb = n => `${(n / 1024 ** 3).toFixed(2)} GB`;

  // Download keys are `<uuid>-<uuid>-<filename>`; strip them so repeated
  // downloads of the same archive group together.
  const UUID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
  const stripKey = name => name.replace(new RegExp(`^(?:${UUID}-){1,2}`, 'i'), '');

  async function scan() {
    const root = await navigator.storage.getDirectory();
    const files = [];
    for (const bucket of BUCKETS) {
      let dir;
      try { dir = await root.getDirectoryHandle(bucket, { create: false }); }
      catch { continue; }
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'file') continue;
        let size = 0; let mtime = 0;
        try { const f = await handle.getFile(); size = f.size; mtime = f.lastModified; }
        catch { /* unreadable — still report it */ }
        files.push({ bucket, name, size, mtime, swap: name.endsWith(SWAP), dir });
      }
    }
    return files;
  }

  async function report() {
    const files = await scan();
    const swap = files.filter(f => f.swap);
    const real = files.filter(f => !f.swap);
    const sum = list => list.reduce((n, f) => n + f.size, 0);
    console.log(`%c${files.length} files — ${gb(sum(files))} total`, 'font-weight:bold');
    console.log(`  orphaned swap : ${swap.length} files, ${gb(sum(swap))}  ← reclaimable now`);
    console.log(`  real archives : ${real.length} files, ${gb(sum(real))}`);
    console.table(
      [...files].sort((a, b) => b.size - a.size).slice(0, 40).map(f => ({
        bucket: f.bucket,
        file: stripKey(f.name),
        size: gb(f.size),
        kind: f.swap ? 'SWAP (orphan)' : 'archive',
        modified: f.mtime ? new Date(f.mtime).toISOString().slice(0, 16) : '',
      })),
    );
    return { total: sum(files), swapBytes: sum(swap), realBytes: sum(real) };
  }

  async function sweepSwap({ dryRun = false } = {}) {
    const swap = (await scan()).filter(f => f.swap);
    let removed = 0; let bytes = 0; let held = 0;
    for (const f of swap) {
      if (dryRun) { bytes += f.size; removed += 1; continue; }
      try { await f.dir.removeEntry(f.name); removed += 1; bytes += f.size; }
      catch { held += 1; }  // still open by a live writer
    }
    console.log(`${dryRun ? '[dry run] would reclaim' : 'reclaimed'} ${removed} swap file(s), ${gb(bytes)}`
      + (held ? ` — ${held} skipped (still open; pause the download and rerun)` : ''));
    return { removed, bytes, held };
  }

  async function dedupe({ dryRun = true, keep = 'largest' } = {}) {
    const real = (await scan()).filter(f => !f.swap);
    const groups = new Map();
    for (const f of real) {
      const key = `${f.bucket}/${stripKey(f.name)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    let removed = 0; let bytes = 0;
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      const ranked = [...list].sort(
        keep === 'newest' ? (a, b) => b.mtime - a.mtime : (a, b) => b.size - a.size || b.mtime - a.mtime,
      );
      const [survivor, ...redundant] = ranked;
      console.log(`${key}: keeping ${gb(survivor.size)} copy, dropping ${redundant.length} other(s)`);
      for (const f of redundant) {
        if (!dryRun) {
          try { await f.dir.removeEntry(f.name); } catch { continue; }
        }
        removed += 1; bytes += f.size;
      }
    }
    console.log(`${dryRun ? '[dry run] would free' : 'freed'} ${gb(bytes)} across ${removed} redundant copy/copies`);
    if (dryRun) console.log('rerun with { dryRun: false } to apply');
    return { removed, bytes };
  }

  globalThis.WEBBRAIN_OPFS = { report, sweepSwap, dedupe, scan };
  console.log('WEBBRAIN_OPFS ready — try: await WEBBRAIN_OPFS.report()');
})();
