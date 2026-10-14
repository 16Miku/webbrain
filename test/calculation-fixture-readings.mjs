// How a model reads the calculation fixtures' own requests. The product never
// reads these words: it asks a model whether a request asks only for its
// arithmetic (the calculation_request question) and, when the request sets a
// form for the answer, asks the active model to write that form down with
// every required text copied from the request. These tests stand in for that
// model with the readings of their own fixed requests.
import { withCalculationReadings } from './semantic-decision-stub.mjs';

// Requests that also ask for other work or for data from elsewhere.
const OTHER_WORK = [
  'Read the page', 'send the answer', 'schedule a check', 'using the current page', 'send it to the current chat',
  'post the result', 'click Save', 'book a flight', 'delete the old item', 'with the downloaded report',
  'explain the current account', 'DM Alice', 'message Alice', 'contact Alice', 'retweet it', 'translate a paragraph',
  'Reply to Alice', 'and calculate', 'done(', 'hesabı sil', 'anneme gönderin', 'buche einen Flug', 'achète un billet',
  'current page price', 'open the page', 'DM someone', 'send the result to Alice', 'Send any messages.',
  'send it to Alice', 'except read the latest message', 'Read the current chat', 'and send it.', 'and post it',
  'current page data',
];
// Requests that only quote or describe a calculation.
const NOT_REQUESTED = ['The page says', 'The current page says'];
// Answer forms the fixtures set, as a model writes them down.
const FORMS = [
  [/finish with marker "([^"]+)"\. Include marker ([A-Z_]+)\b/u, match => ({ ending: match[1], include: [match[2]] })],
  [/Finish with marker ([A-Z_]+)\. Include marker ([A-Z_]+)\b/u, match => ({ ending: match[1], include: [match[2]] })],
  [/marker "([^"]+)"/u, match => ({ ending: match[1] })],
  [/finish with (MIDRUN-CALCULATE-QA-20261008|RESPONSE_END)\b/u, match => ({ ending: match[1] })],
  [/finish with the result/u, () => ({ result_last: true })],
  [/Return (?:only the result|the result only)/u, () => ({ only_result: true })],
  [/Append marker ([A-Z_]+)\b/u, match => ({ ending: match[1] })],
  [/Include marker ([A-Z_]+)\b/u, match => ({ include: [match[1]] })],
];
// Forms no model can write down as exact texts: they are left to the
// completion judge.
const UNWRITABLE = ['in plain text', 'with rounding', 'Markierung END', 'Finish with FIRST_END. Finish with SECOND_END', 'in two paragraphs'];

export function fixtureCalculationReading(request) {
  const text = String(request || '');
  if (NOT_REQUESTED.some(phrase => text.startsWith(phrase))) return { choice: 'not_requested' };
  if (OTHER_WORK.some(phrase => text.includes(phrase))) return { choice: 'other_work' };
  if (UNWRITABLE.some(phrase => text.includes(phrase))) return { choice: 'only_result_with_form', form: {} };
  for (const [pattern, form] of FORMS) {
    const match = text.match(pattern);
    if (match) {
      return { choice: 'only_result_with_form',
        form: { only_result: false, result_last: false, ending: '', include: [], ...form(match) } };
    }
  }
  return { choice: 'only_result' };
}

// A provider chat that reads calculation requests like a model would.
export const withFixtureCalculationReadings = chat => withCalculationReadings(chat, fixtureCalculationReading);

// The execution guard's fields after a model read a fixture request: the
// reading the agent stores (with the answer form it accepted), for unit tests
// of the policy functions. `expression` names the arithmetic the reading is
// about when the test needs a particular one.
export function fixtureCalculationScope(policy, task, { expression = policy.literalCalculationCandidate(task), ...extra } = {}) {
  const { choice, form } = fixtureCalculationReading(task);
  const accepted = form ? policy.acceptCalculationAnswerForm(form, task) : null;
  return { readScope: 'none', ...extra,
    calculationReading: { task: String(task).trim(), expression, choice, ...(accepted ? { form: accepted } : {}) } };
}
