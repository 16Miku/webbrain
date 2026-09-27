/** Offscreen owner for Emergency Box corpus, PDF, and E5 downloads. */

import { createEmergencyDownloadController } from '../agent/emergency-download-controller.js';
import { createOfflineRagIndexClient } from '../agent/offline-rag-index.js';
import { getSharedOfflineSemanticReranker } from '../agent/offline-semantic-runtime.js';

const TARGET = 'offscreen-emergency-download';
const controller = createEmergencyDownloadController({
  indexClient: createOfflineRagIndexClient(),
  semanticReranker: getSharedOfflineSemanticReranker(),
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET) return false;
  controller.handle(message.command, message).then(
    result => sendResponse(result),
    error => sendResponse({ ok: false, error: String(error?.message || error) }),
  );
  return true;
});
