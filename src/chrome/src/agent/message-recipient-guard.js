// Browser-free normalization and comparison helpers for the direct-message
// recipient guard. This file is mirrored in the Firefox tree; keep both copies
// byte-identical.

export const MESSAGE_TARGET_KINDS = new Set(['named', 'active_conversation']);
export const MESSAGE_RECIPIENT_ROLES = new Set(['to', 'cc', 'bcc']);

// Protected attachments bind one explicit source as well as the conversation.
// Do not authorize the ordinary upload handler's path/id fallback here: a
// failed lookup must not silently attach a different file to a private chat.
export function messageRecipientUploadSourceKey(args = {}) {
  const attachment = typeof args.attachmentId === 'string' ? args.attachmentId.trim() : '';
  const path = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  const hasDownload = args.downloadId != null && args.downloadId !== '';
  if (Number(!!attachment) + Number(!!path) + Number(hasDownload) !== 1) return '';
  if (attachment) return `attachment:${attachment}`;
  if (hasDownload) {
    const id = Number(args.downloadId);
    return Number.isSafeInteger(id) && id >= 0 ? `download:${id}` : '';
  }
  const absolutePath = path.startsWith('/')
    || /^[a-z]:[\\/]/i.test(path)
    || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path);
  return absolutePath && !/[\u0000-\u001f\u007f]/.test(path) ? `path:${path}` : '';
}

function compact(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
export function normalizeMessageTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const targetKind = String(value.target_kind || '').trim();
  if (!MESSAGE_TARGET_KINDS.has(targetKind)) return null;
  if (targetKind === 'active_conversation') {
    return { target_kind: targetKind, recipients: [] };
  }
  const recipients = new Map();
  const rawRecipients = Array.isArray(value.recipients)
    ? value.recipients
    : [value.recipient];
  for (const value of rawRecipients.slice(0, 16)) {
    const legacy = typeof value === 'string' || typeof value === 'number';
    const identity = compact(legacy ? value : (value?.identity ?? value?.recipient), 240);
    const role = compact(legacy ? 'to' : value?.role, 12).toLowerCase();
    const normalized = normalizeRecipientIdentity(identity);
    const key = `${role}:${normalized}`;
    if (identity && normalized && MESSAGE_RECIPIENT_ROLES.has(role) && !recipients.has(key)) {
      recipients.set(key, { identity, role });
    }
  }
  return recipients.size
    ? { target_kind: targetKind, recipients: [...recipients.values()] }
    : null;
}

export function normalizeRecipientIdentity(value) {
  const text = compact(value, 240);
  if (!text) return '';
  try {
    return text.normalize('NFKC').toLocaleLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

export function normalizeRecipientAnswer(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  try {
    return text.normalize('NFKC').toLocaleLowerCase();
  } catch {
    return text.toLowerCase();
  }
}

export function recipientMatchesObservedIdentity(recipient, observedIdentity) {
  const expected = normalizeRecipientIdentity(recipient);
  const observed = normalizeRecipientIdentity(observedIdentity);
  return !!expected && observed === expected;
}

const IDENTITY_WORD_CHAR = /[\p{L}\p{N}]/u;

let cachedWordSegmenter = null;

function getWordSegmenter() {
  if (cachedWordSegmenter) return cachedWordSegmenter;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      cachedWordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    } catch {
      cachedWordSegmenter = null;
    }
  }
  return cachedWordSegmenter;
}

export function getWordBoundaries(text) {
  const boundaries = new Set([0, text.length]);
  const segmenter = getWordSegmenter();
  if (segmenter) {
    try {
      for (const seg of segmenter.segment(text)) {
        boundaries.add(seg.index);
        boundaries.add(seg.index + seg.segment.length);
      }
    } catch {
      // fallback
    }
  }
  return boundaries;
}

/**
 * Return all start/end spans where normalizedIdentity occurs in normalizedAnswer
 * at word boundaries (including script-aware segmentation for unsegmented scripts),
 * or as an exact full-string match for short identities (< 3 chars).
 */
export function findCandidateAnswerSpans(normalizedAnswer, normalizedIdentity) {
  const answer = normalizeRecipientAnswer(normalizedAnswer);
  const identity = normalizeRecipientIdentity(normalizedIdentity);
  if (!identity || !answer) return [];
  if (identity.length < 3) {
    return answer === identity ? [{ start: 0, end: answer.length }] : [];
  }
  const boundaries = getWordBoundaries(answer);
  const spans = [];
  for (let at = answer.indexOf(identity); at >= 0; at = answer.indexOf(identity, at + 1)) {
    const end = at + identity.length;
    const before = at > 0 ? answer[at - 1] : '';
    const after = answer[end] || '';
    const charBoundary = (!before || !IDENTITY_WORD_CHAR.test(before))
      && (!after || !IDENTITY_WORD_CHAR.test(after));
    const segmentBoundary = boundaries.has(at) && boundaries.has(end);
    if (charBoundary || segmentBoundary) {
      spans.push({ start: at, end });
    }
  }
  return spans;
}

