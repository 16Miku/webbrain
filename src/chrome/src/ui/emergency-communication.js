import { getLocale } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';

const COPY = Object.freeze({
  en: {
    header: 'Emergency Communication', headerSubtitle: 'A basic word board that works without the internet',
    builtIn: 'Built in · offline', eyebrow: 'Universal Basic Lexicon',
    title: 'Find a shared word when you do not share a language.',
    lede: 'Choose a language or variety, search 110 everyday concepts, then show the word at full size.',
    concepts: 'Concepts', languages: 'Languages', varieties: 'Varieties', chooseLanguage: 'Language or variety',
    languagePlaceholder: 'Search name, code, script, or PanLex ID', showLanguages: 'Show all languages',
    languageOptionsLabel: 'Languages and varieties', languageResults: '{shown} of {total} varieties',
    noLanguageMatches: 'No languages match this search.',
    search: 'Search this word board', groupAll: 'All', groupEssential: 'Essentials', groupBody: 'Body',
    groupPeople: 'People', groupSurroundings: 'Surroundings', showLarge: 'Show large',
    missing: 'No recorded PanLex term', noMatches: 'No concepts match this search.',
    coverage: '{available} of {total} concepts recorded', sourceEyebrow: 'Source and limits',
    sourceTitle: 'Useful vocabulary, not an interpreter.',
    sourceWarning: 'Terms come from the January 2017 PanLex Swadesh Corpus. They can be incomplete, ambiguous, dialect-specific, or outdated. Use a trained interpreter whenever accuracy is critical.',
    deeperEyebrow: 'Optional deeper sources', deeperTitle: 'When 110 concepts are not enough',
    deeperDescription: 'These projects provide broader offline dictionaries. They are not included in the built-in pack yet.',
    wiktionaryDescription: 'Broad definitions and translations in ZIM archives.',
    wiktionarySize: 'Full English text-only archive: about 8.5 GB as of May 2026.',
    freedictDescription: 'Deeper bilingual dictionaries for about 45 languages.',
    freedictSize: 'Sizes and licenses vary by language pair.',
    estimateNote: 'External archive sizes are estimates and can change when publishers replace a snapshot.',
    dialogNote: 'Point to the word and confirm meaning with gestures or context.', close: 'Close',
    loadError: 'The built-in communication pack could not be opened.',
  },
  zh: {
    header: '应急沟通', headerSubtitle: '无需互联网即可使用的基础词语板', builtIn: '内置 · 离线',
    eyebrow: '通用基础词汇表', title: '语言不通时，找到一个双方都能理解的词。',
    lede: '选择语言或变体，搜索 110 个日常概念，然后以大字显示。',
    concepts: '概念', languages: '语言', varieties: '语言变体', chooseLanguage: '语言或变体', search: '搜索词语板',
    languagePlaceholder: '搜索名称、代码、文字或 PanLex ID', showLanguages: '显示所有语言',
    languageOptionsLabel: '语言和语言变体', languageResults: '显示 {shown}/{total} 个语言变体',
    noLanguageMatches: '没有与搜索相符的语言。',
    groupAll: '全部', groupEssential: '必需', groupBody: '身体', groupPeople: '人物', groupSurroundings: '环境',
    showLarge: '大字显示', missing: 'PanLex 没有记录对应词', noMatches: '没有与搜索相符的概念。',
    coverage: '已记录 {available}/{total} 个概念', sourceEyebrow: '来源与限制', sourceTitle: '这是实用词汇，不是口译员。',
    sourceWarning: '词语来自 2017 年 1 月的 PanLex Swadesh 语料库，可能不完整、含义模糊、仅适用于特定方言或已经过时。准确性至关重要时，请使用受过训练的口译员。',
    deeperEyebrow: '可选的深入来源', deeperTitle: '110 个概念不够用时',
    deeperDescription: '这些项目提供更广泛的离线词典，但尚未包含在内置包中。',
    wiktionaryDescription: '以 ZIM 存档提供广泛的释义和翻译。', wiktionarySize: '完整英文纯文本存档：截至 2026 年 5 月约 8.5 GB。',
    freedictDescription: '面向约 45 种语言的更深入双语词典。', freedictSize: '大小和许可因语言对而异。',
    estimateNote: '外部存档大小为估算值，发布方替换快照后可能变化。', dialogNote: '指向该词，并用手势或上下文确认含义。',
    close: '关闭', loadError: '无法打开内置应急沟通包。',
  },
});

