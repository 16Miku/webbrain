import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { workflows, renderWorkflow, benchmarkSchedule, summarize } from './workflows.mjs';
test('benchmark schedule includes both variants, five repeats, six workflows and two browsers',()=>{
 const schedule=benchmarkSchedule();assert.equal(schedule.length,120);
 for(const browser of ['chrome','firefox'])for(const w of workflows)for(const variant of ['baseline','jev']){
  const rows=schedule.filter(r=>r.browser===browser&&r.workflow===w.id&&r.variant===variant);
  assert.equal(rows.length,5);assert.deepEqual([...new Set(rows.map(r=>r.locale))].sort(),['en','tr']);
 }
 const result=summarize([{variant:'baseline',elapsedMs:1000,success:true},{variant:'jev',elapsedMs:3000,success:false,wrong:1}]);
 assert.equal(result.jev.p50Ms,3000);assert.equal(result.jev.attempts,1);assert.equal(result.jev.wrongActions,1);assert.equal(result.meetsTarget,false);
});
for(const engine of [chromium,firefox])test(`${engine.name()}: all six local workflow fixtures score their real DOM outcomes`,async()=>{
 const browser=await engine.launch();
 try{
  for(const w of workflows){const page=await browser.newPage();page.setDefaultTimeout(5000);
   try{await page.setContent(renderWorkflow(w.id));
    if(w.id==='search'){await page.locator('#query').fill('Ada');await page.locator('button').click();}
    if(w.id==='filter')await page.locator('#filter').selectOption('Active');
    if(w.id==='dynamic'){await page.locator('#city').fill('Ista');await page.locator('button').click();}
    if(w.id==='form'){await page.locator('#name').fill('Ada');await page.locator('#email').fill('ada@example.test');await page.locator('#city').fill('Istanbul');await page.locator('button').click();}
    if(w.id==='save'){await page.locator('#title').fill('WebBrain');await page.locator('button').click();}
    if(w.id==='send'){await page.locator('#message').fill('Merhaba');await page.locator('button').click();}
    assert.deepEqual(await page.evaluate(()=>JSON.parse(document.documentElement.dataset.fixtureResult)),{success:true,actions:1,wrong:0},w.id);
   }finally{await page.close();}
  }
 }finally{await browser.close();}
});
