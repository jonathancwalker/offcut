import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getSharp } from './render.mjs';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_RUN_BYTES = 24 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalJSON = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function fail(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  if (status === 500) error.code = 'MATERIAL_CATALOG_INVALID';
  throw error;
}

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function webURL(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function tags(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => text(item, 80)).filter(Boolean))].slice(0, 32) : [];
}

function dimensions(source, label, status = 500) {
  if (![source.width, source.height].every(value => Number.isInteger(value) && value >= 16 && value <= 8192)
    || source.width * source.height > MAX_PIXELS) fail(`${label} has invalid image dimensions.`, status);
}

// Only explicitly supported descriptive fields reach a run. Catalog file paths,
// job records and arbitrary nested metadata remain private to the collector.
function provenance(input) {
  if (!object(input)) return undefined;
  const result = {};
  for (const [key, limit] of Object.entries({ provider: 80, recordId: 100, title: 160, creator: 1000, date: 160, credit: 1000, license: 300, collectedAt: 80, discoveredWith: 100 })) {
    const value = text(input[key], limit);
    if (value) result[key] = value;
  }
  for (const key of ['url', 'licenseUrl', 'rightsUrl', 'downloadUrl', 'higherResolutionUrl']) {
    const value = webURL(input[key]);
    if (value) result[key] = value;
  }
  for (const key of ['sha256', 'pixelSha256', 'originalSha256', 'configSha256']) {
    if (typeof input[key] === 'string' && HASH.test(input[key])) result[key] = input[key];
  }
  if (object(input.rightsEvidence)) {
    const status = text(input.rightsEvidence.share_license_status, 100);
    const policyUrl = webURL(input.rightsEvidence.policyUrl);
    if (status || policyUrl) result.rightsEvidence = {
      ...(status ? { share_license_status: status } : {}), ...(policyUrl ? { policyUrl } : {}),
    };
  }
  if (object(input.normalization)) {
    const value = input.normalization;
    result.normalization = {
      ...(Number.isInteger(value.maxEdge) && value.maxEdge >= 1 && value.maxEdge <= 8192 ? { maxEdge: value.maxEdge } : {}),
      ...(['jpeg', 'png', 'webp'].includes(value.format) ? { format: value.format } : {}),
      ...(Number.isInteger(value.quality) && value.quality >= 1 && value.quality <= 100 ? { quality: value.quality } : {}),
      ...(typeof value.fullImage === 'boolean' ? { fullImage: value.fullImage } : {}),
    };
  }
  const sourceTags = tags(input.tags);
  if (sourceTags.length) result.tags = sourceTags;
  if (Array.isArray(input.alsoCatalogedAs)) {
    result.alsoCatalogedAs = input.alsoCatalogedAs.slice(0, 32).filter(object).map(alias => {
      const value = {};
      for (const [key, limit] of Object.entries({ provider: 80, recordId: 100, title: 160, credit: 1000 })) {
        const field = text(alias[key], limit);
        if (field) value[key] = field;
      }
      const url = webURL(alias.url);
      if (url) value.url = url;
      if (typeof alias.originalSha256 === 'string' && HASH.test(alias.originalSha256)) value.originalSha256 = alias.originalSha256;
      return value;
    });
  }
  return Object.keys(result).length ? result : undefined;
}

/** Optional run-manifest metadata; standalone engine sources retain their schema. */
export function safeMaterialMetadata(source) {
  if (!object(source)) return {};
  const result = {};
  if (['Studio', 'Cleveland Museum of Art'].includes(source.collection)) result.collection = source.collection;
  if (Array.isArray(source.tags)) result.tags = tags(source.tags);
  const safeProvenance = provenance(source.provenance);
  if (safeProvenance) result.provenance = safeProvenance;
  return result;
}

function decodeInventory(source) {
  const match = typeof source.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source.dataUrl);
  if (!match || match[2].length % 4 || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) fail('The studio inventory contains an invalid embedded image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail('The studio inventory contains an image larger than 16 MiB.');
  return { bytes, mime: `image/${match[1]}` };
}

function metadata({ id, name, width, height, sha256, byteLength, credit, url, license, collection, sourceTags }) {
  return {
    id, name, width, height, sha256, byteLength,
    credit: text(credit, 1000), url: webURL(url), license: text(license, 300), collection, tags: tags(sourceTags),
    previewUrl: `/api/materials/${encodeURIComponent(id)}/thumbnail`, imageUrl: `/api/materials/${encodeURIComponent(id)}`,
  };
}

function snapshotFor(entries) {
  // Attribution is part of the reviewed material identity even when the grid
  // only displays its shorter credit line. Collector bookkeeping is excluded.
  const sources = entries.map(entry => ({ ...entry.metadata, ...(entry.provenance ? { provenance: entry.provenance } : {}) }));
  return hash(canonicalJSON({ version: 1, sources }));
}

