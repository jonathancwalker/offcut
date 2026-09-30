import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getSharp } from '../lib/render.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(root, 'public', 'sources');
const base = new URL(process.argv[2] || 'http://127.0.0.1:4317');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('Use a local Offcut server URL, such as http://127.0.0.1:4317.');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function request(path, body) {
  const response = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(60000),
    ...(body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

const manifest = JSON.parse(await readFile(resolve(sourceDirectory, 'manifest.json'), 'utf8'));
const catalog = await request('/api/source-catalog');
const present = new Set(catalog.sources.map(source => source.sha256));
const missing = [];
for (const entry of manifest) {
  const file = resolve(sourceDirectory, entry.file);
  if (!file.startsWith(sourceDirectory + sep)) throw new Error('Invalid source-pack path.');
  const jpeg = await readFile(file);
  const png = await getSharp()(jpeg).rotate().png({compressionLevel:8}).toBuffer();
  const sha256 = hash(png);
  if (present.has(sha256)) continue;
  missing.push({entry, sha256, pngBytes:png.length, dataUrl:`data:image/jpeg;base64,${jpeg.toString('base64')}`});
  present.add(sha256);
}
if (catalog.sources.length + missing.length > catalog.limits.maxSources) {
  throw new Error(`The pack needs ${missing.length} free slots; this collection has ${catalog.limits.maxSources-catalog.sources.length}. No images were added.`);
}
if (!missing.length) {
  console.log(`All bundled images are already available (${catalog.sources.length} sources).`);
} else {
  const project = await request('/api/project');
  const existingBytes = project.sources.reduce((total, source) => total + Buffer.from(source.dataUrl.split(',')[1], 'base64').length, 0);
  const newBytes = missing.reduce((total, source) => total + source.pngBytes, 0);
  if (existingBytes + newBytes > 24*1024*1024) throw new Error('This pack would exceed the 24 MB image inventory. No images were added.');
  let added = 0;
  try {
    for (const {entry, dataUrl} of missing) {
      // Use the additive source API: it keeps the current artwork, history,
      // cursor, and any sources supplied by the user intact.
      await request('/api/sources', {name:entry.name, credit:entry.credit, license:entry.license, url:entry.url, dataUrl});
      console.log(`Added ${++added}/${missing.length}: ${entry.name}`);
    }
  } catch (error) {
    throw new Error(`${error.message} Added ${added} confirmed images before stopping. Run this command again to check and add only missing images; an interrupted response may already have been saved.`);
  }
  const final = await request('/api/source-catalog');
  if (missing.some(source => !final.sources.some(item => item.sha256 === source.sha256))) throw new Error('Import finished, but some expected images are missing from the current catalog.');
  console.log(`Ready: ${final.sources.length} source images. Existing artwork was preserved.`);
}
