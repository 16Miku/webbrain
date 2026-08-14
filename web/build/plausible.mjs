export const PLAUSIBLE_SCRIPT_URL = 'https://plausible.io/js/pa-yWGfwxkkKSVs-eTuaKYpy.js';

export const PLAUSIBLE_ANALYTICS = `  <!-- Plausible analytics: start -->
  <!-- Privacy-friendly analytics by Plausible -->
  <script async src="${PLAUSIBLE_SCRIPT_URL}"></script>
  <script>
    window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
    plausible.init()
  </script>
  <!-- Plausible analytics: end -->`;

const PLAUSIBLE_BLOCK_RE = /[ \t]*<!-- Plausible analytics: start -->[\s\S]*?<!-- Plausible analytics: end -->[ \t]*/;

export function withPlausibleAnalytics(html) {
  if (PLAUSIBLE_BLOCK_RE.test(html)) {
    return html.replace(PLAUSIBLE_BLOCK_RE, PLAUSIBLE_ANALYTICS);
  }

  if (!html.includes('</head>')) {
    throw new Error('Cannot add Plausible analytics: document has no </head> tag');
  }

  return html.replace('</head>', `${PLAUSIBLE_ANALYTICS}\n</head>`);
}
