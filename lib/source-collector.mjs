import { readFile, writeFile, mkdir, rename, unlink, readdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getSharp } from './render.mjs';
import { fetchClevelandPage } from './collection-providers/cleveland.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['openaccess-api.clevelandart.org', 'openaccess-cdn.clevelandart.org']);
const sleep = (ms, signal) => new Promise((done, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const abort = () => {clearTimeout(timer); reject(signal.reason);};
  const timer = setTimeout(() => {signal?.removeEventListener('abort', abort); done();}, ms);
  signal?.addEventListener('abort', abort, {once:true});
});
class SkipImage extends Error {}
class DownloadBudget extends Error {}
class PauseCollection extends Error {}

async function readJSON(file, fallback) {
  try {return JSON.parse(await readFile(file, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return fallback; throw error;}
}
async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2)+'\n', {mode:0o600});
  await rename(temporary, file);
}
function checkedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new SkipImage('Image or API URL is outside the approved collection hosts.');
  return url;
}
function integer(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return result;
}
export function collectionConfig(input = {}) {
  if (input.provider && input.provider !== 'cleveland') throw new Error('The first collector supports the cleveland provider.');
  const topics = input.topics ?? ['birds', 'botanical', 'architecture', 'textile', 'portrait', 'poster', 'map', 'mechanical'];
  if (!Array.isArray(topics) || !topics.length || topics.length > 16 || topics.some(topic => typeof topic !== 'string' || !topic.trim() || topic.length > 100)) throw new Error('Choose 1–16 nonempty search topics of at most 100 characters.');
  return {
    provider:'cleveland', topics:[...new Set(topics.map(topic => topic.trim()))],
    limit:integer(input.limit, 50, 1, 1000, 'Image limit'),
    maxMB:integer(input.maxMB, 250, 1, 2048, 'Download budget in MB'),
    maxEdge:integer(input.maxEdge, 1000, 256, 2048, 'Maximum image edge'),
    minEdge:256, pageSize:50, maxPagesPerTopic:10,
  };
}

// Reads are sequential across metadata and images, with the same host policy
// applied to redirects. Retry only transient read failures, never access denials.
function collectionNetwork({fetchImpl, signal, delayMs, onBytes, remainingBytes, onProgress, beginImage, endImage}) {
  let lastRequest = 0;
  async function responseFor(url, accept) {
    let current = checkedURL(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      await sleep(Math.max(0, delayMs-(Date.now()-lastRequest)), signal);
      if (signal?.aborted) throw signal.reason;
      lastRequest = Date.now();
      const response = await fetchImpl(current.href, {
        headers:{'User-Agent':'Offcut-Source-Collector/0.1', Accept:accept},
        redirect:'manual', signal:signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        if (!response.headers.get('location')) throw new SkipImage('Redirect did not include a location.');
        current = checkedURL(new URL(response.headers.get('location'), current).href);
        continue;
      }
      return response;
    }
    throw new SkipImage('Too many redirects.');
  }
  async function get(url, accept, read, imageDownload=false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if(imageDownload)await beginImage();
      try {
        const response = await responseFor(url, accept);
        if (!response.ok) {
          await response.body?.cancel();
          if (![408,429,500,502,503,504].includes(response.status)) throw new SkipImage(`Collection returned HTTP ${response.status}.`);
          const retry = response.headers.get('retry-after');
          const wait = retry ? (/^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0, Date.parse(retry)-Date.now())) : 1000*2**attempt;
          if (attempt === 2 || wait > 30000) throw new PauseCollection(`Collection returned HTTP ${response.status}. ${wait>30000?'Its retry window is longer than 30 seconds. ':''}Resume later.`);
          onProgress(`Waiting before retrying HTTP ${response.status}…`);
          await sleep(Math.max(1000, Number.isFinite(wait)?wait:1000), signal);
          continue;
        }
        return await read(response);
      } catch (error) {
        if (signal?.aborted || error instanceof SkipImage || error instanceof DownloadBudget || error instanceof PauseCollection) throw error;
        if (attempt === 2) throw new PauseCollection(`Read failed after 3 attempts: ${error.message}`);
        onProgress('Connection interrupted; retrying this read…');
        await sleep(1000*2**attempt, signal);
      } finally {if(imageDownload)await endImage();}
    }
  }
  return {
    requestJSON: url => get(url, 'application/json', async response => {
      if (!/application\/json/i.test(response.headers.get('content-type') || '')) {await response.body?.cancel(); throw new PauseCollection('The collection did not return JSON metadata.');}
      const chunks=[];let size=0;
      for await (const chunk of response.body) {
        size+=chunk.length;
        if(size>5*1024*1024)throw new PauseCollection('Metadata response exceeds the 5 MiB limit.');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }),
    image: url => get(url, 'image/jpeg,image/png,image/webp', async response => {
      if (!/^image\/(jpeg|png|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) {await response.body?.cancel(); throw new SkipImage('Download is not a supported raster image.');}
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_IMAGE_BYTES) {await response.body?.cancel(); throw new SkipImage('Image download exceeds 16 MB.');}
      if (declared > remainingBytes()) {await response.body?.cancel(); throw new DownloadBudget('Download budget reached.');}
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; onBytes(chunk.length);
        if (size > MAX_IMAGE_BYTES) throw new SkipImage('Image download exceeds 16 MB.');
        if (remainingBytes() < 0) throw new DownloadBudget('Download budget reached.');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }, true),
  };
}

