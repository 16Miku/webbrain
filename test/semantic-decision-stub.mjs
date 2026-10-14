// Stands in for the model in unit tests. It answers WebBrain's fixed-choice
// language decisions (src/*/src/agent/semantic-decisions.js) and its
// consequential-action authorization, and records what each question saw.
//
// `defaultDecide` is a small English oracle for the fixtures' own requests,
// the way a model would read them. Tests about a specific verdict pass their
// own `decide`; the product itself never reads requests with word lists.
import assert from 'node:assert/strict';

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
