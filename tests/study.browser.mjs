// OFFCUT_TEST_URL=http://127.0.0.1:4325 node tests/study.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const origin = process.env.OFFCUT_TEST_URL || 'http://127.0.0.1:4325';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.notEqual(new URL(origin).port, '4317', 'Never run fixtures against the live user server.');
const browser = await playwright.chromium.launch({headless:true});
const studyId = 'study-11111111-1111-4111-8111-111111111111';
const cellId = `cell-${'1'.repeat(64)}`;
const manifest = { id: studyId, manifestHash: 'a'.repeat(64), plan: { normalizedDraft: { label:'Blinded fixture', kind:'calibration', models:[{id:'secret-model',provider:'openai',model:'model-secret'}], prompts:[{id:'secret-prompt',text:'Secret prompt'}] } }, cells:[{cellId,modelId:'secret-model',promptId:'secret-prompt',sourceIds:['paper-1']} ] };
const entry = {cellId,status:'completed',runId:'run-finished'};
const annotationState = {studyId,manifestHash:manifest.manifestHash,annotationSeed:42,cells:[{cellId,displayId:'view-opaque-fixture-000000',displayIndex:0,revision:0,versions:[]}],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'};
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#d6b665"/></svg>';
const page = await browser.newPage({viewport:{width:1100,height:900}});
page.setDefaultTimeout(10_000);
page.on('pageerror', error => console.error('PAGE ERROR', error.message));
const requests=[];
await page.route('**/api/**', async route => {
  const request=route.request(), path=new URL(request.url()).pathname; requests.push({path,method:request.method()});
  const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(path===`/api/studies/${studyId}/review` && request.method()==='GET') return send({review:{studyId,label:'Blinded fixture',kind:'calibration',cards:[{displayId:annotationState.cells[0].displayId,displayIndex:0,revision:annotationState.cells[0].revision,stage:annotationState.cells[0].revision ? annotationState.cells[0].versions.at(-1).stage : 'image_only'}]}});
  if(path===`/api/studies/${studyId}/review/${annotationState.cells[0].displayId}` && request.method()==='GET') { const requested=new URL(request.url()).searchParams.get('stage'); const saved=annotationState.cells[0].revision-1; const stage=requested===null?Math.max(0,saved):Number(requested); const review={displayId:annotationState.cells[0].displayId,displayIndex:0,revision:annotationState.cells[0].revision,stage:['image_only','sources_revealed','trace_revealed'][stage],image:{available:true,url:`/api/studies/${studyId}/review/${annotationState.cells[0].displayId}/image`}}; if(stage>=1)review.sources=[{index:0,url:`/api/studies/${studyId}/review/${annotationState.cells[0].displayId}/sources/0`}]; if(stage>=2)review.trace={requestedModel:{provider:'openai',model:'model-secret'},returnedModels:['model-returned'],prompt:'Secret prompt',status:'completed',events:[{sequence:9,type:'model_output',turn:1,text:'I chose the upper edge.'},{sequence:10,type:'batch_result',turn:1,decisionNote:'Create tension.',actions:[{type:'place'}]}]}; return send({review}); }
  if(path===`/api/studies/${studyId}/annotations` && request.method()==='POST') { const body=request.postDataJSON(); assert.equal(body.displayId,annotationState.cells[0].displayId); annotationState.cells[0].revision++; annotationState.cells[0].versions.push({cellId,studyId,manifestHash:manifest.manifestHash,annotationVersion:annotationState.cells[0].revision,rubricVersion:body.rubricVersion,stage:body.stage,authorLabel:'single-researcher',codes:body.codes,uncertainty:body.uncertainty,evidence:body.evidence,notes:body.notes,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}); return send({annotation:annotationState.cells[0].versions.at(-1),revision:annotationState.cells[0].revision,displayId:annotationState.cells[0].displayId},201); }
  if(path===`/api/studies/${studyId}/review/${annotationState.cells[0].displayId}/image`) return route.fulfill({status:200,contentType:'image/svg+xml',body:art});
  if(path===`/api/studies/${studyId}/review/${annotationState.cells[0].displayId}/sources/0`) return route.fulfill({status:200,contentType:'image/svg+xml',body:art});
  return send({error:`Unexpected ${request.method()} ${path}`},500);
});
try {
  await page.goto(`${origin}/study.html?study=${studyId}`); await page.locator('#study-content').waitFor({state:'visible'});
  assert.equal(await page.locator('.study-display-id').textContent(),'view-opaque-fixture-000000');
  assert.equal((await page.locator('body').textContent()).includes('model-secret'),false);
  assert.equal(await page.locator('.study-sources').count(),0);
  await page.locator('.study-form input[name=codes]').fill('balance'); await page.locator('.study-form textarea[name=notes]').fill('Image first'); await page.locator('.study-form button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.study-reveal')?.textContent === 'Reveal sources');
  assert.equal(requests.some(item=>item.path.includes('/sources/')),false);
  await page.locator('.study-reveal').click(); await page.waitForFunction(() => document.querySelector('.study-sources')); assert.equal(await page.locator('.study-sources img').count(),1);
  await page.locator('.study-form button[type=submit]').click(); await page.waitForFunction(() => document.querySelector('.study-reveal')?.textContent === 'Reveal trace');
  await page.locator('.study-reveal').click(); await page.locator('.study-trace').waitFor({state:'visible'}); assert.match(await page.locator('.study-trace').textContent(),/model-secret/); assert.match(await page.locator('.study-trace').textContent(),/model-returned/); assert.match(await page.locator('.study-trace').textContent(),/Completed/); assert.match(await page.locator('.study-trace-events').textContent(),/I chose the upper edge/);
  await page.locator('.study-form button[type=submit]').click(); await page.waitForFunction(() => !document.querySelector('.study-reveal'));
  assert.equal(requests.filter(item=>item.method==='POST').length,3);
  console.log('PASS blinded staged reveal and append-only annotation flow');
} finally { await page.close(); await browser.close(); }
