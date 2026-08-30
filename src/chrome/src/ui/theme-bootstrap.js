// Pre-paint theme bootstrap. Sets <html data-theme="..."> from
// localStorage('wbTheme') > prefers-color-scheme > 'dark' before the
// stylesheet loads, so the page never opens in the wrong theme.
//
// Must be a classic script (not a module) loaded synchronously in <head>
// BEFORE the stylesheet link — that way it's parser-blocking and runs
// before any layout/paint. MV3's default CSP forbids inline scripts, so
// this lives in its own file.
//
// Stays in lockstep with theme.js, but uses only DOM APIs (no chrome.*)
// since this runs before any module hydration.
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    if (params.get('standalone') === 'true') {
      document.documentElement.setAttribute('data-standalone', 'true');
    }
  } catch (_) { /* ignore */ }

  try {
    var mode = localStorage.getItem('wbTheme');
    if (mode !== 'light' && mode !== 'dark') mode = 'system';
    var theme = (mode === 'system')
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : mode;
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  try {
    if (window.location.pathname.endsWith('/sidepanel.html')) {
      var levels = [75, 80, 90, 100, 110, 125, 150, 175];
      var scale = Number(localStorage.getItem('wbUiScale'));
      if (levels.indexOf(scale) === -1) scale = 100;
      var inverse = Number((10000 / scale).toFixed(4));
      document.documentElement.setAttribute('data-ui-scale', String(scale));
      document.documentElement.style.setProperty('--ui-scale-zoom', String(scale / 100));
      document.documentElement.style.setProperty('--ui-scale-width', inverse + '%');
      document.documentElement.style.setProperty('--ui-scale-height', inverse + 'vh');
    }
  } catch (_) { /* default CSS variables keep the panel at 100% */ }
})();
