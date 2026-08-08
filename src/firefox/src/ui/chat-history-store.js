const DB_NAME = 'webbrain_chat_history';
const DB_VERSION = 1;
const STORE_NAME = 'records';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('conversationId', 'conversationId');
        store.createIndex('url', 'url');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode = 'readonly') {
  return db.transaction([STORE_NAME], mode);
}

function promisifyReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeText(value, max = 20000) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

function normalizeAttachment(attachment) {
  return {
    kind: ['image', 'document', 'text'].includes(attachment?.kind) ? attachment.kind : 'document',
    name: normalizeText(attachment?.name || 'attachment', 240),
    mimeType: normalizeText(attachment?.mimeType || '', 120),
    size: Number.isFinite(Number(attachment?.size)) ? Math.max(0, Number(attachment.size)) : 0,
    source: attachment?.source === 'slash_screenshot' ? 'slash_screenshot' : 'user_upload',
    deliveryState: ['sending', 'included', 'not-sent', 'unknown'].includes(attachment?.deliveryState)
      ? attachment.deliveryState
      : 'included',
  };
}

function normalizeMessage(message, index) {
  return {
    role: ['user', 'assistant', 'system', 'error'].includes(message?.role) ? message.role : 'unknown',
    text: normalizeText(message?.text),
    format: message?.format === 'markdown' ? 'markdown' : 'text',
    index: Number.isFinite(Number(message?.index)) ? Number(message.index) : index,
    createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : null,
    attachments: (Array.isArray(message?.attachments) ? message.attachments : [])
      .map(normalizeAttachment)
      .filter(attachment => attachment.name),
  };
}

function firstText(messages, role) {
  return messages.find((message) => message.role === role && message.text)?.text || '';
}

function lastText(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === role && message.text) return message.text;
  }
  return '';
}

function buildTitle(record, messages) {
  const fromUser = firstText(messages, 'user');
  if (fromUser) return fromUser.replace(/\s+/g, ' ').slice(0, 140);
  if (record.tabTitle) return String(record.tabTitle).slice(0, 140);
  if (record.url) {
    try {
      const u = new URL(record.url);
      return u.hostname || record.url;
    } catch {
      return String(record.url).slice(0, 140);
    }
  }
  return 'Untitled conversation';
}

function normalizeRecord(input, existing = null) {
  const now = Date.now();
  const messages = (Array.isArray(input?.messages) ? input.messages : [])
    .map(normalizeMessage)
    .filter((message) => message.text || message.attachments.length);
  const userMessageCount = messages.filter((message) => message.role === 'user').length;
  const assistantMessageCount = messages.filter((message) => message.role === 'assistant').length;
  const record = {
    ...(existing || {}),
    id: String(input?.id || existing?.id || ''),
    conversationId: input?.conversationId ? String(input.conversationId) : existing?.conversationId || null,
    tabId: Number.isFinite(Number(input?.tabId)) ? Number(input.tabId) : existing?.tabId ?? null,
    url: String(input?.url || existing?.url || ''),
    tabTitle: String(input?.tabTitle || existing?.tabTitle || ''),
    mode: String(input?.mode || existing?.mode || ''),
    providerId: String(input?.providerId || existing?.providerId || ''),
    providerLabel: String(input?.providerLabel || existing?.providerLabel || ''),
    createdAt: Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : Number.isFinite(Number(input?.createdAt))
        ? Number(input.createdAt)
        : now,
    updatedAt: Number.isFinite(Number(input?.updatedAt)) ? Number(input.updatedAt) : now,
    messages,
    messageCount: messages.length,
    userMessageCount,
    assistantMessageCount,
    firstUserMessage: firstText(messages, 'user'),
    lastUserMessage: lastText(messages, 'user'),
    lastAssistantMessage: lastText(messages, 'assistant'),
  };
  record.title = buildTitle(record, messages);
  return record;
}

