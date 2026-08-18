/** Shared E5 worker so retrieval and Emergency downloads use one model lifecycle. */

import { createOfflineSemanticReranker } from './offline-reranker.js';

let sharedReranker = null;
let activeDownloads = 0;

export function getSharedOfflineSemanticReranker(options = {}) {
  if (!sharedReranker) {
    sharedReranker = createOfflineSemanticReranker(options);
  }
  return sharedReranker;
}

export function beginSharedSemanticDownload() {
  activeDownloads += 1;
  return getSharedOfflineSemanticReranker();
}

export function endSharedSemanticDownload() {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

export function resetSharedOfflineSemanticReranker() {
  if (activeDownloads > 0) return;
  sharedReranker?.close?.();
  sharedReranker = null;
}