const DEFAULT_UID = Object.freeze({
  en: 'eng-000', zh: 'cmn-000', ar: 'arb-000', bn: 'ben-000', nl: 'nld-000', tl: 'tgl-000',
  fr: 'fra-000', de: 'deu-000', he: 'heb-000', hi: 'hin-000', id: 'ind-000', ja: 'jpn-000',
  ko: 'kor-000', ms: 'zsm-000', fa: 'pes-000', pl: 'pol-000', pt: 'por-000', ru: 'rus-000',
  es: 'spa-000', th: 'tha-000', tr: 'tur-000', uk: 'ukr-000', vi: 'vie-000',
});
const ESSENTIALS = new Set(['cold', 'come', 'die', 'drink', 'eat', 'fire', 'good', 'kill', 'near', 'far', 'not', 'person', 'rain', 'road', 'salt', 'sleep', 'smoke', 'walk', 'warm', 'water']);
const BODY = new Set(['belly', 'blood', 'bone', 'breast', 'ear', 'eye', 'fat', 'foot', 'hair', 'hand', 'head', 'hear', 'heart', 'knee', 'liver', 'mouth', 'neck', 'nose', 'skin', 'tongue', 'tooth']);
const PEOPLE = new Set(['I', 'man', 'many', 'one', 'person', 'that', 'this', 'two', 'we', 'what', 'who', 'woman', 'you']);

function copyForLocale() {
  return COPY[getLocale()] || COPY.en;
}

function createLanguageDisplayNameFormatters() {
  return [...new Set(['en', getLocale()])].flatMap(locale => {
    try { return [new Intl.DisplayNames([locale], { type: 'language' })]; } catch { return []; }
  });
}

let currentCopy = copyForLocale();
let languageDisplayNameFormatters = createLanguageDisplayNameFormatters();
let currentThemeMode = 'system';
loadMode().then(mode => { currentThemeMode = mode; applyMode(mode, { syncStorage: false }); });
watch(() => currentThemeMode);
const runtimeApi = globalThis.browser || globalThis.chrome;
runtimeApi?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local' || !changes.themeMode) return;
  const next = changes.themeMode.newValue;
  if (THEME_MODES.includes(next)) currentThemeMode = next;
});

const elements = Object.fromEntries([
  'language-input', 'language-toggle', 'language-menu', 'language-results', 'language-options',
  'concept-search', 'language-name', 'language-meta', 'coverage-count',
  'group-nav', 'concept-list', 'concept-count', 'language-count', 'variety-count', 'word-dialog',
  'dialog-language', 'dialog-term', 'dialog-english',
].map(id => [id, document.getElementById(id)]));

let lexicon;
let selectedLanguage;
let selectedGroup = 'all';
let languageLabels = new Map();
let languageRows = [];
let filteredLanguageRows = [];
let highlightedLanguageIndex = -1;
let languagePickerOpen = false;

