/** Tool freshness policy for passive page observations. Mirror in Firefox. */
import { calculateExpression, calculationExpressionSpans, calculationResultInText, tokenizeCalculationExpression } from './calculator.js';

const FRESH_READS = new Set([
  'get_accessibility_tree', 'get_interactive_elements', 'read_page', 'read_page_source',
  'extract_data', 'get_selection', 'get_shadow_dom', 'shadow_dom_query', 'get_frames',
  'iframe_read', 'get_window_info', 'list_webmcp_tools', 'inspect_viewport', 'screenshot',
  'wait_for_element', 'wait_for_stable', 'read_console', 'inspect_network_requests',
  'inspect_element_styles', 'verify_form', 'chat_observe', 'read_pdf', 'get_captcha_capabilities', 'find_text',
]);
const DETACHED_TOOLS = new Set([
  'calculate', 'list_downloads', 'read_downloaded_file', 'scratchpad_write', 'progress_read',
  'progress_update', 'recall_memcode', 'clarify', 'generate_image', 'schedule_task', 'schedule_resume', 'resize_window',
]);
const AX_ACTIONS = new Set(['click_ax', 'type_ax', 'set_field', 'set_checked']);
export function literalCalculationTaskExpression(task, scope) {
  // The lexer also recognizes adjacent numeric tokens such as "1 2".
  // Reuse the bounded calculator parser to reject invalid candidates. Its
  // result is discarded; this creates no tool evidence or completion receipt.
  const candidates = calculationExpressionSpans(task).filter(expression =>
    isLiteralCalculationTask(task, expression, scope) && calculateExpression(expression).success === true);
  return candidates.length === 1 ? candidates[0] : null;
}
// Complete explicit replacement instructions can prohibit page work without
// requiring the word "only". Every suffix clause is matched in full; a later
// affirmative action cannot inherit negation. This is task grammar, not proof.
function replacementCalculationOutputRequirements(before, after) {
  if (!/^(?:(?:stop|cancel|abandon)\s+(?:the\s+)?(?:previous|prior|earlier|old|current)\s+(?:(?:page|chat)\s+)?(?:inspection\s+)?task[.;]\s*)?(?:new|replacement)\s+task:\s*(?:use\s+(?:the\s+)?calculate(?:\s+tool)?\s+to\s+)?(?:calculate|compute|evaluate)$/iu.test(before)) return null;
  const clauses = after.split(/[.;]/u).map(value => value.trim()).filter(Boolean);
  const output = (clauses.shift() || '').replace(/^exactly(?:\s*,)?\s+/iu, '').replace(/^then\s+/iu, '');
  if (!/^(?:report|return|show|give|output)\s+(?:(?:the|its)\s+)?(?:(?:exact|precise|decimal|numeric)\s+)*(?:result|value|answer)(?:\s+and\s+(?:then\s+)?(?:finish|end))?$/iu.test(output)) return null;
  const prohibitedAction = '(?:(?:inspect|read|open|browse|navigate to|interact with)\\s+(?:(?:any|the|current|another)\\s+)?(?:chat|conversation|page|website|webpage|site|account|browser)s?|send\\s+(?:any\\s+)?messages?)';
  const prohibition = new RegExp("^(?:do not|don't|never)\\s+" + prohibitedAction + '(?:\\s+(?:or|and)\\s+' + prohibitedAction + ')*$', 'iu');
  if (clauses.some(value => !prohibition.test(value))) return null;
  return { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false };
}

