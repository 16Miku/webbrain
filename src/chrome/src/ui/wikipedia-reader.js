import {
  createApocalypseStore,
  readApocalypseArticle,
  readApocalypseImage,
  searchApocalypseArchives,
  wikipediaArchiveIncludesImages,
} from '../agent/apocalypse-mode.js';
import { t } from './i18n.js';
import {
  renderPlainWikipediaArticle,
  renderWikipediaArticle,
  wikipediaFragmentId,
} from './wikipedia-article-renderer.js';
import { createWikipediaImageLoader } from './wikipedia-image-loader.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const runtimeApi = globalThis.browser || globalThis.chrome;
let currentThemeMode = 'system';
loadMode().then((mode) => {
  currentThemeMode = mode;
  applyMode(mode, { syncStorage: false });
});
watch(() => currentThemeMode);
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.themeMode) return;
  const next = changes.themeMode.newValue;
  if (THEME_MODES.includes(next)) currentThemeMode = next;
});

const store = createApocalypseStore();
const pageParams = new URLSearchParams(globalThis.location.search);
const archiveId = pageParams.get('id') || '';
const initialArticlePath = pageParams.get('article') || '';
const elements = Object.fromEntries([
  'archive-name', 'reader-badge', 'search-form', 'article-query', 'search-status', 'search-results',
  'article-empty', 'article-view', 'article-title', 'article-provenance', 'article-source',
  'article-note', 'article-text',
].map(id => [id, document.getElementById(id)]));
const imageLoader = createWikipediaImageLoader({
  readImage: (path, options) => readApocalypseImage(archiveId, path, { ...options, record: archive }),
});

let archive = null;
let results = [];
let selectedPath = '';
let displayedPath = '';
let searchBusy = false;
let articleBusy = false;
let articleRequestSequence = 0;
let imagesIncluded = false;

function articleTitle(path) {
  return String(path || '').split('/').pop().replace(/_/g, ' ').trim();
}

function locationFragment() {
  let value = String(globalThis.location.hash || '').replace(/^#/, '');
  try { value = decodeURIComponent(value); } catch {}
  return value.replace(/^wb-wiki-/, '');
}

function articleHref(path, fragment = '') {
  const url = new URL(globalThis.location.href);
  url.searchParams.set('id', archiveId);
  url.searchParams.set('article', path);
  url.hash = fragment ? wikipediaFragmentId(fragment) : '';
  return url.href;
}

function scrollToFragment(fragment) {
  const id = wikipediaFragmentId(fragment);
  if (!id) return;
  globalThis.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[character]));
}

function setStatus(message = '', kind = '') {
  elements['search-status'].textContent = message;
  elements['search-status'].dataset.kind = kind;
}

function updateReaderBadge(value = imagesIncluded) {
  imagesIncluded = value === true;
  elements['reader-badge'].textContent = t(imagesIncluded ? 'ar.images_included' : 'ar.text_only');
  elements['reader-badge'].dataset.kind = imagesIncluded ? 'images' : 'text';
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
  if (!archive || !query || searchBusy || articleBusy) return;
  searchBusy = true;
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
    searchBusy = false;
    elements['search-form'].querySelector('button').disabled = false;
  }
}

function cancelPendingArticleRead() {
  articleRequestSequence += 1;
  articleBusy = false;
}

async function openArticle(result, options = {}) {
  if (!result?.path || articleBusy || (searchBusy && options.historyNavigation !== true)) return;
  const requestSequence = ++articleRequestSequence;
  articleBusy = true;
  selectedPath = result.path;
  renderResults();
  const requestedTitle = result.title || articleTitle(result.path);
  setStatus(t('ar.opening', { title: requestedTitle }));
  try {
    const article = await readApocalypseArticle(archiveId, result.path, {
      maxChars: 250_000,
      maxHtmlChars: 1_000_000,
    });
    if (requestSequence !== articleRequestSequence) return;
    elements['article-title'].textContent = article.title;
    elements['article-provenance'].textContent = [
      article.language,
      article.archiveDate || t('ap.date_unknown'),
      article.archiveTitle,
    ].filter(Boolean).join(' · ');
    elements['article-source'].href = article.url;
    elements['article-source'].hidden = !/^https:\/\//.test(article.url || '');
    imageLoader.clear();
    let rendered = { truncated: false };
    try {
      rendered = renderWikipediaArticle(article.unsafeHtml, elements['article-text'], {
        articleHref,
        articlePath: article.path,
        title: article.title,
      });
      if (rendered.empty) renderPlainWikipediaArticle(article.text, elements['article-text']);
    } catch (error) {
      console.warn('Wikipedia formatting fell back to plain text:', error);
      renderPlainWikipediaArticle(article.text, elements['article-text']);
    }
    const imageCount = imageLoader.start(elements['article-text']);
    updateReaderBadge(imagesIncluded || article.imagesIncluded === true || imageCount > 0);
    elements['article-note'].hidden = article.truncated !== true && rendered.truncated !== true;
    elements['article-empty'].hidden = true;
    elements['article-view'].hidden = false;
    selectedPath = article.path;
    displayedPath = article.path;
    if (options.history !== false) {
      globalThis.history.pushState({ articlePath: article.path }, '', articleHref(article.path, options.fragment));
    }
    if (options.fragment) scrollToFragment(options.fragment);
    setStatus(t('ar.opened', { title: article.title }));
  } catch (error) {
    if (requestSequence !== articleRequestSequence) return;
    setStatus(error.message, 'error');
  } finally {
    if (requestSequence === articleRequestSequence) articleBusy = false;
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
elements['article-text'].addEventListener('click', event => {
  const link = event.target.closest('a[data-wikipedia-path]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void openArticle({
    path: link.dataset.wikipediaPath,
    title: link.textContent.trim() || articleTitle(link.dataset.wikipediaPath),
  }, { fragment: link.dataset.wikipediaFragment || '' });
});
globalThis.addEventListener('popstate', () => {
  cancelPendingArticleRead();
  const path = new URLSearchParams(globalThis.location.search).get('article') || '';
  if (!path) {
    imageLoader.clear();
    selectedPath = '';
    displayedPath = '';
    renderResults();
    elements['article-view'].hidden = true;
    elements['article-empty'].hidden = false;
    setStatus();
    elements['article-query'].focus();
    return;
  }
  if (path !== displayedPath) {
    void openArticle({ path, title: articleTitle(path) }, {
      history: false,
      historyNavigation: true,
      fragment: locationFragment(),
    });
    return;
  }
  selectedPath = path;
  renderResults();
  setStatus();
  scrollToFragment(locationFragment());
});
document.addEventListener('wb-locale-changed', () => {
  if (results.length) renderResults();
  updateReaderBadge();
});
globalThis.addEventListener('pagehide', () => {
  cancelPendingArticleRead();
  imageLoader.clear();
});

try {
  archive = (await store.listArchives()).find(record => record.id === archiveId && record.status === 'ready') || null;
  if (!archive) throw new Error(t('ar.archive_unavailable'));
  elements['archive-name'].textContent = archive.title || archive.filename;
  updateReaderBadge(archive.imagesIncluded === true || wikipediaArchiveIncludesImages(archive));
  if (initialArticlePath) {
    await openArticle(
      { path: initialArticlePath, title: articleTitle(initialArticlePath) },
      { history: false, fragment: locationFragment() },
    );
  } else {
    elements['article-query'].focus();
  }
} catch (error) {
  elements['archive-name'].textContent = t('ar.archive_unavailable');
  elements['article-query'].disabled = true;
  elements['search-form'].querySelector('button').disabled = true;
  setStatus(error.message, 'error');
}