function applyCopy() {
  document.querySelectorAll('[data-copy]').forEach(node => {
    const value = currentCopy[node.dataset.copy];
    if (value) node.textContent = value;
  });
  document.documentElement.lang = getLocale();
  elements['language-input'].placeholder = currentCopy.languagePlaceholder;
  elements['language-toggle'].ariaLabel = currentCopy.showLanguages;
  elements['language-options'].ariaLabel = currentCopy.languageOptionsLabel;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function interpolate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

function languageLabel(language) {
  return `${language.name} · ${language.iso} · ${language.script} · ${language.uid}`;
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}

function languageAliases(language) {
  const aliases = [language.name, language.iso, language.script, language.uid];
  for (const formatter of languageDisplayNameFormatters) {
    try {
      const displayName = formatter.of(language.iso);
      if (displayName && displayName !== language.iso) aliases.push(displayName);
    } catch {}
  }
  return [...new Set(aliases.filter(Boolean).map(normalizeSearch))];
}

function rebuildLanguageIndex() {
  if (!lexicon) return;
  languageLabels = new Map(lexicon.languages.map(language => [languageLabel(language), language]));
  languageRows = lexicon.languages.map((language, index) => {
    const aliases = languageAliases(language);
    return { language, index, aliases, searchText: aliases.join(' ') };
  });
}

function languageMatchScore(row, query) {
  if (row.aliases.includes(query)) return 0;
  if (row.aliases.some(alias => alias.startsWith(query))) return 1;
  return 2;
}

function filterLanguageRows(query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return languageRows;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return languageRows
    .filter(row => tokens.every(token => row.searchText.includes(token)))
    .map(row => ({ row, score: languageMatchScore(row, normalized) }))
    .sort((a, b) => a.score - b.score || a.row.index - b.row.index)
    .map(result => result.row);
}

function setLanguageHighlight(index, { scroll = true } = {}) {
  const count = filteredLanguageRows.length;
  highlightedLanguageIndex = count ? ((index % count) + count) % count : -1;
  elements['language-options'].querySelectorAll('[role="option"]').forEach((option, optionIndex) => {
    option.dataset.highlighted = String(optionIndex === highlightedLanguageIndex);
  });
  const activeOption = highlightedLanguageIndex >= 0
    ? elements['language-options'].querySelector(`[data-option-position="${highlightedLanguageIndex}"]`)
    : null;
  if (activeOption) {
    elements['language-input'].setAttribute('aria-activedescendant', activeOption.id);
    if (scroll) activeOption.scrollIntoView({ block: 'nearest' });
  } else {
    elements['language-input'].removeAttribute('aria-activedescendant');
  }
}

function renderLanguageOptions(query = '') {
  filteredLanguageRows = filterLanguageRows(query);
  elements['language-results'].textContent = interpolate(currentCopy.languageResults, {
    shown: filteredLanguageRows.length.toLocaleString(),
    total: languageRows.length.toLocaleString(),
  });
  if (!filteredLanguageRows.length) {
    elements['language-options'].innerHTML = `<div class="language-empty">${escapeHtml(currentCopy.noLanguageMatches)}</div>`;
    setLanguageHighlight(-1, { scroll: false });
    return;
  }
  elements['language-options'].innerHTML = filteredLanguageRows.map((row, position) => {
    const language = row.language;
    return `<button type="button" id="language-option-${row.index}" class="language-option" role="option" tabindex="-1" data-language-index="${row.index}" data-option-position="${position}" aria-selected="${String(language.uid === selectedLanguage?.uid)}">
      <span class="language-option-name" dir="auto">${escapeHtml(language.name)}</span>
      <span class="language-option-meta">${escapeHtml(`${language.iso} · ${language.script} · ${language.uid}`)}</span>
    </button>`;
  }).join('');
  const selectedIndex = filteredLanguageRows.findIndex(row => row.language.uid === selectedLanguage?.uid);
  setLanguageHighlight(normalizeSearch(query) ? 0 : Math.max(0, selectedIndex), { scroll: false });
}

function openLanguagePicker({ showAll = false } = {}) {
  if (!lexicon) return;
  if (showAll && selectedLanguage) elements['language-input'].value = languageLabel(selectedLanguage);
  const selectedLabel = selectedLanguage ? languageLabel(selectedLanguage) : '';
  const query = showAll || elements['language-input'].value === selectedLabel ? '' : elements['language-input'].value;
  renderLanguageOptions(query);
  languagePickerOpen = true;
  elements['language-menu'].hidden = false;
  elements['language-input'].setAttribute('aria-expanded', 'true');
  elements['language-toggle'].setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => setLanguageHighlight(highlightedLanguageIndex));
}

