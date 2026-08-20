/** Owns Emergency Box corpus, PDF, and E5 downloads outside visible extension pages. */

import { createApocalypseStore } from './apocalypse-mode.js';
import {
  cancelEmergencyCorpusInstall,
  createEmergencyCorpusStorage,
  createEmergencyCorpusStore,
  deleteEmergencyCorpus,
  downloadAndInstallEmergencyCorpus,
  isEmergencyCorpusRecord,
  mergeEmergencyCorpusProgress,
  recoverEmergencyCorpusLifecycle,
} from './emergency-corpus.js';
import { EMERGENCY_CORPUS_RELEASE } from './emergency-corpus-release.js';
import {
  createEmergencyBoxStorage,
  createEmergencyBoxStore,
  deleteEmergencyResource,
  downloadEmergencyResource,
} from './emergency-box.js';
import { createOfflineRagIndexClient } from './offline-rag-index.js';
import {
  beginSharedSemanticDownload,
  endSharedSemanticDownload,
  getSharedOfflineSemanticReranker,
} from './offline-semantic-runtime.js';

export const EMERGENCY_DOWNLOAD_STATE_MESSAGE = 'emergency-download-state';
export const EMERGENCY_SEMANTIC_STATE_KEY = 'webbrainEmergencySemanticDownloadState';

function defaultBroadcast(payload) {
  const api = globalThis.browser || globalThis.chrome;
  try {
    const result = api?.runtime?.sendMessage?.({
      type: EMERGENCY_DOWNLOAD_STATE_MESSAGE,
      ...payload,
    });
    if (typeof result?.catch === 'function') result.catch(() => {});
  } catch { /* Pages poll IndexedDB if no listener is attached. */ }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Emergency download paused.', 'AbortError');
}

