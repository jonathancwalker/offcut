// Isolated static preview only. Every API request is intercepted; no model calls.
// OFFCUT_TEST_URL=http://127.0.0.1:4325 node tests/batch.browser.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';

const require=createRequire(import.meta.url);
let playwright;
try {playwright=require('playwright');}
catch {playwright=require(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const origin=process.env.OFFCUT_TEST_URL || 'http://127.0.0.1:4325';
assert.match(origin,/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.notEqual(new URL(origin).port,'4317','Never run fixtures against the live user server.');
const browser=await playwright.chromium.launch({headless:true});
const errors=[],checks=[];
const mark=name=>{checks.push(name);console.log(`PASS ${name}`);};
const createdAt='2026-10-02T14:30:00.000Z';
const sourceManifest=[
  {id:'paper-1',name:'A study of leaves',width:800,height:1000,sha256:'1'.repeat(64),credit:'Artist one',license:'CC0'},
  {id:'paper-2',name:'A city by the water',width:900,height:700,sha256:'2'.repeat(64),credit:'Artist two',license:'CC0'},
  {id:'paper-3',name:'A blue vase',width:700,height:900,sha256:'3'.repeat(64),credit:'Artist three',license:'CC0'},
];
function plannedBatch(overrides={}) {
  const groups=[{model:'model-alpha-vision',count:3},{model:'model-beta-vision',count:3}];
  const entries=groups.flatMap((group,groupIndex)=>Array.from({length:group.count},(_,runIndex)=>({
    index:groupIndex*3+runIndex,groupIndex,runIndex,model:group.model,seed:runIndex+10,
    sourceIds:runIndex%2?['paper-1','paper-3']:['paper-1','paper-2'],launch:{clientRequestId:`entry-${groupIndex}-${runIndex}`,requestFingerprint:'a'.repeat(64)},
    runId:groupIndex===0 && runIndex<2?`run-${runIndex===0?'finished':'working'}-${groupIndex}`:null,
    status:groupIndex===0?(runIndex===0?'completed':runIndex===1?'running':'queued'):'queued',terminationReason:null,
  })));
  return {id:'batch-12345678-fixture',status:'running',createdAt,updatedAt:createdAt,mode:'compare',materials:'pinned-random',groups,totalRuns:6,completedRuns:1,finishedRuns:1,activeRunId:'run-working-0',terminationReason:null,usage:{inputTokens:100,outputTokens:100},costUSD:null,version:1,seedAlgorithm:'offcut-batch-seeds-v1',spec:{},sourceManifest:structuredClone(sourceManifest),entries,...overrides};
}
const art=`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="540" viewBox="0 0 500 540"><rect width="500" height="540" fill="#ede1cb"/><path d="M0 430 215 80 500 510H0" fill="#a97551"/><path d="M315 15H470V430H315Z" fill="#768675"/><circle cx="170" cy="205" r="95" fill="#d6b665"/><path d="m145 205 87-55 80 275-200 50Z" fill="#424e4c"/></svg>`;
async function fixture({batch=plannedBatch(),mobile=false,library=false,batches,runList,error=false,missing=false,imageErrors=false}={}) {
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1100},...(mobile?{isMobile:true,hasTouch:true}:{})});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const f={page,context,batch,batches:batches || [batch],runs:runList || [],requests:[],images:[],stopRequests:0,fail:error,failStop:false,failImages:imageErrors};
  await page.route('**/api/**',async route=> {
    const request=route.request(),path=new URL(request.url()).pathname;f.requests.push({path,method:request.method()});
    const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(/^\/api\/batches\/[^/]+\/sources\/[^/]+$/.test(path) || /^\/api\/runs\/[^/]+\/render\.png$/.test(path)) {
      f.images.push(path);return route.fulfill({status:f.failImages?503:200,contentType:'image/svg+xml',body:f.failImages?'Unavailable':art});
    }
    if(path==='/api/runs' && request.method()==='GET')return send({runs:f.runs});
    if(path==='/api/archives' && request.method()==='GET')return send({runs:[]});
    if(path==='/api/batches' && request.method()==='GET')return send({batches:f.batches});
    if(path===`/api/batches/${f.batch.id}` && request.method()==='GET')return f.fail?send({error:'The local server is unavailable.'},503):send({batch:f.batch});
    if(path===`/api/batches/${f.batch.id}/stop` && request.method()==='POST') {
      f.stopRequests++;assert.deepEqual(request.postDataJSON(),{});
      if(f.failStop)return send({error:'The stop could not be confirmed.'},503);
      for(const entry of f.batch.entries) {
        if(entry.status==='running'){entry.status='stopped';entry.terminationReason='user_stopped';}
        else if(entry.status==='queued')entry.status='not_run';
      }
      f.batch.status='stopped';f.batch.finishedRuns=f.batch.entries.filter(entry=>['completed','stopped'].includes(entry.status)).length;f.batch.activeRunId=null;
      return send({batch:f.batch});
    }
    errors.push(`Unexpected API request: ${request.method()} ${path}`);return send({error:'Unexpected fixture request'},500);
  });
  await page.goto(library?`${origin}/?batch=${encodeURIComponent(batch.id)}`:missing?`${origin}/batch.html`:`${origin}/batch.html?batch=${encodeURIComponent(batch.id)}`);
  if(library)await page.waitForFunction(()=>document.querySelector('#run-count').textContent!=='—');
  else if(error || missing)await page.locator('#batch-error').waitFor({state:'visible'});
  else await page.locator('#batch-content').waitFor({state:'visible'});
  return f;
}
try {
  {
    const f=await fixture(),{page}=f;
    assert.equal(await page.locator('#batch-identity').textContent(),'Batch · 12345678');
    assert.equal(await page.locator('#batch-mode').textContent(),'Compare');
    assert.equal(await page.locator('#batch-materials').textContent(),'Pins + random extras');
    assert.equal(await page.locator('#batch-pairing').isVisible(),true);
    assert.equal(await page.locator('#batch-progress-text').textContent(),'1 of 6 finished');
    assert.equal(await page.locator('.batch-group').count(),2);assert.equal(await page.locator('.batch-entry').count(),6);
    assert.deepEqual(await page.locator('.batch-group').first().locator('h3').allTextContents(),['Run 1','Run 2','Run 3']);
    assert.equal(await page.locator('.entry-art:visible').count(),1);
    assert.deepEqual(f.images.filter(path=>path.includes('/runs/')),['/api/runs/run-finished-0/render.png'],'working canvases are never fetched');
    assert.equal(await page.locator('.batch-entry[data-status=running] .entry-working-link').getAttribute('href'),'/work.html?run=run-working-0');
    const summary=page.locator('.entry-materials>summary').first();await summary.focus();await page.keyboard.press('Space');
    await page.waitForFunction(()=>document.querySelectorAll('.entry-source-grid img').length===2);
    assert.equal(await page.locator('.entry-materials').first().getAttribute('open'),'');
    const urls=await page.locator('.entry-source-grid a').evaluateAll(nodes=>nodes.map(node=>new URL(node.href).pathname));
    assert.deepEqual(urls,['/api/batches/batch-12345678-fixture/sources/paper-1','/api/batches/batch-12345678-fixture/sources/paper-2']);
    assert.deepEqual(await page.locator('.batch-source-name').allTextContents(),['A study of leaves','A city by the water']);
    assert.equal(await page.locator('.entry-source-grid a').first().getAttribute('target'),'_blank');
    f.batch.entries[1].status='completed';f.batch.finishedRuns=2;f.batch.completedRuns=2;f.batch.entries[2].status='running';f.batch.entries[2].runId='run-next-0';
    await page.locator('#refresh-batch').click();await page.waitForFunction(()=>document.querySelector('#batch-progress-text').textContent==='2 of 6 finished');
    assert.equal(await page.locator('.entry-materials').first().getAttribute('open'),'','refresh preserves material disclosure');
    assert.equal(await page.locator('.entry-source-grid a').count(),2);assert.equal(await page.locator('.entry-art:visible').count(),2);
    assert.equal(f.images.includes('/api/runs/run-next-0/render.png'),false);
    const rows=await page.locator('.batch-entry').evaluateAll(nodes=>nodes.map(node=>({run:node.querySelector('h3').textContent,y:node.getBoundingClientRect().top})));
    for(const run of ['Run 1','Run 2','Run 3']){const pair=rows.filter(row=>row.run===run);assert.ok(Math.abs(pair[0].y-pair[1].y)<1,'matched ordinals stay aligned when materials are open');}
    await page.screenshot({path:'/private/tmp/offcut-batch-desktop.png',fullPage:true});
    mark('model groups, ordinal pairing, progress, final-only art, keyboard disclosure and frozen material URLs');
    await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#stop-batch').click();await page.waitForFunction(()=>document.querySelector('#batch-status').textContent==='Stopped');
    assert.equal(f.stopRequests,1);assert.equal(await page.locator('#stop-batch').isHidden(),true);
    assert.equal(await page.locator('#batch-progress-text').textContent(),'2 of 6 finished');
    assert.equal(await page.locator('#batch-remaining').textContent(),'4 not run');
    assert.equal(await page.locator('.batch-entry[data-status=not_run]').count(),4);
    assert.equal(await page.locator('.entry-art:visible').count(),2);
    await page.reload();await page.locator('#batch-content').waitFor({state:'visible'});
    assert.equal(await page.locator('#batch-status').textContent(),'Stopped');assert.equal(f.stopRequests,1);
    assert.equal(f.requests.filter(request=>request.method==='POST').length,1,'reload only observes; it never launches or resumes');
    assert.equal(await page.locator('#batch-library').getAttribute('href'),'/?batch=batch-12345678-fixture');
    mark('stop preserves finished work, marks unstarted entries and reload never resumes');await f.context.close();
  }
  {
    const failed=plannedBatch({status:'failed',finishedRuns:2,activeRunId:null,terminationReason:'child_failed'});
    failed.entries[1].status='failed';failed.entries[1].terminationReason='provider_or_runner_error';for(const entry of failed.entries)if(entry.status==='queued')entry.status='not_run';
    const f=await fixture({batch:failed}),{page}=f;
    assert.match(await page.locator('#batch-notice').textContent(),/ended after a run failed/);
    assert.equal(await page.locator('#batch-progress-text').textContent(),'2 of 6 finished');
    assert.match(await page.locator('.batch-entry[data-status=failed] .entry-reason').textContent(),/run could not continue/);
    assert.equal(await page.locator('.batch-entry[data-status=failed] .entry-art').getAttribute('href'),'/work.html?run=run-working-0');
    assert.equal(await page.locator('#stop-batch').isHidden(),true);
    f.batch.status='interrupted';await page.reload();await page.locator('#batch-content').waitFor({state:'visible'});
    assert.match(await page.locator('#batch-notice').textContent(),/interrupted/);
    assert.equal(f.requests.some(request=>request.method==='POST'),false);
    mark('failed and interrupted plans remain inspectable without automatic work');await f.context.close();
  }
  {
    const batch=plannedBatch({mode:'explore',materials:'random',status:'completed',totalRuns:4,finishedRuns:4,completedRuns:4,activeRunId:null,groups:[{model:'model-alpha-vision',count:4}]});
    batch.entries=Array.from({length:4},(_,index)=>({...batch.entries[0],index,runIndex:index,groupIndex:0,seed:index+10,runId:`run-explore-${index}`,status:index===3?'limit_reached':'completed',terminationReason:index===3?'turn_limit':'model_finished'}));
    const f=await fixture({batch,imageErrors:true}),{page}=f;
    assert.equal(await page.locator('#batch-mode').textContent(),'Explore');assert.equal(await page.locator('#batch-materials').textContent(),'Random materials');
    assert.equal(await page.locator('#batch-pairing').isHidden(),true);assert.equal(await page.locator('#batch-progress-text').textContent(),'4 of 4 finished');
    assert.equal(await page.locator('.entry-art:visible').count(),4);assert.equal(await page.locator('#stop-batch').isHidden(),true);
    await page.locator('.entry-fallback').first().waitFor({state:'visible'});
    f.failImages=false;await page.locator('#refresh-batch').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('.entry-preview img')].every(image=>image.complete && image.naturalWidth>0 && !image.hidden));
    await page.waitForFunction(()=>!document.querySelector('#refresh-batch').disabled);
    assert.match(await page.locator('.batch-entry[data-status=limit_reached] .entry-reason').textContent(),/Turn limit reached/);
    await page.screenshot({path:'/private/tmp/offcut-batch-explore-desktop.png',fullPage:true});
    mark('completed Explore gallery, limit outcomes and image retry after a transient failure');await f.context.close();
  }
  {
    const f=await fixture({error:true}),{page}=f;
    assert.equal(await page.locator('#batch-content').isHidden(),true);f.fail=false;
    await page.locator('#retry-batch').click();await page.locator('#batch-content').waitFor({state:'visible'});
    f.failStop=true;await page.locator('#stop-batch').click();await page.locator('#batch-error').waitFor({state:'visible'});
    assert.equal(await page.locator('#stop-batch').isEnabled(),true);assert.equal(await page.locator('#batch-status').textContent(),'Working');
    f.failStop=false;await page.locator('#stop-batch').click();await page.waitForFunction(()=>document.querySelector('#batch-status').textContent==='Stopped');
    assert.equal(f.stopRequests,2);mark('load and stop failures expose a safe retry');await f.context.close();
    const missing=await fixture({missing:true});assert.equal(missing.requests.length,0);assert.equal(await missing.page.locator('#retry-batch').isHidden(),true);await missing.context.close();
  }
  {
    const batch=plannedBatch();const past=plannedBatch({id:'batch-past5678-fixture',status:'completed',finishedRuns:6,completedRuns:6});
    const runs=[
      {id:'run-in-batch',status:'completed',createdAt,spec:{model:'model-alpha-vision',provider:'openai'},batch:{id:batch.id,groupIndex:0,runIndex:0}},
      {id:'run-independent',status:'completed',createdAt,spec:{model:'model-alpha-vision',provider:'openai'}},
      {id:'run-other-batch',status:'completed',createdAt,spec:{model:'model-beta-vision',provider:'openai'},batch:{id:past.id,groupIndex:0,runIndex:0}},
      {id:'run-working-0',status:'running',createdAt,spec:{model:'model-alpha-vision',provider:'openai'},batch:{id:batch.id,groupIndex:0,runIndex:1}},
    ];
    const f=await fixture({batch,library:true,batches:[batch,past],runList:runs}),{page}=f;
    assert.equal(await page.locator('#active-batches').isVisible(),true);assert.equal(await page.locator('#active-batch-list a').getAttribute('href'),'/batch.html?batch=batch-12345678-fixture');
    assert.equal(await page.locator('#pending-section').isHidden(),true,'the active batch child is not duplicated in progress');
    assert.equal(await page.locator('#batch-filter').inputValue(),batch.id);assert.deepEqual(await page.locator('.work-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.workId)),['run-in-batch']);
    assert.match(await page.locator('.card-batch').textContent(),/12345678/);
    await page.locator('#batch-history>summary').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#batch-history-list a').getAttribute('href'),'/batch.html?batch=batch-past5678-fixture');
    await page.locator('#batch-filter').selectOption('__individual__');assert.deepEqual(await page.locator('.work-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.workId)),['run-independent']);
    await page.locator('#batch-filter').selectOption('');assert.equal(await page.locator('.work-card').count(),3);
    await page.locator('#model-filter').selectOption('model-beta-vision');assert.equal(await page.locator('.work-card').count(),1);
    await page.locator('.work-card img').evaluate(async image=>{await image.decode();});
    assert.equal(await page.locator('.work-card img').evaluate(image=>image.complete && image.naturalWidth>0 && !image.hidden),true,'completed library artwork decodes successfully');
    await page.screenshot({path:'/private/tmp/offcut-batch-library-desktop.png',fullPage:true});
    mark('library links active and saved batches, filters their works and avoids duplicate progress');await f.context.close();
  }
  {
    const f=await fixture({mobile:true}),{page}=f;
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await page.locator('#stop-batch').evaluate(node=>node.getBoundingClientRect().height>=44),true);
    await page.locator('.entry-materials>summary').first().click();
    assert.equal(await page.locator('.entry-materials>summary').first().evaluate(node=>node.getBoundingClientRect().height>=44),true);
    await page.screenshot({path:'/private/tmp/offcut-batch-mobile.png',fullPage:true});
    await f.context.close();
    const lib=await fixture({mobile:true,library:true,batches:[plannedBatch(),plannedBatch({id:'batch-saved-fixture',status:'stopped'})]});
    await lib.page.locator('#batch-history>summary').click();
    assert.equal(await lib.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await lib.page.screenshot({path:'/private/tmp/offcut-batch-library-mobile.png',fullPage:true});
    mark('mobile observer and library fit the viewport with accessible controls');await lib.context.close();
  }
  assert.deepEqual(errors,[],'no page errors or unexpected API calls');
  console.log(`\n${checks.length} browser scenarios passed. No paid model calls or server data mutations.`);
} finally {await browser.close();}
