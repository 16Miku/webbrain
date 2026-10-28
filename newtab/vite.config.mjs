import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import path from 'path';

// The bulletin check reads /newtab-comm.html from a localhost page (features/bulletin), and the
// dev server answers unknown paths with index.html, whose <noscript> text then showed up as a
// bulletin. Serve the site's own files, as the web site's preview does: the shipped empty one,
// and the sample for ?newtab-comm=placeholder.
const BULLETIN_FILES = ['newtab-comm.html', 'newtab-comm-placeholder.html'];
const bulletinFiles = {
  name: 'webbrain-bulletin-files',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const name = (req.url || '').split('?')[0].slice(1);
      if (!BULLETIN_FILES.includes(name)) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(path.resolve(__dirname, '../web', name)));
    });
  },
};

// Output lands in ../src/chrome/newtab (scripts/build.mjs mirrors it to Firefox).
// base './' keeps every asset URL relative: extension pages are served from
// chrome-extension://<id>/newtab/ and moz-extension://<uuid>/newtab/.
export default defineConfig({
  base: './',
  plugins: [bulletinFiles],
  // JSX goes through Vite's built-in esbuild: no SWC/Babel native addon needed.
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: path.resolve(__dirname, '../src/chrome/newtab'),
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    // Extension pages must not load inline scripts (MV3 CSP).
    modulePreload: { polyfill: false },
    rollupOptions: { output: { manualChunks: undefined } },
  },
  resolve: {
    extensions: ['.js', '.jsx'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      i18n: path.resolve(__dirname, './src/i18n'),
      components: path.resolve(__dirname, './src/components'),
      contexts: path.resolve(__dirname, './src/contexts'),
      assets: path.resolve(__dirname, './src/assets'),
      config: path.resolve(__dirname, './src/config'),
      features: path.resolve(__dirname, './src/features'),
      lib: path.resolve(__dirname, './src/lib'),
      scss: path.resolve(__dirname, './src/scss'),
      translations: path.resolve(__dirname, './src/i18n/locales'),
      utils: path.resolve(__dirname, './src/utils'),
    },
  },
  css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
});