export function createEmergencyDownloadController(options = {}) {
  const apocalypseStore = options.apocalypseStore || createApocalypseStore();
  const corpusStore = options.corpusStore || createEmergencyCorpusStore();
  const corpusStorage = options.corpusStorage || createEmergencyCorpusStorage();
  const resourceStore = options.resourceStore || createEmergencyBoxStore();
  const resourceStorage = options.resourceStorage || createEmergencyBoxStorage();
  const indexClient = options.indexClient || createOfflineRagIndexClient();
  const semanticReranker = options.semanticReranker || getSharedOfflineSemanticReranker();
  const corpusDescriptor = options.corpusDescriptor === undefined
    ? EMERGENCY_CORPUS_RELEASE
    : options.corpusDescriptor;
  const downloadCorpus = options.downloadCorpus || downloadAndInstallEmergencyCorpus;
  const recoverCorpus = options.recoverCorpus || recoverEmergencyCorpusLifecycle;
  const cancelCorpus = options.cancelCorpus || cancelEmergencyCorpusInstall;
  const deleteCorpus = options.deleteCorpus || deleteEmergencyCorpus;
  const downloadResource = options.downloadResource || downloadEmergencyResource;
  const removeResource = options.deleteResource || deleteEmergencyResource;
  const storageArea = options.storageArea
    || (globalThis.browser || globalThis.chrome)?.storage?.local;
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : defaultBroadcast;
  const requireApocalypse = options.requireApocalypse !== false;

  let corpusJob = null;
  let lastCorpus = null;
  let semanticJob = null;
  const resourceJobs = new Map();
  const resourceQueue = [];
  let recovered = null;

  const publishCorpus = (value) => {
    if (!value || typeof value !== 'object') return null;
    if (isEmergencyCorpusRecord(value)) {
      lastCorpus = value;
      return lastCorpus;
    }
    if (!isEmergencyCorpusRecord(lastCorpus)) return null;
    lastCorpus = mergeEmergencyCorpusProgress(lastCorpus, value);
    return lastCorpus;
  };

  const publish = (patch = {}) => {
    const semantic = patch.semantic || semanticReranker.snapshot();
    const corpus = Object.prototype.hasOwnProperty.call(patch, 'corpus')
      ? publishCorpus(patch.corpus)
      : null;
    if (storageArea?.set) {
      void storageArea.set({ [EMERGENCY_SEMANTIC_STATE_KEY]: semantic }).catch?.(() => {});
    }
    broadcast({
      corpus,
      semantic,
      resource: patch.resource || null,
    });
  };

  const requireEnabled = async () => {
    if (!requireApocalypse) return;
    const config = await apocalypseStore.getConfig().catch(() => null);
    if (config?.enabled !== true) {
      throw new Error('Enable Apocalypse Mode before downloading Emergency Box files.');
    }
  };

  const snapshot = async () => {
    const [corpus, resources] = await Promise.all([
      corpusStore.get().catch(() => null),
      resourceStore.list().catch(() => []),
    ]);
    return {
      ok: true,
      corpus,
      semantic: semanticReranker.snapshot(),
      resources: (Array.isArray(resources) ? resources : []).filter(record => (
        ['queued', 'downloading', 'paused', 'error'].includes(record?.status)
      )),
      active: {
        corpus: Boolean(corpusJob),
        semantic: Boolean(semanticJob),
        resources: [...resourceJobs.keys(), ...resourceQueue.map(item => item.id)],
      },
    };
  };

  const waitForJob = async job => {
    if (!job?.promise) return;
    try { await job.promise; } catch { /* Pause and stop map this onto stored state. */ }
  };

  const isLiveJob = job => Boolean(job) && !job.controller.signal.aborted;

  const startCorpus = async () => {
    await requireEnabled();
    if (!corpusDescriptor) throw new Error('The Emergency text-pack release is not available yet.');
    if (isLiveJob(corpusJob)) return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    await waitForJob(corpusJob);
    if (isLiveJob(corpusJob)) return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    const current = await corpusStore.get().catch(() => null);
    if (current?.status === 'ready' && current.active) {
      return { ok: true, started: false, reason: 'ready', ...(await snapshot()) };
    }
    const controller = new AbortController();
    const job = { controller, promise: null };
    corpusJob = job;
    job.promise = (async () => {
      try {
        const record = await downloadCorpus(corpusDescriptor, {
          store: corpusStore,
          storage: corpusStorage,
          signal: controller.signal,
          buildIndex: request => indexClient.buildEmergencyIndex(request),
          deleteIndex: path => indexClient.deleteIndex(path),
          onProgress: next => publish({ corpus: next }),
        });
        publish({ corpus: record });
        return record;
      } catch (error) {
        if (error?.name !== 'AbortError' && controller.signal.aborted) throw abortError(controller.signal);
        throw error;
      } finally {
        if (corpusJob === job) corpusJob = null;
      }
    })();
    job.promise.catch(() => {});
    return { ok: true, started: true, ...(await snapshot()) };
  };

  const pauseCorpus = async () => {
    const job = corpusJob;
    job?.controller.abort(abortError(job.controller.signal));
    await waitForJob(job);
    return await snapshot();
  };

  const removeCorpus = async ({ cancelOnly = false } = {}) => {
    await pauseCorpus();
    const record = cancelOnly
      ? await cancelCorpus({
        store: corpusStore,
        storage: corpusStorage,
        deleteIndex: path => indexClient.deleteIndex(path),
      })
      : (await deleteCorpus({
        store: corpusStore,
        storage: corpusStorage,
        deleteIndex: path => indexClient.deleteIndex(path),
      }), null);
    publish({ corpus: record });
    return { ok: true, corpus: record, ...(await snapshot()) };
  };

  const startSemantic = async () => {
    await requireEnabled();
    if (isLiveJob(semanticJob)) return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    await waitForJob(semanticJob);
    if (isLiveJob(semanticJob)) return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    const current = semanticReranker.snapshot();
    if (current.status === 'ready') {
      return { ok: true, started: false, reason: 'ready', ...(await snapshot()) };
    }
    const controller = new AbortController();
    const job = { controller, promise: null };
    semanticJob = job;
    beginSharedSemanticDownload();
    job.promise = (async () => {
      try {
        const state = await semanticReranker.download({
          signal: controller.signal,
          onProgress: progress => publish({ semantic: { ...semanticReranker.snapshot(), ...progress, status: 'downloading' } }),
        });
        publish({ semantic: state });
        return state;
      } finally {
        endSharedSemanticDownload();
        if (semanticJob === job) semanticJob = null;
        publish({ semantic: semanticReranker.snapshot() });
      }
    })();
    job.promise.catch(() => {});
    return { ok: true, started: true, ...(await snapshot()) };
  };

  const pauseSemantic = async () => {
    const job = semanticJob;
    job?.controller.abort(abortError(job?.controller.signal));
    await waitForJob(job);
    const state = await semanticReranker.pause().catch(() => semanticReranker.snapshot());
    publish({ semantic: state });
    return await snapshot();
  };

  const stopSemantic = async () => {
    await pauseSemantic();
    const state = await semanticReranker.stop();
    publish({ semantic: state });
    return { ok: true, semantic: state, ...(await snapshot()) };
  };

  const pumpResourceQueue = () => {
    if (resourceJobs.size) return;
    const resource = resourceQueue.shift();
    if (!resource) return;
    void runResource(resource);
  };

  const runResource = resource => {
    const id = String(resource?.id || '');
    if (!id || resourceJobs.has(id)) return;
    const controller = new AbortController();
    const job = { controller, resource, promise: null };
    resourceJobs.set(id, job);
    job.promise = (async () => {
      try {
        const record = await downloadResource(resource, {
          store: resourceStore,
          storage: resourceStorage,
          signal: controller.signal,
          onProgress: next => publish({ resource: next }),
        });
        publish({ resource: record });
        return record;
      } finally {
        if (resourceJobs.get(id) === job) resourceJobs.delete(id);
        pumpResourceQueue();
      }
    })();
    job.promise.catch(() => {});
  };

  const startResource = async resourceValue => {
    await requireEnabled();
    const resource = resourceValue && typeof resourceValue === 'object' ? resourceValue : null;
    const id = String(resource?.id || '');
    if (!id) throw new Error('Emergency resource download is missing an id.');
    const existing = resourceJobs.get(id);
    const queued = () => resourceQueue.some(item => item.id === id);
    if (isLiveJob(existing) || queued()) {
      return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    }
    await waitForJob(existing);
    if (isLiveJob(resourceJobs.get(id)) || queued()) {
      return { ok: true, started: false, reason: 'active', ...(await snapshot()) };
    }
    const current = await resourceStore.get(id).catch(() => null);
    if (current?.status === 'ready') {
      return { ok: true, started: false, reason: 'ready', ...(await snapshot()) };
    }
    if (resourceJobs.size) {
      resourceQueue.push(resource);
      return { ok: true, started: true, queued: true, ...(await snapshot()) };
    }
    runResource(resource);
    return { ok: true, started: true, ...(await snapshot()) };
  };

  const pauseResource = async idValue => {
    const id = String(idValue || '');
    const queuedIndex = resourceQueue.findIndex(item => item.id === id);
    if (queuedIndex >= 0) resourceQueue.splice(queuedIndex, 1);
    const job = resourceJobs.get(id);
    job?.controller.abort(abortError(job.controller.signal));
    await waitForJob(job);
    return await snapshot();
  };

  const stopResource = async idValue => {
    const id = String(idValue || '');
    await pauseResource(id);
    await removeResource(id, { store: resourceStore, storage: resourceStorage });
    publish({ resource: { id, status: 'deleted' } });
    return { ok: true, ...(await snapshot()) };
  };

  const recover = async () => {
    const corpus = await recoverCorpus({
      store: corpusStore,
      storage: corpusStorage,
      deleteIndex: path => indexClient.deleteIndex(path),
    });
    await semanticReranker.status().catch(() => 'error');
    if (!semanticJob) {
      const semantic = semanticReranker.snapshot();
      if (semantic.status === 'downloading') await semanticReranker.pause().catch(() => {});
    }
    const records = await resourceStore.list().catch(() => []);
    for (const record of records) {
      if (record?.status !== 'downloading' || resourceJobs.has(record.id)) continue;
      await resourceStore.put({ ...record, status: 'paused', error: '', updatedAt: Date.now() });
    }
    publish({ corpus, semantic: semanticReranker.snapshot() });
    return await snapshot();
  };

  recovered = recover().catch(error => {
    recovered = Promise.resolve({ ok: false, error: String(error?.message || error) });
    return recovered;
  });

  return Object.freeze({
    snapshot,
    recover: () => recovered,
    async handle(command, payload = {}) {
      await recovered;
      switch (String(command || '')) {
        case 'status':
          return await snapshot();
        case 'start_corpus':
          return await startCorpus();
        case 'pause_corpus':
          return await pauseCorpus();
        case 'cancel_corpus':
          return await removeCorpus({ cancelOnly: true });
        case 'delete_corpus':
          return await removeCorpus({ cancelOnly: false });
        case 'start_semantic':
          return await startSemantic();
        case 'pause_semantic':
          return await pauseSemantic();
        case 'stop_semantic':
          return await stopSemantic();
        case 'start_resource':
          return await startResource(payload.resource);
        case 'pause_resource':
          return await pauseResource(payload.id);
        case 'stop_resource':
          return await stopResource(payload.id);
        default:
          throw new Error(`Unknown emergency download command: ${command}`);
      }
    },
  });
}
