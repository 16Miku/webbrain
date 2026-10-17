const DB_NAME = 'webbrain_chat_history';
const STORE = 'records';

/**
 * Read-only peek at the side panel's chat history (same extension origin).
 * Never creates the database: opening a missing IndexedDB would create an empty
 * v1 database and break WebBrain's own upgrade path.
 */
export async function readRecentChats(limit = 4, idb = globalThis.indexedDB) {
  if (!idb?.databases) return [];
  const existing = await idb.databases();
  if (!existing.some((db) => db.name === DB_NAME)) return [];

  const db = await new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });

  try {
    if (!db.objectStoreNames.contains(STORE)) return [];
    return await new Promise((resolve, reject) => {
      const rows = [];
      const store = db.transaction([STORE], 'readonly').objectStore(STORE);
      const source = store.indexNames.contains('updatedAt') ? store.index('updatedAt') : store;
      const cursorRequest = source.openCursor(null, 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || rows.length >= limit) return resolve(rows);
        const { id, title, url, updatedAt } = cursor.value;
        rows.push({ id, title: String(title || '').slice(0, 140), url: String(url || ''), updatedAt });
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  } finally {
    db.close();
  }
}
