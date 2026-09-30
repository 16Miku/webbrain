// Run after npm run build:all. Serves only local built assets to real engines;
// this is package/module smoke coverage, not a live CMS or extension E2E run.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { CMS_FIXTURES } from './fixtures/cms-api-first.mjs';

for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${name}: built CMS packages import and load in the browser engine`, async () => {
    const root = resolve(`build/${name}`);
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('http://cms-fixture.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local CMS package fixture</title>' });
        const file = resolve(root, `.${pathname}`);
        const rel = relative(root, file);
        if (rel.startsWith('..') || isAbsolute(rel)) return route.abort();
        await route.fulfill({ contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/plain', body: await readFile(file) });
      });
      await page.goto('http://cms-fixture.test/');
      const result = await page.evaluate(async fixtures => {
        const skills = await import('/src/agent/skills.js');
        const adapters = await import('/src/agent/adapters.js');
        const records = await Promise.all(skills.DEFAULT_SKILL_SOURCES.map(async s => ({
          ...s, sourceType: 'built-in', sourceUrl: s.path,
          content: await (await fetch(`/${s.path}`)).text(),
        })));
        return fixtures.map(f => {
          const id = `cms-${f.cms}`;
          const adapter = adapters.getActiveAdapter(f.tab);
          const prompt = skills.buildCustomSkillsPrompt(records, { tier: 'mid', mode: 'act', activeSkillIds: [id] });
          return { id, adapter: adapter?.name, guided: adapter?.notes.includes('fetch_url'),
            loaded: prompt.includes(`skills/${id}.md`), count: (prompt.match(/<skill /g) || []).length,
            compact: skills.buildSkillLoaderDefinition(records, { tier: 'compact', mode: 'act' }),
          };
        });
      }, CMS_FIXTURES.map(({ cms, tab }) => ({ cms, tab })));
      assert.equal(result.length, 9);
      for (const r of result) {
        // The Sanity fixture uses a custom /studio URL: identity needs observed
        // UI evidence, so the URL-only matcher must remain a generic candidate.
        assert.equal(r.adapter, r.id === 'cms-sanity' ? 'cms-editor-candidate' : r.id);
        assert.equal(r.guided, true);
        assert.equal(r.loaded, true);
        assert.equal(r.count, 1);
        assert.equal(r.compact, null);
      }
    } finally { await browser.close(); }
  });
}
