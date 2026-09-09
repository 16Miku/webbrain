// Isolated DOM fixtures. Every request is fulfilled locally; no live account
// is opened and no publication is sent. Run with npm run test:social-contract:dom.
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import fs from 'node:fs';
import vm from 'node:vm';
const browser = await chromium.launch({headless:true});
let checked=0;
try {
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  const page=await context.newPage();
  for(const build of ['chrome','firefox']){
    const {Agent}=await import(`../src/${build}/src/agent/agent.js`);
    const invariant=await import(`../src/${build}/src/agent/completion-invariant.js`);
    const source=fs.readFileSync(`src/${build}/src/agent/agent.js`,'utf8');
    const marker=source.indexOf('const publicationRecordRoot = ${publicationResourceRecordRoot.toString()};');
    const raw=source.slice(source.lastIndexOf('`',marker)+1,source.indexOf('`',marker+1));
    const completionProbe=vm.runInNewContext('`'+raw+'`',invariant);
    const readPublished=()=>page.evaluate(code=>Function('return ('+code+')')(),completionProbe);

    const probe=async(selector='#publish')=>page.evaluate(({source,selector})=>{
      const fn=Function('return ('+source+')')();
      return fn('click',{selector});
    },{source:Agent._submitActionProbe.toString(),selector});
    for(const platform of ['twitter','bluesky']){
      await page.goto(platform==='twitter'?'https://x.com/home':'https://bsky.app/');
      const body='Beginning ① Ａ 👨‍👩‍👧\n\n'+ 'long exact body '.repeat(650)+'END';
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><main><div id="composer"><div contenteditable="true" role="textbox" id="body" style="white-space:pre-wrap"></div><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div></main>`);
      await page.locator('#body').fill(body);
      const result=await probe();
      assert.equal(result?.isSubmit,true,`${build}/${platform}: submit target`);
      assert.equal(result.publicationResourceUrlsComplete,true);
      assert.deepEqual(result.publicationResourceUrls,[]);
      assert.equal(result.publicationSnapshot?.complete,true,`${build}/${platform}: complete composer`);
      assert.equal(result.publicationSnapshot.posts[0].bodyText,body);
      assert.deepEqual(result.publicationSnapshot.posts[0].attachments,[]);
      assert.equal(result.publicationSnapshot.posts[0].context.kind,'post');
      checked++;
      // A link preview is not an uploaded attachment. Avatar/emoji images also
      // cannot satisfy the user's requested media count.
      await page.locator('#composer').evaluate(el=>{
        const box=document.createElement('div');box.setAttribute('data-testid','linkPreview');
        box.innerHTML='<img src="data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>" width="40" height="40">';
        el.append(box);
        const image=document.createElement('img');image.src='https://cdn.example/chart.png';image.width=80;image.height=60;image.alt='①';el.append(image);
      });
      const withMedia=await probe();
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments.length,1);
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments[0].alt,'①');
      checked++;
      // A missing parent in a reply composer is incomplete relationship
      // evidence; it must never be represented as permission for a new post.
      await page.locator('#composer').evaluate(el=>{const hint=document.createElement('span');hint.dataset.testid='replyingTo';hint.textContent='Replying to someone';el.append(hint);});
      const reply=await probe();
      assert.equal(reply.publicationSnapshot.complete,false);
      checked++;
      // Each attachment must have exactly one observed owner in a thread.
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><div id="composer"><section id="first"><div contenteditable="true" role="textbox">First</div><img src="https://cdn.example/one.png" width="40" height="40"></section><section><div contenteditable="true" role="textbox">Second</div><img src="https://cdn.example/two.png" width="40" height="40"></section><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div>`);
      const thread=await probe();
      assert.equal(thread.publicationSnapshot.complete,true);
      assert.deepEqual(thread.publicationSnapshot.posts.map(p=>p.attachments.length),[1,1]);checked++;
      await page.locator('#composer').evaluate(el=>el.append(el.querySelector('img').cloneNode()));
      const unowned=await probe();
      assert.equal(unowned.publicationSnapshot.complete,false,'unassigned thread media cannot disappear');checked++;

      // Exercise the actual injected completion probe, including its bounds.
      const permalink=platform==='twitter'?'https://x.com/alice/status/2222222222222222222':'https://bsky.app/profile/alice.bsky.social/post/3abc';
      const card=platform==='twitter'?'tweet':'feedItem-by-alice';
      const bodyId=platform==='twitter'?'tweetText':'postText';
      await page.setContent(`<article data-testid="${card}" id="published"><a href="${permalink}">timestamp</a><div data-testid="${bodyId}">Hello</div>${Array.from({length:13},(_,i)=>`<img src="https://cdn.example/${i}.png" alt="image" width="20" height="20">`).join('')}</article>`);
      let published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachments.length,13,'attachments beyond twelve must not disappear');
      assert.equal(published.attachmentsComplete,true);checked++;
      await page.locator('#published').evaluate(el=>{for(let i=0;i<8;i++)el.append(el.querySelector('img').cloneNode());});
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'overflow cannot prove an exact media count');checked++;
      await page.locator('#published').evaluate(el=>{
        [...el.querySelectorAll('img')].slice(1).forEach(node=>node.remove());
        el.querySelector('img').alt='a'.repeat(25001);
      });
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'truncated alt text cannot prove exactness');checked++;
      await page.locator('#published').evaluate((el,bodyId)=>{
        el.querySelector('img').alt='image';
        for(let i=0;i<8;i++)el.append(el.querySelector(`[data-testid="${bodyId}"]`).cloneNode(true));
      },bodyId);
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.bodyTextComplete,false,'overflow cannot prove a complete body');checked++;

    }
  }
} finally { await browser.close(); }
console.log(`${checked} isolated publication DOM checks passed`);
