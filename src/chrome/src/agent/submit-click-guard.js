// Browser-free duplicate-submit guard. This file is mirrored in the Firefox
// tree; keep both copies byte-identical.

export const SUBMIT_CLICK_WINDOW_MS = 45_000;

const SUBMIT_LIKE_CLICK_RE = /^(create|save|submit|add|post|publish|send|confirm|sign up|sign in|log in|register|place order|pay|checkout|update|apply|finish|done)\b/i;

/**
 * Record the first submit-like text click and reject a rapid duplicate on the
 * same tab and URL. Returns the tool result to emit when blocked, otherwise
 * null. The URL callback is lazy so ordinary clicks and explicit retries do
 * not perform a tab lookup.
 */
export async function guardRecentSubmitClick(
  recentSubmitClicks,
  tabId,
  args,
  getCurrentUrl,
  now = Date.now,
) {
  if (!args?.text || args._allowResubmit) return null;

  const rawText = String(args.text).trim();
  if (!SUBMIT_LIKE_CLICK_RE.test(rawText)) return null;

  let currentUrl = '';
  try {
    currentUrl = await getCurrentUrl() || '';
  } catch { /* preserve empty-URL fallback */ }

  const entries = recentSubmitClicks.get(tabId) || [];
  const key = `${rawText.toLowerCase()}|${currentUrl}`;
  const timestamp = now();
  const fresh = entries.filter(entry => timestamp - entry.ts < SUBMIT_CLICK_WINDOW_MS);
  const match = fresh.find(entry => entry.key === key);

  if (match) {
    return {
      success: false,
      dispatched: false,
      blockedDuplicateSubmit: true,
      error: `Blocked: you already clicked "${rawText}" on this page ${Math.round((timestamp - match.ts) / 1000)}s ago and the URL has not changed since. Stripe-style UIs often reuse the same label for the modal-OPEN button and the SUBMIT button inside the modal — a second click typically creates a duplicate record. Before clicking "${rawText}" again, verify: (a) that all required fields are actually filled by reading the form/page, (b) that this click is intended as a FIRST submit and not a retry. If the previous click did nothing because a field was empty, fill the field first. If you genuinely need to retry, pass _allowResubmit: true in the args.`,
      previousClickUrl: match.url,
      currentUrl,
      secondsSincePrevious: Math.round((timestamp - match.ts) / 1000),
    };
  }

  fresh.push({ key, ts: timestamp, url: currentUrl, text: rawText });
  recentSubmitClicks.set(tabId, fresh);
  return null;
}