async function boundedRead(file, limit, label, status) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label} must be a regular file.`, status);
    if (info.size > limit) fail(`${label} exceeds the ${limit / 1024 / 1024} MiB limit.`, status);
    const chunks = [];
    let size = 0;
    while (true) {
      // Read at most one byte beyond the limit, even if a writer grows the file.
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) fail(`${label} exceeds the ${limit / 1024 / 1024} MiB limit.`, status);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await handle?.close(); }
}

/** Read-only bridge between the current studio and the collector's disk library. */
export function createMaterialCatalog({ directory } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('A source-library directory is required.');
  const base = resolve(directory);
  const thumbnails = new Map();
  let thumbnailBytes = 0;

  async function safeFile(relative, label, status) {
    const root = await realpath(base);
    const parts = relative.split('/');
    let path = base;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      const info = await lstat(path);
      if (info.isSymbolicLink()) fail(`${label} cannot be a symbolic link.`, status);
      if (index === parts.length - 1 && !info.isFile()) fail(`${label} must be a regular file.`, status);
      if (index < parts.length - 1 && !info.isDirectory()) fail(`${label} has an invalid asset directory.`, status);
    }
    const file = await realpath(path);
    if (!file.startsWith(root + sep)) fail(`${label} is outside the source library.`, status);
    return file;
  }

  async function readCatalog() {
    let bytes;
    try {
      const file = await safeFile('catalog.json', 'The source catalog', 500);
      bytes = await boundedRead(file, MAX_CATALOG_BYTES, 'The source catalog', 500);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error.status) throw error;
      fail('The source catalog could not be read. Check the local collection directory.');
    }
    let catalog;
    try { catalog = JSON.parse(bytes.toString('utf8')); }
    catch { fail('The source catalog contains invalid JSON. Repair catalog.json before choosing library materials.'); }
    if (!object(catalog) || catalog.version !== 1 || !Array.isArray(catalog.sources)) fail('The source catalog has an unsupported or damaged schema.');
    return catalog.sources;
  }

  async function entries(inventory) {
    if (!Array.isArray(inventory)) fail('The studio inventory must be an array.');
    const result = [];
    const seenHashes = new Set();
    const seenPixels = new Set();
    const seenIDs = new Set();
    for (const source of inventory) {
      if (!object(source) || typeof source.id !== 'string' || !ID.test(source.id) || seenIDs.has(source.id)) fail('The studio inventory contains an invalid or duplicated source ID.');
      seenIDs.add(source.id);
      dimensions(source, `Studio source ${source.id}`);
      const image = decodeInventory(source);
      const sha256 = hash(image.bytes);
      const pixelHash = source.pixelSha256 ?? source.provenance?.pixelSha256;
      if (seenHashes.has(sha256) || (HASH.test(pixelHash) && seenPixels.has(pixelHash))) continue;
      seenHashes.add(sha256);
      if (HASH.test(pixelHash)) seenPixels.add(pixelHash);
      const description = metadata({
        ...source, name: text(source.name, 160) || source.id, sha256, byteLength: image.bytes.length,
        collection: 'Studio', sourceTags: source.tags ?? source.provenance?.tags,
      });
      result.push({ metadata: description, image, provenance: provenance(source.provenance) });
    }
    const catalog = await readCatalog();
    for (const [index, source] of catalog.entries()) {
      const label = `Source catalog entry ${index + 1}`;
      if (!object(source) || source.provider !== 'cleveland' || typeof source.sha256 !== 'string' || !HASH.test(source.sha256)) fail(`${label} has invalid provider or image hash metadata.`);
      if (source.file !== `assets/${source.sha256}.jpg`) fail(`${label} must reference assets/<sha256>.jpg matching its image hash.`);
      dimensions(source, label);
      if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_IMAGE_BYTES) fail(`${label} has an invalid image byte length (16 MiB maximum).`);
      if (!text(source.title, 160)) fail(`${label} needs an image title.`);
      if (source.pixelSha256 !== undefined && (typeof source.pixelSha256 !== 'string' || !HASH.test(source.pixelSha256))) fail(`${label} has an invalid normalized-pixel hash.`);
      if (seenHashes.has(source.sha256) || seenHashes.has(source.pixelSha256) || seenPixels.has(source.pixelSha256)) continue;
      const id = `library-${source.sha256}`;
      if (seenIDs.has(id)) fail('A library image ID conflicts with a studio source ID. Rename that studio source before using the catalog.');
      seenIDs.add(id);
      seenHashes.add(source.sha256);
      if (source.pixelSha256) seenPixels.add(source.pixelSha256);
      const description = metadata({
        ...source, id, name: text(source.title, 160), byteLength: source.bytes,
        collection: 'Cleveland Museum of Art', sourceTags: [...tags(source.tags), text(source.discoveredWith, 80)].filter(Boolean),
      });
      result.push({ metadata: description, file: source.file, provenance: provenance(source) });
    }
    return result;
  }

  async function validatedImage(entry) {
    const source = entry.metadata;
    let image = entry.image;
    if (!image) {
      try {
        const file = await safeFile(entry.file, `Library image ${source.id}`, 409);
        image = { bytes: await boundedRead(file, MAX_IMAGE_BYTES, `Library image ${source.id}`, 409), mime: 'image/jpeg' };
      } catch (error) {
        if (error.status) throw error;
        fail(`Library image ${source.id} is unavailable. Refresh the materials and review your selection.`, 409);
      }
    }
    if (hash(image.bytes) !== source.sha256 || image.bytes.length !== source.byteLength) fail(`Image ${source.id} has changed. Refresh the materials and review your selection.`, 409);
    let info;
    try { info = await getSharp()(image.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata(); }
    catch { fail(`Image ${source.id} could not be opened as a supported raster image.`, 409); }
    if (info.width !== source.width || info.height !== source.height || info.pages > 1
      || !['png', 'jpeg', 'webp'].includes(info.format) || `image/${info.format}` !== image.mime
      || (info.orientation !== undefined && info.orientation !== 1)) fail(`Image ${source.id} has inconsistent dimensions or an unsupported image format.`, 409);
    return image;
  }

  return {
    async list(inventory) {
      const current = await entries(inventory);
      return { sources: current.map(entry => entry.metadata), snapshot: snapshotFor(current) };
    },

    async resolve(inventory, sourceIds, sourceHashes, { snapshot } = {}) {
      if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 24 || sourceIds.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(sourceIds).size !== sourceIds.length) fail('Choose between 1 and 24 different source image IDs in the desired order.', 400);
      if (!object(sourceHashes) || Object.keys(sourceHashes).length !== sourceIds.length
        || sourceIds.some(id => !Object.hasOwn(sourceHashes, id) || typeof sourceHashes[id] !== 'string' || !HASH.test(sourceHashes[id]))) fail('Supply exactly one SHA-256 hash for each selected source image.', 400);
      if (snapshot !== undefined && (typeof snapshot !== 'string' || !HASH.test(snapshot))) fail('Supply a valid source catalog snapshot hash.', 400);
      const current = await entries(inventory);
      if (snapshot !== undefined && snapshotFor(current) !== snapshot) fail('The collection changed. Refresh the materials and review your selection.', 409);
      const available = new Map(current.map(entry => [entry.metadata.id, entry]));
      const selectedEntries = sourceIds.map(id => {
        const entry = available.get(id);
        if (!entry) fail('A selected image is no longer available. Refresh the materials and review your selection.', 409);
        if (entry.metadata.sha256 !== sourceHashes[id]) fail('A selected image has changed. Refresh the materials and review your selection.', 409);
        return entry;
      });
      // Fail before loading or embedding any selected disk image. Per-file
      // integrity checks below verify these advertised lengths against bytes.
      if (selectedEntries.reduce((sum, entry) => sum + entry.metadata.byteLength, 0) > MAX_RUN_BYTES) fail('Selected source images must total no more than 24 MiB.', 400);
      const selected = [];
      for (const entry of selectedEntries) {
        const source = entry.metadata;
        const image = await validatedImage(entry);
        selected.push({
          id: source.id, name: source.name, width: source.width, height: source.height,
          dataUrl: `data:${image.mime};base64,${image.bytes.toString('base64')}`,
          ...(source.credit ? { credit: source.credit } : {}), ...(source.url ? { url: source.url } : {}),
          ...(source.license ? { license: source.license } : {}),
          ...safeMaterialMetadata({ collection: source.collection, tags: source.tags, provenance: entry.provenance }),
        });
      }
      return selected;
    },

    async image(inventory, id, { thumbnail = false } = {}) {
      if (typeof id !== 'string' || !ID.test(id)) fail('Unknown material image.', 404);
      const entry = (await entries(inventory)).find(candidate => candidate.metadata.id === id);
      if (!entry) fail('Unknown material image.', 404);
      // Never let cached thumbnails bypass integrity checks on current disk bytes.
      const image = await validatedImage(entry);
      if (!thumbnail) return { bytes: Buffer.from(image.bytes), mime: image.mime };
      const key = entry.metadata.sha256;
      if (thumbnails.has(key)) {
        const cached = thumbnails.get(key);
        thumbnails.delete(key); thumbnails.set(key, cached);
        return { bytes: Buffer.from(cached), mime: 'image/png' };
      }
      let bytes;
      try { bytes = await getSharp()(image.bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer(); }
      catch { fail(`Image ${id} could not be decoded for its thumbnail.`, 409); }
      // Concurrent requests may have populated this key while sharp was running.
      if (thumbnails.has(key)) { thumbnailBytes -= thumbnails.get(key).length; thumbnails.delete(key); }
      thumbnails.set(key, bytes); thumbnailBytes += bytes.length;
      while (thumbnails.size > 64 || thumbnailBytes > 8 * 1024 * 1024) {
        const oldest = thumbnails.keys().next().value;
        thumbnailBytes -= thumbnails.get(oldest).length;
        thumbnails.delete(oldest);
      }
      return { bytes: Buffer.from(bytes), mime: 'image/png' };
    },
  };
}
