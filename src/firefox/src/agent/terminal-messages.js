/**
 * Plain-language final answers for runs that a runtime guard ended.
 *
 * The guard's mechanical diagnostic (bracketed, with job ids and recovery
 * instructions) stays in tool results, verbose rows and traces. The person
 * reading the chat gets what happened and what to check next. Messages carry
 * no page content, private values or tool arguments. Keep the Firefox copy
 * byte-identical.
 */

const PLATFORM_LABELS = {
  twitter: 'X', x: 'X', bluesky: 'Bluesky', mastodon: 'Mastodon', linkedin: 'LinkedIn',
  threads: 'Threads', facebook: 'Facebook', instagram: 'Instagram', reddit: 'Reddit',
};

export function socialPlatformLabel(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return 'the requested site';
  if (key === 'unresolved_intent') return 'the requested site';
  return PLATFORM_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

function joinLabels(labels) {
  const unique = [...new Set(labels.filter(Boolean))];
  if (unique.length <= 1) return unique[0] || '';
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

function socialMessage({ unconfirmed = [], notStarted = [], verified = [] } = {}) {
  const parts = [];
  const done = joinLabels(verified.map(socialPlatformLabel));
  const pending = joinLabels(unconfirmed.map(socialPlatformLabel));
  const missing = joinLabels(notStarted.map(socialPlatformLabel));
  if (done) parts.push(`I posted to ${done}.`);
  if (pending) {
    parts.push(`I clicked Post on ${pending}, but I couldn't confirm the post afterwards. `
      + 'The page changed, or the post was edited, before I could check it.');
    parts.push(`I didn't post again, so there won't be a duplicate. Please check ${pending} to make sure the post looks right.`);
  }
  if (missing) parts.push(`I couldn't finish posting to ${missing}, so nothing was published there.`);
  if (!parts.length) parts.push("I couldn't confirm that the post was published, so I stopped without posting again.");
  return parts.join(' ');
}

/**
 * kind: the guard branch that ended the run. facts: booleans and platform
 * names only. Unknown kinds fall back to an honest generic message.
 */
export function terminalGuardUserMessage(kind, facts = {}) {
  const consequential = facts.consequential === true;
  const readOnly = !consequential && facts.readOnly === true;
  switch (kind) {
    case 'task_changed':
      return 'Your request changed while I was working, so I stopped before finishing. Send the updated request again and I will start fresh.';
    case 'schedule_missing':
      return "I couldn't set up the scheduled task, so nothing will run later. Some one-time steps may already have happened.";
    case 'download_missing':
      return "I couldn't download the file, so nothing was saved. Finding a link to it is not the same as saving it.";
    case 'social_missing':
      return socialMessage(facts);
    case 'submission_missing':
      // Only a recorded submit dispatch for this task may say "I submitted".
      return facts.submitted === true
        ? "I submitted it, but I couldn't confirm the result on the page afterwards. Please check the page before trying again, so nothing is submitted twice."
        : consequential
          ? "I took some steps on the page, but the final submission didn't go through or couldn't be confirmed. Please check the page before trying again."
          : "I couldn't complete the submission, and I didn't find any sign that it was submitted. Please check the page before trying again.";
    case 'forbidden_submission':
      return 'The form was submitted even though the task was to leave it unsubmitted. Please check the page to see what was sent.';
    case 'job_evidence_missing':
      return "I couldn't verify the result, so anything I found so far may be incomplete. Please don't rely on it without checking.";
    case 'draft_missing':
      return "I couldn't confirm that the draft was saved. The editor may still contain unsaved text, so please check it before trying again.";
    case 'ledger_incomplete':
      return "I couldn't confirm that every item was handled. Some items may still need attention.";
    case 'stale_cancellation':
      return consequential || facts.toolsCompleted === true
        ? "I stopped because I couldn't confirm the task finished. Some steps were completed, so please check the page before trying again."
        : 'I stopped without completing the task. Nothing was changed.';
    case 'clarification_required':
      return 'I need your answer to my question before I continue. The earlier choice was picked automatically after a timeout, so I did not treat it as your decision. Please answer it and try again.';
    case 'placeholder_output':
      return 'The model stopped giving usable answers, so I ended the task. Please try again; a new conversation or a different model may help.';
    case 'empty_output':
      return facts.reason === 'content_filter'
        ? 'The model provider filtered its response, so I could not continue. Please rephrase the request or try another provider.'
        : facts.reason === 'output_limit' || facts.reason === 'reasoning_only'
          ? 'The model used up its response limit without giving an answer. Try lowering its reasoning effort or choosing another model.'
          : 'The model returned empty responses, so I could not continue. Please try again later or choose another model.';
    case 'mode_contradiction':
    default:
      return consequential
        ? "I did part of the work but couldn't confirm the task finished. Please check the page before trying again, so nothing happens twice."
        : readOnly
          ? "I completed some read-only steps but couldn't verify the requested result, so I stopped. Nothing was changed, submitted, or sent."
          : "I couldn't complete the requested action, so I stopped without claiming success. Nothing was changed, submitted, or sent.";
  }
}

/** One plain-language step-limit message; the tool inventory stays in traces. */
export function stepLimitUserMessage(steps, lastAssistantText = '') {
  const count = Number.isSafeInteger(steps) && steps > 0 ? steps : 0;
  const lines = [`I reached the step limit${count ? ` (${count} step${count === 1 ? '' : 's'})` : ''} before finishing the task.`];
  const snippet = String(lastAssistantText || '').replace(/\s+/g, ' ').trim();
  if (snippet) lines.push(`Where I stopped: "${snippet.slice(0, 280)}${snippet.length > 280 ? '...' : ''}"`);
  lines.push('This usually means the task is too complex for the current model, the step limit is too low (you can raise it in Settings), or the task should be split into smaller parts.');
  return lines.join('\n\n');
}
