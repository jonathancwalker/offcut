import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getSharp} from '../lib/render.mjs';
import {collectSources,collectionConfig} from '../lib/source-collector.mjs';

const candidate=(id,title=`Source ${id}`)=>({provider:'cleveland',recordId:String(id),title,creator:'Fixture',date:'1900',credit:'Fixture museum',license:'CC0 1.0',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',url:`https://clevelandart.org/art/${id}`,rightsUrl:`https://clevelandart.org/art/${id}`,rightsEvidence:{share_license_status:'CC0'},downloadUrl:`https://openaccess-cdn.clevelandart.org/${id}.jpg`});
const page=items=>async()=>({candidates:items,nextOffset:null,total:items.length});
async function setup(t){
 const directory=await mkdtemp(join(tmpdir(),'offcut-collector-test-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const image=await getSharp()({create:{width:600,height:400,channels:3,background:'#e64f35'}}).jpeg().toBuffer();
 const other=await getSharp()({create:{width:500,height:600,channels:3,background:'#3564aa'}}).jpeg().toBuffer();
 return {directory,image,other};
}
const response=bytes=>new Response(bytes,{headers:{'content-type':'image/jpeg','content-length':String(bytes.length)}});
const config={limit:2,topics:['animals'],maxMB:5,maxEdge:512};

test('collector saves image provenance and skips exact originals across sizes and record IDs',async t=>{
 const {directory,image}=await setup(t);let calls=0;
 const first=await collectSources({directory,config:{...config,limit:1,maxEdge:256},fetchPage:page([candidate(1,'<script>bad</script>')]),fetchImpl:async()=>{calls++;return response(image);},delayMs:0});
 assert.equal(first.job.status,'completed');assert.equal(first.job.added,1);
 assert.equal(first.job.bytesDownloaded,image.length);assert.equal(first.job.budgetBytesUsed,image.length);assert.equal(first.job.pendingDownload,undefined);
 const second=await collectSources({directory,config,fetchPage:page([candidate(1),candidate(2)]),fetchImpl:async()=>{calls++;return response(image);},delayMs:0});
 assert.equal(second.job.added,0);assert.equal(second.job.duplicates,2);assert.equal(second.totalImages,1);assert.equal(calls,2);
 const catalog=JSON.parse(await readFile(second.catalogPath));assert.equal(catalog.sources[0].license,'CC0 1.0');assert.equal(catalog.sources[0].alsoCatalogedAs[0].recordId,'2');
 assert.ok(catalog.sources[0].originalSha256);assert.ok(catalog.sources[0].pixelSha256);
 const html=await readFile(second.galleryPath,'utf8');assert.ok(!html.includes('<script>bad'));assert.ok(html.includes('&lt;script&gt;bad'));
 assert.equal((await readdir(join(directory,'assets'))).length,1);
});

test('resume reconciles committed images after an interrupted job checkpoint without overshooting its target',async t=>{
 const {directory,image,other}=await setup(t);const controller=new AbortController();
 const items=[candidate(1),candidate(2),candidate(3)];
 const first=await collectSources({directory,config,signal:controller.signal,fetchPage:page(items),fetchImpl:async()=>response(image),delayMs:0,onProgress:message=>{if(message.startsWith('Saved'))controller.abort(new Error('Stop fixture'));}});
 assert.equal(first.job.status,'paused');assert.equal(first.job.added,1);
 const file=join(directory,'jobs',first.job.id+'.json');
 const checkpoint=JSON.parse(await readFile(file));checkpoint.added=0;checkpoint.turn=0;checkpoint.topics[0].queue=items;checkpoint.inFlight={key:'cleveland:1',topic:0};await writeFile(file,JSON.stringify(checkpoint));
 let downloads=0;
 const resumed=await collectSources({directory,resume:true,fetchPage:()=>{throw Error('Should use saved page');},fetchImpl:async url=>{downloads++;assert.ok(url.endsWith('/2.jpg'));return response(other);},delayMs:0});
 assert.equal(resumed.job.status,'completed');assert.equal(resumed.job.id,first.job.id);assert.equal(resumed.job.added,2);assert.equal(resumed.totalImages,2);assert.equal(downloads,1);
 assert.equal(resumed.job.duplicates,0);assert.equal(resumed.job.budgetBytesUsed,image.length+other.length);
});

test('a durable download reservation preserves the budget after a hard-crash checkpoint gap',async t=>{
 const {directory,image}=await setup(t);const controller=new AbortController();let beforeTransfer;
 const first=await collectSources({directory,config:{...config,maxMB:1},signal:controller.signal,fetchPage:page([candidate(1),candidate(2)]),fetchImpl:async()=>{
  const [file]=await readdir(join(directory,'jobs'));
  beforeTransfer=JSON.parse(await readFile(join(directory,'jobs',file)));
  assert.equal(beforeTransfer.pendingDownload.reservedBytes,1024*1024);
  assert.equal(beforeTransfer.bytesDownloaded,0);
  return response(image);
 },delayMs:0,onProgress:message=>{if(message.startsWith('Saved'))controller.abort(new Error('Stop fixture'));}});
 // Emulate termination after bytes were received but before transfer settlement
 // became durable; retain the saved catalog to exercise both reconciliation paths.
 await writeFile(join(directory,'jobs',first.job.id+'.json'),JSON.stringify(beforeTransfer));
 const resumed=await collectSources({directory,resume:true,fetchPage:()=>{throw Error('Must not search beyond its budget');},fetchImpl:()=>{throw Error('Must not download beyond its budget');},delayMs:0});
 assert.equal(resumed.job.status,'budget_reached');assert.equal(resumed.job.added,1);assert.equal(resumed.job.duplicates,0);
 assert.equal(resumed.job.budgetBytesUsed,1024*1024);assert.equal(resumed.job.uncertainDownloadBytes,1024*1024);
 assert.equal(resumed.job.pendingDownload,undefined);
});

test('download budget stops before an oversized transfer and unsupported images remain skipped',async t=>{
 const {directory}=await setup(t);
 const bounded=await collectSources({directory,config:{...config,maxMB:1},fetchPage:page([candidate(1)]),fetchImpl:async()=>new Response('x',{headers:{'content-type':'image/jpeg','content-length':String(2*1024*1024)}}),delayMs:0});
 assert.equal(bounded.job.status,'budget_reached');assert.equal(bounded.job.added,0);assert.equal(bounded.job.bytesDownloaded,0);
 const skip=await collectSources({directory,config,fetchPage:page([candidate(2)]),fetchImpl:async()=>new Response('<html>no image</html>',{headers:{'content-type':'text/html'}}),delayMs:0});
 assert.equal(skip.job.skipped,1);assert.equal(skip.job.added,0);
 const again=await collectSources({directory,config,fetchPage:page([candidate(2)]),fetchImpl:async()=>{throw Error('Should not fetch a rejected record again');},delayMs:0});
 assert.equal(again.job.skipped,1);assert.equal(again.job.duplicates,0);
});

test('collector honors long Retry-After and refuses redirects outside approved hosts',async t=>{
 const {directory}=await setup(t);let calls=0;
 const paused=await collectSources({directory,config,fetchPage:page([candidate(1)]),fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'60'}});},delayMs:0});
 assert.equal(paused.job.status,'paused');assert.equal(calls,1);
 const resumed=await collectSources({directory,resume:true,fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});},delayMs:0});
 assert.equal(resumed.job.skipped,1);assert.equal(resumed.job.status,'search_complete');assert.equal(calls,2);
});

