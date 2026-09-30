import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSources } from '../lib/source-collector.mjs';

const args=process.argv.slice(2);
const shellQuote=value=>`'${value.replace(/'/g, "'\\''")}'`;
if(args.includes('--help')){
  console.log(`Collect reusable source images into a separate local library.

npm run sources:collect -- --limit 100 --topics "birds,botanical,textile,architecture"
npm run sources:collect -- --resume

Options:
  --limit N       Maximum new images in this job (default 50; max 1000)
  --topics LIST   Comma-separated search topics; sampled in turn
  --max-mb N      Maximum downloaded image bytes in MiB (default 250)
  --max-edge N    Longest saved image edge in pixels (default 1000)
  --directory D  Library directory (default .data/source-library)
  --resume       Continue the most recently interrupted job, using its settings

Cleveland Museum of Art is the first source. Only records whose image reuse
status is CC0 are collected. Existing records and exact images are skipped.
One request at a time; short transient failures are retried. No model calls.
This library is separate from the current 24-image run picker.`);
  process.exit(0);
}
const options={config:{}};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
options.directory=resolve(root,'.data/source-library');
for(let index=0;index<args.length;index++){
  const flag=args[index];
  if(flag==='--resume'){options.resume=true;continue;}
  if(!['--limit','--topics','--max-mb','--max-edge','--directory'].includes(flag))throw new Error(`Unknown option: ${flag}. Use --help.`);
  const value=args[++index];if(!value || value.startsWith('--'))throw new Error(`${flag} needs a value.`);
  if(flag==='--directory')options.directory=resolve(value);
  else if(flag==='--topics')options.config.topics=value.split(',').map(topic=>topic.trim()).filter(Boolean);
  else options.config[{'--limit':'limit','--max-mb':'maxMB','--max-edge':'maxEdge'}[flag]]=Number(value);
}
if(options.resume && Object.keys(options.config).length)throw new Error('--resume uses the saved settings; omit limit, topics and size options.');
const controller=new AbortController();
const stop=()=>controller.abort(new Error('Stopped by user.'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
  const {job,totalImages,galleryPath}=await collectSources({...options,signal:controller.signal,onProgress:message=>console.log(message)});
  console.log(`\n${job.status}: ${job.added} saved, ${job.duplicates} duplicates, ${job.skipped} skipped. Library: ${totalImages} images.`);
  console.log(`Job: ${job.id}\nPreview: ${galleryPath}`);
  if(job.status==='paused'){console.log(`Continue with: npm run sources:collect -- --resume --directory ${shellQuote(options.directory)}`);process.exitCode=2;}
} finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
