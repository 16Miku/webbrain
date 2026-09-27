import { createEmergencyCorpusStorage, createEmergencyCorpusStore } from '../agent/emergency-corpus.js';
import { createEmergencyPassages, validateEmergencyCorpusManifest, verifyEmergencyDocument } from '../agent/offline-rag.js';
import { t } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
let currentThemeMode = 'system';
loadMode().then(mode => { currentThemeMode = mode; applyMode(mode, { syncStorage: false }); });
watch(() => currentThemeMode);
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && THEME_MODES.includes(changes.themeMode?.newValue)) {
    currentThemeMode = changes.themeMode.newValue;
  }
});

const store = createEmergencyCorpusStore();
const storage = createEmergencyCorpusStorage();
const parameters = new URLSearchParams(globalThis.location.search);
const documentId = parameters.get('document') || '';
const requestedPassageId = parameters.get('passage') || '';
const elements = Object.fromEntries([
  'document-title', 'document-meta', 'offline-badge', 'reader-message', 'document-view',
  'document-license', 'document-source', 'document-passages', 'reader-status',
].map(id => [id, document.getElementById(id)]));

function showError(message) {
  elements['reader-message'].hidden = false;
  elements['reader-message'].dataset.kind = 'error';
  elements['reader-message'].textContent = message;
  elements['document-view'].hidden = true;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function renderPassages(passages) {
  const fragment = document.createDocumentFragment();
  let selected = null;
  for (const passage of passages) {
    const section = document.createElement('section');
    section.className = 'text-passage';
    section.dataset.passageId = passage.passageId;
    const heading = document.createElement('h2');
    heading.textContent = passage.locator;
    const body = document.createElement('pre');
    body.textContent = passage.text;
    section.append(heading, body);
    if (passage.passageId === requestedPassageId) {
      section.dataset.selected = 'true';
      selected = section;
    }
    fragment.append(section);
  }
  elements['document-passages'].replaceChildren(fragment);
  if (selected) requestAnimationFrame(() => selected.scrollIntoView({ block: 'center' }));
  return !!selected;
}

async function initialize() {
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(documentId)
      || (requestedPassageId && !/^[a-z0-9._:-]{1,220}$/.test(requestedPassageId))) {
    showError(t('et.missing_document'));
    return;
  }
  try {
    const state = await store.get();
    if (state?.status !== 'ready' || !state.active?.installId || !state.active?.manifest) {
      showError(t('et.not_installed'));
      return;
    }
    const manifest = validateEmergencyCorpusManifest(state.active.manifest);
    const metadata = manifest.documents.find(item => item.id === documentId);
    if (!metadata) {
      showError(t('et.missing_document'));
      return;
    }
    const file = await storage.readInstallFile(state.active.installId, metadata.path);
    const verified = await verifyEmergencyDocument(metadata, await file.arrayBuffer());
    const passages = await createEmergencyPassages(metadata, verified.text, { corpusVersion: manifest.version });
    elements['document-title'].textContent = metadata.title;
    elements['document-meta'].textContent = [metadata.collection, metadata.language].filter(Boolean).join(' · ');
    elements['document-license'].textContent = `${t('et.license')}: ${metadata.license}`;
    const sourceUrl = safeExternalUrl(metadata.sourceUrl);
    if (sourceUrl) elements['document-source'].href = sourceUrl;
    else elements['document-source'].hidden = true;
    const found = renderPassages(passages);
    elements['offline-badge'].hidden = false;
    elements['reader-message'].hidden = true;
    elements['document-view'].hidden = false;
    elements['reader-status'].textContent = requestedPassageId && !found
      ? t('et.passage_not_found')
      : t('et.ready', { count: passages.length });
  } catch (error) {
    console.error('[Emergency text reader]', error);
    showError(t('et.integrity_error'));
  }
}

initialize();

