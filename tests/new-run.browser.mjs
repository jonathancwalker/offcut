// An isolated preview supplies static assets; every API request is intercepted.
// OFFCUT_TEST_URL=http://127.0.0.1:4324 node tests/new-run.browser.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {drawMaterialIds} from '../public/material-selection.mjs';
import {planBatch} from '../public/batch-plan.mjs';

const require=createRequire(import.meta.url);
let playwright;
try { playwright=require('playwright'); }
catch { playwright=require(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const origin=process.env.OFFCUT_TEST_URL || 'http://127.0.0.1:4324';
assert.match(origin,/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
assert.notEqual(new URL(origin).port,'4317','Never run browser fixtures against the live user server.');
const browser=await playwright.chromium.launch({headless:true});
const DRAFT='offcut.new-run.draft.v2', LEGACY='offcut.new-run.draft.v1', PENDING='offcut.new-run.pending.v1', BATCH_PENDING='offcut.new-batch.pending.v1';
const errors=[], checks=[];
const sources=Array.from({length:75},(_,index)=>({
  id:`image-${String(index+1).padStart(3,'0')}`,name:`${index%2?'Still life':'Botanical study'} ${index+1}`,
  sha256:(index+1).toString(16).padStart(64,'0'),width:700+index,height:900,
  byteLength:320000,credit:`Artist ${index+1}`,url:`https://museum.example/art/${index+1}`,license:'CC0',
  collection:index%3===0?'Studio':'Cleveland Museum of Art',tags:index%2?['vase','table']:['flower','plant'],
  previewUrl:`/fixture/thumb-${index+1}.svg`,imageUrl:`/fixture/full-${index+1}.svg`,
}));
const baseCatalog=()=>({sources:structuredClone(sources),snapshot:'a'.repeat(64),limits:{maxSources:24,maxSourceBytes:24*1024*1024,uploadSlots:3}});
const ids=async(page,tray)=>page.locator(`#${tray} [data-source-id]`).evaluateAll(nodes=>nodes.map(node=>node.dataset.sourceId));
const selection=async page=>[...await ids(page,'pinned-tray'),...await ids(page,'random-tray')];
const stored=(page,key=DRAFT)=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);
const mark=name=>{checks.push(name);console.log(`PASS ${name}`);};
async function fixture({catalog=baseCatalog(),storage={},mobile=false,post='failure',runList=[],batchList=[]}={}) {
  const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1440,height:1100}});
  const page=await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
  const fixture={context,page,catalog,requests:[],batchRequests:[],uploads:[],runList,batchList,post,providerConfigured:true,keyRequests:[]};
  await page.addInitScript(storage=>{
    // Seed storage once so reloads exercise the app's persisted draft/receipt.
    if (!sessionStorage.getItem('fixture-initialized')) {
      for (const [key,value] of Object.entries(storage)) sessionStorage.setItem(key,JSON.stringify(value));
      sessionStorage.setItem('fixture-initialized','true');
    }
  },storage);
  await page.route('**/fixture/**',route=>{
    const number=Number(route.request().url().match(/-(\d+)/)?.[1] || 1);
    const colors=['#b66445','#8a917b','#bdb095','#4f6d71','#d6c4a3'];
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="220"><rect width="180" height="220" fill="${colors[number%5]}"/><circle cx="90" cy="95" r="${30+number%20}" fill="#e9dec9"/><path d="M30 210 92 92 155 210" fill="#394b47"/><text x="14" y="24" fill="#fff" font-size="13">${number}</text></svg>`;
    return route.fulfill({status:200,contentType:'image/svg+xml',body:svg});
  });
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if (path==='/api/source-catalog') return send(fixture.catalog);
    if (path==='/api/providers') return send({providers:[{id:'openai',configured:fixture.providerConfigured,keySource:fixture.providerConfigured?'environment':null}],defaultModel:'fixture-vision'});
    if (path==='/api/providers/openai' && request.method()==='POST') {
      fixture.keyRequests.push(request.postDataJSON());fixture.providerConfigured=true;return send({provider:{id:'openai',configured:true,keySource:'session'}});
    }
    if (path==='/api/providers/openai/test' && request.method()==='POST') return send({models:['fixture-vision']});
    if (path==='/api/batches' && request.method()==='GET') return send({batches:fixture.batchList});
    if (path==='/api/batches' && request.method()==='POST') {
      const body=request.postDataJSON();fixture.batchRequests.push(body);
      if (fixture.post==='success') return send({batch:{id:'batch-fixture'}});
      if (fixture.post==='reject') return send({error:'The catalog changed. Review your images.'},409);
      if (fixture.post==='missing-key') return send({error:'Connect an OpenAI API key before starting an experiment.'},400);
      return route.abort('connectionreset');
    }
    if (path==='/api/runs' && request.method()==='GET') return send({runs:fixture.runList});
    if (path==='/api/runs' && request.method()==='POST') {
      const body=request.postDataJSON();fixture.requests.push(body);
      if (fixture.post==='success') return send({run:{id:'run-fixture'}});
      if (fixture.post==='reject') return send({error:'The catalog changed. Review your images.'},409);
      if (fixture.post==='missing-key') return send({error:'Connect an OpenAI API key before starting an experiment.'},400);
      return route.abort('connectionreset');
    }
    if (path==='/api/sources' && request.method()==='POST') {
      fixture.uploads.push(request.postDataJSON());
      const source={...structuredClone(sources[0]),id:`uploaded-${fixture.uploads.length}`,name:`Uploaded ${fixture.uploads.length}`,collection:'Studio',sha256:'b'.repeat(64)};
      if (fixture.duplicateUpload) {
        delete source.sha256;source.dataUrl=`data:image/png;base64,${Buffer.from('normalized duplicate paper').toString('base64')}`;
      } else { fixture.catalog.sources.push(source);fixture.catalog.snapshot='c'.repeat(64); }
      if (fixture.staleOnUpload) fixture.catalog.sources.find(item=>item.id===fixture.staleOnUpload).sha256='9'.repeat(64);
      fixture.catalog.limits.uploadSlots--;
      return send({state:{sources:[source]}});
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
  // The destination is observed without loading the library or its API calls.
  await page.route(`${origin}/?started=*`,route=>route.fulfill({status:200,contentType:'text/html',body:'<title>Started</title>'}));
  await page.route(`${origin}/batch.html?batch=*`,route=>route.fulfill({status:200,contentType:'text/html',body:'<title>Batch started</title>'}));
  await page.goto(`${origin}/new.html`);
  await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
  return fixture;
}
async function setCount(page,count) { await page.locator('#random-count').fill(String(count)); }
try {
  {
    const f=await fixture(),{page}=f;
    const initial=await selection(page),saved=await stored(page);
    assert.equal(initial.length,6); assert.deepEqual(await ids(page,'pinned-tray'),[]);
    assert.equal(await page.locator('.material-tile').count(),12);
    assert.equal(await page.locator('.material-tile img[loading=lazy]').count(),12);
    assert.equal(await page.locator('#catalog-count').textContent(),'75');
    assert.deepEqual(await page.locator('#collection-filter option').allTextContents(),['All collections','Cleveland Museum of Art','Studio']);
    assert.equal(await page.locator('#add-images').isEnabled(),true,'catalog is not the upload-capacity limit');
    assert.deepEqual(initial,drawMaterialIds(saved.materialSelection));
    await page.locator('#random-tray button').first().click();
    const promoted=await stored(page),extras=await ids(page,'random-tray');
    assert.deepEqual(await ids(page,'pinned-tray'),[initial[0]]);
    assert.deepEqual(extras.slice(0,5),initial.slice(1));
    assert.equal(extras.length,6);assert.equal(promoted.materialSelection.seed,saved.materialSelection.seed);
    assert.equal(new Set(await selection(page)).size,7);
    await page.locator('#reshuffle').click();
    assert.deepEqual(await ids(page,'pinned-tray'),[initial[0]]);
    const shuffled=await stored(page);assert.notEqual(shuffled.materialSelection.seed,saved.materialSelection.seed);
    const beforeReload=await selection(page);await page.reload();await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.deepEqual(await selection(page),beforeReload,'reload keeps the reviewed draw');
    assert.equal((await stored(page)).materialSelection.seed,shuffled.materialSelection.seed);
    await page.locator('#next-page').click();assert.match(await page.locator('#page-count').textContent(),/13–24 of 75/);
    assert.equal(await page.locator('.material-tile').count(),12);
    await page.locator('#source-search').fill('plant');
    assert.match(await page.locator('#page-count').textContent(),/of 38/);
    assert.deepEqual(await selection(page),beforeReload,'browsing alone does not alter the whole-collection draw');
    await page.locator('#collection-filter').selectOption('Studio');
    assert.match(await page.locator('#page-count').textContent(),/of 13/);
    await page.locator('#random-pool').selectOption('filtered');
    const filteredRecipe=(await stored(page)).materialSelection;
    assert.equal(filteredRecipe.seed,shuffled.materialSelection.seed); assert.equal(filteredRecipe.candidateIds.length,13);
    assert.ok((await ids(page,'random-tray')).every(id=>f.catalog.sources.find(s=>s.id===id).collection==='Studio'));
    await page.locator('#source-search').fill('Botanical study 1');
    assert.equal(await page.locator('#random-count').inputValue(),'6');
    assert.equal(await page.locator('#launch-run').isDisabled(),true);
    assert.match(await page.locator('#selection-error').textContent(),/Requested 6 random images/);
    assert.deepEqual(await ids(page,'random-tray'),[],'an impossible draw is not silently reduced');
    await setCount(page,0);assert.equal(await page.locator('#launch-run').isEnabled(),true);
    await page.locator('#clear-pins').click();assert.match(await page.locator('#selection-error').textContent(),/Pin an image/);
    assert.equal(await page.locator('#launch-run').isDisabled(),true);
    await page.locator('#source-search').fill('');await page.locator('#collection-filter').selectOption('');
    await setCount(page,24);await page.locator('#source-grid .material-pick').first().click();
    assert.equal(await page.locator('#random-count').inputValue(),'24');
    assert.match(await page.locator('#selection-error').textContent(),/between 1 and 24/);
    await page.locator('#clear-pins').click();await setCount(page,6);
    await page.locator('#source-grid .material-pick').first().focus();await page.keyboard.press('Space');
    assert.equal(await page.locator('#pin-count').textContent(),'1');
    assert.equal(await page.locator('#source-grid .material-pick').first().evaluate(node=>document.activeElement===node),true);
    await page.locator('#source-grid .material-details').first().click();
    assert.match(await page.locator('#source-full').getAttribute('src'),/\/fixture\/full-1.svg/);
    assert.match(await page.locator('#source-metadata').textContent(),/Artist 1.*CC0/);
    assert.equal(await page.locator('#source-metadata a').getAttribute('href'),'https://museum.example/art/1');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#source-grid .material-details').first().evaluate(node=>document.activeElement===node),true);
    await page.screenshot({path:'/private/tmp/offcut-material-picker-fixture-desktop.png',fullPage:true});
    mark('bounded contact sheet, actual metadata, deterministic pins/extras, explicit filtered pool, limit failures and keyboard preview');
    await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#collection-filter').selectOption('Studio');
    await page.locator('#source-search').fill('plant');
    await page.locator('#random-pool').selectOption('filtered');
    await page.locator('#random-tray button').first().click();
    const reviewed=await selection(page),recipe=(await stored(page)).materialSelection,filters=(await stored(page)).filters;
    await page.locator('#launch-run').click();
    await page.locator('#pending-notice').waitFor({state:'visible'});
    assert.equal(f.requests.length,1);const body=f.requests[0];
    assert.deepEqual(body.sourceIds,reviewed);assert.deepEqual(body.sourceIds,drawMaterialIds(body.materialSelection));
    assert.deepEqual(body.materialSelection,recipe);
    assert.deepEqual(body.sourceHashes,Object.fromEntries(reviewed.map(id=>[id,sources.find(s=>s.id===id).sha256])));
    assert.deepEqual(await stored(page,PENDING),body);
    assert.equal(await page.locator('#reshuffle').isDisabled(),true);
    assert.equal(await page.locator('#model').isDisabled(),true);
    await page.reload();await page.locator('#pending-notice').waitFor({state:'visible'});
    assert.deepEqual(await selection(page),reviewed);assert.deepEqual(await stored(page,PENDING),body);
    assert.deepEqual((await stored(page)).filters,filters,'pending reload preserves the pool context');
    assert.equal(await page.locator('#random-pool').inputValue(),'filtered');
    f.catalog.snapshot='d'.repeat(64);f.catalog.sources[0].sha256='e'.repeat(64);
    await page.reload();await page.locator('#pending-notice').waitFor({state:'visible'});
    f.post='success';await page.locator('#retry-start').click();
    await page.waitForURL('**/?started=run-fixture');
    assert.equal(f.requests.length,2);assert.deepEqual(f.requests[1],body,'retry keeps exact original receipt despite changed catalog');
    assert.equal(await stored(page,PENDING),null);assert.deepEqual((await stored(page)).filters,filters);
    mark('exact reviewed launch, durable interrupted request, reload and byte-for-byte retry receipt');
    await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#collection-filter').selectOption('Studio');await page.locator('#random-pool').selectOption('filtered');
    const before=await selection(page),filters=(await stored(page)).filters;
    await page.locator('#launch-run').click();await page.locator('#pending-notice').waitFor({state:'visible'});
    const receipt=await stored(page,PENDING);f.runList=[{id:'already-started',status:'running',launch:{clientRequestId:receipt.clientRequestId}}];
    await page.reload();await page.waitForURL('**/?started=already-started');assert.equal(f.requests.length,1);
    assert.deepEqual((await stored(page)).filters,filters);
    await page.goto(`${origin}/new.html`);await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.deepEqual(await selection(page),before,'recovered receipt preserves the filtered draft for the next visit');
    mark('an existing receipt is recovered without a second POST');await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#random-tray button').first().click();const pinned=(await ids(page,'pinned-tray'))[0];
    f.catalog.sources=f.catalog.sources.filter(source=>source.id!==pinned);f.catalog.snapshot='f'.repeat(64);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.equal(await page.locator('#launch-run').isDisabled(),true);assert.equal(await page.locator('#review-materials').isVisible(),true);
    assert.deepEqual(await ids(page,'pinned-tray'),[pinned],'unavailable pins are not quietly discarded');
    await page.locator('#review-materials').click();assert.deepEqual(await ids(page,'pinned-tray'),[]);
    assert.match(await page.locator('#material-message').textContent(),/1 unavailable pin was removed/);
    assert.equal((await stored(page)).materialSelection.catalogSnapshot,'f'.repeat(64));
    assert.equal(await page.locator('#launch-run').isEnabled(),true);
    f.post='reject';await page.locator('#launch-run').click();await page.locator('#refresh-materials').waitFor({state:'visible'});
    assert.equal(await stored(page,PENDING),null);assert.equal(await page.locator('#launch-run').isDisabled(),true);
    f.catalog.snapshot='9'.repeat(64);await page.locator('#refresh-materials').click();
    await page.waitForFunction(()=>!document.querySelector('#launch-run').disabled);
    assert.equal(await page.locator('#launch-run').isEnabled(),true);assert.equal(f.requests.length,1,'review does not launch automatically');
    mark('stale catalog and missing pins require explicit review; 409 refresh never launches');await f.context.close();
  }
  {
    const legacy={sources:sources.slice(0,2).map(({id,sha256})=>({id,sha256})),model:'legacy-vision',limits:{maxPieces:12,maxActions:60,maxTurns:6,maxMinutes:5,maxOutputTokens:4096}};
    const f=await fixture({storage:{[LEGACY]:legacy}}),{page}=f;
    assert.deepEqual(await selection(page),legacy.sources.map(s=>s.id));assert.equal(await page.locator('#random-count').inputValue(),'0');
    assert.equal(await page.locator('#model').inputValue(),'legacy-vision');assert.equal(await page.locator('#maxActions').inputValue(),'60');
    assert.equal((await stored(page)).version,2);assert.equal(await page.locator('#launch-run').isEnabled(),true);
    await page.locator('#image-files').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from([1,2,3])});
    await page.waitForFunction(()=>document.querySelector('#material-message').textContent.includes('image added and pinned'));
    assert.deepEqual(await ids(page,'pinned-tray'),[...legacy.sources.map(s=>s.id),'uploaded-1']);
    assert.equal(await page.locator('#catalog-count').textContent(),'76');assert.equal(f.uploads.length,1);
    assert.equal(await page.locator('#launch-run').isEnabled(),true);
    mark('legacy manual selection migrates to pins; uploads use available studio slots and pin only the confirmed addition');await f.context.close();
  }
  {
    const legacy={sources:sources.slice(0,2).map(({id,sha256})=>({id,sha256}))};
    const f=await fixture({storage:{[LEGACY]:legacy}}),{page}=f;
    f.staleOnUpload=sources[0].id;
    await page.locator('#image-files').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from([1,2,3])});
    await page.waitForFunction(()=>document.querySelector('#material-message').textContent.includes('image added and pinned'));
    assert.equal(await page.locator('#review-materials').isVisible(),true);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.deepEqual(await ids(page,'pinned-tray'),[...legacy.sources.map(s=>s.id),'uploaded-1'],'new pin intent survives a stale-upload reload');
    assert.equal(await page.locator('#launch-run').isDisabled(),true);
    await page.locator('#review-materials').click();assert.equal(await page.locator('#launch-run').isEnabled(),true);
    mark('a concurrent source change during upload preserves every new pin behind the review gate');await f.context.close();
  }
  {
    const catalog=baseCatalog();catalog.sources[0].sha256=createHash('sha256').update('normalized duplicate paper').digest('hex');
    const f=await fixture({catalog}),{page}=f;f.duplicateUpload=true;
    await setCount(page,0);
    await page.locator('#image-files').setInputFiles({name:'same.png',mimeType:'image/png',buffer:Buffer.from([1,2,3])});
    await page.waitForFunction(()=>document.querySelector('#material-message').textContent.includes('already in the collection'));
    assert.deepEqual(await ids(page,'pinned-tray'),[sources[0].id]);
    assert.equal(await page.locator('#catalog-count').textContent(),'75');
    assert.equal(await page.locator('#launch-run').isEnabled(),true);
    assert.equal((await stored(page)).materialSelection.pinnedIds.includes('uploaded-1'),false);
    mark('deduplicated upload pins the existing normalized image instead of a phantom ID');await f.context.close();
  }
  {
    const catalog=baseCatalog();catalog.limits.uploadSlots=0;catalog.sources.forEach(source=>source.byteLength=5*1024*1024);
    const f=await fixture({catalog}),{page}=f;
    assert.equal(await page.locator('#add-images').isDisabled(),true);
    assert.match(await page.locator('#selection-error').textContent(),/30.0 MiB.*24 MiB/);assert.equal(await page.locator('#launch-run').isDisabled(),true);
    await setCount(page,4);assert.equal(await page.locator('#launch-run').isEnabled(),true);
    f.runList=[{id:'active-fixture',status:'running'}];await page.reload();await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.equal(await page.locator('#active-notice').isVisible(),true);assert.equal(await page.locator('#launch-run').isDisabled(),true);
    mark('total image byte budget, exhausted upload slots and active-run guard');await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#random-tray button').first().click();
    for (const value of ['', '2.5', '25']) {
      await page.locator('#random-count').fill(value);
      assert.equal(await page.locator('#launch-run').isDisabled(),true);
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
      assert.equal(await page.locator('#random-count').inputValue(),value);
      assert.equal(await page.locator('#launch-run').isDisabled(),true,'invalid requested extras remain invalid after reload');
      assert.equal(await page.locator('#pin-count').textContent(),'1');
    }
    mark('blank, fractional and excessive random counts survive reload without turning into a pins-only run');await f.context.close();
  }
  {
    const f=await fixture({mobile:true}),{page}=f;
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile page does not overflow horizontally');
    assert.equal(await page.locator('#more-random').evaluate(node=>node.getBoundingClientRect().height>=44),true);
    await page.locator('#random-tray button').first().click();await page.locator('#fewer-random').click();
    assert.equal(await page.locator('#pin-count').textContent(),'1');assert.equal(await page.locator('#random-count').inputValue(),'5');
    await page.screenshot({path:'/private/tmp/offcut-material-picker-fixture-mobile.png',fullPage:true});
    mark('mobile layout, touch-size controls and tray actions');await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    const firstDraw=await selection(page),originalRecipe=(await stored(page)).materialSelection;
    await page.locator('#run-count').fill('3');
    assert.equal(await page.locator('#batch-settings').isVisible(),true);
    assert.equal(await page.locator('#batch-materials').inputValue(),'random');
    assert.match(await page.locator('#run-summary').textContent(),/3 runs.*36 model turns total/);
    await page.locator('#add-model').click();await page.locator('#group-model-1').fill('other-vision');await page.locator('#group-count-1').fill('2');
    assert.match(await page.locator('#run-summary').textContent(),/5 runs.*60 model turns total/);
    await page.locator('#launch-run').click();await page.locator('#batch-review').waitFor({state:'visible'});
    assert.equal(f.batchRequests.length,0,'reviewing has not launched paid work');
    const plan=planBatch({groups:[{model:'fixture-vision',count:3},{model:'other-vision',count:2}],mode:'explore',materials:'random',materialSelection:originalRecipe});
    for (const entry of plan.entries) {
      await page.locator('#review-table').selectOption(String(entry.index));
      assert.deepEqual(await ids(page,'review-table-images'),entry.sourceIds);
    }
    assert.deepEqual(plan.entries[0].sourceIds,firstDraw,'the first table is the reviewed source draw');
    assert.notDeepEqual(plan.entries[0].sourceIds,plan.entries[3].sourceIds,'Explore uses independent draws for model groups');
    await page.locator('#close-batch-review').click();
    assert.deepEqual((await stored(page)).materialSelection,originalRecipe,'previewing never changes the seed or source draft');
    await page.locator('[name=batch-mode][value=compare]').check();
    await page.locator('#launch-run').click();
    await page.locator('#review-table').selectOption('0');const sharedFirst=await ids(page,'review-table-images');
    await page.locator('#review-table').selectOption('3');assert.deepEqual(await ids(page,'review-table-images'),sharedFirst);
    await page.locator('#review-table').selectOption('1');const sharedSecond=await ids(page,'review-table-images');
    await page.locator('#review-table').selectOption('4');assert.deepEqual(await ids(page,'review-table-images'),sharedSecond);
    await page.screenshot({path:'/private/tmp/offcut-batch-review-fixture-desktop.png',fullPage:true});
    await page.locator('#confirm-batch').click();await page.locator('#pending-notice').waitFor({state:'visible'});
    assert.equal(f.requests.length,0);assert.equal(f.batchRequests.length,1);const body=f.batchRequests[0];
    assert.deepEqual(body.groups,[{model:'fixture-vision',count:3},{model:'other-vision',count:2}]);
    assert.equal(body.mode,'compare');assert.equal(body.materials,'random');assert.deepEqual(body.sourceIds,firstDraw);assert.deepEqual(body.materialSelection,originalRecipe);
    assert.equal(await stored(page,PENDING),null);assert.deepEqual(await stored(page,BATCH_PENDING),body);
    assert.equal(await page.locator('#run-count').isDisabled(),true);assert.equal(await page.locator('#add-model').isDisabled(),true);
    await page.reload();await page.locator('#pending-notice').waitFor({state:'visible'});
    assert.equal(await page.locator('#group-count-1').inputValue(),'2');assert.equal(await page.locator('[name=batch-mode][value=compare]').isChecked(),true);
    f.catalog.snapshot='9'.repeat(64);await page.reload();await page.locator('#pending-notice').waitFor({state:'visible'});
    f.post='success';await page.locator('#retry-start').click();await page.waitForURL('**/batch.html?batch=batch-fixture');
    assert.deepEqual(f.batchRequests[1],body,'batch retry preserves all groups, source recipe and UUID after a catalog change');
    assert.equal(await stored(page,BATCH_PENDING),null);
    mark('model groups, Explore and Compare table previews, explicit total budget, isolated durable batch retry');await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#run-count').fill('2');
    await page.locator('#random-tray button').first().click();const pin=(await ids(page,'pinned-tray'))[0];
    assert.equal(await page.locator('#batch-materials').inputValue(),'pinned-random');
    await page.locator('#launch-run').click();
    for (const value of ['0','1']) {await page.locator('#review-table').selectOption(value);assert.ok((await ids(page,'review-table-images')).includes(pin));}
    await page.locator('#close-batch-review').click();await page.locator('#batch-materials').selectOption('random');
    assert.equal(await page.locator('#launch-run').isDisabled(),true);assert.deepEqual(await ids(page,'pinned-tray'),[pin],'random-only mode does not silently discard pins');
    await page.locator('#batch-materials').selectOption('same');await page.locator('#launch-run').click();
    const same=await ids(page,'review-table-images');await page.locator('#next-table').click();assert.deepEqual(await ids(page,'review-table-images'),same);
    await page.locator('#close-batch-review').click();await page.locator('#batch-materials').selectOption('pinned-random');await setCount(page,0);
    assert.equal(await page.locator('#launch-run').isDisabled(),true);
    await page.locator('#batch-materials').selectOption('same');
    await page.locator('#run-count').fill('51');assert.equal(await page.locator('#launch-run').isDisabled(),true);
    await page.locator('#run-count').fill('25');await page.locator('#add-model').click();await page.locator('#group-model-1').fill('other-vision');await page.locator('#group-count-1').fill('26');
    assert.equal(await page.locator('#launch-run').isDisabled(),true);assert.match(await page.locator('#batch-error').textContent(),/50/);
    await page.locator('#group-count-1').fill('25');assert.equal(await page.locator('#launch-run').isEnabled(),true);
    await page.locator('.remove-model').click();await page.locator('#run-count').fill('1');
    assert.equal(await page.locator('#batch-settings').isHidden(),true);assert.match(await page.locator('#launch-run').textContent(),/Start run/);
    mark('pinned draws, fixed-table repeats, material-mode errors without lost pins, 50-run cap and return to one run');await f.context.close();
  }
  {
    const f=await fixture(),{page}=f;
    await page.locator('#run-count').fill('2');await page.locator('#launch-run').click();await page.locator('#confirm-batch').click();await page.locator('#pending-notice').waitFor({state:'visible'});
    const body=f.batchRequests[0];f.batchList=[{id:'recovered-batch',status:'running',launch:{clientRequestId:body.clientRequestId}}];
    await page.reload();await page.waitForURL('**/batch.html?batch=recovered-batch');
    assert.equal(f.batchRequests.length,1,'accepted batch recovery does not issue a second start');assert.equal(await stored(page,BATCH_PENDING),null);
    await page.goto(`${origin}/new.html`);await page.waitForFunction(()=>!document.querySelector('#source-search').disabled);
    assert.equal(await page.locator('#launch-run').isDisabled(),true);assert.equal(await page.locator('#active-link').getAttribute('href'),'/batch.html?batch=recovered-batch');
    mark('accepted batch lookup recovers navigation and an active batch blocks another launch');await f.context.close();
  }
  {
    const f=await fixture({mobile:true}),{page}=f;
    await page.locator('#run-count').fill('2');await page.locator('#add-model').click();await page.locator('#group-model-1').fill('another-vision');
    await page.locator('[name=batch-mode][value=compare]').check();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'/private/tmp/offcut-batch-setup-fixture-mobile.png',fullPage:true});
    await page.locator('#launch-run').click();
    assert.equal(await page.locator('#batch-review').evaluate(node=>node.scrollWidth>node.clientWidth),false);
    await page.locator('#next-table').click();assert.match(await page.locator('#review-table-detail').textContent(),/Table 2 of 3/);
    await page.screenshot({path:'/private/tmp/offcut-batch-review-fixture-mobile.png',fullPage:true});
    mark('mobile model rows and navigable table review fit without horizontal overflow');await f.context.close();
  }
  {
    for (const isBatch of [false,true]) {
      const f=await fixture(),{page}=f,key=isBatch?BATCH_PENDING:PENDING;
      if (isBatch) await page.locator('#run-count').fill('2');
      await page.locator('#launch-run').click();if(isBatch)await page.locator('#confirm-batch').click();
      await page.locator('#pending-notice').waitFor({state:'visible'});
      const receipt=await stored(page,key);
      f.providerConfigured=false;f.post='missing-key';
      await page.reload();await page.locator('#pending-notice').waitFor({state:'visible'});
      assert.equal(await page.locator('#api-key').isDisabled(),true,'an uncertain receipt remains immutable until checked');
      await page.locator('#retry-start').click();await page.waitForFunction(key=>sessionStorage.getItem(key)===null&&!document.querySelector('#api-key').disabled,key);
      const requests=isBatch?f.batchRequests:f.requests;
      assert.deepEqual(requests[1],receipt,'the first check retries the exact uncertain receipt');
      assert.equal(await stored(page,key),null,'definitive missing-key400 releases the unaccepted receipt');
      assert.equal(await page.locator('#api-key').isEnabled(),true);assert.equal(await page.locator('#save-key').isEnabled(),true);
      assert.deepEqual(await selection(page),receipt.sourceIds,'credential recovery preserves the chosen table');
      await page.locator('#api-key').fill('fixture-key-placeholder');await page.locator('#save-key').click();
      await page.waitForFunction(()=>document.querySelector('#connection-message').textContent.includes('Access checked'));
      assert.equal(f.keyRequests.length,1);
      assert.equal((await page.evaluate(()=>JSON.stringify({...sessionStorage}))).includes('fixture-key-placeholder'),false);
      f.post='success';await page.locator('#launch-run').click();if(isBatch)await page.locator('#confirm-batch').click();
      await page.waitForURL(isBatch?'**/batch.html?batch=batch-fixture':'**/?started=run-fixture');
      assert.notEqual(requests[2].clientRequestId,receipt.clientRequestId,'definitively rejected starts use a new launch receipt');
      assert.deepEqual({...requests[2],clientRequestId:receipt.clientRequestId},receipt,'reconnection does not reroll or alter budgets');
      await f.context.close();
    }
    mark('lost session key: exact uncertain retry, definitive400 unlock, reconnect and unchanged single/batch setup');
  }
  assert.deepEqual(errors,[],'no uncaught page errors');
  console.log(`\n${checks.length} browser scenarios passed. No paid model calls or server data mutations.`);
} finally { await browser.close(); }
