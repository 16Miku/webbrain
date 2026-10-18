// Hardware eval for the tiny Ask screenshot gate: the in-browser model's own
// Yes/No readout on whether a question needs a screenshot of the current page
// (src/chrome/src/agent/tiny-ask.js, tinyAskScreenshotGate). Runs labelled
// questions in several languages through the real extension's decision path
// and reports accuracy, latency and every miss.
//
//   node scripts/check-tiny-ask-screenshot-gate.mjs --profile <profile with the model cached> \
//     --adapter-luid 0,82094 --output .build/tiny-ask-gate/result.json
//
// --extension DIR    unpacked extension (default src/chrome); use a fresh profile per build
// --threshold P      Yes threshold to report (default TINY_ASK_SCREENSHOT_GATE_THRESHOLD)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { tinyAskScreenshotGate, tinyAskScreenshotGateProbability, TINY_ASK_SCREENSHOT_GATE_THRESHOLD } from '../src/chrome/src/agent/tiny-ask.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const extension = path.resolve(option('--extension', path.join(root, 'src/chrome')));
const profile = path.resolve(option('--profile', '.build/tiny-ask-gate/profile'));
const output = path.resolve(option('--output', '.build/tiny-ask-gate/result.json'));
const model = 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision';
const threshold = Number(option('--threshold', TINY_ASK_SCREENSHOT_GATE_THRESHOLD));

// [expected, language, question, context]. Expected Yes: the answer depends on
// what the current page visibly shows. Pages have text unless `pageChars` says
// otherwise.
const TEXT_PAGE = { pageChars: 5000 };
const TEXTLESS = { pageChars: 0 };
const CASES = [
  // Visual questions about the current page.
  [true, 'en', 'What color is the Buy button?', TEXT_PAGE],
  [true, 'en', 'What does the chart on this page show?', TEXT_PAGE],
  [true, 'en', 'Describe the photo at the top.', TEXT_PAGE],
  [true, 'en', 'Is the logo red or blue?', TEXT_PAGE],
  [true, 'en', 'How does this page look on my screen?', TEXT_PAGE],
  [true, 'tr', 'Satın al butonu ne renk?', TEXT_PAGE],
  [true, 'tr', 'Bu sayfadaki grafik ne gösteriyor?', TEXT_PAGE],
  [true, 'tr', 'Fotoğraftaki kupa ne renk?', TEXT_PAGE],
  [true, 'de', 'Welche Farbe hat der Kaufen-Knopf?', TEXT_PAGE],
  [true, 'de', 'Was zeigt das Diagramm auf dieser Seite?', TEXT_PAGE],
  [true, 'es', '¿De qué color es el botón de compra?', TEXT_PAGE],
  [true, 'es', '¿Qué muestra la foto de esta página?', TEXT_PAGE],
  [true, 'fr', 'De quelle couleur est le logo ?', TEXT_PAGE],
  [true, 'fr', 'Que montre le graphique sur cette page ?', TEXT_PAGE],
  [true, 'it', 'Di che colore è il pulsante Acquista?', TEXT_PAGE],
  [true, 'pt', 'O que mostra a imagem desta página?', TEXT_PAGE],
  [true, 'ja', 'このページの画像には何が写っていますか？', TEXT_PAGE],
  [true, 'ar', 'ما لون زر الشراء في هذه الصفحة؟', TEXT_PAGE],
  // Questions about a page with almost no text.
  [true, 'en', 'What is on this page?', TEXTLESS],
  [true, 'tr', 'Bu sayfada ne var?', TEXTLESS],
  [true, 'de', 'Was ist auf dieser Seite zu sehen?', TEXTLESS],
  [true, 'es', 'Resume esta página.', TEXTLESS],
  // Mixed sources that name the current page.
  [true, 'en', 'Compare the attached image with the logo on this page.', { ...TEXT_PAGE, imageAttachment: true }],
  [true, 'tr', 'Eklediğim resim bu sayfadaki logoya benziyor mu?', { ...TEXT_PAGE, imageAttachment: true }],
  // Answered from the page text.
  [false, 'en', 'How much is the Pro plan per month?', TEXT_PAGE],
  [false, 'en', 'Summarize this page in two sentences.', TEXT_PAGE],
  [false, 'en', 'When did the repairs end?', TEXT_PAGE],
  [false, 'en', 'Who wrote this article?', TEXT_PAGE],
  [false, 'tr', 'Pro planı aylık ne kadar?', TEXT_PAGE],
  [false, 'tr', 'Bu sayfayı özetle.', TEXT_PAGE],
  [false, 'de', 'Wie viel kostet der Pro-Tarif im Monat?', TEXT_PAGE],
  [false, 'de', 'Fasse diese Seite zusammen.', TEXT_PAGE],
  [false, 'es', '¿Cuánto cuesta el plan Pro al mes?', TEXT_PAGE],
  [false, 'fr', 'Résume cette page en deux phrases.', TEXT_PAGE],
  [false, 'it', 'Quando è stato pubblicato questo articolo?', TEXT_PAGE],
  [false, 'pt', 'Quanto custa o plano Pro por mês?', TEXT_PAGE],
  [false, 'ja', 'このページを要約してください。', TEXT_PAGE],
  [false, 'ar', 'لخص هذه الصفحة.', TEXT_PAGE],
  // General knowledge, including visual-sounding questions.
  [false, 'en', 'What does melanoma look like?', TEXT_PAGE],
  [false, 'en', 'Explain what melanoma looks like.', TEXTLESS],
  [false, 'en', 'Who was Ada Lovelace?', TEXTLESS],
  [false, 'en', 'What color is a flamingo?', TEXT_PAGE],
  [false, 'en', 'How do I treat a burn?', TEXT_PAGE],
  [false, 'tr', 'Melanom nasıl görünür?', TEXT_PAGE],
  [false, 'tr', 'Ada Lovelace kimdir?', TEXTLESS],
  [false, 'de', 'Wie sieht ein Flamingo aus?', TEXT_PAGE],
  [false, 'es', '¿Qué es la fotosíntesis?', TEXT_PAGE],
  [false, 'fr', 'Quelle est la capitale du Japon ?', TEXTLESS],
  [false, 'ja', '富士山の高さは？', TEXT_PAGE],
  [false, 'ar', 'من هو ابن سينا؟', TEXT_PAGE],
  // Only about an attached image or a linked page.
  [false, 'en', 'What is in this image?', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'tr', 'Bu resimde ne var?', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'de', 'Beschreibe dieses Bild.', { ...TEXT_PAGE, imageAttachment: true }],
  [false, 'en', 'What color is the logo at https://brand.example/about?', { ...TEXT_PAGE, linkedPage: true }],
  [false, 'es', 'Resume https://news.example/launch en una frase.', { ...TEXT_PAGE, linkedPage: true }],
];

