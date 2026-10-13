import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';

const timeout = setTimeout(() => { console.error('Dialog test timed out'); process.exit(1); }, 30000);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  // Prevent Playwright's default dismissal: the production client must answer.
  page.on('dialog', () => {});
  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  const answered = [];
  client.attach = async () => {};
  client.sendCommand = (_tab, method, params) => session.send(method, params);
  session.on('Page.javascriptDialogOpening', params => client._onDebuggerEvent(
    { tabId: 1 }, 'Page.javascriptDialogOpening', params,
  ));
  session.on('Page.javascriptDialogClosed', params => client._onDebuggerEvent(
    { tabId: 1 }, 'Page.javascriptDialogClosed', params,
  ));
  await client.startDialogHandling(1, { onHandled: type => answered.push(type) });
  await page.setContent('<button id="go">Continue</button>');
  const result = await session.send('Runtime.evaluate', {
    expression: `(() => { alert('Notice'); const confirmed = confirm('Continue?');
      const answer = prompt('Value?', 'default value'); return { confirmed, answer }; })()`,
    returnByValue: true,
  });
  assert.deepEqual(result.result.value, { confirmed: false, answer: null });
  const timerDialog = await session.send('Runtime.evaluate', {
    expression: 'new Promise(resolve => setTimeout(() => resolve(confirm("Timer confirmation")), 0))',
    awaitPromise: true, returnByValue: true,
  });
  assert.equal(timerDialog.result.value, false);
  await page.evaluate(() => {
    document.querySelector('#go').onclick = () => {
      window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; };
    };
  });
  await page.click('#go');
  const unmatchedClosed = new Promise(resolve => session.once('Page.javascriptDialogClosed', resolve));
  await assert.rejects(page.goto('data:text/html,unrelated'), /ERR_ABORTED|aborted|canceled/i);
  await unmatchedClosed;
  assert.equal(page.url(), 'about:blank');
  const release = client.authorizeNavigationDialog(1, page.url());
  await page.goto('about:blank');
  release();
  assert.equal(page.url(), 'about:blank');
  assert.deepEqual(answered, ['alert', 'confirm', 'prompt', 'confirm', 'beforeunload', 'beforeunload']);
  client.stopDialogHandling(1);
  const opened = new Promise(resolve => session.once('Page.javascriptDialogOpening', resolve));
  const pending = session.send('Runtime.evaluate', { expression: 'confirm("Already open")', returnByValue: true });
  await opened;
  await client.startDialogHandling(1);
  assert.equal((await pending).result.value, false);
  client.stopDialogHandling(1);
  console.log('PASS: real Chrome alert, confirm, prompt, and beforeunload resume renderer/navigation.');
} finally {
  await browser.close();
  clearTimeout(timeout);
}