// A literal expression and a narrow instruction wrapper establish that the
// answer does not depend on live page data. Other deliverables stay excluded.
export function isLiteralCalculationTask(task, expression, { readScope = null, deliverables = [] } = {}) {
  if (typeof task !== 'string' || typeof expression !== 'string' || !expression.trim()
      || task.length > 6000 || expression.length > 6000) return false;
  const normalized = task.trim().replace(/\s+/g, ' ');
  let tokens, matches;
  try {
    tokens = tokenizeCalculationExpression(expression);
    const escaped = tokens.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Whitespace may separate tokens, never change a number, exponent or name.
    // A final sentence period is wrapper punctuation; a continuing decimal is
    // part of the arithmetic token and cannot be matched as a shorter number.
    const pattern = new RegExp('(?<![\\p{L}\\p{N}_.])' + escaped.join('\\s*')
      + '(?![\\p{L}\\p{N}_]|\\.\\d)', 'gu');
    matches = [...normalized.matchAll(pattern)].filter(match => {
      const actual = tokenizeCalculationExpression(match[0]);
      return actual.length === tokens.length && actual.every((value, index) => value === tokens[index]);
    });
  } catch { return false; }
  if (matches.length !== 1) return false;
  const start = matches[0].index, end = start + matches[0][0].length;
  const before = normalized.slice(0, start).trim(), after = normalized.slice(end).trim();
  if (/^(?:(?:cancel (?:the )?(?:(?:current|previous) )?(?:page inspection|task))[.;:]?\s*)?(?:only\s+)?(?:calculate|compute)\s*:?$/i.test(before)
      && /^(?:[.;]?\s*(?:do not|don't) interact with (?:the )?page[.]?|[.;]?)$/i.test(after)) return true;
  // Broader natural instructions additionally need the current planner's
  // explicit no-page-read intent and arithmetic/output-only deliverables.
  // These facts tighten retention; they never authorize another tool or skip
  // the terminal completion gate.
  const otherWork = /\b(?:read|open|browse|inspect|interact|click|type|enter|write|fill|post|publish|send|submit|save|upload|download|fetch|research|schedule|navigate|scroll|visit|reply|tell|translate|summarize|draft|compose|search|find|locate|email|edit|modify|create|solve|analyze|explain|book|buy|purchase|order|pay|transfer|delete|remove|cancel|okuyun|oku|aç|tıkla|gönder|paylaş|yayımla|kaydet|indir|yükle|zamanla|sil|enviar|publicar|abrir|leer|guardar|comprar|borrar|hochladen|senden|öffne|lesen|buche|kaufe|lösche|envoyer|publier|ouvrir|lire|achète|supprime)\b|发送|發送|发布|發佈|上传|下載|下载|读取|開く|送信|投稿/iu;
  const externalInput = /\b(?:page|browser|website|webpage|site|account|chat|conversation|file|downloaded|uploaded|document|report|spreadsheet|sayfa|tarayıcı|hesap|sohbet|dosya|webseite|konto|datei)\b/iu;
  // A final answer's literal ending is output formatting, not a message-send
  // obligation. Match the complete bounded description; reply to a recipient
  // or additional page work must still reject this narrow arithmetic scope.
  const responseFormatDeliverable = /^(?:(?:a|the)\s+)?(?:final\s+)?(?:reply|response|answer)\s+(?:ending|finishing)\s+with\s+(?:marker\s+)?[A-Z][A-Z0-9_-]{2,79}[.]?$/iu;
  if (readScope !== 'none' || !Array.isArray(deliverables) || !deliverables.length || deliverables.length > 8
      || deliverables.some(value => typeof value !== 'string' || value.length > 1000
        || !/(?:arithmet|calculat|numeric|decimal|result|value|marker|format|hesap|sonuç|değer|etiket|işaret|ergebnis|wert|rechnung|résultat|calcul|resultado|valor|计算|结果|計算|結果)/iu.test(value)
        || (!responseFormatDeliverable.test(value) && (otherWork.test(value) || externalInput.test(value))))) return false;
  if (replacementCalculationOutputRequirements(before, after)) return true;
  const arithmetic = /(?:\b(?:calculate|compute|evaluate|hesapla|hesaplayın|calcula|calcule|berechne)\b|计算|計算)/iu;
  const exclusive = /(?:\b(?:only|just|solely|yalnızca|sadece|seulement|nur|solo|apenas|только)\b|只|のみ|だけ)/iu;
  if (!arithmetic.test(normalized) || !exclusive.test(before)
      || /\b(?:says|said|quoted|quote|contains|instructs|asks)\b/iu.test(before)) return false;
  const work = new RegExp(otherWork.source, 'giu');
  // Negation is limited to its own clause, and a later affirmative contrast
  // cannot inherit it. Cancellation of earlier work has the same boundary.
  for (const clause of normalized.split(/[.;\n]/u)) {
    for (const match of clause.matchAll(work)) {
      const preceding = clause.slice(0, match.index).split(/\b(?:and|but|then|however|instead|ve|sonra|ama|und|et|puis|mais|dann|aber)\b/iu).at(-1);
      if (!/(?:\b(?:do not|don't|never|must not|should not|no)\b|不要|勿|しない)/iu.test(preceding)
          && !(match[0].toLowerCase() === 'cancel' && /^\s+(?:the\s+)?(?:previous|prior|earlier|old)\b/iu.test(clause.slice(match.index + match[0].length)))
          && !/\b(?:abandon|cancel|ignore|forget)\b[^;]*\b(?:previous|prior|earlier|old)\b[^;]*$/iu.test(preceding)) return false;
    }
  }
  // The trailing instruction may format/report this result, not request a
  // second task or another input. Literal response markers are plain data;
  // their digits must not be mistaken for arithmetic inputs.
  const suffix = after.replace(/\b(?:marker|tag|code|etiket|işaret|markierung|marqueur|marcador)\s*(?:[:=]\s*)?(?:"[^"\n]{1,80}"|'[^'\n]{1,80}'|\u0060[^\u0060\n]{1,80}\u0060|[A-Za-z0-9_.:-]{1,80})/giu, ' marker ')
    .replace(/\b((?:[Ff]inish|[Ee]nd)\s+with)\s+["'\u0060]?([A-Z][A-Z0-9_-]{2,79})["'\u0060]?(?=[.;\s]|$)/gu, '$1 marker')
    .replace(/[()[\]{}"'\u0060:,\s]+/gu, ' ').trim();
  const outputClause = /^(?:(?:and|then|please|finally|ve|und|et)\s+)?(?:report|return|show|give|output|answer|finish|end|respond|append|include|use\s+(?:the\s+)?(?:actual\s+)?calculate|call\s+calculate|(?:after|if|when)\s+(?:the\s+)?(?:actual\s+)?(?:calculate|calculation|tool)|do not|don't|never|must not|the\s+(?:(?:final|user visible|assistant)\s+)?(?:answer|response)|you\s+(?:must|should)\s+(?:report|return|show|finish)|(?:tam|kesin|ondalık|sayısal)\s+(?:sonucu|değeri)|hesapla|hesaplayın|gib|beende|berechne|retourne|termine|calcule|devuelve|termina|calcula)\b/iu;
  const clauses = suffix.split(/[.;\n]/u).map(value => value.trim()).filter(Boolean);
  // Validate the complete output instruction, not just its first verb. An
  // unknown request such as "return the result and DM someone" must retain the
  // ordinary page-dependent completion path even if a planner misclassified it.
  const prefixWords = new Set('change of task changeoftask abandon cancel ignore forget the previous prior old earlier current existing unfinished telegram whatsapp browser page site tab conversation chat inspection inspect read reading request instructions goal work act do not don\'t dont never must should no please and but instead only just solely new this that is to using with actual tool calculate calculator calculation compute evaluate arithmetic expression value input literal use call execute nothing anything any interaction action actions interact send post click type open from now it switch replace replaced replacement change abort stop unrelated abandontelegram completely or your exactly'.split(' '));
  const outputWords = new Set('its a an the actual tool calculate calculator calculation arithmetic expression exact precise decimal numeric result results value output answer response final user visible assistant report return show give finish end respond append include use call after if when returns returned has have had produced produces completed succeeds succeeded successful success and then please finally only just solely with marker tag code do not don\'t dont never must should rounding digits format formatted formatting as print text in plain no browser page interact interaction action actions say claim completion before executing'.split(' '));
  for (const value of ['sadece', 'yalnızca', 'hesapla', 'hesaplayın', 'tam', 'kesin', 'ondalık', 'sayısal', 'sonucu', 'sonuç', 'değeri', 'bildir', 've', 'ile', 'bitir',
    'berechne', 'nur', 'gib', 'das', 'exakte', 'ergebnis', 'zurück', 'und', 'beende', 'mit',
    'calcule', 'seulement', 'retourne', 'le', 'résultat', 'et', 'termine', 'avec',
    'calcula', 'solo', 'devuelve', 'el', 'resultado', 'valor', 'y', 'termina', 'con']) {
    prefixWords.add(value); outputWords.add(value);
  }
  const knownWords = (value, words) => [...value.matchAll(/[\p{L}\p{N}_]+/gu)].every(match => words.has(match[0].toLowerCase()));
  return !!clauses.length && clauses.every(value => outputClause.test(value))
    && knownWords(before, prefixWords) && knownWords(suffix, outputWords)
    && !externalInput.test(suffix.replace(/\breport\b/giu, ''))
    // Additional numeric inputs need their own evidence. The bounded marker
    // above is output data, so its digits do not create another calculation.
    && !/\d/u.test(before + ' ' + suffix)
    && !/\bdone\s*[(\{:]/iu.test(normalized);
}

// Formatting is genuine task data, never tool evidence or a completion grant.
// The full arithmetic-only grammar above must accept the task first.
export function literalCalculationOutputRequirements(task, expression, scope) {
  if (!isLiteralCalculationTask(task, expression, scope)) return null;
  const requirements = { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false };
  const normalized = task.trim().replace(/\s+/g, ' ');
  const tokens = tokenizeCalculationExpression(expression).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const arithmetic = new RegExp('(?<![\\p{L}\\p{N}_.])' + tokens.join('\\s*') + '(?![\\p{L}\\p{N}_]|\\.\\d)', 'gu');
  const match = [...normalized.matchAll(arithmetic)][0];
  if (!match) return null;
  let suffix = normalized.slice(match.index + match[0].length).trim();
  const replacement = replacementCalculationOutputRequirements(normalized.slice(0, match.index).trim(), suffix);
  if (replacement) return replacement;
  // Recognize complete output clauses, rather than treating known vocabulary
  // as proof that an arbitrary formatting obligation has been satisfied.
  const marker = /\b(?:marker|tag|code|etiket|işaret)\s*(?:[:=]\s*)?(?:"([^"\n]{1,80})"|'([^'\n]{1,80})'|`([^`\n]{1,80})`|([A-Za-z0-9_:-]{1,80}))/giu;
  suffix = suffix.replace(marker, (_whole, ...groups) => {
    const value = groups.slice(0, 4).find(item => item != null);
    const index = requirements.markers.push(value) - 1; return ' marker_' + index + ' ';
  });
  suffix = suffix.replace(/\b(?:[Ff]inish|[Ee]nd)\s+with\s+(?:"([^"\n]{1,80})"|'([^'\n]{1,80})'|`([^`\n]{1,80})`|([A-Z][A-Z0-9_-]{2,79}))(?=[.;\s]|$)/gu,
    (_whole, ...groups) => { const value = groups.slice(0, 4).find(item => item != null);
      const index = requirements.markers.push(value) - 1; return 'finish with marker_' + index; });
  const clauses = suffix.split(/[.;]/u).map(value => value.trim()).filter(Boolean);
  const result = '(?:(?:the|its)\\s+)?(?:(?:exact|precise|decimal|numeric)\\s+)*(?:result|value|answer)';
  const report = new RegExp('^(?:report|return|show|give|output|answer)\\s+(?:(only|just)\\s+)?' + result + '(?:\\s+(only|just))?(?:\\s+and\\s+(finish|end)\\s+with\\s+(marker_\\d+|' + result + '))?$', 'iu');
  const finish = value => {
    const markerIndex = /^marker_(\d+)$/u.exec(value);
    const literal = markerIndex ? requirements.markers[Number(markerIndex[1])] : null;
    if (!literal || (requirements.suffix && requirements.suffix !== literal)) return false;
    requirements.suffix = literal; return true;
  };
  for (let clause of clauses) {
    clause = clause.replace(/^(?:(?:and|then|please|finally)\s+)?(?:after\s+(?:the\s+)?actual\s+tool\s+succeeds,\s*)?/iu, '').trim();
    const output = clause.match(report);
    if (output) {
      if (output[1] || output[2]) requirements.onlyScalar = true;
      if (output[3]) {
        if (/^marker_/u.test(output[4])) { if (!finish(output[4])) return null; }
        else requirements.scalarAtEnd = true;
      }
      continue;
    }
    const finishMarker = clause.match(/^(?:finish|end)\s+with\s+(marker_\d+)$/iu)
      || clause.match(/^(?:tam|kesin|ondalık|sayısal)\s+(?:sonucu|değeri)\s+bildir\s+ve\s+(marker_\d+)\s+ile\s+bitir$/iu);
    if (finishMarker) {
      if (!finish(finishMarker[1])) return null; continue;
    }
    if (new RegExp('^(?:finish|end)\\s+with\\s+' + result + '$', 'iu').test(clause)) { requirements.scalarAtEnd = true; continue; }
    const append = clause.match(/^append\s+(?:the\s+)?(marker_\d+)$/iu);
    if (append) { if (!finish(append[1])) return null; continue; }
    if (/^include\s+(?:the\s+)?marker_\d+$/iu.test(clause)) continue;
    if (/^(?:do not|don't)\s+(?:claim completion before executing calculate|interact with (?:the )?page)$/iu.test(clause)) continue;
    return null;
  }
  requirements.markers = [...new Set(requirements.markers)];
  if (requirements.onlyScalar && (requirements.markers.length || requirements.suffix)) return null;
  return requirements;
}

export function literalCalculationSummaryFormatMatches(summary, requirements, result, fraction) {
  const literalPresent = value => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[\p{L}\p{N}_]/u.test(value) ? '(?<![\\p{L}\\p{N}_])' : '';
    const right = /[\p{L}\p{N}_]$/u.test(value) ? '(?![\\p{L}\\p{N}_])' : '';
    return new RegExp(left + escaped + right, 'u').test(summary);
  };
  const suffixPresent = value => {
    const text = summary.trimEnd();
    return text.endsWith(value) && (!/^[\p{L}\p{N}_]/u.test(value)
      || !/[\p{L}\p{N}_]$/u.test(text.slice(0, -value.length)));
  };
  return typeof summary === 'string' && !!requirements
    && requirements.markers.every(literalPresent)
    && (!requirements.suffix || suffixPresent(requirements.suffix))
    && (!(requirements.onlyScalar || requirements.scalarAtEnd) || calculationResultInText(summary, result, fraction,
      { onlyScalar: requirements.onlyScalar, atEnd: requirements.scalarAtEnd }));
}
// A candidate only: the isolated monitor must validate the private snapshot
// captured together with the page observation before the model made this call.
const BOUND_ACTIONS = new Set(['click', 'click_ax', 'type_text', 'type_ax', 'set_field', 'set_checked',
  'press_keys', 'hover', 'upload_file']);
function hasBoundTarget(name, args, state) {
  return BOUND_ACTIONS.has(name) && !!state.actionBinding?.snapshotToken
    && !Number.isFinite(args.x) && !Number.isFinite(args.y)
    && (args.frameId == null || Number(args.frameId) === 0)
    && (args.targetFrame == null || Number(args.targetFrame) === 0)
    && !args.allFrames && !args.all && !args.urlFilter
    && (/^ref_[A-Za-z0-9_-]+$/.test(args.ref_id || '')
      || (typeof args.selector === 'string' && !!args.selector.trim())
      || (['type_text', 'press_keys'].includes(name) && !args.ref_id && !args.selector
        && state.actionBinding.focusedTargetAvailable === true));
}
const httpUrl = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export function isPassivePageFeedback(events) {
  return !!events?.length && events.every(event => event.kind === 'dom' && event.source === 'page'
    && event.frameId === 0 && !/^(?:base|style|link)(?:$|[\s#.])/.test(event.target || ''));
}

function axTargetContext(page, refId) {
  if (!page || page.success === false || page.depthTruncated || page.truncated || !/^ref_[A-Za-z0-9_-]+$/.test(refId || '')) return null;
  const lines = String(page.pageContent || '').split(/\r?\n/);
  const indices = lines.flatMap((line, index) => line.includes(`[${refId}]`) ? [index] : []);
  if (indices.length !== 1) return null;
  const index = indices[0], line = lines[index];
  if (/\b(?:occluded|disabled|inert)=true\b/.test(line)) return null;
  let depth = line.length - line.trimStart().length;
  const ancestors = [];
  let scope = index, scopeRole = '';
  let navigation = false;
  const href = /\bhref=("(?:\\.|[^"\\])*")/.exec(line);
  if (/^\s*link\b/.test(line) && href) {
    try { navigation = !!httpUrl(new URL(JSON.parse(href[1]), page.url).href); } catch {}
  }
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    const ancestorDepth = lines[i].length - lines[i].trimStart().length;
    if (lines[i].trim() && ancestorDepth < depth) {
      ancestors.unshift(lines[i]); depth = ancestorDepth;
      // A form/dialog/region binds the action to its recipient/composer/entity,
      // not just to a same-labelled control elsewhere on the document.
      const role = /^\s*(form|dialog|region|article|listitem)\b/.exec(lines[i])?.[1];
      if (!navigation && role && (scope === index || (scopeRole === 'form' && role !== 'form'))) {
        scope = i; scopeRole = role;
      }
    }
  }
  const scopeDepth = lines[scope].length - lines[scope].trimStart().length;
  let end = scope + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > scopeDepth)) end++;
  // Conversation/entity headings often sit outside the composer form.
  // Bind their full AX subtree just as the local monitor does, so an unchanged
  // control cannot silently transfer to another recipient or resource.
  const headings = [];
  if (!navigation) for (let i = 0; i < lines.length; i++) {
    if (!/^\s*heading\b/.test(lines[i])) continue;
    const headingDepth = lines[i].length - lines[i].trimStart().length;
    let last = i + 1;
    while (last < lines.length && (!lines[last].trim() || lines[last].length - lines[last].trimStart().length > headingDepth)) last++;
    headings.push(lines.slice(i, last));
  }
  return { line, context: JSON.stringify([ancestors, lines.slice(scope, end), headings]) };
}

export function pageFeedbackCallPolicy(name, args = {}, state = {}, currentPage = null, events = []) {
  if (FRESH_READS.has(name)) return { kind: 'observe' };
  if (DETACHED_TOOLS.has(name)) return { kind: 'independent' };
  if (['fetch_url', 'research_url'].includes(name) && httpUrl(args.url)
      && ['GET', 'HEAD'].includes(String(args.method || 'GET').toUpperCase())
      && !args.replayRequestId && !args.body) return { kind: 'independent' };
  if (['download_files', 'download_file'].includes(name)) {
    // Match the handler's singular-URL alias and precedence exactly. Page churn
    // does not alter a concrete resource URL already supplied to the download.
    const urls = Array.isArray(args.urls) && args.urls.length ? args.urls : args.url ? [args.url] : [];
    if (urls.length && urls.every(httpUrl)) return { kind: 'independent' };
  }
  if (name === 'download_public_media' && (httpUrl(args.url) || httpUrl(state.url))) return { kind: 'independent' };
  if (name === 'navigate' && httpUrl(args.url)) return { kind: 'navigate' };
  // Ask exposes a summary-only done schema. Its answer can come from completed
  // detached research, so unrelated counters (or a failed AX refresh) do not
  // require a new inference. The run mode is private pre-inference state.
  const askSummary = state.runMode === 'ask'
    && !Object.prototype.hasOwnProperty.call(args, 'outcome')
    && typeof args.summary === 'string' && !!args.summary.trim();
  if (name === 'done' && (askSummary || ['partial', 'failed'].includes(args.outcome)
      || (args.outcome === 'success' && (currentPage?.success !== false
        || state.pureCalculationComplete === true)))) return { kind: 'observe', terminal: true };
  if (name === 'download_social_media' && !args.scroll && !args.all
      && [undefined, 'main', 'auto'].includes(args.mode)
      && [undefined, 'dom', 'auto'].includes(args.strategy)
      && (args.limit == null || args.limit === 1)) {
    const target = !args.target || args.target === 'media' ? 'auto' : args.target;
    if (['auto', 'image', 'video'].includes(target)) {
      const binding = state.mediaBindings?.[target];
      if (binding && (args.mode === 'main' || binding.focused)) return { kind: 'media', binding, target };
      // An unavailable optional precapture is not a changed page. Dispatch a
      // read-only resolver result so the model can inspect actual media sources;
      // this policy never permits an unbound fetch/save or a fallback mutation.
      return { kind: 'media_resolve', target, reason: binding ? 'focus_unverified' : 'media_binding_missing' };
    }
  }
  if (hasBoundTarget(name, args, state)) return { kind: 'bound_target' };
  if (!AX_ACTIONS.has(name) || !currentPage || events.some(event => /^(?:form|input|textarea|select|option)(?:$|[\s#.])/.test(event.target || ''))) return { kind: 'unsafe' };
  const before = axTargetContext(state.page && { ...state.page, url: state.page.url || state.url }, args.ref_id);
  const after = axTargetContext({ ...currentPage, url: currentPage.url || state.url }, args.ref_id);
  if (!before || before.context !== after?.context) return { kind: 'unsafe' };
  // Submissions retain all existing model, form, recipient and dispatch gates.
  // A changing submit surface must be reconsidered rather than accepted from AX alone.
  if (name === 'click_ax' && /\btype="submit"/.test(after.line)) return { kind: 'unsafe' };
  return { kind: 'target' };
}

export function isPageIndependentCalculationCompletion(calls, state, events) {
  if (state?.pureCalculationComplete !== true || !state.calculationResponseScope
      || calls?.length !== 1 || !events?.length || calls[0].function?.name !== 'done') return false;
  let args;
  try { args = JSON.parse(calls[0].function.arguments); } catch { return false; }
  if (args?.outcome !== 'success') return false;
  // Spontaneous page focus remains material for browser actions. A current
  // literal calculation receipt and its terminal answer do not depend on it.
  // Physical gestures, editing, navigation and focus into a frame stay fenced.
  return events.every(event => isPassivePageFeedback([event])
    || (event.kind === 'activity' && event.source === 'page' && event.frameId === 0
      && !/^(?:iframe|frame)(?:$|[\s#.])/i.test(event.target || '')));
}

// These tools inspect the current top-level document without acting on focus.
// Read-preparation tools that can click a profile or wait/scroll remain excluded.
const PAGE_ACTIVITY_READS = new Set([
  'get_accessibility_tree', 'get_interactive_elements', 'read_page', 'read_page_source', 'verify_form',
]);
function isPageOwnedActivityRead(calls, events) {
  return !!calls?.length && calls.every(call => PAGE_ACTIVITY_READS.has(call.function?.name))
    && !!events?.length && events.every(event => isPassivePageFeedback([event])
      || (event?.kind === 'activity' && event.source === 'page' && event.frameId === 0
        && typeof event.target === 'string'
        && !/^(?:iframe|frame|base|style|link)(?:$|[\s#.])/i.test(event.target)));
}

export function canRetainPageFeedbackCalls(calls, state, currentPage, events, { pending = false } = {}) {
  if (!calls?.length || (!isPassivePageFeedback(events)
      && !isPageIndependentCalculationCompletion(calls, state, events)
      && !isPageOwnedActivityRead(calls, events))) return false;
  return calls.every(call => {
    let args;
    try { args = JSON.parse(call.function?.arguments); } catch { return false; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const policy = pageFeedbackCallPolicy(call.function?.name, args, state, currentPage, events);
    if (policy.terminal && calls.length !== 1) return false;
    // A target comparison only certifies the snapshot just read. Further DOM
    // changes require local revalidation; fresh readers/media have their own fences.
    if (pending && policy.kind === 'target') return false;
    return policy.kind !== 'unsafe';
  });
}
