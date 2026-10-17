import { defineConfig } from 'vite';
import path from 'path';

// Output lands in ../src/chrome/newtab (scripts/build.mjs mirrors it to Firefox).
// base './' keeps every asset URL relative: extension pages are served from
// chrome-extension://<id>/newtab/ and moz-extension://<uuid>/newtab/.
export default defineConfig({
  base: './',
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
