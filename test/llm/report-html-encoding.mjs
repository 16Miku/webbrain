import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTS = [
  'test/llm/analysis/llm_browser_agent_vs_sonnet_simple.html',
  'test/llm/results/llm_browser_agent_vs_consensus.html',
  'test/llm/results/llm_browser_agent_vs_sonnet.html',
  'test/llm/results/llm_browser_agent_vs_sonnet_simple.html',
];

function loadReport(relativePath, mutate = () => {}) {
  const html = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const dataScript = scripts.find(match => /\bid=["']data-script["']/.test(match[1]));
  const runtime = scripts.find(match => match[2].includes('const DATA = JSON.parse('));
  assert.ok(dataScript && runtime, `${relativePath}: actual report script boundaries`);
  const data = JSON.parse(dataScript[2]);
  mutate(data);
  const nodes = new Map();
  const htmlWrites = [];
  function node(key) {
    if (!nodes.has(key)) {
      let content = '';
      nodes.set(key, {
        textContent: key === '#data-script' ? JSON.stringify(data) : '',
        classList: { add() {}, remove() {} },
        addEventListener() {},
        get innerHTML() { return content; },
        set innerHTML(value) { content = String(value); htmlWrites.push({ key, value: content }); },
      });
    }
    return nodes.get(key);
  }
  const document = {
    getElementById: id => node('#' + id),
    querySelector: selector => node(selector),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({ document });
  // Execute the complete authored report runtime, not a copied encoding helper.
  vm.runInContext(runtime[2], context, { filename: relativePath, timeout: 1500 });
  return { context, nodes, htmlWrites };
}

for (const relativePath of REPORTS) {
  test(`${relativePath}: dataset labels remain text at actual KPI and chart sinks`, () => {
    const marker = '<img src=x onerror=1>';
    const result = loadReport(relativePath, data => {
      for (const row of data.rows) row.model = marker;
      if ('reference' in data) data.reference = marker;
    });
    assert.match(result.nodes.get('#kpis').innerHTML, /&lt;img src=x onerror=1&gt;/);
    assert.ok(result.htmlWrites.every(write => !write.value.includes(marker)),
      'raw attacker label must not become report markup');
  });

  test(`${relativePath}: count strings and task identifiers cannot inject markup`, () => {
    const marker = '<img src=x onerror=2>';
    const result = loadReport(relativePath, data => {
      for (const row of data.rows) {
        for (const key of ['errors', 'total_tokens', 'prompt_tokens', 'completion_tokens']) row[key] = marker;
      }
      if (data.majority) {
        for (const value of Object.values(data.majority)) { value.support = marker; value.total = marker; }
        for (const votes of Object.values(data.votes)) {
          for (const key of Object.keys(votes)) votes[key] = marker;
        }
        const first = Object.values(data.majority)[0];
        data.majority[marker] = { ...first, share: -1, support: marker, total: marker };
        data.votes[marker] = { known_tool: marker };
        data.task_user[marker] = 'Untrusted task identifier';
      }
    });
    assert.ok(result.htmlWrites.length >= 5, 'normal report render paths executed');
    assert.ok(result.htmlWrites.every(write => !write.value.includes(marker)),
      'numeric fields and dataset keys must not create elements');
    assert.equal(vm.runInContext(`fmtNum(${JSON.stringify(marker)})`, result.context), '0');
  });

  test(`${relativePath}: genuine dataset and numeric presentation still render`, () => {
    const result = loadReport(relativePath);
    assert.ok(result.nodes.get('#kpis').innerHTML.includes('class="kpi"'));
    assert.ok(result.htmlWrites.some(write => write.key === '#lbtable tbody' && write.value.includes('<tr>')));
    assert.equal(vm.runInContext('fmtNum(12345.5)', result.context), (12345.5).toLocaleString());
    assert.equal(vm.runInContext('fmtNum(0)', result.context), '0');
    assert.equal(vm.runInContext(`escapeHtml('plain & <x> "quoted"')`, result.context),
      'plain &amp; &lt;x&gt; &quot;quoted&quot;');
  });
}
