// Stands in for the model in unit tests. It answers WebBrain's fixed-choice
// language decisions (src/*/src/agent/semantic-decisions.js) and its
// consequential-action authorization, and records what each question saw.
//
// `defaultDecide` is a small English oracle for the fixtures' own requests,
// the way a model would read them. Tests about a specific verdict pass their
// own `decide`; the product itself never reads requests with word lists.
import assert from 'node:assert/strict';
import { SEMANTIC_QUESTIONS } from '../src/chrome/src/agent/semantic-decisions.js';

export function semanticQuestionOf(agent, messages) {
  return {
    request: JSON.parse(messages[1].content).request,
    page: JSON.parse(agent._unwrapUntrusted(messages.at(-1).content)).page,
    system: messages[0].content,
    wrapped: messages.at(-1).content,
  };
}

const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];

export function defaultDecide(kind, { request, page }) {
  const text = String(request || '');
  if (kind === 'deletion_request') {
    if (/\b(?:don'?t|do not|never|without)\b[^.]*\b(?:delet|remov)/i.test(text)) return { choice: 'forbidden', evidence: text };
    if (!/\b(?:delete|remove|trash|erase)\b/i.test(text)) return { choice: 'not_requested', evidence: '' };
    if (page?.earlierResultOfThisTask) return { choice: 'delete_this', evidence: text };
    // A linked item is named by its link; a request that links something else
    // means another item.
    if (page?.link && text.includes(page.link)) return { choice: 'delete_this', evidence: text };
    if (page?.link && /https?:\/\//i.test(text)) return { choice: 'other_item', evidence: '' };
    const siblings = new Set((page?.siblings || []).flatMap(words));
    const requested = new Set(words(text));
    const own = words(page?.item).filter(word => requested.has(word) && !siblings.has(word)
      && !['delete', 'remove', 'from', 'with', 'this', 'that', 'item', 'cart'].includes(word));
    return own.length ? { choice: 'delete_this', evidence: text } : { choice: 'unclear', evidence: '' };
  }
  if (kind === 'deletion_prerequisite') {
    return /\b(?:delete|remove)\b(?![^.]*\b(?:characters?|hashtags?|words?|symbols?|marks?)\b)/i.test(text)
      ? { choice: 'delete_previous', evidence: text } : { choice: 'keep_previous', evidence: '' };
  }
  if (kind === 'sending_forbidden') {
    return /\b(?:don'?t|do not|never)\s+send\b/i.test(text) ? { choice: 'forbidden', evidence: text } : { choice: 'not_forbidden', evidence: '' };
  }
  return null;
}

export const authorizeAll = ({ input, authority }) => ({ key: input.key, authorized: true, latestRequestEvidence: authority.latestAcceptedRequest });

// Replace the agent's model calls. `decide(kind, question)` returns
// { choice, evidence }, a bare choice string, or null (no answer).
// `authorize({ input, authority, system })` answers the publication and
// submission authorization check.
export function installModelStub(agent, { decide = defaultDecide, authorize = authorizeAll, provider = null } = {}) {
  const calls = [];
  agent._chatWithCostAllowance = async (usedProvider, messages, _options, _cost, meta) => {
    if (provider) assert.equal(usedProvider, provider);
    const name = String(meta?.generationName || '');
    if (name.startsWith('semantic_')) {
      const kind = name.slice('semantic_'.length);
      const question = semanticQuestionOf(agent, messages);
      calls.push({ kind, ...question });
      const answer = await decide(kind, question);
      if (answer == null) throw new Error('No model answer.');
      return { content: JSON.stringify(typeof answer === 'string' ? { choice: answer, evidence: question.request } : answer) };
    }
    if (name === 'resource_mutation_authorization') {
      const input = JSON.parse(agent._unwrapUntrusted(messages.at(-1).content));
      const authority = JSON.parse(messages[1].content);
      calls.push({ kind: 'authorization', input, authority, system: messages[0].content });
      return { content: JSON.stringify(await authorize({ input, authority, system: messages[0].content })) };
    }
    throw new Error(`Unexpected model call ${name}.`);
  };
  return calls;
}

// For scripted providers that answer every request from a fixed script: the
// fixed-choice questions WebBrain asks on its own (what a short turn does,
// whether a request forbids an action) get no answer here, as from a model
// that cannot tell, instead of consuming the script.
export const FIXED_CHOICE_QUESTION = "Answer one fixed-choice question for a browser agent's safety check.";
export function withoutFixedChoiceAnswers(chat) {
  return (messages, options) => String(messages?.[0]?.content || '').startsWith(FIXED_CHOICE_QUESTION)
    ? Promise.resolve({ content: JSON.stringify({ choice: '', evidence: '' }) })
    : chat(messages, options);
}

// Which fixed-choice question a request asks, read from the question's own
// text, and whether it asks it about a list of items.
export function fixedChoiceQuestion(messages) {
  const system = String(messages?.[0]?.content || '');
  if (!system.startsWith(FIXED_CHOICE_QUESTION)) return null;
  const kind = Object.entries(SEMANTIC_QUESTIONS).find(([, spec]) => system.includes(spec.instructions))?.[0] || null;
  let request = '', data = {};
  try { request = JSON.parse(messages[1].content).request; } catch {}
  try {
    const wrapped = String(messages.at(-1).content);
    const json = wrapped.slice(wrapped.indexOf('{'), wrapped.lastIndexOf('}') + 1);
    data = JSON.parse(json);
  } catch {}
  return { kind, request, batch: Array.isArray(data.items), items: data.items || [], page: data.page || {} };
}

// Answers the named fixed-choice questions the way a model that read them
// would. `answers[kind]` is a choice, { choice, evidence }, or a function of
// ({ request, page, item }) returning either (or null for no answer). A
// choice without evidence quotes the whole request. Questions not named get
// no answer, as from a model that cannot tell.
export function withFixedChoiceAnswers(chat, answers = {}) {
  const answerFor = async (kind, question) => {
    const entry = answers[kind];
    const value = typeof entry === 'function' ? await entry(question) : entry;
    if (value == null || value === '') return null;
    return typeof value === 'string' ? { choice: value, evidence: question.request } : value;
  };
  return async (messages, options) => {
    const question = fixedChoiceQuestion(messages);
    if (!question) return chat(messages, options);
    if (!question.kind) return { content: JSON.stringify({ choice: '', evidence: '' }) };
    if (question.batch) {
      const list = [];
      for (const [item, entry] of question.items.entries()) {
        const answer = await answerFor(question.kind, { request: question.request, item: entry });
        if (answer) list.push({ item, ...answer });
      }
      return { content: JSON.stringify({ answers: list }) };
    }
    const answer = await answerFor(question.kind, { request: question.request, page: question.page });
    return { content: JSON.stringify(answer || { choice: '', evidence: '' }) };
  };
}

// The calculation fixtures' requests, read the way a model would: which
// expression they ask for, whether they ask for anything else, and the form
// they set for the answer (texts copied exactly from the request).
export const CALCULATION_FORM_PROMPT = 'The user\'s request in `request` asks a browser agent only to calculate';
export function withCalculationReadings(chat, read) {
  const readings = withFixedChoiceAnswers(chat, {
    calculation_request: question => read(question.request, question.page.expression)?.choice || null,
  });
  return async (messages, options) => {
    if (String(messages?.[0]?.content || '').startsWith(CALCULATION_FORM_PROMPT)) {
      const { request, expression } = JSON.parse(messages[1].content);
      const form = read(request, expression)?.form;
      return { content: JSON.stringify(form || {}) };
    }
    return readings(messages, options);
  };
}

// How a model reads the fixtures' own page texts: the status a page showed
// after a submit, and whether a text shows a site workflow's last step as
// done. A small English oracle for the test fixtures, the way a model would
// read them; the product never reads these words.
export function fixtureStatusReading(text) {
  const value = String(text || '');
  if (/\b(?:not|never|failed|failure|error|unable|cannot|invalid|rejected|denied|unsuccessful|required)\b/i.test(value)) return 'error';
  if (/\b(?:will be|is being|pending|loading|sending|saving)\b/i.test(value)) return 'other';
  if (/\b(?:success(?:ful|fully)?|saved|submitted|created|sent|published|completed|updated|uploaded|added|approved|resolved|received|confirmed|recorded|accepted|thank you|done)\b/i.test(value)) return 'success';
  return 'other';
}

const FIXTURE_WORKFLOW_STATES = [
  [/draft/i, /\bdraft\s+(?:auto[- ]?)?saved\b|\bsaved\s+draft\b|草稿已保存|下書きを保存しました|taslak kaydedildi/i],
  [/message was sent/i, /\bmessage\s+sent\b|消息发送成功|消息已发送|发送成功|ileti gönderildi/i],
  [/submitted and received/i, /\bresponse\s+(?:was\s+)?submitted\b|\bapplication\s+(?:was\s+)?(?:submitted|received)\b|\bthank you for (?:submitting|applying)\b|提交成功|başvurunuz alındı/i],
  [/changes were saved/i, /\bchanges?\s+saved\b|\bsaved successfully\b|保存成功|başarıyla kaydedildi/i],
  [/resolved/i, /\b(?:conversation|thread|review)\s+(?:was\s+)?(?:marked\s+as\s+)?resolved\b|已解决|çözüldü/i],
];
export function fixtureWorkflowStateReading(state, text) {
  const value = String(text || '');
  if (/\b(?:not|never|failed|failure|error|unable|cannot)\b|发送失败|未发送/i.test(value)) return 'failed';
  const shown = FIXTURE_WORKFLOW_STATES.find(([meaning]) => meaning.test(String(state || '')))?.[1];
  return shown?.test(value) ? 'reached' : 'other';
}

// How a model reads the fixtures' own control captions (the control_effect
// question): what activating a control labelled so does. A small oracle for
// the test fixtures, the way a model would read them; the product never reads
// these words.
const END = '(?=$|[\\s!.,:;?…])';
export function fixtureControlEffectReading(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (new RegExp(`^(?:continue|next|sign in|log in|devam|ileri|weiter|suivant|siguiente|次へ)${END}`, 'iu').test(value)) return 'next_step';
  if (/^add to (?:cart|bag|basket)\b/i.test(value)) return 'commit';
  if (new RegExp(`^(?:add|choose|select|attach|insert|format|bold|italic|ekle|seç)${END}`, 'iu').test(value) || /emoji/i.test(value)) return 'form_edit';
  if (new RegExp(`^(?:save|submit|post|publish|send|confirm|commit|resolve|pay|purchase|buy|checkout|place order|create|update|apply|finish|done|sign up|register|reply|gönder|kaydet|yayınla|onayla|öde|enviar|guardar|envoyer|enregistrer|senden|speichern|送信|保存|发送|提交)${END}`, 'iu').test(value)) return 'commit';
  return 'other';
}

// Stands in for the model that reads page texts in unit tests (status
// messages, workflow states, validation alerts): `read(kind, item)` returns a
// choice or null for no answer. Records every item asked.
export function stubPageTextReadings(agent, read = (kind, item) => (kind === 'status_message'
  ? fixtureStatusReading(item.text) : kind === 'workflow_state' ? fixtureWorkflowStateReading(item.state, item.text)
    : kind === 'control_effect' ? fixtureControlEffectReading(item.text) : null)) {
  const asked = [];
  agent._semanticDecisions = async (_tabId, kind, { items = [] } = {}) => items.map(item => {
    asked.push({ kind, ...item });
    const choice = read(kind, item);
    return choice ? { choice, evidence: item.text, source: 'decision_model' } : { choice: null, evidence: '', source: 'unavailable' };
  });
  return asked;
}

// The reply a model would give, in a fixture run, to one of WebBrain's
// fixed-choice questions sent to a fake provider (`messages` as the provider
// receives them), or null when the request is not such a question. Page-text
// questions are read with the fixture oracles above; any other question gets
// no answer unless `answers[kind]` gives one, as from a model that cannot tell.
export function fixtureFixedChoiceReply(messages, answers = {}) {
  const question = fixedChoiceQuestion(messages);
  if (!question) return null;
  const read = (item) => {
    if (typeof answers[question.kind] === 'function') return answers[question.kind]({ request: question.request, item, page: question.page });
    if (question.kind === 'status_message') return fixtureStatusReading(item?.text);
    if (question.kind === 'workflow_state') return fixtureWorkflowStateReading(item?.state, item?.text);
    if (question.kind === 'control_effect') return fixtureControlEffectReading(item?.text);
    return answers[question.kind] ?? null;
  };
  const evidenceOf = item => (typeof item?.text === 'string' ? item.text : typeof item?.label === 'string' ? item.label : question.request);
  if (question.batch) {
    const list = [];
    question.items.forEach((item, index) => {
      const answer = read(item);
      if (!answer) return;
      list.push(typeof answer === 'string' ? { item: index, choice: answer, evidence: evidenceOf(item) } : { item: index, ...answer });
    });
    return JSON.stringify({ answers: list });
  }
  const answer = read(null);
  return JSON.stringify(!answer ? { choice: '', evidence: '' }
    : typeof answer === 'string' ? { choice: answer, evidence: question.request } : answer);
}

// The readings a model would have given the fixtures' page texts, for unit
// tests of the synchronous checks that use remembered readings (stand-in for
// Agent#_pageTextReading after _readPageTexts).
export function fixturePageTextReading(kind, text, context = {}) {
  if (kind === 'status_message') return fixtureStatusReading(text);
  if (kind === 'workflow_state') return fixtureWorkflowStateReading(context?.state, text);
  if (kind === 'control_effect') return fixtureControlEffectReading(text);
  return null;
}

// Only the page-text questions (status messages, workflow states, control
// captions), for fake providers that answer WebBrain's other fixed-choice
// questions themselves.
export function fixturePageTextReply(messages) {
  const kind = fixedChoiceQuestion(messages)?.kind;
  return ['status_message', 'workflow_state', 'control_effect'].includes(kind) ? fixtureFixedChoiceReply(messages) : null;
}
