import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');

function dataUri(relativePath, mime) {
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function fontUri(name) {
  const bytes = readFileSync(path.join(DIR, 'fonts', name));
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

const assets = {
  logo: dataUri('assets/logo-github.png', 'image/png'),
};

const fonts = {
  display: fontUri('instrument-serif-400.woff2'),
  sans: fontUri('instrument-sans-var.woff2'),
  mono: fontUri('geist-mono-var.woff2'),
};

const SUPERSAMPLE = 2;

const copy = {
  en: {
    headline: 'Open-source AI browser agent',
    body: 'Chat with and act on any page — running local models, fully private.',
    features: ['Chrome & Firefox', 'llama.cpp', 'OpenRouter', 'OpenAI', 'GPL-3.0+ licensed'],
    bannerUrl: 'webbrain.one',
    socialUrl: 'github.com/webbrain-one/webbrain',
  },
  tr: {
    headline: 'Yapay Zeka Chrome/Firefox Yardımcısı',
    body: 'Herhangi bir sayfayla sohbet et, işlem yap — yerel modellerle, tamamen özel.',
    features: ['Chrome & Firefox', 'llama.cpp', 'OpenRouter', 'OpenAI', 'GPL-3.0+ lisanslı'],
    bannerUrl: 'webbrain.one/tr/',
  },
};

function featureRow(items, className = 'feature-row') {
  return `<div class="${className}">${items.map((item) => `<span>${item}</span>`).join('')}</div>`;
}

const sharedCss = `
  @font-face {
    font-family: 'Instrument Serif';
    src: url(${fonts.display}) format('woff2');
    font-style: normal;
    font-weight: 400;
  }
  @font-face {
    font-family: 'Instrument Sans';
    src: url(${fonts.sans}) format('woff2');
    font-style: normal;
    font-weight: 400 700;
  }
  @font-face {
    font-family: 'Geist Mono';
    src: url(${fonts.mono}) format('woff2');
    font-style: normal;
    font-weight: 400 700;
  }
  :root {
    color-scheme: light;
    --display: 'Instrument Serif', ui-serif, Georgia, serif;
    --sans: 'Instrument Sans', ui-sans-serif, system-ui, sans-serif;
    --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --ink: #11182c;
    --muted: #55627a;
    --quiet: #77839a;
    --purple: #685cf6;
    --cyan: #10b9ce;
    --paper: #f8f8ff;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    overflow: hidden;
    font-family: var(--sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .canvas {
    position: relative;
    overflow: hidden;
    isolation: isolate;
  }
  .canvas::before {
    content: '';
    position: absolute;
    z-index: 2;
    inset: 0 0 auto;
    height: var(--rail, 7px);
    background: linear-gradient(90deg, var(--purple), #8f59f3 44%, var(--cyan));
  }
  .paper {
    color: var(--ink);
    background:
      radial-gradient(circle at 18% 8%, rgba(104, 92, 246, 0.08), transparent 28%),
      radial-gradient(circle at 92% 82%, rgba(16, 185, 206, 0.07), transparent 30%),
      linear-gradient(145deg, #fbfbff, #f4f5ff);
  }
  .paper::after {
    content: '';
    position: absolute;
    z-index: -1;
    right: -8%;
    bottom: -34%;
    width: 58%;
    height: 62%;
    opacity: 0.45;
    transform: rotate(-8deg);
    background:
      linear-gradient(90deg, transparent 0 44px, rgba(104, 92, 246, 0.055) 44px 46px, transparent 46px 92px),
      linear-gradient(0deg, transparent 0 44px, rgba(16, 185, 206, 0.05) 44px 46px, transparent 46px 92px);
  }
  .dark {
    --ink: #f8f7ff;
    --muted: #cbc7df;
    --quiet: #aaa5c2;
    color: var(--ink);
    background:
      radial-gradient(circle at 20% 54%, rgba(121, 97, 255, 0.34), transparent 29%),
      radial-gradient(circle at 88% 105%, rgba(33, 194, 205, 0.12), transparent 34%),
      linear-gradient(135deg, #17142f, #2c2458);
  }
  .logo {
    display: block;
    object-fit: cover;
    border-radius: 24%;
    box-shadow:
      0 18px 46px rgba(30, 21, 91, 0.22),
      0 0 0 1px rgba(255, 255, 255, 0.12);
  }
  .wordmark {
    font-family: var(--sans);
    font-weight: 700;
    letter-spacing: -0.055em;
  }
  .headline {
    margin: 0;
    font-family: var(--display);
    font-weight: 400;
    letter-spacing: -0.025em;
  }
  .body-copy {
    color: var(--muted);
    font-weight: 450;
    letter-spacing: -0.012em;
  }
  .accent {
    width: 118px;
    height: 5px;
    border-radius: 99px;
    background: linear-gradient(90deg, var(--purple), var(--cyan));
  }
  .feature-row {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--quiet);
    font-family: var(--mono);
    font-weight: 500;
    letter-spacing: -0.025em;
  }
  .feature-row span {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
  }
  .feature-row span + span::before {
    content: '·';
    margin: 0 0.75em;
    color: #b8bad0;
  }
  .url {
    color: var(--purple);
    font-family: var(--mono);
    font-weight: 600;
    letter-spacing: -0.035em;
  }
`;

function socialCard() {
  const c = copy.en;
  return {
    file: 'webbrain-social-card.png',
    width: 1280,
    height: 640,
    body: `
      <main class="canvas paper social-card">
        <div class="social-inner">
          <div class="social-brand">
            <img class="logo" src="${assets.logo}" alt="">
            <span class="wordmark">WebBrain</span>
          </div>
          <h1 class="headline">${c.headline}</h1>
          <div class="accent"></div>
          <div class="body-copy">${c.body}</div>
          ${featureRow(c.features)}
          <div class="url">${c.socialUrl}</div>
        </div>
      </main>`,
    css: `
      .social-card {
        --rail: 6px;
        width: 1280px;
        height: 640px;
      }
      .social-inner {
        position: relative;
        z-index: 1;
        height: 100%;
        padding: 62px 72px 45px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .social-brand {
        display: flex;
        align-items: center;
        gap: 24px;
      }
      .social-brand .logo { width: 112px; height: 112px; border-radius: 27px; }
      .social-brand .wordmark { font-size: 61px; }
      .social-card .headline {
        margin-top: 59px;
        font-size: 69px;
        line-height: 0.98;
      }
      .social-card .accent { margin-top: 24px; }
      .social-card .body-copy { margin-top: 34px; font-size: 25px; }
      .social-card .feature-row { margin-top: 23px; font-size: 15px; }
      .social-card .url { margin-top: auto; font-size: 17px; }
    `,
  };
}

function socialCardSmall() {
  const c = copy.en;
  return {
    file: 'webbrain-social-card-300x188.png',
    width: 300,
    height: 188,
    body: `
      <main class="canvas paper social-small">
        <div class="small-inner">
          <div class="small-brand">
            <img class="logo" src="${assets.logo}" alt="">
            <span class="wordmark">WebBrain</span>
          </div>
          <h1 class="headline">${c.headline}</h1>
          <div class="accent"></div>
          <div class="body-copy">${c.body}</div>
          ${featureRow(c.features)}
          <div class="url">${c.socialUrl}</div>
        </div>
      </main>`,
    css: `
      .social-small {
        --rail: 2px;
        width: 300px;
        height: 188px;
      }
      .small-inner {
        position: relative;
        z-index: 1;
        height: 100%;
        padding: 18px 17px 12px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .small-brand { display: flex; align-items: center; gap: 7px; }
      .small-brand .logo { width: 31px; height: 31px; border-radius: 8px; }
      .small-brand .wordmark { font-size: 17px; letter-spacing: -0.045em; }
      .social-small .headline {
        margin-top: 17px;
        font-size: 22px;
        line-height: 1;
        white-space: nowrap;
      }
      .social-small .accent { width: 35px; height: 2px; margin-top: 8px; }
      .social-small .body-copy {
        margin-top: 10px;
        font-size: 7.6px;
        line-height: 1.2;
        white-space: nowrap;
      }
      .social-small .feature-row { margin-top: 7px; font-size: 5.4px; }
      .social-small .feature-row span + span::before { margin: 0 0.56em; }
      .social-small .url { margin-top: auto; font-size: 6.2px; }
    `,
  };
}

function websiteSocialCard() {
  const c = copy.en;
  return {
    file: 'website/og-image.png',
    width: 1200,
    height: 630,
    body: `
      <main class="canvas paper website-social">
        <div class="website-social-inner">
          <div class="website-social-brand">
            <img class="logo" src="${assets.logo}" alt="">
            <span class="wordmark">WebBrain</span>
          </div>
          <h1 class="headline">${c.headline}</h1>
          <div class="accent"></div>
          <div class="body-copy">${c.body}</div>
          ${featureRow(c.features)}
          <div class="url">${c.bannerUrl}</div>
        </div>
      </main>`,
    css: `
      .website-social {
        --rail: 6px;
        width: 1200px;
        height: 630px;
      }
      .website-social-inner {
        position: relative;
        z-index: 1;
        height: 100%;
        padding: 63px 68px 45px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .website-social-brand {
        display: flex;
        align-items: center;
        gap: 22px;
      }
      .website-social-brand .logo { width: 108px; height: 108px; border-radius: 26px; }
      .website-social-brand .wordmark { font-size: 58px; }
      .website-social .headline {
        margin-top: 59px;
        font-size: 67px;
        line-height: 0.98;
      }
      .website-social .accent { margin-top: 24px; }
      .website-social .body-copy { margin-top: 34px; font-size: 24px; }
      .website-social .feature-row { margin-top: 23px; font-size: 14px; }
      .website-social .url { margin-top: auto; font-size: 17px; }
    `,
  };
}

function storeMarquee() {
  return {
    file: 'store-promo-1400x560.png',
    width: 1400,
    height: 560,
    body: `
      <main class="canvas dark store-marquee">
        <div class="store-icon-wrap">
          <div class="store-orbit"></div>
          <img class="logo" src="${assets.logo}" alt="">
        </div>
        <div class="store-copy">
          <div class="wordmark">WebBrain</div>
          <h1 class="headline">Open-Source AI Browser Agent</h1>
          <div class="body-copy">Any LLM. Any Page. Your Data.</div>
          <div class="store-pills">
            <span>GPL-3.0+ LICENSED</span>
            <span>11+ PROVIDERS</span>
            <span>LOCAL OR CLOUD</span>
            <span>MV3 &amp; MV2</span>
          </div>
        </div>
      </main>`,
    css: `
      .store-marquee {
        --rail: 7px;
        width: 1400px;
        height: 560px;
        display: grid;
        grid-template-columns: 470px 1fr;
        align-items: center;
        padding: 56px 95px 48px 80px;
      }
      .store-icon-wrap {
        position: relative;
        width: 350px;
        height: 350px;
        display: grid;
        place-items: center;
      }
      .store-orbit {
        position: absolute;
        inset: 0;
        border: 1px solid rgba(178, 165, 255, 0.25);
        border-radius: 50%;
        box-shadow: inset 0 0 80px rgba(104, 92, 246, 0.08);
      }
      .store-orbit::after {
        content: '';
        position: absolute;
        width: 11px;
        height: 11px;
        top: 38px;
        right: 61px;
        border-radius: 50%;
        background: var(--cyan);
        box-shadow: 0 0 22px rgba(16, 185, 206, 0.8);
      }
      .store-icon-wrap .logo { width: 246px; height: 246px; border-radius: 58px; }
      .store-copy { align-self: center; padding-top: 2px; }
      .store-marquee .wordmark { font-size: 101px; line-height: 0.95; }
      .store-marquee .headline {
        margin-top: 27px;
        color: #e1dff1;
        font-size: 47px;
        line-height: 1;
        letter-spacing: -0.018em;
      }
      .store-marquee .body-copy { margin-top: 19px; font-size: 27px; }
      .store-pills { display: flex; gap: 11px; margin-top: 40px; }
      .store-pills span {
        padding: 10px 15px 9px;
        border: 1px solid rgba(180, 169, 255, 0.34);
        border-radius: 999px;
        background: rgba(111, 91, 230, 0.14);
        color: #e9e7f5;
        font-family: var(--mono);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.045em;
      }
    `,
  };
}

function storeSmall() {
  return {
    file: 'store-promo-440x280.png',
    width: 440,
    height: 280,
    body: `
      <main class="canvas dark store-small">
        <div class="small-store-icon">
          <img class="logo" src="${assets.logo}" alt="">
        </div>
        <div class="small-store-copy">
          <div class="wordmark">WebBrain</div>
          <h1 class="headline">Open-Source AI Browser Agent</h1>
          <div class="body-copy">Any LLM. Any Page. Your Data.</div>
          <div class="mini-rule"></div>
        </div>
      </main>`,
    css: `
      .store-small {
        --rail: 3px;
        width: 440px;
        height: 280px;
        display: grid;
        grid-template-columns: 140px 1fr;
        align-items: center;
        padding: 36px 29px 32px 32px;
      }
      .small-store-icon {
        width: 120px;
        height: 120px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(180, 169, 255, 0.22);
        border-radius: 50%;
      }
      .small-store-icon .logo { width: 91px; height: 91px; border-radius: 22px; }
      .small-store-copy { padding-left: 9px; }
      .store-small .wordmark { font-size: 41px; line-height: 1; }
      .store-small .headline {
        margin-top: 17px;
        color: #e1dff1;
        font-size: 19px;
        line-height: 1.04;
      }
      .store-small .body-copy { margin-top: 11px; font-size: 12.5px; }
      .mini-rule {
        width: 42px;
        height: 2px;
        margin-top: 23px;
        border-radius: 99px;
        background: linear-gradient(90deg, #8f79ff, var(--cyan));
      }
    `,
  };
}

function banner(locale) {
  const c = copy[locale];
  const isTurkish = locale === 'tr';
  return {
    file: `banners/webbrain-banner-${locale}.png`,
    width: 2560,
    height: 800,
    body: `
      <main class="canvas paper banner-wide ${isTurkish ? 'banner-tr' : 'banner-en'}">
        <section class="banner-brand">
          <img class="logo" src="${assets.logo}" alt="">
          <div class="banner-wordmark wordmark">WebBrain</div>
          <div class="url">${c.bannerUrl}</div>
        </section>
        <div class="banner-divider"></div>
        <section class="banner-message">
          <h1 class="headline">${c.headline}</h1>
          <div class="accent"></div>
          <div class="body-copy">${c.body}</div>
          ${featureRow(c.features)}
        </section>
      </main>`,
    css: `
      .banner-wide {
        --rail: 12px;
        width: 2560px;
        height: 800px;
        display: grid;
        grid-template-columns: 520px 1px 1fr;
        align-items: center;
        gap: 0;
        padding: 86px 110px 74px;
      }
      .banner-brand {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding-left: 28px;
      }
      .banner-brand .logo { width: 238px; height: 238px; border-radius: 56px; }
      .banner-wordmark { margin-top: 30px; font-size: 67px; line-height: 1; }
      .banner-brand .url { margin-top: 24px; font-size: 27px; }
      .banner-divider {
        width: 1px;
        height: 520px;
        background: linear-gradient(transparent, rgba(104, 92, 246, 0.2) 12%, rgba(104, 92, 246, 0.2) 88%, transparent);
      }
      .banner-message {
        min-width: 0;
        padding-left: 110px;
      }
      .banner-wide .headline {
        font-size: 112px;
        line-height: 0.96;
        white-space: nowrap;
      }
      .banner-tr .headline { font-size: 89px; letter-spacing: -0.03em; }
      .banner-wide .accent { margin-top: 43px; width: 180px; height: 7px; }
      .banner-wide .body-copy {
        margin-top: 48px;
        font-size: 38px;
        line-height: 1.25;
        white-space: nowrap;
      }
      .banner-wide .feature-row {
        justify-content: flex-start;
        margin-top: 43px;
        font-size: 21px;
      }
    `,
  };
}

function bannerVertical() {
  const c = copy.en;
  return {
    file: 'banners/webbrain-banner-vertical-en.png',
    width: 1280,
    height: 2560,
    body: `
      <main class="canvas paper banner-vertical">
        <header class="vertical-brand">
          <img class="logo" src="${assets.logo}" alt="">
          <span class="wordmark">WebBrain</span>
        </header>
        <section class="vertical-message">
          <div class="vertical-kicker">OPEN SOURCE · ANY LLM</div>
          <h1 class="headline">Open-source<br>AI browser<br>agent</h1>
          <div class="accent"></div>
          <div class="body-copy">${c.body}</div>
        </section>
        <section class="vertical-features">
          ${c.features.map((item, index) => `
            <div class="vertical-feature">
              <span>${String(index + 1).padStart(2, '0')}</span>
              <strong>${item}</strong>
            </div>`).join('')}
        </section>
        <footer class="vertical-footer">
          <div class="url">${c.socialUrl}</div>
        </footer>
      </main>`,
    css: `
      .banner-vertical {
        --rail: 12px;
        width: 1280px;
        height: 2560px;
        padding: 112px 105px 98px;
        display: flex;
        flex-direction: column;
      }
      .vertical-brand {
        display: flex;
        align-items: center;
        gap: 38px;
      }
      .vertical-brand .logo { width: 206px; height: 206px; border-radius: 49px; }
      .vertical-brand .wordmark { font-size: 91px; }
      .vertical-message { margin-top: 275px; }
      .vertical-kicker {
        color: var(--purple);
        font-family: var(--mono);
        font-size: 25px;
        font-weight: 600;
        letter-spacing: 0.15em;
      }
      .banner-vertical .headline {
        margin-top: 48px;
        max-width: 990px;
        font-size: 151px;
        line-height: 0.91;
      }
      .banner-vertical .accent { width: 210px; height: 8px; margin-top: 62px; }
      .banner-vertical .body-copy {
        max-width: 970px;
        margin-top: 76px;
        font-size: 48px;
        line-height: 1.34;
      }
      .vertical-features {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        margin-top: 140px;
      }
      .vertical-feature {
        min-height: 116px;
        padding: 26px 28px;
        display: grid;
        grid-template-columns: 50px 1fr;
        align-items: center;
        gap: 17px;
        border: 1px solid rgba(104, 92, 246, 0.16);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.55);
        box-shadow: 0 18px 54px rgba(34, 41, 91, 0.055);
      }
      .vertical-feature span {
        color: var(--purple);
        font-family: var(--mono);
        font-size: 17px;
      }
      .vertical-feature strong {
        color: var(--muted);
        font-family: var(--mono);
        font-size: 21px;
        font-weight: 550;
        letter-spacing: -0.03em;
      }
      .vertical-feature:last-child {
        grid-column: 1 / -1;
        width: calc(50% - 9px);
      }
      .vertical-footer {
        margin-top: auto;
        padding-top: 56px;
        border-top: 1px solid rgba(104, 92, 246, 0.14);
      }
      .vertical-footer .url { font-size: 30px; }
    `,
  };
}

const scenes = [
  socialCard(),
  socialCardSmall(),
  websiteSocialCard(),
  storeMarquee(),
  storeSmall(),
  banner('en'),
  banner('tr'),
  bannerVertical(),
];

function html(scene) {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          ${sharedCss}
          html, body { width: ${scene.width}px; height: ${scene.height}px; }
          ${scene.css}
        </style>
      </head>
      <body>${scene.body}</body>
    </html>`;
}

async function renderAll() {
  const browser = await chromium.launch();
  try {
    for (const scene of scenes) {
      const output = path.join(DIR, scene.file);
      await mkdir(path.dirname(output), { recursive: true });

      const page = await browser.newPage({
        viewport: { width: scene.width, height: scene.height },
        deviceScaleFactor: SUPERSAMPLE,
      });
      await page.setContent(html(scene), { waitUntil: 'load' });
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map((image) => {
          if (image.complete) return undefined;
          return new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', reject, { once: true });
          });
        }));
        await document.fonts.ready;
      });
      const supersampled = await page.screenshot({ scale: 'device' });
      const finalBase64 = await page.evaluate(async ({ pngBase64, width, height }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${pngBase64}`;
        await image.decode();

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, width, height);
        return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
      }, {
        pngBase64: supersampled.toString('base64'),
        width: scene.width,
        height: scene.height,
      });
      await writeFile(output, Buffer.from(finalBase64, 'base64'));
      await page.close();
      console.log('rendered', path.relative(DIR, output));
    }

    const websiteSocial = path.join(DIR, 'website', 'og-image.png');
    await copyFile(websiteSocial, path.join(ROOT, 'web', 'og-image.png'));
    await copyFile(websiteSocial, path.join(ROOT, 'web', 'twitter-image.png'));
    console.log('synced web/og-image.png and web/twitter-image.png');
  } finally {
    await browser.close();
  }
}

renderAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
