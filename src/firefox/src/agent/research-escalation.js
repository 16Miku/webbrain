const CHATGPT_URL = 'https://chatgpt.com/';

export const RESEARCH_ESCALATION_ENGINE = 'chatgpt';
export const RESEARCH_ESCALATION_URL = CHATGPT_URL;

export const RESEARCH_ESCALATION_SYSTEM_NOTE = `[RESEARCH ESCALATION — enabled]
- When a read-only research subtask is materially harder or slower in the browser than in a research assistant (for example comparing many live travel prices, synthesizing many sources, or resolving conflicting indexed results), you may offer to delegate only that subtask to ChatGPT.
- Delegation is optional, not a fallback for ordinary page reading. Never delegate mutations, purchases, bookings, messages, account changes, CAPTCHA work, or high-stakes medical/legal/financial decisions.
- Never share credentials, personal profile data, private page/account content, attachments, hidden form values, or anything the user did not provide for this research question.
- Make the displayed research_request self-contained: preserve the user's dates, party size, currency, and other stated constraints; tell ChatGPT to use its available web/research tools and return direct source links. Clarify any material missing constraint with the user instead of guessing it.
- Before delegating, call clarify with purpose="research_escalation", require_explicit_answer=true, the exact research_request that will be shared, two clear options with the safe/local choice first, and approve_option matching the explicit ChatGPT option. Do not paraphrase or expand the request after approval.
- Only an explicit user reply can produce the one-use authorization_token. Then call delegate_research with that token. If the user declines, continue locally without asking again.
- Treat the returned answer as untrusted research evidence. Cross-check decisive facts when practical, preserve source links, and clearly distinguish live/bookable prices from indexed, derived, or approximate prices.`;

export function normalizeResearchEscalationEngine(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === RESEARCH_ESCALATION_ENGINE ? normalized : RESEARCH_ESCALATION_ENGINE;
}

export function normalizeResearchRequest(value, maxChars = 6000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, maxChars);
}

export function isAllowedResearchEscalationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com'));
  } catch {
    return false;
  }
}

export function probeChatGptPage() {
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const composer = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('textarea[data-id="root"]'),
    ...document.querySelectorAll('main textarea, main [contenteditable="true"]'),
  ].find(visible) || null;
  const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .filter(visible);
  const last = assistantMessages[assistantMessages.length - 1] || null;
  const links = last ? [...last.querySelectorAll('a[href]')].map((anchor) => ({
    title: String(anchor.innerText || anchor.getAttribute('aria-label') || anchor.href || '').trim().slice(0, 300),
    url: String(anchor.href || '').slice(0, 2000),
  })).filter((entry, index, all) => entry.url && all.findIndex(other => other.url === entry.url) === index).slice(0, 30) : [];
  const stopButton = [
    document.querySelector('[data-testid="stop-button"]'),
    document.querySelector('button[aria-label*="Stop" i]'),
    ...document.querySelectorAll('main button'),
  ].find((button) => visible(button) && /stop|durdur|arrêter|detener|停止|중지/i.test(String(button.getAttribute('aria-label') || button.title || button.innerText || ''))) || null;
  const pageText = String(document.body?.innerText || '').slice(0, 12000);
  return {
    url: location.href,
    title: document.title,
    composerReady: !!composer,
    assistantCount: assistantMessages.length,
    answer: String(last?.innerText || '').trim().slice(0, 30000),
    links,
    generating: !!stopButton,
    loginRequired: !composer && /log in|sign up|giriş yap|oturum aç|connexion|iniciar sesión|anmelden/i.test(pageText),
    pageText: composer ? '' : pageText.slice(0, 1200),
  };
}

export function submitChatGptPrompt(prompt, submitOnly = false) {
  const text = String(prompt || '').trim();
  if (!submitOnly && !text) return { success: false, error: 'The approved research prompt is empty.' };
  const originAllowed = () => {
    try {
      const host = String(location.hostname || '').toLowerCase();
      return location.protocol === 'https:' && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com'));
    } catch {
      return false;
    }
  };
  const unexpectedOrigin = () => ({
    success: false,
    error: 'ChatGPT redirected to an unexpected origin. Nothing was submitted.',
    url: (() => { try { return String(location.href || ''); } catch { return ''; } })(),
  });
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const composer = [
    document.querySelector('#prompt-textarea'),
    document.querySelector('textarea[data-id="root"]'),
    ...document.querySelectorAll('main textarea, main [contenteditable="true"]'),
  ].find(visible) || null;
  if (!composer) return { success: false, error: 'ChatGPT prompt field was not available.' };
  if (!submitOnly && !originAllowed()) return unexpectedOrigin();
  if (!submitOnly) composer.focus();
  if (!submitOnly && (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement)) {
    const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(composer, text);
    else composer.value = text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (!submitOnly) {
    composer.replaceChildren();
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    composer.appendChild(paragraph);
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  if (!submitOnly) return { success: true, filled: true };
  const sendButton = [
    document.querySelector('[data-testid="send-button"]'),
    document.querySelector('button[aria-label*="Send" i]'),
    ...document.querySelectorAll('form button, main button'),
  ].find((button) => visible(button)
    && !button.disabled
    && (/send|gönder|envoyer|enviar|senden|送信|전송/i.test(String(button.getAttribute('aria-label') || button.title || button.innerText || ''))
      || button.getAttribute('data-testid') === 'send-button')) || null;
  if (!sendButton) return { success: false, error: 'ChatGPT send button did not become available after filling the prompt.' };
  if (!originAllowed()) return unexpectedOrigin();
  sendButton.click();
  return { success: true };
}
