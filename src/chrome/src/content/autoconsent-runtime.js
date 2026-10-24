// Keep cancellation outside the upstream module. All clicks, including delayed
// clicks in waitForThenClick and click-all rules, recheck background coverage.
import AutoConsent from '../../vendor/autoconsent/autoconsent.esm.js';

export function guardCookieBannerInstance(consent, hasCoverage) {
  let stopped = false;
  const cancelled = new Error('Cookie-banner coverage revoked');
  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      consent.config.enabled = false;
      consent.config.autoAction = null;
      consent.undoPrehide();
    } catch {} // It may not have received its init response yet.
  }
  async function allowed() {
    if (stopped) return false;
    let covered = false;
    try { covered = await hasCoverage() === true; } catch {}
    if (stopped || !covered) {
      stop();
      return false;
    }
    return true;
  }
  async function requireCoverage() {
    if (!await allowed()) throw cancelled;
  }
  for (const name of ['_start', 'doOptOut', 'doOptIn', 'handlePopup']) {
    if (typeof consent[name] !== 'function') continue;
    const original = consent[name].bind(consent);
    consent[name] = async (...args) => {
      try {
        await requireCoverage();
        return await original(...args);
      } catch (error) {
        if (error !== cancelled) throw error;
        return false;
      }
    };
  }
  for (const name of ['findCmp', 'waitForPopup']) {
    const original = consent[name].bind(consent);
    consent[name] = (...args) => stopped ? Promise.resolve(name === 'findCmp' ? [] : false) : original(...args);
  }
  const dom = consent.domActions;
  const clickElement = dom.clickElement.bind(dom);
  dom.clickElement = async element => {
    await requireCoverage();
    const result = await clickElement(element);
    await requireCoverage();
    return result;
  };
  dom.click = async (selector, all = false) => {
    const elements = dom.elementSelector(selector);
    if (!elements.length) return false;
    for (const element of all ? elements : elements.slice(0, 1)) {
      // Selector chains can enter a same-origin iframe. Upstream clickElement
      // rejects that realm's HTMLElement; upstream selector clicks do not.
      await requireCoverage();
      element.click();
      await requireCoverage();
    }
    return true;
  };
  // Some upstream dynamic rules use raw element.click() after awaiting a
  // helper. Unwind the rule at that boundary, rather than returning false
  // and letting it continue into those direct mutations.
  for (const name of ['wait', 'waitForElement', 'waitForVisible', 'waitForThenClick']) {
    if (typeof dom[name] !== 'function') continue;
    const original = dom[name].bind(dom);
    dom[name] = async (...args) => {
      await requireCoverage();
      const result = await original(...args);
      await requireCoverage();
      return result;
    };
  }
  // These upstream helpers are synchronous. Revocation also stops cosmetic
  // changes and pre-hiding while an earlier rule is waiting for an element.
  for (const name of ['hide', 'stylesheet', 'removeClass', 'setStyle', 'addStyle', 'prehide']) {
    const original = dom[name].bind(dom);
    dom[name] = (...args) => stopped ? false : original(...args);
  }
  const restoreFocus = consent.restoreFocus.bind(consent);
  consent.restoreFocus = () => { if (!stopped) restoreFocus(); };
  return { stop, get stopped() { return stopped; } };
}

export function createCookieBannerRuntime(send, hasCoverage) {
  let guard;
  const consent = new AutoConsent(message => {
    if (!guard?.stopped) send(message);
  }, null, { autoconsent: [] });
  guard = guardCookieBannerInstance(consent, hasCoverage);
  return {
    stop: guard.stop,
    get stopped() { return guard.stopped; },
    receive(message) {
      if (message.type === 'stop' || (message.type === 'initResp' && !message.config?.enabled)) {
        guard.stop();
        return;
      }
      if (!guard.stopped) return consent.receiveMessageCallback(message);
    },
  };
}