function closeLanguagePicker({ restoreSelection = false } = {}) {
  languagePickerOpen = false;
  elements['language-menu'].hidden = true;
  elements['language-input'].setAttribute('aria-expanded', 'false');
  elements['language-toggle'].setAttribute('aria-expanded', 'false');
  elements['language-input'].removeAttribute('aria-activedescendant');
  if (restoreSelection && selectedLanguage) elements['language-input'].value = languageLabel(selectedLanguage);
}

function conceptGroup(concept) {
  if (ESSENTIALS.has(concept)) return 'essential';
  if (BODY.has(concept)) return 'body';
  if (PEOPLE.has(concept)) return 'people';
  return 'surroundings';
}

function chooseLanguage(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase();
  if (!normalized || !lexicon) return null;
  return languageLabels.get(value)
    || lexicon.languages.find(language => language.uid.toLocaleLowerCase() === normalized)
    || lexicon.languages.find(language => language.iso.toLocaleLowerCase() === normalized)
    || lexicon.languages.find(language => language.name.toLocaleLowerCase() === normalized)
    || lexicon.languages.find(language => languageLabel(language).toLocaleLowerCase().includes(normalized))
    || null;
}

function render() {
  if (!lexicon || !selectedLanguage) return;
  const query = elements['concept-search'].value.trim().toLocaleLowerCase();
  const cards = lexicon.concepts.map((concept, index) => ({
    concept,
    index,
    terms: selectedLanguage.terms[index] || [],
    group: conceptGroup(concept),
  })).filter(card => (selectedGroup === 'all' || card.group === selectedGroup)
    && (!query || card.concept.toLocaleLowerCase().includes(query)
      || card.terms.some(term => term.toLocaleLowerCase().includes(query))));
  const available = selectedLanguage.terms.filter(terms => terms.length).length;
  elements['language-name'].textContent = selectedLanguage.name;
  elements['language-meta'].textContent = `${selectedLanguage.iso} · ${selectedLanguage.script} · ${selectedLanguage.uid}`;
  elements['coverage-count'].textContent = interpolate(currentCopy.coverage, { available, total: lexicon.conceptCount });
  elements['concept-list'].innerHTML = cards.length ? cards.map(card => {
    const translation = card.terms.length ? card.terms.join(' · ') : currentCopy.missing;
    return `<article class="concept-card" data-available="${String(card.terms.length > 0)}">
      <div class="concept-number">${String(card.index + 1).padStart(3, '0')}</div>
      <div class="concept-copy">
        <span class="english-term">${escapeHtml(card.concept)}</span>
        <strong class="translated-term" dir="auto">${escapeHtml(translation)}</strong>
      </div>
      <button type="button" data-show-index="${card.index}"${card.terms.length ? '' : ' disabled'}>${escapeHtml(currentCopy.showLarge)}</button>
    </article>`;
  }).join('') : `<div class="empty-state">${escapeHtml(currentCopy.noMatches)}</div>`;
}

function selectLanguage(language, { closePicker = true } = {}) {
  if (!language) return;
  selectedLanguage = language;
  elements['language-input'].value = languageLabel(language);
  if (closePicker) closeLanguagePicker();
  render();
}

function showWord(index) {
  const concept = lexicon.concepts[index];
  const terms = selectedLanguage?.terms[index] || [];
  if (!concept || !terms.length) return;
  elements['dialog-language'].textContent = `${selectedLanguage.name} · ${selectedLanguage.script}`;
  elements['dialog-term'].textContent = terms.join(' · ');
  elements['dialog-english'].textContent = `English: ${concept}`;
  elements['word-dialog'].showModal();
}

