/** Firefox keeps its SQLite index worker in the extension page that uses it. */

import { createOfflineRagIndexClient } from './offline-rag-index.js';

export function createHostedOfflineRagIndexClient(options = {}) {
  return createOfflineRagIndexClient(options);
}
