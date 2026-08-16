import { OPENSTAX_CATALOG_SNAPSHOT_DATE, PREFETCHED_OPENSTAX_CATALOG } from './openstax-catalog.js';

export { OPENSTAX_CATALOG_SNAPSHOT_DATE, PREFETCHED_OPENSTAX_CATALOG };

const EMERGENCY_BOX_DB_NAME = 'webbrain_emergency_box';
const EMERGENCY_BOX_DB_VERSION = 1;
const RESOURCE_STORE = 'resources';
const RESOURCE_DIRECTORY = 'webbrain-emergency-box';
const OPENSTAX_API = 'https://openstax.org/apps/cms/api/v2';
const ALL_RESOURCE_CATEGORY_PRIORITY = Object.freeze({ health: 0, field: 1, education: 2 });

export function compareEmergencyBoxResources(left = {}, right = {}, options = {}) {
  if (options.groupCategories === true) {
    const categoryDifference = (ALL_RESOURCE_CATEGORY_PRIORITY[left.category] ?? 99)
      - (ALL_RESOURCE_CATEGORY_PRIORITY[right.category] ?? 99);
    if (categoryDifference) return categoryDifference;
  }
  const readyDifference = Number(right.status === 'ready') - Number(left.status === 'ready');
  return readyDifference || String(left.title || '').localeCompare(String(right.title || ''));
}

export const EMERGENCY_BOX_HEALTH_RESOURCES = Object.freeze([
  {
    id: 'health-who-icrc-basic-emergency-care',
    title: 'WHO / ICRC Basic Emergency Care',
    description: 'A practical approach to acutely ill and injured patients in low-resource settings.',
    category: 'health',
    collection: 'Emergency health',
    publisher: 'World Health Organization and ICRC',
    published: '2018',
    language: 'en',
    url: 'https://hlh.who.int/docs/librariesprovider4/hlh-documents/who-icrc-basic-emergency-care.pdf?sfvrsn=4460e22e_5',
    sourceUrl: 'https://www.who.int/publications-detail-redirect/basic-emergency-care-approach-to-the-acutely-ill-and-injured',
  },
  {
    id: 'health-ifrc-first-aid-guidelines-2020',
    title: 'International First Aid Guidelines',
    description: 'Evidence-based first aid guidance for common illnesses, injuries and emergencies.',
    category: 'health',
    collection: 'First aid',
    publisher: 'International Federation of Red Cross and Red Crescent Societies',
    published: '2020',
    language: 'en',
    url: 'https://www.ifrc.org/sites/default/files/2022-02/EN_GFARC_GUIDELINES_2020.pdf',
    sourceUrl: 'https://www.ifrc.org/document/international-first-aid-resuscitation-and-education-guidelines',
  },
  {
    id: 'health-who-essential-medicines-2023',
    title: 'WHO Model List of Essential Medicines',
    description: 'The 23rd WHO model list of medicines considered essential for a basic health system.',
    category: 'health',
    collection: 'Medicines',
    publisher: 'World Health Organization',
    published: '2023',
    language: 'en',
    whoHandle: '10665/371090',
    sourceUrl: 'https://www.who.int/publications/i/item/WHO-MHP-HPS-EML-2023.02',
  },
  {
    id: 'health-who-surgical-care-district-hospital',
    title: 'Surgical Care at the District Hospital',
    description: 'Emergency and essential surgical procedures for facilities with limited specialist support.',
    category: 'health',
    collection: 'Clinical care',
    publisher: 'World Health Organization',
    published: '2003',
    language: 'en',
    whoHandle: '10665/43141',
    sourceUrl: 'https://iris.who.int/handle/10665/43141',
  },
  {
    id: 'field-who-medical-guide-for-ships',
    title: 'International Medical Guide for Ships',
    description: 'Diagnosis and treatment guidance for ships and other isolated settings.',
    category: 'field',
    collection: 'Remote care',
    publisher: 'World Health Organization',
    published: '2007',
    language: 'en',
    whoHandle: '10665/43814',
    sourceUrl: 'https://iris.who.int/handle/10665/43814',
  },
  {
    id: 'field-niosh-chemical-hazards-pocket-guide',
    title: 'NIOSH Pocket Guide to Chemical Hazards',
    description: 'Workplace chemical exposure limits, symptoms, protection and first-aid information.',
    category: 'field',
    collection: 'Chemical hazards',
    publisher: 'National Institute for Occupational Safety and Health',
    published: '2007',
    language: 'en',
    url: 'https://www.cdc.gov/niosh/docs/2007-107/pdfs/2007-107.pdf',
    sourceUrl: 'https://www.cdc.gov/niosh/npg/',
  },
  {
    id: 'field-army-first-aid-fm-4-25-11',
    title: 'First Aid — U.S. Army Field Manual',
    description: 'Field assessment and immediate treatment procedures for injuries and environmental emergencies.',
    category: 'field',
    collection: 'Field manuals',
    publisher: 'U.S. Department of the Army',
    published: '2002',
    language: 'en',
    archiveIdentifier: 'fm-4-25.11-first-aid',
    sourceUrl: 'https://archive.org/details/fm-4-25.11-first-aid',
  },
]);

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Emergency Box storage transaction aborted.'));
  });
}