/**
 * Does the user's answer actually name this identity, rather than merely
 * containing its letters?
 *
 * A bare substring test authorizes on accidents: the observed display name
 * "Ann" is inside "I cannot decide". Requiring the match to sit against a
 * non-alphanumeric neighbour or a string edge keeps an incidental fragment
 * from standing in for the user naming someone. Identities shorter than 3
 * characters accept exact equality to authorize short names without loose
 * substring false positives.
 */
export function answerNamesIdentity(normalizedAnswer, normalizedIdentity) {
  return findCandidateAnswerSpans(normalizedAnswer, normalizedIdentity).length > 0;
}

/**
 * Verify that each observed recipient identity is matched by a distinct,
 * non-overlapping span in the user's answer.
 *
 * When one observed identity is a boundary-delimited prefix of another
 * (e.g. "Ann" and "Ann Smith", or "user@example.co" and "user@example.co.uk"),
 * a single mention must not satisfy both candidates. A distinct span is
 * required for each observed recipient identity.
 */
export function answerNamesAllObservedRecipients(normalizedAnswer, observedCandidates) {
  const answer = normalizeRecipientAnswer(normalizedAnswer);
  if (!answer || !Array.isArray(observedCandidates) || observedCandidates.length === 0) {
    return false;
  }
  const candidateGroups = [];
  const seenCanonical = new Set();
  for (const c of observedCandidates) {
    const canonical = normalizeRecipientIdentity(typeof c === 'string' ? c : (c?.identity ?? c?.recipient));
    if (!canonical || seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    const aliasList = [
      canonical,
      ...(Array.isArray(c?.aliases) ? c.aliases.map(normalizeRecipientIdentity) : []),
    ].filter(Boolean);
    candidateGroups.push([...new Set(aliasList)]);
  }
  if (candidateGroups.length === 0) return false;

  const candidateSpans = [];
  for (const aliases of candidateGroups) {
    const spans = [];
    for (const alias of aliases) {
      for (const span of findCandidateAnswerSpans(answer, alias)) {
        if (!spans.some(s => s.start === span.start && s.end === span.end)) {
          spans.push(span);
        }
      }
    }
    if (spans.length === 0) return false;
    candidateSpans.push(spans);
  }

  function search(index, usedSpans) {
    if (index >= candidateSpans.length) return true;
    for (const span of candidateSpans[index]) {
      const overlaps = usedSpans.some(used => !(span.end <= used.start || used.end <= span.start));
      if (!overlaps) {
        usedSpans.push(span);
        if (search(index + 1, usedSpans)) return true;
        usedSpans.pop();
      }
    }
    return false;
  }

  return search(0, []);
}

// Words that make a displayed question about where a message goes: sending,
// sharing or forwarding it, or which person, account or conversation gets it.
// Stems match at a word start so inflected forms count; scripts written
// without spaces between words match anywhere.
const RECIPIENT_QUESTION_WORD = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[
  'send', 'sent', 'messag', 'deliver', 'forward', 'shar(?:e|ing)', 'repl(?:y|ies|ying)', 'recipient', 'receiv', 'contact',
  'conversa', 'chat', 'dms?(?![\\p{L}])', 'e-?mail', 'mail', 'thread', 'inbox', 'person', 'people', 'user', 'account',
  'whom', 'address',
  'gönder', 'ilet', 'yolla', 'mesaj', 'paylaş', 'alıcı', 'kime', 'kişi', 'kullanıcı', 'hesab', 'hesap', 'sohbet', 'konuşma',
  'schick', 'nachricht', 'empfänger', 'erhalt', 'bekomm', 'wem', 'weiterleit', 'teilen',
  'envi[aáeéoó]', 'envoy', 'envoi', 'mensaj', 'mensag', 'messagg', 'destinat', 'compart', 'partag', 'partilh',
  'condivid', 'inoltr', 'reenv', 'transf[eé]r', 'invia', 'invio', 'pessoa', 'contatt', 'recib', 'reçoi', 'recev',
  'receb', 'ricev',
  'stuur', 'verstuur', 'verzend', 'bericht', 'ontvanger', 'delen',
  'wyśl', 'wysł', 'wiadomo', 'odbiorc', 'udostępn', 'zpráv', 'příjemc',
  'отправ', 'посла', 'пошл', 'сообщен', 'пересла', 'получ', 'собеседник', 'надісл', 'повідомл', 'одержувач',
  'kirim', 'pesan', 'penerima', 'bagikan', 'gửi', 'tin nhắn', 'người nhận', 'chia sẻ',
  'أرسل', 'ارسل', 'إرسال', 'ارسال', 'رسالة', 'مستلم', 'المستلم', 'بفرست', 'پیام', 'گیرنده',
  'שלח', 'הודעה', 'נמען', 'भेज', 'संदेश', 'प्राप्तकर्ता',
].join('|')})`, 'iu');
const RECIPIENT_QUESTION_UNSPACED = /送|发|發|传|傳|消息|信息|訊息|收|联系人|聯絡人|メッセージ|宛|受け取|보내|전송|메시지|받|ส่ง|ข้อความ/u;

/**
 * Does a clarification question show the user the exact recipients the page
 * addresses, and ask about them as recipients?
 *
 * A recipient is authorized only by an answer that names it, given to a
 * question that showed it. The question must name every observed recipient
 * itself (options alone do not show where the message goes) and either ask
 * about sending to them or be declared a recipient question by its caller.
 */
export function questionPresentsObservedRecipients(question, observedCandidates, declaredRecipientQuestion = false) {
  const text = String(question ?? '');
  if (!text.trim() || text.length > 2000) return false;
  if (!answerNamesAllObservedRecipients(text, observedCandidates)) return false;
  return declaredRecipientQuestion === true || questionAsksAboutRecipient(text);
}

/** Does a question ask about sending a message or about who receives it? */
export function questionAsksAboutRecipient(question) {
  const normalized = normalizeRecipientAnswer(question).replace(/\u0307/g, '');
  if (!normalized || normalized.length > 2000) return false;
  return RECIPIENT_QUESTION_WORD.test(normalized) || RECIPIENT_QUESTION_UNSPACED.test(normalized);
}

// A reply that refuses, cancels or points somewhere else. Naming a recipient
// inside such a reply ("No, not Mallory") is never approval of that recipient.
const ANSWER_REFUSAL = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[
  'no', 'nope', 'nah', 'not', 'never', 'none', 'nobody', 'no\\s*one', 'nothing', 'neither', 'nor',
  "don[’']?t", "doesn[’']?t", "didn[’']?t", "won[’']?t", "wouldn[’']?t", "shouldn[’']?t", "can[’']?t", 'cannot',
  "isn[’']?t", "wasn[’']?t", "aren[’']?t", 'stop', 'cancel\\p{L}*', 'abort\\p{L}*', 'reject\\p{L}*', 'refuse\\p{L}*', 'deny',
  'wrong', 'incorrect', 'mistake\\p{L}*', 'other', 'another', 'different', 'else',
  'hayır', 'hayir', 'değil', 'degil', 'yanlış', 'yanlis', 'iptal', 'vazgeç\\p{L}*', 'vazgec\\p{L}*', 'gönderme\\p{L}*',
  'gonderme\\p{L}*', 'yollama\\p{L}*', 'istemiyorum', 'olmaz', 'yok', 'başka', 'baska', 'diğer', 'diger',
  'nein', 'nicht', 'kein\\p{L}*', 'falsch', 'abbrechen', 'stopp', 'andere[mnrs]?',
  'não', 'nao', 'non', 'nunca', 'jamais', 'mai', 'ningun[oa]?', 'nadie', 'nada', 'nenhum\\p{L}*', 'nessun\\p{L}*',
  'aucun\\p{L}*', 'pas', 'cancelar', 'annuler', 'annulla', 'incorrect[oa]', 'equivocad[oa]', 'errad[oa]',
  'sbagliat[oa]', 'faux', 'otr[oa]', 'outr[oa]', 'altr[oa]', 'autre\\p{L}*',
  'nee', 'niet', 'geen', 'annuleren', 'verkeerd\\p{L}*',
  'nie', 'anuluj', 'inn[ya]', 'нет', 'не', 'ни', 'никому', 'никогда', 'отмен\\p{L}*', 'неправильн\\p{L}*', 'друг(?:ой|ому|ая|ие|ую|ого|им)',
  'ні', 'скасу\\p{L}*', 'tidak', 'bukan', 'jangan', 'batal\\p{L}*', 'salah', 'không', 'đừng', 'hủy', 'sai',
  'لا', 'ليس', 'إلغاء', 'الغاء', 'خطأ', 'לא', 'בטל', 'नहीं', 'मत', 'रद्द',
].join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const ANSWER_REFUSAL_UNSPACED = /不要|不是|不对|不對|别|別|取消|错|錯|いいえ|違う|ちがう|キャンセル|ないで|아니|취소|마세요|말아/u;

/**
 * Does the user's reply refuse, cancel or redirect the send rather than
 * approve it? The observed recipient names themselves are removed first, so a
 * contact called "No Limits" is still approvable by name.
 */
export function answerRefusesRecipient(answer, observedCandidates = []) {
  let text = normalizeRecipientAnswer(answer);
  if (!text || text.length > 8192) return !!text;
  const aliases = [];
  for (const candidate of Array.isArray(observedCandidates) ? observedCandidates.slice(0, 16) : []) {
    const identity = typeof candidate === 'string' ? candidate : (candidate?.identity ?? candidate?.recipient);
    for (const alias of [identity, ...(Array.isArray(candidate?.aliases) ? candidate.aliases.slice(0, 16) : [])]) {
      const normalized = normalizeRecipientIdentity(alias);
      if (normalized && !aliases.includes(normalized)) aliases.push(normalized);
    }
  }
  aliases.sort((left, right) => right.length - left.length);
  for (const alias of aliases) {
    for (const span of findCandidateAnswerSpans(text, alias).reverse()) {
      text = `${text.slice(0, span.start)} ${text.slice(span.end)}`;
    }
  }
  // A non-Turkish locale lowercases "İ" to "i" plus a combining dot.
  text = text.replace(/\u0307/g, '');
  return ANSWER_REFUSAL.test(text) || ANSWER_REFUSAL_UNSPACED.test(text);
}

/**
 * Does the user's reply grant every remaining send of the task at once, as
 * the "Send all remaining messages in this task without asking again" option
 * does? A refusal ("Cancel all") is never a grant; check that first.
 */
export function answerGrantsAllRemainingSends(answer) {
  const text = normalizeRecipientAnswer(answer);
  if (!text || text.length > 2000) return false;
  const bare = text.replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
  return /(?<![\p{L}\p{N}])(?:send|allow|approve|authori[sz]e)\s+(?:(?:them|these|those|it)\s+)?all(?![\p{L}\p{N}])/u.test(text)
    || /(?<![\p{L}\p{N}])all\s+(?:remaining|the\s+rest|of\s+them)(?![\p{L}\p{N}])/u.test(text)
    || /(?<![\p{L}\p{N}])(?:hepsin[ei]|tümün[eü]|herkese)\s+(?:gönder|yolla|ilet)/u.test(text)
    || /^(?:all|everything|everyone|all of them|hepsi|hepsine|hepsini|tümü|tümüne|alle|todos|todas|tous|tutti|все|全部|すべて|모두)$/u.test(bare);
}

export function messageTargetMatchesObservedIdentities(target, candidates) {
  const normalizedTarget = normalizeMessageTarget(target);
  const recipients = new Map();
  for (const value of (Array.isArray(candidates) ? candidates : []).slice(0, 16)) {
    const legacy = typeof value === 'string' || typeof value === 'number';
    const identity = compact(legacy ? value : (value?.identity ?? value?.recipient), 240);
    const role = compact(legacy ? 'to' : value?.role, 12).toLowerCase();
    const normalized = normalizeRecipientIdentity(identity);
    const key = `${role}:${normalized}`;
    if (identity && normalized && MESSAGE_RECIPIENT_ROLES.has(role) && !recipients.has(key)) {
      recipients.set(key, { identity, role });
    }
  }
  if (!normalizedTarget) return false;
  // active_conversation is planner intent, not a dispatch-time identity. A
  // protected adapter must pin it to a concrete named identity before tools
  // run; accepting any later conversation would authorize retargeting.
  if (normalizedTarget.target_kind === 'active_conversation') return false;
  const expected = new Set(normalizedTarget.recipients.map(recipient => (
    `${recipient.role}:${normalizeRecipientIdentity(recipient.identity)}`
  )));
  return expected.size === recipients.size
    && [...expected].every(key => recipients.has(key));
}

/**
 * Does the user answer explicitly authorize targetRole (to, cc, or bcc) for
 * candidateIdentity?
 *
 * Role authorization must come strictly from the user's answer, never from
 * the clarification context (question, reason, or options) which are
 * model-authored and cannot supply recipient authorization.
 *
 * For 'bcc' and 'cc', explicit mentions of BCC or CC in the answer authorize the role.
 * Each role label is strictly associated with its intended recipient rather than
 * accepted anywhere in a shared multi-recipient sentence or clause.
 *
 * For 'bcc' and 'cc', explicit mentions of BCC or CC attached to the recipient
 * identity in the answer authorize the role.
 * For 'to', because "to" is also a ubiquitous preposition ("send to Alice"),
 * an explicit role label ("To: Alice", "Alice (To)", "as To", "in To", "to To", "To field")
 * or localized role indicator ("收件人", "主送") attached to the recipient identity
 * is required in the user's answer.
 */
function coordinatedListShape(text, leadingSeparator, trailingSeparator) {
  if (!text || text.length > 8192 || /[\n\r|/]/.test(text)) return false;
  const lower = text.toLowerCase(), parts = []; let start = 0;
  for (let at = 0; at < text.length; at++) {
    let size = 0;
    if (',;，；和'.includes(text[at])) size = 1;
    else if (at > 0 && /\s/.test(text[at - 1])) {
      for (const word of ['and', 'or', '以及', '与', '及']) {
        if (lower.startsWith(word, at) && (!/^[a-z]+$/.test(word)
          || !/[a-z0-9_]/i.test(text[at + word.length] || ''))) { size = word.length; break; }
      }
    }
    if (size) { parts.push(text.slice(start, at)); at += size - 1; start = at + 1; }
  }
  parts.push(text.slice(start));
  if (parts.length < 2) return false;
  if (leadingSeparator) { if (parts[0].trim()) return false; parts.shift(); }
  if (trailingSeparator) { if (parts.at(-1).trim()) return false; parts.pop(); }
  return parts.length > 0 && parts.every(part => part.trim().length > 0);
}

function groupedRoleSuffix(text, suffixPattern) {
  if (!text || text.length > 8192) return null;
  const roleStarts = /\b(?:as|in|into|to|from|cc|bcc|carbon|blind)\b|[:：(\[【]|[作设收主抄密暗]/gi;
  let match, attempts = 0;
  while ((match = roleStarts.exec(text)) !== null) {
    if (++attempts > 64) return null;
    const rolePart = text.slice(match.index).match(suffixPattern);
    if (rolePart && coordinatedListShape(text.slice(0, match.index), true, false)) {
      return { 0: text.slice(0, match.index + rolePart[0].length), 1: rolePart[0], index: 0 };
    }
  }
  return null;
}

function groupedRolePrefix(text) {
  if (!text || text.length > 8192) return null;
  const leaders = /\b(?:to|cc|bcc)\s*[:：]|(?:作为|设为)?(?:收件人|主送|抄送|密送|暗送)\s*[:：]?/gi;
  let match, attempts = 0;
  while ((match = leaders.exec(text)) !== null) {
    if (++attempts > 64) return null;
    if (coordinatedListShape(text.slice(match.index + match[0].length), false, true)) {
      return { 0: text.slice(match.index), 1: match[0], index: match.index };
    }
  }
  return null;
}

export function clarificationAuthorizesRecipientRole(clarifyContext, answer, candidateIdentity, targetRole) {
  const role = String(targetRole || '').trim().toLowerCase();
  if (!MESSAGE_RECIPIENT_ROLES.has(role)) return false;

  const rawAnswer = String(answer ?? '');
  if (!rawAnswer || rawAnswer.length > 8192) return false;
  const answerText = rawAnswer.trim();
  if (!answerText) return false;

  const candidate = typeof candidateIdentity === 'object' && candidateIdentity !== null
    ? candidateIdentity
    : { identity: candidateIdentity };
  const rawId = candidate.identity ?? candidate.recipient ?? candidateIdentity;
  const normId = normalizeRecipientIdentity(rawId);
  const candidateAliases = [
    normId,
    ...(Array.isArray(candidate.aliases) ? candidate.aliases.slice(0, 16).map(normalizeRecipientIdentity) : []),
  ].filter(Boolean);

  const candidateSpanCache = new Map();

  function snippetHasExplicitRole(snippet, roleToCheck) {
    if (!snippet) return false;
    const transitionMatch = snippet.match(/\b(?:from\s+(to|cc|bcc)\s+to\s+(to|cc|bcc)|(to|cc|bcc)\s*(?:->|=>|→)\s*(to|cc|bcc))\b/i);
    if (transitionMatch) {
      const targetRole = (transitionMatch[2] || transitionMatch[4]).toLowerCase();
      return roleToCheck === targetRole;
    }
    if (roleToCheck === 'bcc') {
      return /\b(?:bcc|blind\s+carbon\s+copy)\b|密送|暗送/i.test(snippet);
    }
    if (roleToCheck === 'cc') {
      return /\b(?:cc|carbon\s+copy)\b|抄送/i.test(snippet);
    }
    if (roleToCheck === 'to') {
      if (/\bto\s*[:：]/i.test(snippet)) return true;
      if (/[(\[【]\s*to\s*[)\]】]/i.test(snippet)) return true;
      if (/\b(?:as|in|into|role|field|to)\s+to\b/i.test(snippet)) return true;
      if (/\bto\s+(?:field|role|recipient)\b/i.test(snippet)) return true;
      if (/\bfrom\s+(?:bcc|cc)\s+to\s+to\b/i.test(snippet)) return true;
      if (/\b(?:bcc|cc)\s*(?:->|=>|→)\s*to\b/i.test(snippet)) return true;
      if (/(?:作为|设为)?(?:收件人|主送)/i.test(snippet)) return true;
      const trimmed = snippet.trim();
      if (/^(?:to|as\s+to)$/i.test(trimmed)) return true;
      return false;
    }
    return false;
  }

  function hasNegation(text) {
    if (!text) return false;
    const str = String(text).replace(/\bno\s+(?:problem|worries)\b/gi, ' ');
    const negationRe = /\b(?:\w+n['’]t|not|no|never|neither|nor|dont|doesnt|didnt|wont|cant|cannot|shouldnt|mustnt|isnt|arent|wasnt|werent|avoid\w*|prohibit\w*|disallow\w*|refus\w*|reject\w*|stop\w*|prevent\w*|without)\b|不要|别|不能|不可|不得|不用|不是|不行|不准|决不|绝不|不应|不该|禁止|严禁|请勿|非|勿|免|未|不(?:设|加|放|移|作|把|给)/i;
    return negationRe.test(str);
  }

  function prefixHasNegation(fullPrefix, prefix, roleToCheck = null) {
    if (hasNegation(prefix)) return true;
    if (!fullPrefix) return false;
    const boundaryRe = /[;\n\r|]|(?:\b(?:but|however|yet|instead\s+of|rather\s+than|whereas|while|whilst)\b)|(?:而不是|而非)/gi;
    let lastBoundary = 0;
    let m;
    while ((m = boundaryRe.exec(fullPrefix)) !== null) {
      lastBoundary = m.index + m[0].length;
    }
    const segment = fullPrefix.slice(lastBoundary);
    const parts = segment.split(/[,，]/);
    let relevantStart = 0;
    const generalRecipientRe = /\b(?:anyone|anybody|any\s+one|no\s*one|nobody|someone|somebody|people|persons?|users?|recipients?|contacts?|others?|everyone|everybody|either|neither|all|any|team|group|members?)\b|谁|任何人|大家|所有人|团队|群组|成员/i;
    const continuationRe = /^\s*(?:\b(?:especially|particularly|including|specifically|mainly|even|let\s+alone|much\s+less|not\s+to\s+mention)\b|尤其是|特别[是地]?|包括|更不用说|更别提)/i;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const partHasNeg = hasNegation(part);
      const partHasRole = roleWordsRe.test(part);

      if (partHasRole) {
        if (!partHasNeg) {
          relevantStart = parts.slice(0, i + 1).join(',').length + 1;
        } else {
          if (roleToCheck && !snippetHasExplicitRole(part, roleToCheck)) {
            relevantStart = parts.slice(0, i + 1).join(',').length + 1;
          } else {
            const remainingPrefix = parts.slice(i + 1).join(',');
            const namesOtherRecipient = candidateAliases.length > 0
              && !candidateAliases.some(alias => answerNamesIdentity(part, alias))
              && !generalRecipientRe.test(part);
            if (namesOtherRecipient && !continuationRe.test(remainingPrefix)) {
              relevantStart = parts.slice(0, i + 1).join(',').length + 1;
            }
          }
        }
      }
    }
    const relevantPrefix = segment.slice(relevantStart);
    return hasNegation(relevantPrefix);
  }

  function isPrecededByNegatedCoordGroup(fullPrefix) {
    const coordTrailingRe = /(?:[,;，；和]|(?:\s+(?:\b(?:and|or)\b|以及|与|及)\s*))\s*$/i;
    if (!coordTrailingRe.test(fullPrefix)) return false;
    const lastDelimiterIdx = Math.max(
      fullPrefix.lastIndexOf(';'),
      fullPrefix.lastIndexOf('；'),
      fullPrefix.lastIndexOf('\n'),
      fullPrefix.lastIndexOf('|'),
    );
    const relevantPrefix = lastDelimiterIdx >= 0 ? fullPrefix.slice(lastDelimiterIdx + 1) : fullPrefix;
    if (roleWordsRe.test(relevantPrefix)) return false;
    return hasNegation(relevantPrefix);
  }

  const prefixPatterns = {
    to: /(?:\bto\s*[:：]|\b(?:as|in|into|to)\s+(?:the\s+)?to(?:\s+(?:field|role|recipient))?\s*[:：,]?(?:\s+(?:put|move|set|send|keep|leave|add|place))?|(?:作为|设为)?(?:收件人|主送)\s*[:：]?)\s*$/i,
    cc: /(?:\b(?:cc|carbon\s+copy)\s*[:：]|\b(?:as|in|into)\s+(?:the\s+)?(?:cc|carbon\s+copy)(?:\s+(?:field|role|recipient))?\s*[:：,]?(?:\s+(?:put|move|set|send|keep|leave|add|place))?|(?:作为|设为)?抄送\s*[:：]?)\s*$/i,
    bcc: /(?:\b(?:bcc|blind\s+carbon\s+copy)\s*[:：]|\b(?:as|in|into)\s+(?:the\s+)?(?:bcc|blind\s+carbon\s+copy)(?:\s+(?:field|role|recipient))?\s*[:：,]?(?:\s+(?:put|move|set|send|keep|leave|add|place))?|(?:作为|设为)?(?:密送|暗送)\s*[:：]?)\s*$/i,
  };

  const suffixPatterns = {
    to: /^\s*(?:[:：]\s*to\b|[(\[【]\s*to\s*[)\]】]|(?:->|=>|→)\s*to\b|(?:(?:is|should\s+be|remains?|stays?|needs?\s+to\s+be)\s+)?(?:as|in|into|to)\s+(?:the\s+)?to(?:\s+(?:field|role|recipient))?\b|(?:from\s+(?:bcc|cc)\s+to\s+to\b)|to\s+(?:field|role|recipient)\b|(?:作为|设为)?(?:收件人|主送))/i,
    cc: /^\s*(?:[:：]\s*(?:cc|carbon\s+copy)\b|[(\[【]\s*(?:cc|carbon\s+copy)\s*[)\]】]|(?:->|=>|→)\s*(?:cc|carbon\s+copy)\b|(?:(?:is|should\s+be|remains?|stays?|needs?\s+to\s+be)\s+)?(?:as|in|into|to)\s+(?:the\s+)?(?:cc|carbon\s+copy)(?:\s+(?:field|role|recipient))?\b|(?:from\s+(?:to|bcc)\s+to\s+cc\b)|(?:cc|carbon\s+copy)\s+(?:field|role|recipient)\b|(?:作为|设为)?抄送)/i,
    bcc: /^\s*(?:[:：]\s*(?:bcc|blind\s+carbon\s+copy)\b|[(\[【]\s*(?:bcc|blind\s+carbon\s+copy)\s*[)\]】]|(?:->|=>|→)\s*(?:bcc|blind\s+carbon\s+copy)\b|(?:(?:is|should\s+be|remains?|stays?|needs?\s+to\s+be)\s+)?(?:as|in|into|to)\s+(?:the\s+)?(?:bcc|blind\s+carbon\s+copy)(?:\s+(?:field|role|recipient))?\b|(?:from\s+(?:to|cc)\s+to\s+bcc\b)|(?:bcc|blind\s+carbon\s+copy)\s+(?:field|role|recipient)\b|(?:作为|设为)?(?:密送|暗送))/i,
  };

  const delimiterRe = /[,;，；\n\r|/]|(?:\s*\b(?:and|or|while|whilst|but|whereas|yet|however|instead\s+of|rather\s+than|as\s+well\s+as)\b\s*)|(?:\s*(?:而不是|而非)\s*)|(?:\s+(?:以及|与|及|而|但是|但)\s*)/gi;
  const roleWordsRe = /\b(?:to|cc|bcc|carbon\s+copy|blind\s+carbon\s+copy)\b|收件人|主送|抄送|密送|暗送/i;

  function testRole(roleToCheck) {
    let hasSpans = false;
    for (const alias of candidateAliases) {
      let spans = candidateSpanCache.get(alias);
      if (!spans) {
        spans = findCandidateAnswerSpans(answerText, alias);
        if (spans.length > 64) return false;
        candidateSpanCache.set(alias, spans);
      }
      if (spans.length > 0) {
        hasSpans = true;
        for (const span of spans) {
          let clauseStart = 0;
          delimiterRe.lastIndex = 0;
          let m;
          while ((m = delimiterRe.exec(answerText)) !== null) {
            if (m.index < span.start) {
              clauseStart = m.index + m[0].length;
            } else {
              break;
            }
          }

          let clauseEnd = answerText.length;
          delimiterRe.lastIndex = span.end;
          const mAfter = delimiterRe.exec(answerText);
          if (mAfter) {
            clauseEnd = mAfter.index;
          }

          const prefix = answerText.slice(clauseStart, span.start);
          const suffix = answerText.slice(span.end, clauseEnd);
          const fullPrefix = answerText.slice(0, span.start);

          if (prefixPatterns[roleToCheck].test(prefix)) {
            if (!prefixHasNegation(fullPrefix, prefix, roleToCheck)) {
              return true;
            }
          }

          const suffixMatch = suffix.match(suffixPatterns[roleToCheck]);
          if (suffixMatch) {
            if (!prefixHasNegation(fullPrefix, prefix, roleToCheck) && !hasNegation(suffixMatch[0]) && !isPrecededByNegatedCoordGroup(fullPrefix)) {
              return true;
            }
          }

          // Grouped role suffix: e.g. Put Alice and Bob in BCC / 把Alice和Bob设为密送
          const fullSuffix = answerText.slice(span.end);
          const coordMatch = groupedRoleSuffix(fullSuffix, suffixPatterns[roleToCheck]);
          if (coordMatch) {
            const intervening = fullSuffix.slice(0, coordMatch.index + coordMatch[0].length - coordMatch[1].length);
            const rolePart = coordMatch[1];
            if (!roleWordsRe.test(intervening) && suffixPatterns[roleToCheck].test(rolePart)) {
              if (!prefixHasNegation(fullPrefix, prefix, roleToCheck) && !hasNegation(intervening) && !hasNegation(rolePart) && !isPrecededByNegatedCoordGroup(fullPrefix)) {
                return true;
              }
            }
          }

          // Grouped role prefix: e.g. To: Alice and Bob
          const prefixCoordMatch = groupedRolePrefix(fullPrefix);
          if (prefixCoordMatch) {
            const roleLeader = prefixCoordMatch[1];
            const intervening = prefixCoordMatch[0].slice(roleLeader.length);
            if (!roleWordsRe.test(intervening) && prefixPatterns[roleToCheck].test(roleLeader)) {
              const beforeLeader = fullPrefix.slice(0, fullPrefix.length - prefixCoordMatch[0].length);
              if (!prefixHasNegation(beforeLeader, beforeLeader, roleToCheck) && !hasNegation(roleLeader) && !hasNegation(intervening)) {
                return true;
              }
            }
          }
        }
      }
    }

    if (!hasSpans) {
      delimiterRe.lastIndex = 0;
      const hasMultipleClauses = delimiterRe.test(answerText);
      if (!hasMultipleClauses && snippetHasExplicitRole(answerText, roleToCheck)) {
        if (!hasNegation(answerText)) {
          return true;
        }
      }
    }

    return false;
  }

  if (!testRole(role)) return false;

  // Reject answers that authorize multiple conflicting roles for this recipient.
  for (const otherRole of MESSAGE_RECIPIENT_ROLES) {
    if (otherRole !== role && testRole(otherRole)) {
      return false;
    }
  }

  return true;
}

/**
 * Resolve observed recipient candidates against previously authorized recipients
 * and clarification context/answer.
 *
 * Preserves previously authorized delivery roles (such as 'bcc') both when an
 * observed recipient's role is changed and when previously authorized recipients
 * are replaced by new identities (e.g. replacing BCC Alice with Bob). An observed
 * candidate only adopts a different delivery role when the user's answer affirmatively
 * authorizes that role for that specific recipient.
 */
export function resolveClarifiedRecipients(observedCandidates, previousTarget, clarifyContext, answer) {
  const previous = normalizeMessageTarget(previousTarget);
  const previousRecipients = previous?.recipients || [];
  const rawList = Array.isArray(observedCandidates) ? observedCandidates : [];

  const matchedPreviousIndices = new Set();
  const candidatePreviousRoles = new Map();

  for (let i = 0; i < rawList.length; i++) {
    const candidate = rawList[i];
    const legacy = typeof candidate === 'string' || typeof candidate === 'number';
    const identity = compact(legacy ? candidate : (candidate?.identity ?? candidate?.recipient), 240);
    const norm = normalizeRecipientIdentity(identity);
    const candidateAliases = [
      norm,
      ...(Array.isArray(candidate?.aliases) ? candidate.aliases.map(normalizeRecipientIdentity) : []),
    ].filter(Boolean);

    for (let p = 0; p < previousRecipients.length; p++) {
      if (matchedPreviousIndices.has(p)) continue;
      const prevNorm = normalizeRecipientIdentity(previousRecipients[p].identity);
      if (candidateAliases.includes(prevNorm)) {
        candidatePreviousRoles.set(i, previousRecipients[p].role);
        matchedPreviousIndices.add(p);
        break;
      }
    }
  }

  const remainingPrevious = previousRecipients
    .map((r, idx) => ({ ...r, idx }))
    .filter(r => !matchedPreviousIndices.has(r.idx));

  // Match replacements to compatible observed recipient slots first to avoid
  // swapping roles when multiple recipients with different roles are replaced.
  for (let i = 0; i < rawList.length; i++) {
    if (candidatePreviousRoles.has(i)) continue;
    const candidate = rawList[i];
    const legacy = typeof candidate === 'string' || typeof candidate === 'number';
    const observedRole = compact(legacy ? 'to' : candidate?.role, 12).toLowerCase() || 'to';
    const matchIdx = remainingPrevious.findIndex(r => r.role === observedRole);
    if (matchIdx !== -1) {
      const [matched] = remainingPrevious.splice(matchIdx, 1);
      candidatePreviousRoles.set(i, matched.role);
    }
  }

  // Assign any remaining unmatched replacement candidates by restrictive rank (bcc > cc > to).
  const roleRank = { bcc: 3, cc: 2, to: 1 };
  remainingPrevious.sort((a, b) => (roleRank[b.role] || 0) - (roleRank[a.role] || 0));

  for (let i = 0; i < rawList.length; i++) {
    if (candidatePreviousRoles.has(i)) continue;
    if (remainingPrevious.length > 0) {
      const replaced = remainingPrevious.shift();
      candidatePreviousRoles.set(i, replaced.role);
    }
  }

  return rawList.map((candidate, i) => {
    const legacy = typeof candidate === 'string' || typeof candidate === 'number';
    const identity = compact(legacy ? candidate : (candidate?.identity ?? candidate?.recipient), 240);
    const observedRole = compact(legacy ? 'to' : candidate?.role, 12).toLowerCase() || 'to';
    const previousRole = candidatePreviousRoles.get(i);

    const authorizedRoles = ['to', 'cc', 'bcc'].filter(r => (
      clarificationAuthorizesRecipientRole(clarifyContext, answer, candidate, r)
    ));
    const authorizedRole = authorizedRoles.length === 1 ? authorizedRoles[0] : null;

    if (authorizedRole) {
      return { identity, role: authorizedRole };
    }
    if (previousRole) {
      return { identity, role: previousRole };
    }
    return { identity, role: observedRole };
  });
}
