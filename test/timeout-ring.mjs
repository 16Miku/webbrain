import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';

const read = async (rel) => (await fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const extract = (source, name) => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};

test('the ring module is identical in both builds', async () => {
  assert.equal(await read('src/chrome/src/ui/timeout-ring.js'), await read('src/firefox/src/ui/timeout-ring.js'));
});

for (const build of ['chrome', 'firefox']) {
  describe(`${build}: clock ring that empties with an auto-timeout`, () => {
    let browser, ring, panel, css, en;
    before(async () => {
      browser = await chromium.launch({ headless: true });
      ring = (await read(`src/${build}/src/ui/timeout-ring.js`)).replace(/^export /gm, '');
      panel = await read(`src/${build}/src/ui/sidepanel.js`);
      css = await read(`src/${build}/styles/sidepanel.css`);
      en = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    });
    after(async () => { await browser?.close(); });

    async function page(run) {
      const p = await browser.newPage({ viewport: { width: 380, height: 600 } });
      try {
        await p.setContent('<body><div id="root"></div></body>');
        await p.addStyleTag({ content: css });
        await p.addScriptTag({ content: `
          const EN = ${JSON.stringify(en)};
          function t(key, params = {}) { return String(EN[key] || key).replace(/\\{(\\w+)\\}/g, (_, k) => params[k] ?? ''); }
          window.submitted = [];
          function submitClarify(card, tabId, clarifyId, answer, source) { window.submitted.push({ answer, source }); card.classList.add('clarify-answered'); }
          ${ring}
          ${extract(panel, 'clearClarifyCountdown')}
          ${extract(panel, 'startClarifyCountdown')}
          ${extract(panel, 'stopPlanReviewTimeoutRing')}
          ${extract(panel, 'startPlanReviewTimeoutRing')}
          Object.assign(window, { createTimeoutRing, updateTimeoutRing, startClarifyCountdown, startPlanReviewTimeoutRing, stopPlanReviewTimeoutRing });
        ` });
        return await run(p);
      } finally { await p.close(); }
    }

    test('it empties clockwise as the time runs out and warns when little is left', async () => {
      await page(async (p) => {
        const read = (share) => p.evaluate((s) => {
          const r = window.createTimeoutRing();
          document.getElementById('root').appendChild(r);
          window.updateTimeoutRing(r, s * 120_000, 120_000);
          return {
            offset: Number(r.querySelector('.timeout-ring-progress').getAttribute('stroke-dashoffset')),
            circumference: Number(r.querySelector('.timeout-ring-progress').getAttribute('stroke-dasharray')),
            hand: r.querySelector('.timeout-ring-hand').getAttribute('transform'),
            low: r.classList.contains('timeout-ring-low'), title: r.title, text: r.textContent, hidden: r.getAttribute('aria-hidden'),
          };
        }, share);
        const full = await read(1), half = await read(.5), empty = await read(0);
        assert.equal(full.offset, 0, 'a full ring at the start');
        assert.ok(Math.abs(half.offset + half.circumference / 2) < .01, 'half the ring is gone at half time, removed from 12 o\'clock clockwise like the hand');
        assert.ok(Math.abs(empty.offset + empty.circumference) < .01, 'nothing is left at the end');
        assert.ok(half.offset < 0, 'a negative offset removes the start of the arc (where the hand has swept), not its trailing end');
        assert.equal(full.hand, 'rotate(0.0 12 12)'); assert.equal(half.hand, 'rotate(180.0 12 12)'); assert.equal(empty.hand, 'rotate(360.0 12 12)');
        assert.equal(full.low, false); assert.equal(half.low, false); assert.equal(empty.low, true);
        assert.equal(full.title, '2:00'); assert.equal(half.title, '1:00'); assert.equal(empty.title, '0:00');
        assert.equal(full.text, '', 'the ring carries no text, so it needs no translation');
        assert.equal(full.hidden, 'true');
      });
    });

    test('the clarification card shows it in the bottom-right corner and keeps its text countdown', async () => {
      await page(async (p) => {
        const result = await p.evaluate(async () => {
          const card = document.createElement('div');
          card.className = 'clarify-card';
          card.style.width = '320px';
          const button = document.createElement('button');
          button.className = 'clarify-option'; button.textContent = 'Commit it';
          card.appendChild(button);
          card.dataset.timeoutSec = '30';
          document.getElementById('root').appendChild(card);
          window.startClarifyCountdown(card, { tabId: 1, clarifyId: 'c1', deadlineTs: Date.now() + 30_000, firstOption: 'Commit it' });
          const early = Number(card.querySelector('.timeout-ring-progress').getAttribute('stroke-dashoffset'));
          await new Promise((r) => setTimeout(r, 1300));
          const later = Number(card.querySelector('.timeout-ring-progress').getAttribute('stroke-dashoffset'));
          const c = card.getBoundingClientRect(), r = card.querySelector('.timeout-ring').getBoundingClientRect();
          return { early, later, rightGap: c.right - r.right, bottomGap: c.bottom - r.bottom, label: card.querySelector('.clarify-timeout').textContent, rings: card.querySelectorAll('.timeout-ring').length };
        });
        assert.equal(result.rings, 1);
        assert.match(result.label, /^Picks “Commit it” in (28|29|30)s$/, 'the text countdown is unchanged');
        assert.ok(result.later < result.early, 'the ring empties as time passes');
        assert.ok(result.rightGap >= 0 && result.rightGap <= 16, `right edge (${result.rightGap})`);
        assert.ok(result.bottomGap >= 0 && result.bottomGap <= 16, `bottom edge (${result.bottomGap})`);
      });
    });

    test('a clarification card that was already running restarts from what is left, then drops the ring when answered', async () => {
      await page(async (p) => {
        const result = await p.evaluate(async () => {
          const card = document.createElement('div');
          card.className = 'clarify-card';
          document.getElementById('root').appendChild(card);
          // No timeoutSec (restored card): the time left when it starts is the whole period.
          window.startClarifyCountdown(card, { tabId: 1, clarifyId: 'c2', deadlineTs: Date.now() + 20_000, firstOption: 'A' });
          const start = Number(card.querySelector('.timeout-ring-progress').getAttribute('stroke-dashoffset'));
          card.classList.add('clarify-answered');
          await new Promise((r) => setTimeout(r, 400));
          return { start, rings: card.querySelectorAll('.timeout-ring').length };
        });
        assert.ok(result.start > -1, 'starts (nearly) full');
        assert.equal(result.rings, 0, 'the ring goes away with the countdown');
      });
    });

    test('the plan review card shows it at the end of the action row until the review is settled', async () => {
      await page(async (p) => {
        const result = await p.evaluate(async () => {
          const card = document.createElement('div');
          card.className = 'plan-review-card';
          card.style.width = '340px';
          card.innerHTML = '<div class="plan-review-actions"><button class="plan-review-approve">Run</button><button class="plan-review-change">Edit as text</button><button class="plan-review-cancel">Cancel</button></div>';
          card.dataset.timeoutSec = '120';
          card.dataset.deadlineTs = String(Date.now() + 90_000);
          document.getElementById('root').appendChild(card);
          window.startPlanReviewTimeoutRing(card);
          const ring = card.querySelector('.plan-review-actions .timeout-ring');
          const first = Number(ring.querySelector('.timeout-ring-progress').getAttribute('stroke-dashoffset'));
          const actions = card.querySelector('.plan-review-actions').getBoundingClientRect(), r = ring.getBoundingClientRect();
          const cancel = card.querySelector('.plan-review-cancel').getBoundingClientRect();
          // Starting again (rebind) never stacks a second ring.
          window.startPlanReviewTimeoutRing(card);
          const rings = card.querySelectorAll('.timeout-ring').length;
          card.classList.add('plan-reviewed');
          await new Promise((res) => setTimeout(res, 500));
          return { first, rings, afterSettled: card.querySelectorAll('.timeout-ring').length, atEnd: actions.right - r.right, beyondButtons: r.left >= cancel.right - 1 };
        });
        // 90 s of 120 s left: a quarter of the ring is gone.
        assert.ok(result.first < -10 && result.first > -18, `quarter emptied (${result.first})`);
        assert.equal(result.rings, 1);
        assert.equal(result.afterSettled, 0, 'settling the review removes the ring');
        assert.ok(result.atEnd >= 0 && result.atEnd <= 4, 'at the end of the row');
        assert.equal(result.beyondButtons, true, 'it does not overlap the buttons');
      });
    });

    test('a plan whose time has already run out gets no ring; a card without a deadline gets none either', async () => {
      await page(async (p) => {
        const counts = await p.evaluate(() => {
          const make = (deadline) => {
            const card = document.createElement('div');
            card.className = 'plan-review-card';
            card.innerHTML = '<div class="plan-review-actions"></div>';
            if (deadline != null) { card.dataset.timeoutSec = '120'; card.dataset.deadlineTs = String(deadline); }
            document.getElementById('root').appendChild(card);
            window.startPlanReviewTimeoutRing(card);
            return card.querySelectorAll('.timeout-ring').length;
          };
          return [make(Date.now() - 1000), make(null)];
        });
        assert.deepEqual(counts, [0, 0]);
      });
    });
  });
}