const result = { model, extension, threshold, startedAt: new Date().toISOString(), cases: [] };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--enable-unsafe-webgpu', '--force-high-performance-gpu',
      ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ onboardingComplete: true, wbLocale: 'en', helpImproveWebBrain: false }));
  result.extensionVersion = await harness.evaluate(() => chrome.runtime.getManifest().version);
  const preset = (await import('../src/chrome/src/providers/webgpu.js')).webgpuModelPreset(model);
  await message('update_provider', { providerId: 'webgpu', config: { model, dtype: preset.dtype } });
  const status = await message('get_webgpu_download_status', { model });
  if (!status?.ready) throw new Error(`${model} is not cached in this profile`);
  for (const [index, [expected, language, question, facts]] of CASES.entries()) {
    const gate = tinyAskScreenshotGate({ question, ...facts });
    const started = Date.now();
    const reply = await message('webgpu_decide_fixture', { fixture: { ...gate, promptVariant: 'classify' } });
    const seconds = (Date.now() - started) / 1000;
    const probability = tinyAskScreenshotGateProbability(reply?.result?.answers);
    const choice = reply?.result?.answers?.needs_screenshot?.choice || null;
    const entry = {
      expected, language, question, ...facts, choice, probability,
      predicted: probability >= threshold, seconds, ...(reply?.success ? {} : { error: reply?.error || 'no reply' }),
    };
    entry.correct = entry.error ? false : entry.predicted === expected;
    if (index > 0) result.cases.push(entry); else result.cold = entry;
    console.log(JSON.stringify({ ok: entry.correct, p: entry.probability?.toFixed(3), choice, s: seconds, language, question }));
  }
  // The first call loads the model; score it, but keep it out of the latency.
  const all = [result.cold, ...result.cases];
  const latency = result.cases.map(entry => entry.seconds).sort((a, b) => a - b);
  const share = (rows, test) => `${rows.filter(test).length}/${rows.length}`;
  result.summary = {
    accuracy: share(all, entry => entry.correct),
    yesRecall: share(all.filter(entry => entry.expected), entry => entry.predicted),
    falseYes: share(all.filter(entry => !entry.expected), entry => entry.predicted),
    byLanguage: Object.fromEntries([...new Set(all.map(entry => entry.language))]
      .map(language => [language, share(all.filter(entry => entry.language === language), entry => entry.correct)])),
    latencySeconds: { p50: latency[Math.floor(latency.length / 2)], p95: latency[Math.floor(latency.length * 0.95)] },
    misses: all.filter(entry => !entry.correct).map(entry => ({ expected: entry.expected, p: entry.probability, question: entry.question })),
  };
  console.log(JSON.stringify(result.summary, null, 1));
} catch (error) {
  result.error = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await context?.close().catch(() => {});
}