const escaped = value => String(value??'').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
async function writeGallery(directory, catalog) {
  const cards = catalog.sources.map(source => `<article><a href="assets/${source.sha256}.jpg"><img src="assets/${source.sha256}.jpg" loading="lazy" alt="${escaped(source.title)}"></a><h2>${escaped(source.title)}</h2><p>${escaped(source.creator||'Creator not recorded')}${source.date?' · '+escaped(source.date):''}</p><p><a href="${escaped(source.url)}">Collection record</a> · ${escaped(source.license)}</p></article>`).join('\n');
  await writeFile(join(directory,'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Collected sources — Offcut</title><style>body{margin:0;padding:40px;font:14px system-ui;color:#302b25;background:#f8f5ef}h1{font-weight:500}header{margin-bottom:32px}header p{color:#746d63}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:30px 22px}article{min-width:0}img{display:block;width:100%;height:250px;object-fit:contain;background:#ebe4d8}h2{font-size:13px;font-weight:500;margin:12px 0 7px}p{font-size:11px;line-height:1.6;overflow-wrap:anywhere}a{color:inherit}article p{margin:5px 0;color:#746d63}@media(max-width:550px){body{padding:22px}main{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 14px}img{height:190px}}</style><header><h1>Collected sources</h1><p>${catalog.sources.length} images · Local collection · Choose a smaller set for each run</p></header><main>${cards}</main></html>`, {mode:0o600});
}

async function acquireLock(directory) {
  const file=join(directory,'.collector.lock');
  const recoveryFile=join(directory,'.collector-recovery.lock');
  const take=async()=>{
    const handle=await open(file,'wx',0o600);
    try {await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:now()}));}
    catch(error){await unlink(file);throw error;}
    finally {await handle.close();}
  };
  const isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  try {await take();}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const owner=await readJSON(file,null);
    if(!Number.isInteger(owner?.pid)||owner.pid<=0)throw new Error('Collector lock is unreadable. Check that no collector is running before removing .collector.lock.');
    if(isAlive(owner.pid))throw new Error('A collection job is already running in this directory.');
    let recovery;
    try{recovery=await open(recoveryFile,'wx',0o600);}
    catch(cause){if(cause.code==='EEXIST')throw new Error('Collector lock recovery is already in progress. If it was interrupted, check for a running collector before removing .collector-recovery.lock.');throw cause;}
    try {
      // Serialize stale-lock recovery and recheck after acquiring that guard.
      // Another job may have replaced the stale owner since the first read.
      const current=await readJSON(file,null);
      if(current){
        if(!Number.isInteger(current.pid)||current.pid<=0||isAlive(current.pid))throw new Error('A collection job is already running in this directory.');
        await unlink(file);
      }
      try{await take();}catch(cause){if(cause.code==='EEXIST')throw new Error('Another collection job acquired the directory.');throw cause;}
    } finally {await recovery.close();await unlink(recoveryFile);}
  }
  return () => unlink(file);
}

