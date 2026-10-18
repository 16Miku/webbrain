import { shouldShowWebBrainNewTab } from 'lib/gate';

// Decide before the app (and Mue's stylesheet and data) is loaded: an opted-out tab should
// not pay for it, and must not flash it before the browser's own page replaces it.
shouldShowWebBrainNewTab().then((show) => {
  if (show) return import('./boot');
  return null;
});