function safeResourceKey(value) {
  const key = String(value || '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^\.+/, '').slice(0, 180);
  if (!key) throw new Error('Emergency Box resource key is invalid.');
  return `${key}.pdf`;
}

function contentRangeTotal(value) {
  const match = String(value || '').match(/\/([0-9]+)$/);
  return match ? Number(match[1]) : 0;
}

function normalizedRecord(resource, patch = {}) {
  return {
    ...resource,
    format: 'pdf',
    sourceUrl: resource.sourceUrl || resource.url || '',
    rights: resource.rights || 'See the publisher source for license and reuse terms.',
    ...patch,
  };
}

export function createEmergencyBoxStore(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  const open = () => {
    if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(EMERGENCY_BOX_DB_NAME, EMERGENCY_BOX_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RESOURCE_STORE)) {
          database.createObjectStore(RESOURCE_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  };
  return {
    async list() {
      const database = await open();
      return await idbRequest(database.transaction(RESOURCE_STORE, 'readonly').objectStore(RESOURCE_STORE).getAll());
    },
    async get(id) {
      const database = await open();
      return await idbRequest(database.transaction(RESOURCE_STORE, 'readonly').objectStore(RESOURCE_STORE).get(id));
    },
    async put(record) {
      const database = await open();
      const transaction = database.transaction(RESOURCE_STORE, 'readwrite');
      transaction.objectStore(RESOURCE_STORE).put(record);
      await idbTransaction(transaction);
      return record;
    },
    async delete(id) {
      const database = await open();
      const transaction = database.transaction(RESOURCE_STORE, 'readwrite');
      transaction.objectStore(RESOURCE_STORE).delete(id);
      await idbTransaction(transaction);
    },
  };
}

export function createEmergencyBoxStorage(storageManager = globalThis.navigator?.storage) {
  async function directory(create = true) {
    if (typeof storageManager?.getDirectory !== 'function') {
      throw new Error('Origin Private File System storage is unavailable in this browser.');
    }
    const root = await storageManager.getDirectory();
    return await root.getDirectoryHandle(RESOURCE_DIRECTORY, { create });
  }
  async function handle(key, create = false) {
    return await (await directory(create)).getFileHandle(safeResourceKey(key), { create });
  }
  return {
    async open(key) {
      return await (await handle(key)).getFile();
    },
    async size(key) {
      try {
        return (await this.open(key)).size;
      } catch (error) {
        if (error?.name === 'NotFoundError') return 0;
        throw error;
      }
    },
    async createWriter(key) {
      const writable = await (await handle(key, true)).createWritable({ keepExistingData: true });
      let settled = false;
      return {
        async write(position, bytes) {
          if (settled) throw new Error('Emergency Box writer is already closed.');
          await writable.write({ type: 'write', position, data: bytes });
        },
        async truncate(size) {
          if (settled) throw new Error('Emergency Box writer is already closed.');
          await writable.truncate(size);
        },
        async close() {
          if (settled) return;
          await writable.close();
          settled = true;
        },
        async abort(reason) {
          if (settled) return;
          await writable.abort(reason);
          settled = true;
        },
      };
    },
    async delete(key) {
      try {
        await (await directory(false)).removeEntry(safeResourceKey(key));
      } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
      }
    },
  };
}

export async function loadOpenStaxCatalog(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Network access is unavailable.');
  const response = await fetchImpl(`${OPENSTAX_API}/pages/?type=books.Book&fields=title,slug&limit=200`);
  if (!response.ok) throw new Error(`OpenStax catalog returned HTTP ${response.status}.`);
  const payload = await response.json();
  return (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => item?.id && item?.title && item?.meta?.detail_url)
    .map(item => normalizedRecord({
      id: `openstax-${item.id}`,
      title: item.title,
      description: 'Open textbook. Download the compact PDF for offline reading.',
      category: 'education',
      collection: 'OpenStax',
      publisher: 'OpenStax, Rice University',
      published: String(item.meta.first_published_at || '').slice(0, 4),
      language: String(item.meta.locale || 'en').split('-')[0],
      detailUrl: item.meta.detail_url,
      sourceUrl: item.meta.html_url || 'https://openstax.org/subjects',
    }));
}

export async function resolveEmergencyResource(resource, fetchImpl = globalThis.fetch) {
  if (resource?.url) return normalizedRecord(resource);
  if (resource?.whoHandle) {
    const handleResponse = await fetchImpl(`https://iris.who.int/handle/${encodeURI(resource.whoHandle)}`);
    if (!handleResponse.ok) throw new Error(`WHO IRIS returned HTTP ${handleResponse.status}.`);
    const itemId = String(handleResponse.url || '').match(/\/items\/([0-9a-f-]{36})(?:[/?#]|$)/i)?.[1];
    if (!itemId) throw new Error('WHO IRIS did not resolve this publication to a downloadable item.');
    const apiResponse = await fetchImpl(`https://iris.who.int/server/api/core/items/${itemId}?embed=bundles/bitstreams`, {
      headers: { Accept: 'application/json' },
    });
    if (!apiResponse.ok) throw new Error(`WHO IRIS item metadata returned HTTP ${apiResponse.status}.`);
    const payload = await apiResponse.json();
    const bundles = payload?._embedded?.bundles?._embedded?.bundles || [];
    const original = bundles.find(bundle => bundle?.name === 'ORIGINAL');
    const bitstreams = original?._embedded?.bitstreams?._embedded?.bitstreams || [];
    const languagePenalty = name => /(?:^|[_-])(rus|fre|fra|spa|ara|chi|vie|tuk|hin|mar|kor)(?:[_.-]|$)/i.test(name) ? 10 : 0;
    const score = bitstream => {
      const name = String(bitstream?.name || '');
      if (!/\.pdf$/i.test(name)) return 100;
      if (/(?:^|[_-])eng(?:[_.-]|$)|english/i.test(name)) return 0;
      if (/^\d{10,}\.pdf$/i.test(name)) return 1;
      return 2 + languagePenalty(name);
    };
    const bitstream = [...bitstreams].sort((left, right) => score(left) - score(right))[0];
    const url = bitstream?._links?.content?.href;
    if (!url || score(bitstream) >= 100) throw new Error('WHO IRIS did not provide a PDF bitstream for this publication.');
    return normalizedRecord(resource, { url });
  }
  if (resource?.archiveIdentifier) {
    const response = await fetchImpl(`https://archive.org/metadata/${encodeURIComponent(resource.archiveIdentifier)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Internet Archive metadata returned HTTP ${response.status}.`);
    const payload = await response.json();
    const candidates = (Array.isArray(payload?.files) ? payload.files : [])
      .filter(file => /\.pdf$/i.test(String(file?.name || '')) && !/(?:_text|_encrypted)\.pdf$/i.test(String(file.name)))
      .sort((left, right) => (Number(right.size) || 0) - (Number(left.size) || 0));
    if (!candidates.length) throw new Error('Internet Archive did not provide a readable PDF for this manual.');
    const filename = String(candidates[0].name).split('/').map(encodeURIComponent).join('/');
    return normalizedRecord(resource, {
      url: `https://archive.org/download/${encodeURIComponent(resource.archiveIdentifier)}/${filename}`,
    });
  }
  if (!resource?.detailUrl || !String(resource.id || '').startsWith('openstax-')) {
    throw new Error('This resource does not provide a downloadable PDF.');
  }
  const response = await fetchImpl(resource.detailUrl);
  if (!response.ok) throw new Error(`OpenStax book details returned HTTP ${response.status}.`);
  const detail = await response.json();
  const url = detail?.low_resolution_pdf_url || detail?.high_resolution_pdf_url;
  if (!url) throw new Error('OpenStax did not provide a PDF for this book.');
  return normalizedRecord(resource, { url });
}

export async function downloadEmergencyResource(resource, options = {}) {
  const store = options.store || createEmergencyBoxStore();
  const storage = options.storage || createEmergencyBoxStorage();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const resolved = await resolveEmergencyResource(resource, fetchImpl);
  const storageKey = resolved.storageKey || resolved.id;
  const existing = await store.get(resolved.id);
  let offset = await storage.size(storageKey);
  let writer;
  let lastPersistedAt = 0;
  const persist = async patch => {
    const record = normalizedRecord(resolved, {
      ...existing,
      storageKey,
      ...patch,
      updatedAt: Date.now(),
    });
    await store.put(record);
    onProgress(record);
    return record;
  };

  try {
    await persist({ status: 'downloading', error: '', bytesReceived: offset });
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
    const response = await fetchImpl(resolved.url, { headers, signal });
    if (!response.ok) throw new Error(`PDF download returned HTTP ${response.status}.`);
    if (offset > 0 && response.status !== 206) offset = 0;
    const contentLength = Number(response.headers?.get?.('content-length')) || 0;
    const totalBytes = contentRangeTotal(response.headers?.get?.('content-range')) || (contentLength ? offset + contentLength : 0);
    writer = await storage.createWriter(storageKey);
    if (offset === 0) await writer.truncate(0);

    const reader = response.body?.getReader?.();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new DOMException('Download paused.', 'AbortError');
        await writer.write(offset, value);
        offset += value.byteLength;
        const now = Date.now();
        if (now - lastPersistedAt >= 500) {
          lastPersistedAt = now;
          await persist({ status: 'downloading', bytesReceived: offset, totalBytes });
        } else {
          onProgress(normalizedRecord(resolved, { ...existing, storageKey, status: 'downloading', bytesReceived: offset, totalBytes }));
        }
      }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writer.write(offset, bytes);
      offset += bytes.byteLength;
    }
    await writer.close();
    writer = null;

    const file = await storage.open(storageKey);
    if ((await file.slice(0, 5).text()) !== '%PDF-') {
      await storage.delete(storageKey);
      throw new Error('The downloaded file is not a valid PDF.');
    }
    return await persist({
      status: 'ready',
      bytesReceived: file.size,
      totalBytes: file.size,
      downloadedAt: Date.now(),
      error: '',
    });
  } catch (error) {
    if (writer) {
      try {
        // OPFS writable streams are atomic: aborting rolls the file back to its
        // pre-download size. Commit successfully written chunks so a pause or
        // transient network failure can resume from durable progress.
        await writer.close();
      } catch {
        try { await writer.abort?.(error); } catch { /* preserve the original failure */ }
      }
      writer = null;
    }
    const bytesReceived = await storage.size(storageKey).catch(() => 0);
    const paused = error?.name === 'AbortError' || signal?.aborted;
    await persist({
      status: paused ? 'paused' : 'error',
      bytesReceived,
      error: paused ? '' : String(error?.message || error),
    });
    if (!paused) throw error;
    return await store.get(resolved.id);
  }
}

export async function deleteEmergencyResource(id, options = {}) {
  const store = options.store || createEmergencyBoxStore();
  const storage = options.storage || createEmergencyBoxStorage();
  const record = await store.get(id);
  if (!record) return false;
  await storage.delete(record.storageKey || record.id);
  await store.delete(id);
  return true;
}
