import { useEffect, useState } from 'react';
import { MdArrowForward, MdClose } from 'react-icons/md';
import { wbT } from 'lib/wb-strings';
import { resolveWebBrainLocale } from 'lib/locale';
import companionIcon from 'assets/icons/companion.png';
import anthropicLogo from 'assets/providers/anthropic.svg';
import openaiLogo from 'assets/providers/openai.svg';
import geminiLogo from 'assets/providers/gemini.svg';
import xaiLogo from 'assets/providers/xai.svg';
import kimiLogo from 'assets/providers/kimi.svg';
import {
  PLANS,
  companionPageUrl,
  dismissCompanionPromo,
  shouldShowCompanionPromo,
} from './companion-promo';

import './companion-promo.scss';

const LEAVE_MS = 260;
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

// Shown under the task box while there is no bulletin to show (Bulletin.jsx), at its own width.
// Renders nothing until storage says to show it (companion-promo.js).
function CompanionPromo() {
  const [state, setState] = useState('checking');

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
    if (state !== 'leaving') return undefined;
    const timer = setTimeout(() => setState('gone'), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (state !== 'shown' && state !== 'leaving') return null;

  return (
    <aside
      className={state === 'leaving' ? 'wbCompanionPromo leaving' : 'wbCompanionPromo'}
      aria-label="WebBrain Companion"
    >
      <ul className="wbcpPlans">
        {PLANS.map((plan) => (
          <li
            key={plan.logo}
            className="wbcpTile"
            style={{ '--wbcp-tile': plan.tile }}
            title={plan.name}
          >
            <img src={LOGOS[plan.logo]} alt={plan.name} width="22" height="22" />
          </li>
        ))}
      </ul>
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