/**
 * Save or update a chat history record in IndexedDB.
 * @param {Object} input - Record with at least { id, messages }.
 * @returns {Promise<Object|null>} Saved record or null if invalid.
 */
export async function saveChatHistoryRecord(input) {
  if (!input?.id) return null;
  const db = await openDB();
  const existing = await promisifyReq(tx(db).objectStore(STORE_NAME).get(String(input.id))).catch(() => null);
  const record = normalizeRecord(input, existing);
  if (!record.id || record.userMessageCount < 1) return null;
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).put(record));
  return record;
}

function sameMessageContent(left, right) {
  const leftAttachments = (Array.isArray(left.attachments) ? left.attachments : []).map(normalizeAttachment);
  const rightAttachments = (Array.isArray(right.attachments) ? right.attachments : []).map(normalizeAttachment);
  return left.role === right.role
    && left.text === right.text
    && (left.format || 'text') === (right.format || 'text')
    && Number(left.index) === Number(right.index)
    && JSON.stringify(leftAttachments) === JSON.stringify(rightAttachments);
}

/**
 * Repair only the serialized message content of an existing history record.
 * Conversation metadata and timestamps remain unchanged, and a missing record
 * is never recreated by this migration path.
 * @param {string} id - Existing record ID.
 * @param {Array<Object>} messages - Messages recovered from restored chat DOM.
 * @returns {Promise<Object|null>} Repaired/existing record, or null if absent.
 */
export async function repairChatHistoryRecordMessages(id, messages) {
  if (!id || !Array.isArray(messages)) return null;
  const db = await openDB();
  const transaction = tx(db, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    let result = null;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('History repair transaction aborted'));

    const getReq = store.get(String(id));
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;

      const previousMessages = Array.isArray(existing.messages) ? existing.messages : [];
      const normalizedMessages = messages
        .map((message, index) => {
          const normalized = normalizeMessage(message, index);
          const previous = previousMessages.find((candidate) => (
            Number(candidate?.index) === normalized.index && candidate?.role === normalized.role
          ));
          if (Number.isFinite(Number(previous?.createdAt))) {
            normalized.createdAt = Number(previous.createdAt);
          }
          return normalized;
        })
        .filter((message) => message.text || message.attachments.length);

      const unchanged = previousMessages.length === normalizedMessages.length
        && previousMessages.every((message, index) => sameMessageContent(message, normalizedMessages[index]));
      if (unchanged) {
        result = existing;
        return;
      }

      const repaired = normalizeRecord({
        ...existing,
        messages: normalizedMessages,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      }, existing);
      if (repaired.userMessageCount < 1) {
        result = existing;
        return;
      }
      result = repaired;
      store.put(repaired);
    };
  });
}

/**
 * List chat history records, newest first.
 * @param {Object} [params] - { limit }.
 * @returns {Promise<Array<Object>>} Array of history records.
 */
export async function listChatHistoryRecords({ limit = 500 } = {}) {
  const db = await openDB();
  const index = tx(db).objectStore(STORE_NAME).index('updatedAt');
  const out = [];
  await new Promise((resolve) => {
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => resolve();
  });
  return out;
}

/**
 * Get a single chat history record by ID.
 * @param {string} id - Record ID.
 * @returns {Promise<Object|null>} Record or null if not found.
 */
export async function getChatHistoryRecord(id) {
  if (!id) return null;
  const db = await openDB();
  return promisifyReq(tx(db).objectStore(STORE_NAME).get(String(id)));
}

/**
 * Delete a chat history record by ID.
 * @param {string} id - Record ID to delete.
 * @returns {Promise<void>}
 */
export async function deleteChatHistoryRecord(id) {
  if (!id) return;
  const db = await openDB();
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).delete(String(id)));
}

/**
 * Delete all chat history records.
 * @returns {Promise<void>}
 */
export async function clearChatHistoryRecords() {
  const db = await openDB();
  await promisifyReq(tx(db, 'readwrite').objectStore(STORE_NAME).clear());
}
