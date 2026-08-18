export const EMERGENCY_DOWNLOAD_ACTION = 'emergency_download';
export const EMERGENCY_DOWNLOAD_STATE_MESSAGE = 'emergency-download-state';
export const EMERGENCY_SEMANTIC_STATE_KEY = 'webbrainEmergencySemanticDownloadState';
export const CORPUS_DOWNLOAD_ID = 'rag-emergency-corpus';
export const SEMANTIC_DOWNLOAD_ID = 'rag-semantic-model';

export async function sendEmergencyDownloadCommand(command, payload = {}) {
  const api = globalThis.browser || globalThis.chrome;
  if (!api?.runtime?.sendMessage) throw new Error('Extension messaging is unavailable.');
  const response = await api.runtime.sendMessage({
    target: 'background',
    action: EMERGENCY_DOWNLOAD_ACTION,
    command,
    ...payload,
  });
  if (response?.error) throw new Error(String(response.error));
  if (response?.ok === false) throw new Error(String(response.error || 'Emergency download failed.'));
  return response;
}