elements['language-input'].addEventListener('focus', () => openLanguagePicker({
  showAll: Boolean(selectedLanguage && elements['language-input'].value === languageLabel(selectedLanguage)),
}));
elements['language-input'].addEventListener('click', () => {
  const showingSelection = Boolean(selectedLanguage && elements['language-input'].value === languageLabel(selectedLanguage));
  openLanguagePicker({ showAll: showingSelection });
  if (showingSelection) elements['language-input'].select();
});
elements['language-input'].addEventListener('input', () => openLanguagePicker());
elements['language-input'].addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!languagePickerOpen) openLanguagePicker();
    else setLanguageHighlight(highlightedLanguageIndex + (event.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (languagePickerOpen && (event.key === 'Home' || event.key === 'End')) {
    event.preventDefault();
    setLanguageHighlight(event.key === 'Home' ? 0 : filteredLanguageRows.length - 1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const highlighted = filteredLanguageRows[highlightedLanguageIndex]?.language;
    selectLanguage(highlighted || chooseLanguage(elements['language-input'].value));
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLanguagePicker({ restoreSelection: true });
    elements['language-input'].select();
    return;
  }
  if (event.key === 'Tab') closeLanguagePicker({ restoreSelection: true });
});
elements['language-toggle'].addEventListener('click', () => {
  if (languagePickerOpen) {
    closeLanguagePicker({ restoreSelection: true });
    return;
  }
  elements['language-input'].focus();
  openLanguagePicker({ showAll: true });
  elements['language-input'].select();
});
elements['language-options'].addEventListener('click', event => {
  const option = event.target.closest('[data-language-index]');
  if (!option) return;
  selectLanguage(lexicon.languages[Number(option.dataset.languageIndex)]);
});
document.addEventListener('pointerdown', event => {
  if (languagePickerOpen && !event.target.closest('.language-combobox')) {
    closeLanguagePicker({ restoreSelection: true });
  }
});
elements['concept-search'].addEventListener('input', render);
elements['group-nav'].addEventListener('click', event => {
  const button = event.target.closest('[data-group]');
  if (!button) return;
  selectedGroup = button.dataset.group;
  elements['group-nav'].querySelectorAll('[data-group]').forEach(candidate => candidate.classList.toggle('active', candidate === button));
  render();
});
elements['concept-list'].addEventListener('click', event => {
  const button = event.target.closest('[data-show-index]');
  if (button) showWord(Number(button.dataset.showIndex));
});
document.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => elements['word-dialog'].close()));
elements['word-dialog'].addEventListener('click', event => {
  if (event.target === elements['word-dialog']) elements['word-dialog'].close();
});

document.addEventListener('wb-locale-changed', () => {
  const selectedLabel = selectedLanguage ? languageLabel(selectedLanguage) : '';
  const pickerQuery = languagePickerOpen && elements['language-input'].value !== selectedLabel
    ? elements['language-input'].value
    : '';
  currentCopy = copyForLocale();
  languageDisplayNameFormatters = createLanguageDisplayNameFormatters();
  applyCopy();
  if (!lexicon) return;
  rebuildLanguageIndex();
  elements['concept-count'].textContent = lexicon.conceptCount.toLocaleString(getLocale());
  elements['language-count'].textContent = lexicon.languageCount.toLocaleString(getLocale());
  elements['variety-count'].textContent = lexicon.varietyCount.toLocaleString(getLocale());
  if (languagePickerOpen) renderLanguageOptions(pickerQuery);
  else if (selectedLanguage) elements['language-input'].value = languageLabel(selectedLanguage);
  render();
});

applyCopy();
try {
  const response = await fetch('./data/panlex-swadesh-110.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  lexicon = await response.json();
  elements['concept-count'].textContent = lexicon.conceptCount.toLocaleString();
  elements['language-count'].textContent = lexicon.languageCount.toLocaleString();
  elements['variety-count'].textContent = lexicon.varietyCount.toLocaleString();
  rebuildLanguageIndex();
  const preferredUid = DEFAULT_UID[getLocale()] || 'eng-000';
  selectLanguage(lexicon.languages.find(language => language.uid === preferredUid)
    || lexicon.languages.find(language => language.uid === 'eng-000') || lexicon.languages[0], { closePicker: false });
} catch (error) {
  console.error('Emergency communication pack failed to load:', error);
  elements['concept-list'].innerHTML = `<div class="empty-state">${escapeHtml(currentCopy.loadError)}</div>`;
}