/** Collect into a disk-backed library. Never touches the live studio or model API. */
export async function collectSources({directory, config:input, resume=false, signal, onProgress=()=>{}, fetchImpl=fetch, fetchPage=fetchClevelandPage, delayMs=1100}={}) {
  if (!directory) throw new Error('A collection directory is required.');
  directory=resolve(directory);
  await mkdir(join(directory,'assets'),{recursive:true,mode:0o700});
  await mkdir(join(directory,'jobs'),{recursive:true,mode:0o700});
  const unlock=await acquireLock(directory);
  let job, catalog, committedCatalog;
  const catalogPath=join(directory,'catalog.json');
  let jobPath;
  const checkpoint=async()=>{job.updatedAt=now();await atomicJSON(jobPath,job);};
  try {
    catalog=await readJSON(catalogPath,{version:1,sources:[],records:{}});
    committedCatalog=structuredClone(catalog);
    if (catalog.version!==1 || !Array.isArray(catalog.sources) || !catalog.records || typeof catalog.records!=='object' || Array.isArray(catalog.records)) throw new Error('Unsupported or damaged local collection catalog.');
    if (resume) {
      const jobs=[];
      for (const file of await readdir(join(directory,'jobs'))) if(file.endsWith('.json')) {
        const candidate=await readJSON(join(directory,'jobs',file),null);
        if(candidate && candidate.version===1 && /^collect-[a-f0-9-]{36}$/.test(candidate.id) && ['running','paused'].includes(candidate.status)) jobs.push(candidate);
      }
      jobs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
      job=jobs[0]; if(!job)throw new Error('No unfinished job to resume. Start a new collection job.');
      job.config=collectionConfig(job.config);
      onProgress(`Resuming ${job.id}: ${job.added} of ${job.config.limit} images already saved.`);
    } else {
      const config=collectionConfig(input);
      job={version:1,id:`collect-${randomUUID()}`,createdAt:now(),updatedAt:now(),status:'running',config,added:0,duplicates:0,skipped:0,bytesDownloaded:0,storedBytes:0,turn:0,topics:config.topics.map(query=>({query,offset:0,pages:0,done:false,queue:[]})),issues:[]};
      onProgress(`Collecting up to ${config.limit} new images from ${config.topics.length} topics.`);
    }
    jobPath=join(directory,'jobs',`${job.id}.json`);
    const committed=catalog.sources.filter(source=>source.jobId===job.id);
    job.added=committed.length;job.storedBytes=committed.reduce((sum,source)=>sum+source.bytes,0);
    job.budgetBytesUsed ??= job.bytesDownloaded;
    if(job.pendingDownload){
      // A hard crash can lose observed-byte accounting. Charge its persisted
      // reservation conservatively before allowing another network transfer.
      job.budgetBytesUsed+=job.pendingDownload.reservedBytes;
      job.uncertainDownloadBytes=(job.uncertainDownloadBytes||0)+job.pendingDownload.reservedBytes;
      delete job.pendingDownload;
      onProgress('Recovered an interrupted download; its reserved allowance counts against this job’s budget.');
    }
    job.status='running';delete job.lastError;
    await checkpoint();
    const budget=job.config.maxMB*1024*1024;
    const network=collectionNetwork({
      fetchImpl,signal,delayMs,onProgress,onBytes:bytes=>{job.bytesDownloaded+=bytes;},
      remainingBytes:()=>budget-job.budgetBytesUsed-(job.pendingDownload?job.bytesDownloaded-job.pendingDownload.downloadedBefore:0),
      beginImage:async()=>{
        const reservedBytes=Math.min(MAX_IMAGE_BYTES,budget-job.budgetBytesUsed);
        if(reservedBytes<=0)throw new DownloadBudget('Download budget reached.');
        job.pendingDownload={reservedBytes,downloadedBefore:job.bytesDownloaded};
        await checkpoint();
      },
      endImage:async()=>{
        job.budgetBytesUsed+=job.bytesDownloaded-job.pendingDownload.downloadedBefore;
        delete job.pendingDownload;
        await checkpoint();
      },
    });
    const byHash=new Map(catalog.sources.map(source=>[source.pixelSha256,source]));
    const byOriginal=new Map();
    for(const source of catalog.sources){
      byOriginal.set(source.originalSha256,source);
      for(const alias of source.alsoCatalogedAs||[])if(alias.originalSha256)byOriginal.set(alias.originalSha256,source);
    }
    const configKey=hash(JSON.stringify(job.config));
    while (job.added<job.config.limit) {
      if(signal?.aborted)throw signal.reason;
      if(job.budgetBytesUsed>=budget)throw new DownloadBudget('Download budget reached.');
      if(job.topics.every(topic=>topic.done&&!topic.queue.length)){job.status='search_complete';break;}
      const topic=job.topics[job.turn%job.topics.length];
      if(!topic.queue.length && !topic.done) {
        onProgress(`Searching ${topic.query}…`);
        const page=await fetchPage({query:topic.query,offset:topic.offset,limit:job.config.pageSize,requestJSON:network.requestJSON});
        topic.pages++;
        topic.queue=page.candidates;
        topic.done=page.nextOffset===null || topic.pages>=job.config.maxPagesPerTopic;
        if(page.nextOffset!==null)topic.offset=page.nextOffset;
        await checkpoint();
      }
      const candidate=topic.queue[0];
      if(!candidate){job.turn++;await checkpoint();continue;}
      const key=`${candidate.provider}:${candidate.recordId}`;
      if(catalog.records[key]) {
        const record=catalog.records[key];
        const recoveredSave=job.inFlight?.key===key && record.status==='stored' && committed.some(source=>source.id===record.id);
        topic.queue.shift();
        if(!recoveredSave){if(record.status==='skipped')job.skipped++;else job.duplicates++;}
        job.turn++;delete job.inFlight;await checkpoint();continue;
      }
      try {
        // Persist the in-flight identity before downloading. On resumption an
        // already committed catalog record reconciles an interrupted checkpoint.
        job.inFlight={key,topic:job.turn%job.topics.length};await checkpoint();
        const original=await network.image(candidate.downloadUrl);
        let jpeg, dimensions, pixels;
        try {
          const pipeline=getSharp()(original,{limitInputPixels:20_000_000,failOn:'error'});
          const metadata=await pipeline.metadata();
          if(metadata.pages>1)throw new Error('Animated or multipage images are excluded.');
          if(Math.min(metadata.width,metadata.height)<job.config.minEdge)throw new Error('Image is below the 256-pixel minimum short edge.');
          jpeg=await pipeline.rotate().resize({width:job.config.maxEdge,height:job.config.maxEdge,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
          dimensions=await getSharp()(jpeg).metadata();
          pixels=await getSharp()(jpeg).rotate().png({compressionLevel:8}).toBuffer();
        } catch(error) {throw new SkipImage(`Image could not be accepted: ${error.message}`);}
        const pixelSha256=hash(pixels);
        const originalSha256=hash(original);
        const existing=byOriginal.get(originalSha256)||byHash.get(pixelSha256);
        if(existing) {
          existing.alsoCatalogedAs ??= [];
          existing.alsoCatalogedAs.push({provider:candidate.provider,recordId:candidate.recordId,url:candidate.url,title:candidate.title,credit:candidate.credit,originalSha256});
          byOriginal.set(originalSha256,existing);
          catalog.records[key]={status:'duplicate',id:existing.id};job.duplicates++;
        } else {
          const sha256=hash(jpeg);
          const source={...candidate,id:`${candidate.provider}-${candidate.recordId}`,file:`assets/${sha256}.jpg`,width:dimensions.width,height:dimensions.height,sha256,pixelSha256,originalSha256,bytes:jpeg.length,pngBytes:pixels.length,collectedAt:now(),jobId:job.id,configSha256:configKey,discoveredWith:topic.query,normalization:{maxEdge:job.config.maxEdge,format:'jpeg',quality:88,fullImage:true}};
          await writeFile(join(directory,source.file),jpeg,{mode:0o600});
          catalog.sources.push(source);byHash.set(pixelSha256,source);byOriginal.set(originalSha256,source);catalog.records[key]={status:'stored',id:source.id};
          job.added++;job.storedBytes+=jpeg.length;
        }
        await atomicJSON(catalogPath,catalog);committedCatalog=structuredClone(catalog);
        if(!existing)onProgress(`Saved ${job.added}/${job.config.limit}: ${candidate.title}`);
      } catch(error) {
        if(!(error instanceof SkipImage))throw error;
        job.skipped++;job.issues.push({at:now(),recordId:key,url:candidate.url,reason:error.message});
        catalog.records[key]={status:'skipped',reason:error.message};
        await atomicJSON(catalogPath,catalog);committedCatalog=structuredClone(catalog);
        onProgress(`Skipped ${candidate.title}: ${error.message}`);
      }
      topic.queue.shift();job.turn++;delete job.inFlight;await checkpoint();
    }
    if(job.added>=job.config.limit)job.status='completed';
  } catch(error) {
    if(!job || !jobPath)throw error;
    job.status=error instanceof DownloadBudget?'budget_reached':'paused';
    job.lastError=signal?.aborted?'Stopped. Resume this job to continue.':error.message;
    onProgress(job.lastError);
  } finally {
    try {
      if(job && jobPath){
        // Count committed assets from this job in case interruption occurred
        // between the catalog commit and the job checkpoint.
        catalog=committedCatalog;
        if(catalog){const saved=catalog.sources.filter(source=>source.jobId===job.id);job.added=saved.length;job.storedBytes=saved.reduce((sum,source)=>sum+source.bytes,0);}
        await checkpoint();
        if(catalog)await writeGallery(directory,catalog);
      }
    } finally {await unlock();}
  }
  return {job,catalogPath,galleryPath:join(directory,'index.html'),totalImages:catalog.sources.length};
}
