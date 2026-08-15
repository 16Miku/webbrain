import {
  createApocalypseStore,
  readApocalypseArticle,
  searchApocalypseArchives,
} from '../agent/apocalypse-mode.js';
import { t } from './i18n.js';

const store = createApocalypseStore();
const archiveId = new URLSearchParams(globalThis.location.search).get('id') || '';
const elements = Object.fromEntries([
  'archive-name', 'search-form', 'article-query', 'search-status', 'search-results',
  'article-empty', 'article-view', 'article-title', 'article-provenance', 'article-source',
  'article-note', 'article-text',
].map(id => [id, document.getElementById(id)]));

let archive = null;
let results = [];
let selectedPath = '';
let busy = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[character]));
}

function setStatus(message = '', kind = '') {
  elements['search-status'].textContent = message;
  elements['search-status'].dataset.kind = kind;
}

function renderResults() {
  if (!results.length) {
    elements['search-results'].innerHTML = `<div class="empty-state">${escapeHtml(t('ar.no_results'))}</div>`;
    return;
  }
  elements['search-results'].innerHTML = results.map((result, index) => `
    <button type="button" class="result-button" data-result="${index}" aria-current="${String(result.path === selectedPath)}">
      <strong>${escapeHtml(result.title)}</strong>
      <span>${escapeHtml(result.excerpt)}</span>
    </button>`).join('');
}

async function search() {
  const query = elements['article-query'].value.trim();
  if (!archive || !query || busy) return;
  busy = true;
  elements['search-form'].querySelector('button').disabled = true;
  setStatus(t('ar.searching', { query }));
  try {
    results = await searchApocalypseArchives(query, {
      archiveId,
      requireEnabled: false,
      limit: 10,
    });
    renderResults();
    setStatus(results.length ? t('ar.result_count', { count: results.length }) : t('ar.no_results'));
  } catch (error) {
    results = [];
    renderResults();
    setStatus(error.message, 'error');
  } finally {
    busy = false;
    elements['search-form'].querySelector('button').disabled = false;
  }
}

async function openArticle(result) {
  if (!result?.path || busy) return;
  busy = true;
  selectedPath = result.path;
  renderResults();
  setStatus(t('ar.opening', { title: result.title }));
  try {
    const article = await readApocalypseArticle(archiveId, result.path, { maxChars: 250_000 });
    elements['article-title'].textContent = article.title;
    elements['article-provenance'].textContent = [
      article.language,
      article.archiveDate || t('ap.date_unknown'),
      article.archiveTitle,
    ].filter(Boolean).join(' · ');
    elements['article-source'].href = article.url;
    elements['article-source'].hidden = !/^https:\/\//.test(article.url || '');
    elements['article-note'].hidden = article.truncated !== true;
    elements['article-text'].textContent = article.text;
    elements['article-empty'].hidden = true;
    elements['article-view'].hidden = false;
    setStatus(t('ar.opened', { title: article.title }));
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    busy = false;
  }
}

elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  void search();
});
elements['search-results'].addEventListener('click', event => {
  const button = event.target.closest('[data-result]');
  if (button) void openArticle(results[Number(button.dataset.result)]);
});
document.addEventListener('wb-locale-changed', () => {
  if (results.length) renderResults();
});

try {
  archive = (await store.listArchives()).find(record => record.id === archiveId && record.status === 'ready') || null;
  if (!archive) throw new Error(t('ar.archive_unavailable'));
  elements['archive-name'].textContent = archive.title || archive.filename;
  elements['article-query'].focus();
} catch (error) {
  elements['archive-name'].textContent = t('ar.archive_unavailable');
  elements['article-query'].disabled = true;
  elements['search-form'].querySelector('button').disabled = true;
  setStatus(error.message, 'error');
}
