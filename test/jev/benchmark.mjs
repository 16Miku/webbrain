import { createServer } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { benchmarkSchedule, renderWorkflow, summarize } from './workflows.mjs';
import { launchDriver } from './extension-driver.mjs';
const args=process.argv.slice(2), schedule=benchmarkSchedule();
const value=flag=>args[args.indexOf(flag)+1];
if(!args.includes('--live')){
  console.log(JSON.stringify({mode:'dry-run',paidRequests:0,attempts:schedule.length,browsers:['chrome','firefox'],repetitions:5,locales:['en','tr'],workflows:[...new Set(schedule.map(r=>r.workflow))],performanceVerified:false},null,2));
}else{
  const budget=Number(args.includes('--budget-usd')?value('--budget-usd'):0);
  const required=['JEV_API_KEY','JEV_LLM_API_KEY','JEV_LLM_BASE_URL','JEV_LLM_MODEL','JEV_LLM_INPUT_USD_PER_MILLION','JEV_LLM_OUTPUT_USD_PER_MILLION'];
  if(!(budget>0)||required.some(key=>!process.env[key]))throw Error('Live benchmarking requires --budget-usd and all documented JEV_* environment settings. No request was made.');
  const inputPrice=Number(process.env.JEV_LLM_INPUT_USD_PER_MILLION),outputPrice=Number(process.env.JEV_LLM_OUTPUT_USD_PER_MILLION);
  if(!Number.isFinite(inputPrice)||inputPrice<0||!Number.isFinite(outputPrice)||outputPrice<0)throw Error('Invalid pricing');
  const output=resolve(args.includes('--out')?value('--out'):'/tmp/jev-live-benchmark');await mkdir(output,{recursive:true});
  const server=createServer((req,res)=>{try{res.setHeader('Content-Type','text/html');res.end(renderWorkflow(new URL(req.url,'http://localhost').pathname.slice(1)));}catch{res.statusCode=404;res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const rows=[];let spent=0;
  try{
    for(const browser of ['chrome','firefox']){
      const driver=await launchDriver(browser);
      try{
        await driver.configure({baseUrl:process.env.JEV_LLM_BASE_URL,apiKey:process.env.JEV_LLM_API_KEY,model:process.env.JEV_LLM_MODEL,inputCostPerMillionUsd:inputPrice,outputCostPerMillionUsd:outputPrice,contextWindow:64000,maxOutputTokens:2048}, {typesafeApiKey:process.env.JEV_API_KEY,systemOneEnabled:true,systemOneWatchEnabled:false,systemOneCompletionEnabled:false,tracingEnabled:true,losslessTrace:false,helpImproveWebBrain:false,userMemoryEnabled:false,planBeforeActMode:'try',planReviewMode:'off',maxAgentSteps:40,autoScreenshot:'off',agentAllowLocalNetwork:true,costAllowanceSessionUsd:budget,costAllowanceTotalUsd:budget,meteredProviderCostSpentUsd:0});
        for(const row of schedule.filter(r=>r.browser===browser)){
          if(spent>=budget)throw Error('Budget exhausted; remaining attempts were not run');
          const start=Date.now();let result;
          try{result=await driver.trial({...row,url:`${origin}/${row.workflow}`,budgetUsd:budget-spent});}
          catch(error){const costs=await driver.evaluate("(globalThis.browser||chrome).storage.local.get('meteredProviderCostSpentUsd')");result={success:false,error:String(error.message),elapsedMs:Date.now()-start,modelCostUsd:costs.meteredProviderCostSpentUsd||0};}
          spent+=result.modelCostUsd||0;rows.push({...row,...result});
          await writeFile(`${output}/report.json`,JSON.stringify({model:process.env.JEV_LLM_MODEL,jevModel:'jev-1.13.0',budgetUsd:budget,spentUsd:spent,rows,summary:summarize(rows)},null,2));
          console.log(`${browser} ${row.workflow} ${row.repetition} ${row.variant}: ${result.success?'pass':'fail'}`);
        }
      }finally{await driver.close();}
    }
  }finally{server.close();await writeFile(`${output}/report.json`,JSON.stringify({model:process.env.JEV_LLM_MODEL,jevModel:'jev-1.13.0',budgetUsd:budget,spentUsd:spent,rows,summary:summarize(rows)},null,2));}
}