test('both agents tell the panel when the plan review runs out', async () => {
  for (const build of ['chrome', 'firefox']) {
    const agent = await read(`src/${build}/src/agent/agent.js`);
    assert.match(agent, /onUpdate\('plan_review', \{\s*planId, plan, markdown, verboseMarkdown,\s*timeoutSec,\s*deadlineTs,\s*\}\)/, `${build}: the live plan_review update carries the period and the deadline`);
    assert.match(agent, /tabPending\.set\(planId, \{[^}]*timeoutSec, deadlineTs \}\)/, `${build}: the pending entry keeps them for a reopened panel`);
    assert.match(agent, /\.\.\.\(entry\?\.timeoutSec > 0 && entry\?\.deadlineTs > 0 \? \{ timeoutSec: entry\.timeoutSec, deadlineTs: entry\.deadlineTs \} : \{\}\)/, `${build}: the recovered pending plan carries them too`);
    const panel = await read(`src/${build}/src/ui/sidepanel.js`);
    assert.match(panel, /card\.dataset\.deadlineTs = String\(Math\.floor\(planDeadlineTs\)\)/, `${build}: the plan card keeps the deadline so a restored card can rebuild the ring`);
    assert.match(panel, /function bindPlanReviewCard\(card\) \{[\s\S]*?startPlanReviewTimeoutRing\(card\);/, `${build}: binding (also after restore) starts the ring`);
  }
});
