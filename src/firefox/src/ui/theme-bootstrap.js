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
      var root = document.documentElement;
      var levels = [75, 80, 90, 100, 110, 125, 150, 175];
      var applyScale = function (value) {
        var scale = Number(value);
        if (levels.indexOf(scale) === -1) scale = 100;
        var inverse = Number((10000 / scale).toFixed(4));
        root.setAttribute('data-ui-scale', String(scale));
        root.style.setProperty('--ui-scale-zoom', String(scale / 100));
        root.style.setProperty('--ui-scale-width', inverse + '%');
        root.style.setProperty('--ui-scale-height', inverse + 'vh');
      };
      var ready = false;
      var reveal = function () {
        if (ready) return;
        ready = true;
        root.setAttribute('data-ui-scale-ready', 'true');
      };

      // localStorage is synchronous and avoids a flash on normal page opens.
      // The canonical storage API is checked below because MV3 service workers
      // cannot update this mirror when a global command changes the scale.
      applyScale(localStorage.getItem('wbUiScale'));
      root.setAttribute('data-ui-scale-ready', 'false');
      var storage = globalThis.browser?.storage?.local || globalThis.chrome?.storage?.local;
      if (!storage?.get) {
        reveal();
      } else if (globalThis.browser?.storage?.local?.get) {
        Promise.resolve(storage.get({ uiScale: 100 })).then(function (stored) {
          applyScale(stored?.uiScale);
          reveal();
        }).catch(reveal);
      } else {
        storage.get({ uiScale: 100 }, function (stored) {
          applyScale(stored?.uiScale);
          reveal();
        });
      }
      // Do not leave the panel hidden if a browser API never resolves.
      window.setTimeout(reveal, 1000);
    }
  } catch (_) { /* default CSS variables keep the panel at 100% */ }
})();
