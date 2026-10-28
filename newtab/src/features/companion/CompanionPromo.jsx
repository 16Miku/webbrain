import { useEffect, useRef, useState } from 'react';
import { MdArrowForward, MdClose } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import { resolveWebBrainLocale } from 'lib/locale';
import companionIcon from 'assets/icons/companion.png';
import webbrainIcon from 'assets/icons/webbrain.png';
import anthropicLogo from 'assets/providers/anthropic.svg';
import openaiLogo from 'assets/providers/openai.svg';
import geminiLogo from 'assets/providers/gemini.svg';
import xaiLogo from 'assets/providers/xai.svg';
import kimiLogo from 'assets/providers/kimi.svg';
import {
  DEMO_PLANS,
  companionPageUrl,
  dismissCompanionPromo,
  shouldShowCompanionPromo,
} from './companion-promo';

import './companion-promo.scss';

// One plan per step. The keyframes in companion-promo.scss are percentages of this (--wbcp-step).
const STEP_MS = 3200;
const LEAVE_MS = 260;
// Lifts the photo credit above the banner while it is on screen; the banner's height (which
// depends on how the text wraps in each language) goes in --wbcp-height (companion-promo.scss).
const SHOWN_CLASS = 'wbCompanionPromoShown';
const LOGOS = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  gemini: geminiLogo,
  xai: xaiLogo,
  kimi: kimiLogo,
};

const prefersStill = () =>
  Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ||
  document.body.classList.contains('no-animations');

// A plan's sign-in travels through the tray app into WebBrain's side panel, which answers with
// that plan selected in its composer.
function Demo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    // Still mode keeps the first plan; the stylesheet drops the animations and shows the end state.
    if (prefersStill()) return undefined;
    const timer = setInterval(() => setStep((n) => n + 1), STEP_MS);
    return () => clearInterval(timer);
  }, []);

  const plan = DEMO_PLANS[step % DEMO_PLANS.length];
  const logo = LOGOS[plan.logo];

  return (
    <div
      className="wbcpDemo"
      aria-hidden="true"
      style={{
        '--wbcp-plan': plan.color,
        '--wbcp-tile': plan.tile,
        '--wbcp-left': plan.left / 100,
        '--wbcp-step': `${STEP_MS}ms`,
      }}
    >
      {/* Keyed by step so every animation inside restarts with the next plan. */}
      <div className="wbcpStage" key={step}>
        <span className="wbcpPlan">
          <span className="wbcpTile">
            <img src={logo} alt="" width="20" height="20" />
          </span>
          <span className="wbcpMeter">
            <span className="wbcpMeterFill" />
          </span>
          <span className="wbcpPlanName">{plan.name}</span>
        </span>
        <span className="wbcpWire">
          <span className="wbcpPacket" />
        </span>
        <span className="wbcpTray">
          <img src={companionIcon} alt="" width="20" height="20" />
          <span className="wbcpAddr">127.0.0.1:8327</span>
          <span className="wbcpLive" />
        </span>
        <span className="wbcpWire wbcpWireOut">
          <span className="wbcpPacket" />
        </span>
        <span className="wbcpWindow">
          <span className="wbcpWindowBar">
            <i />
            <i />
            <i />
            <b />
          </span>
          <span className="wbcpWindowBody">
            <span className="wbcpPage">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="wbcpPanel">
              <span className="wbcpPanelHead">
                <img src={webbrainIcon} alt="" width="9" height="9" />
                <b />
              </span>
              <span className="wbcpAsk" />
              <span className="wbcpReply">
                <i />
                <i />
                <i />
              </span>
              <span className="wbcpComposer">
                <span className="wbcpComposerLogo">
                  <img src={logo} alt="" width="8" height="8" />
                </span>
                <b />
              </span>
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

// Fixed to the bottom of the page, outside #center: it is a fixed overlay, not part of the
// centred widget column. Renders nothing until storage says to show it (companion-promo.js).
function CompanionPromo() {
  const [state, setState] = useState('checking');
  const banner = useRef(null);

  useEffect(() => {
    let alive = true;
    shouldShowCompanionPromo().then((show) => {
      if (alive) setState(show ? 'shown' : 'gone');
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state !== 'shown') return undefined;
    const root = document.documentElement;
    root.classList.add(SHOWN_CLASS);
    const observer =
      typeof globalThis.ResizeObserver === 'function' && banner.current
        ? new globalThis.ResizeObserver(([entry]) => {
            root.style.setProperty(
              '--wbcp-height',
              `${Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height)}px`,
            );
          })
        : null;
    observer?.observe(banner.current);
    return () => {
      observer?.disconnect();
      root.classList.remove(SHOWN_CLASS);
      root.style.removeProperty('--wbcp-height');
    };
  }, [state]);

  useEffect(() => {
    if (state !== 'leaving') return undefined;
    const timer = setTimeout(() => setState('gone'), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (state !== 'shown' && state !== 'leaving') return null;

  return (
    <aside
      ref={banner}
      className={state === 'leaving' ? 'wbCompanionPromo leaving' : 'wbCompanionPromo'}
      aria-label="WebBrain Companion"
    >
      <Demo />
      <div className="wbcpText">
        <span className="wbcpEyebrow">
          <img src={companionIcon} alt="" width="16" height="16" />
          WebBrain Companion
        </span>
        <strong className="wbcpTitle">{wbT('wb.companion_title')}</strong>
        <span className="wbcpBody">{wbT('wb.companion_body')}</span>
      </div>
      <div className="wbcpActions">
        <a
          className="wbcpCta"
          href={companionPageUrl(resolveWebBrainLocale())}
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {wbT('wb.companion_cta')}
          <MdArrowForward className="wbcpCtaArrow" />
        </a>
        <span className="wbcpPlatforms">macOS · Windows · Linux</span>
      </div>
      <button
        type="button"
        className="wbcpDismiss"
        title={wbT('wb.companion_dismiss')}
        aria-label={wbT('wb.companion_dismiss')}
        onClick={() => {
          dismissCompanionPromo();
          setState(prefersStill() ? 'gone' : 'leaving');
        }}
      >
        <MdClose />
      </button>
    </aside>
  );
}

export default CompanionPromo;