test('metadata responses are capped while reading and pause without requesting images',async t=>{
 const {directory}=await setup(t);let pulls=0;
 const result=await collectSources({directory,config,fetchImpl:async()=>new Response(new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(1024*1024));if(pulls===20)controller.close();}}),{headers:{'content-type':'application/json'}}),delayMs:0});
 assert.equal(result.job.status,'paused');assert.match(result.job.lastError,/5 MiB/);assert.ok(pulls<20);assert.equal(result.totalImages,0);
});

test('live collector lock rejects a second writer and interruption releases it',async t=>{
 const {directory,image}=await setup(t);let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const first=collectSources({directory,config:{...config,limit:1},fetchPage:page([candidate(1)]),fetchImpl:async()=>{started();await new Promise(resolve=>{release=resolve;});return response(image);},delayMs:0});
 await ready;
 await assert.rejects(collectSources({directory,config,fetchPage:page([]),delayMs:0}),/already running/);
 release();await first;
 await assert.rejects(readFile(join(directory,'.collector.lock')),error=>error.code==='ENOENT');
});

test('collection options reject unbounded limits and normalize distinct topics',()=>{
 assert.throws(()=>collectionConfig({limit:Infinity}),/integer/);
 assert.throws(()=>collectionConfig({topics:[]}),/topics/);
 assert.deepEqual(collectionConfig({topics:[' birds ','birds','maps']}).topics,['birds','maps']);
});
