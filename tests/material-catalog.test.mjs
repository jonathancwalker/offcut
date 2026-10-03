import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { getSharp } from '../lib/render.mjs';
import { createMaterialCatalog, safeMaterialMetadata } from '../lib/material-catalog.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = sources => Object.fromEntries(sources.map(source => [source.id, source.sha256]));
const status = (code, pattern) => error => error.status === code && (!pattern || pattern.test(error.message));
const jpeg = async (color = '#cf4825', width = 600, height = 400) => getSharp()({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 88 }).toBuffer();

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-material-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  return { directory, catalog: createMaterialCatalog({ directory }) };
}

async function inventorySource(id = 'studio-one', color = '#344d9a') {
  const bytes = await getSharp()({ create: { width: 640, height: 480, channels: 4, background: color } }).png({ compressionLevel: 8 }).toBuffer();
  return { id, name: 'Studio image', width: 640, height: 480, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, credit: 'Studio credit', url: 'https://example.com/source', license: 'CC0' };
}

async function record(bytes, overrides = {}) {
  const info = await getSharp()(bytes).metadata();
  const sha256 = hash(bytes);
  const png = await getSharp()(bytes).rotate().png({ compressionLevel: 8 }).toBuffer();
  return {
    provider: 'cleveland', recordId: '123', title: 'Collected image', creator: 'Fixture artist', date: '1900',
    credit: 'Fixture artist; The Cleveland Museum of Art', license: 'CC0 1.0',
    url: 'https://clevelandart.org/art/123', rightsUrl: 'https://clevelandart.org/art/123',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://openaccess-api.clevelandart.org/' },
    downloadUrl: 'https://openaccess-cdn.clevelandart.org/123.jpg',
    file: `assets/${sha256}.jpg`, sha256, pixelSha256: hash(png), originalSha256: hash(bytes),
    width: info.width, height: info.height, bytes: bytes.length, collectedAt: '2026-10-02T12:00:00.000Z',
    discoveredWith: 'birds', tags: ['Print', 'Japanese Art'],
    normalization: { maxEdge: 1000, format: 'jpeg', quality: 88, fullImage: true },
    ...overrides,
  };
}

async function writeCatalog(directory, sources, extra = {}) {
  await writeFile(join(directory, 'catalog.json'), JSON.stringify({ version: 1, sources, records: {}, ...extra }));
}

async function saveImage(directory, bytes, overrides) {
  const source = await record(bytes, overrides);
  await writeFile(join(directory, source.file), bytes);
  return source;
}

test('an absent library lists current inventory and returns independent images without writing or mutating it', async t => {
  const { directory } = await setup(t);
  const absent = join(directory, 'not-created');
  const catalog = createMaterialCatalog({ directory: absent });
  const source = Object.freeze(await inventorySource());
  const inventory = Object.freeze([source]);
  const before = JSON.stringify(inventory);
  const listed = await catalog.list(inventory);
  assert.equal(listed.sources.length, 1);
  assert.match(listed.snapshot, /^[a-f0-9]{64}$/);
  assert.equal(listed.sources[0].collection, 'Studio');
  assert.equal(listed.sources[0].dataUrl, undefined);
  assert.equal(listed.sources[0].previewUrl, '/api/materials/studio-one/thumbnail');
  assert.equal(listed.sources[0].imageUrl, '/api/materials/studio-one');
  const resolved = await catalog.resolve(inventory, [source.id], hashes(listed.sources));
  assert.equal(resolved[0].dataUrl, source.dataUrl);
  resolved[0].name = 'Changed returned copy';
  assert.equal(JSON.stringify(inventory), before);
  const image = await catalog.image(inventory, source.id);
  assert.equal(image.mime, 'image/png');
  assert.equal(hash(image.bytes), listed.sources[0].sha256);
  const thumb = await catalog.image(inventory, source.id, { thumbnail: true });
  const info = await getSharp()(thumb.bytes).metadata();
  assert.deepEqual([info.width, info.height], [360, 270]);
  thumb.bytes.fill(0);
  assert.equal((await getSharp()((await catalog.image(inventory, source.id, { thumbnail: true })).bytes).metadata()).width, 360);
  await assert.rejects(stat(absent), error => error.code === 'ENOENT');
  assert.equal((await catalog.list(inventory)).snapshot, listed.snapshot);
});

test('a catalog can list more than 24 images using metadata alone, without any asset files', async t => {
  const { directory, catalog } = await setup(t);
  const fixture = await record(await jpeg());
  const sources = Array.from({ length: 80 }, (_, index) => {
    const sha256 = hash(`metadata-only-${index}`);
    return { ...fixture, sha256, pixelSha256: hash(`pixels-${index}`), file: `assets/${sha256}.jpg`, title: `Image ${index}` };
  });
  await writeCatalog(directory, sources);
  const listed = await catalog.list([]);
  assert.equal(listed.sources.length, 80);
  assert.equal(listed.sources[79].name, 'Image 79');
  assert.equal(listed.sources[0].byteLength, fixture.bytes);
  await assert.rejects(catalog.image([], listed.sources[0].id), status(409, /unavailable/));
});

test('selection count and total byte limits fail before reading any missing image assets', async t => {
  const { directory, catalog } = await setup(t);
  const fixture = await record(await jpeg());
  const records = Array.from({ length: 25 }, (_, index) => {
    const sha256 = hash(`bounded-selection-${index}`);
    return { ...fixture, sha256, pixelSha256: hash(`bounded-pixels-${index}`), file: `assets/${sha256}.jpg`, bytes: 13 * 1024 * 1024 };
  });
  await writeCatalog(directory, records);
  const listed = await catalog.list([]);
  await assert.rejects(catalog.resolve([], listed.sources.map(source => source.id), hashes(listed.sources)), status(400, /1 and 24/));
  const tooManyBytes = listed.sources.slice(0, 2);
  await assert.rejects(catalog.resolve([], tooManyBytes.map(source => source.id), hashes(tooManyBytes)), status(400, /24 MiB/));
  const withinLimits = listed.sources.slice(0, 1);
  await assert.rejects(catalog.resolve([], withinLimits.map(source => source.id), hashes(withinLimits)), status(409, /unavailable/));
});

test('mixed selections preserve order and exact JPEG bytes, with bounded public attribution and provenance', async t => {
  const { directory, catalog } = await setup(t);
  const firstBytes = await jpeg();
  const first = await saveImage(directory, firstBytes, {
    title: 'X'.repeat(250), credit: 'C'.repeat(1400), license: 'L'.repeat(400),
    tags: Array.from({ length: 60 }, (_, i) => `${i}-` + 't'.repeat(100)),
    secret: 'must not appear', privatePath: '/private/local-secret', jobId: 'private-job',
    rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://example.com/policy', privatePath: '/private/evidence' },
    normalization: { maxEdge: 1000, format: 'jpeg', quality: 88, fullImage: true, command: 'unsafe' },
    alsoCatalogedAs: [{ provider: 'cleveland', recordId: '456', title: 'Alias', url: 'https://example.com/alias', file: '/private/alias' }],
  });
  const second = await saveImage(directory, await jpeg('#e3c738'));
  await writeCatalog(directory, [first, second]);
  const inventory = [await inventorySource()];
  const before = JSON.stringify(inventory);
  const listed = await catalog.list(inventory);
  const firstID = `library-${first.sha256}`, secondID = `library-${second.sha256}`;
  const ids = [secondID, inventory[0].id, firstID];
  const selectedHashes = Object.fromEntries(ids.map(id => [id, listed.sources.find(source => source.id === id).sha256]));
  const selected = await catalog.resolve(inventory, ids, selectedHashes);
  assert.deepEqual(selected.map(source => source.id), ids);
  assert.equal(selected[2].dataUrl, `data:image/jpeg;base64,${firstBytes.toString('base64')}`);
  assert.equal(selected[2].name.length, 160);
  assert.equal(selected[2].credit.length, 1000);
  assert.equal(selected[2].license.length, 300);
  assert.equal(selected[2].provenance.creator, 'Fixture artist');
  assert.equal(selected[2].collection, 'Cleveland Museum of Art');
  assert.equal(selected[1].collection, 'Studio');
  assert.equal(selected[2].tags.length, 32);
  assert.equal(selected[2].provenance.rightsEvidence.share_license_status, 'CC0');
  assert.equal(selected[2].provenance.sha256, first.sha256);
  assert.deepEqual(selected[2].provenance.normalization, { maxEdge: 1000, format: 'jpeg', quality: 88, fullImage: true });
  assert.equal(listed.sources[1].tags.length, 32);
  assert.ok(listed.sources[1].tags.every(tag => tag.length <= 80));
  assert.ok(!JSON.stringify({ selected, listed }).includes('/private/'));
  assert.ok(!JSON.stringify({ selected, listed }).includes('private-job'));
  assert.ok(!JSON.stringify({ selected, listed }).includes('must not appear'));
  assert.ok(!JSON.stringify(listed).includes('assets/'));
  assert.equal(JSON.stringify(inventory), before);
  const image = await catalog.image(inventory, firstID);
  assert.equal(image.mime, 'image/jpeg');
  assert.deepEqual(image.bytes, firstBytes);
});

test('exact bytes and collector normalized-PNG hashes deduplicate in favor of existing studio IDs', async t => {
  const { directory, catalog } = await setup(t);
  const bytes = await jpeg();
  const item = await record(bytes);
  // No JPEG asset is needed: metadata knows this is already present as a PNG.
  await writeCatalog(directory, [item]);
  const png = await getSharp()(bytes).rotate().png({ compressionLevel: 8 }).toBuffer();
  const inventory = [{ id: 'already-imported', name: 'Existing', width: item.width, height: item.height, dataUrl: `data:image/png;base64,${png.toString('base64')}` }];
  const listed = await catalog.list(inventory);
  assert.deepEqual(listed.sources.map(source => source.id), ['already-imported']);
  assert.equal(listed.sources[0].sha256, item.pixelSha256);
  assert.equal((await catalog.resolve(inventory, ['already-imported'], hashes(listed.sources)))[0].dataUrl, inventory[0].dataUrl);
  const exact = [{ ...inventory[0], dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` }];
  assert.deepEqual((await catalog.list(exact)).sources.map(source => source.id), ['already-imported']);
  assert.deepEqual((await catalog.list([...inventory, { ...inventory[0], id: 'duplicate-studio' }])).sources.map(source => source.id), ['already-imported']);
  await writeCatalog(directory, [item, { ...item, title: 'Another record' }]);
  assert.equal((await catalog.list([])).sources.length, 1);
});

test('resolution rejects changed assets even after preview caching, and never changes library bytes', async t => {
  const { directory, catalog } = await setup(t);
  const bytes = await jpeg();
  const item = await saveImage(directory, bytes);
  await writeCatalog(directory, [item]);
  const listed = await catalog.list([]);
  const id = listed.sources[0].id;
  const before = await readFile(join(directory, 'catalog.json'));
  const preview = await catalog.image([], id, { thumbnail: true });
  assert.equal((await getSharp()(preview.bytes).metadata()).width, 360);
  await catalog.resolve([], [id], hashes(listed.sources));
  assert.deepEqual(await readFile(join(directory, item.file)), bytes);
  assert.deepEqual(await readFile(join(directory, 'catalog.json')), before);
  await writeFile(join(directory, item.file), await jpeg('#3f5425'));
  await assert.rejects(catalog.resolve([], [id], hashes(listed.sources)), status(409, /changed/));
  await assert.rejects(catalog.image([], id, { thumbnail: true }), status(409, /changed/));
});

test('source IDs and hashes are exact, and each call uses the supplied current inventory', async t => {
  const { catalog } = await setup(t);
  const inventory = [await inventorySource()];
  const listed = await catalog.list(inventory);
  const [source] = listed.sources;
  await assert.rejects(catalog.resolve(inventory, [source.id, source.id], hashes(listed.sources)), status(400, /different/));
  await assert.rejects(catalog.resolve(inventory, [source.id], { ...hashes(listed.sources), extra: source.sha256 }), status(400, /exactly one/));
  await assert.rejects(catalog.resolve(inventory, [source.id], { [source.id]: 'bad' }), status(400, /SHA-256/));
  await assert.rejects(catalog.resolve(inventory, [source.id], { [source.id]: hash('outdated') }), status(409, /changed/));
  await assert.rejects(catalog.resolve([], [source.id], hashes(listed.sources)), status(409, /no longer available/));
  const changed = [await inventorySource(source.id, '#efff22')];
  await assert.rejects(catalog.resolve(changed, [source.id], hashes(listed.sources)), status(409, /changed/));
  await assert.rejects(catalog.image(inventory, '../catalog.json'), status(404));
  await assert.rejects(catalog.image([], source.id), status(404));
});

test('malformed, oversized and invalid catalog metadata surfaces useful errors', async t => {
  const { directory, catalog } = await setup(t);
  await writeFile(join(directory, 'catalog.json'), '{"sources":');
  await assert.rejects(catalog.list([]), status(500, /invalid JSON/));
  await writeCatalog(directory, [], { version: 999 });
  await assert.rejects(catalog.list([]), status(500, /schema/));
  await writeFile(join(directory, 'catalog.json'), ' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(catalog.list([]), status(500, /16 MiB/));
  const item = await record(await jpeg());
  for (const update of [{ width: 0 }, { width: 8192, height: 8192 }, { bytes: 0 }, { bytes: 16 * 1024 * 1024 + 1 }, { pixelSha256: 'bad' }, { sha256: 'bad' }, { provider: 'unknown' }]) {
    await writeCatalog(directory, [{ ...item, ...update }]);
    await assert.rejects(catalog.list([]), status(500, /catalog entry 1/));
  }
});

test('catalog asset paths reject traversal, alternate files and URLs before opening images', async t => {
  const { directory, catalog } = await setup(t);
  const item = await record(await jpeg());
  for (const file of ['../outside.jpg', '/private/outside.jpg', 'assets/../outside.jpg', 'https://example.com/image.jpg', `assets/${hash('wrong-file')}.jpg`, `assets/${item.sha256}.png`]) {
    await writeCatalog(directory, [{ ...item, file }]);
    await assert.rejects(catalog.list([]), status(500, /assets\/<sha256>\.jpg/));
  }
});

test('catalog files, assets and asset directories cannot escape through symbolic links', async t => {
  const { directory, catalog } = await setup(t);
  const bytes = await jpeg();
  const item = await record(bytes);
  const outside = await mkdtemp(join(tmpdir(), 'offcut-material-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideImage = join(outside, `${item.sha256}.jpg`);
  await writeFile(outsideImage, bytes);
  await writeCatalog(directory, [item]);
  const listed = await catalog.list([]);
  const id = listed.sources[0].id;
  await symlink(outsideImage, join(directory, item.file));
  await assert.rejects(catalog.resolve([], [id], hashes(listed.sources)), status(409, /symbolic link/));
  await rm(join(directory, 'assets'), { recursive: true });
  await symlink(outside, join(directory, 'assets'));
  await assert.rejects(catalog.image([], id), status(409, /symbolic link/));
  await writeCatalog(outside, [item]);
  await rm(join(directory, 'catalog.json'));
  await symlink(join(outside, 'catalog.json'), join(directory, 'catalog.json'));
  await assert.rejects(catalog.list([]), status(500, /symbolic link/));
});

test('catalog and image paths must refer to regular files', async t => {
  const { directory, catalog } = await setup(t);
  await mkdir(join(directory, 'catalog.json'));
  await assert.rejects(catalog.list([]), status(500, /regular file/));
  await rm(join(directory, 'catalog.json'), { recursive: true });
  const item = await record(await jpeg());
  await writeCatalog(directory, [item]);
  await mkdir(join(directory, item.file));
  const listed = await catalog.list([]);
  await assert.rejects(catalog.resolve([], [listed.sources[0].id], hashes(listed.sources)), status(409, /regular file/));
});

test('selected files validate dimensions, encoding and size without normalizing the stored bytes', async t => {
  const { directory, catalog } = await setup(t);
  const bytes = await jpeg();
  const item = await saveImage(directory, bytes);
  for (const update of [{ width: item.width + 1 }, { bytes: item.bytes + 1 }]) {
    await writeCatalog(directory, [{ ...item, ...update }]);
    const listed = await catalog.list([]);
    await assert.rejects(catalog.resolve([], [listed.sources[0].id], hashes(listed.sources)), status(409, /dimensions|changed/));
  }
  const png = await getSharp()(bytes).png().toBuffer();
  const pngRecord = await saveImage(directory, png);
  await writeCatalog(directory, [pngRecord]);
  let listed = await catalog.list([]);
  await assert.rejects(catalog.resolve([], [listed.sources[0].id], hashes(listed.sources)), status(409, /unsupported image format/));
  await writeCatalog(directory, [item]);
  await writeFile(join(directory, item.file), Buffer.alloc(16 * 1024 * 1024 + 1));
  listed = await catalog.list([]);
  await assert.rejects(catalog.resolve([], [listed.sources[0].id], hashes(listed.sources)), status(409, /16 MiB/));
  const invalid = Buffer.from('This is not a JPEG.');
  const invalidHash = hash(invalid);
  const invalidRecord = { ...item, sha256: invalidHash, file: `assets/${invalidHash}.jpg`, bytes: invalid.length };
  await writeFile(join(directory, invalidRecord.file), invalid);
  await writeCatalog(directory, [invalidRecord]);
  listed = await catalog.list([]);
  await assert.rejects(catalog.resolve([], [listed.sources[0].id], hashes(listed.sources)), status(409, /could not be opened/));
});

test('snapshot hashes preserve source order and public metadata while ignoring private collector bookkeeping', async t => {
  const { directory, catalog } = await setup(t);
  const first = await record(await jpeg());
  const second = await record(await jpeg('#236faa'));
  await writeCatalog(directory, [first, second]);
  const original = await catalog.list([]);
  const reorderedKeys = source => Object.fromEntries(Object.entries(source).reverse());
  await writeCatalog(directory, [reorderedKeys({ ...first, jobId: 'another-job' }), reorderedKeys(second)], { records: { new: 'bookkeeping' } });
  assert.equal((await catalog.list([])).snapshot, original.snapshot);
  await writeCatalog(directory, [second, first]);
  assert.notEqual((await catalog.list([])).snapshot, original.snapshot);
  await writeCatalog(directory, [{ ...first, title: 'Revised title' }, second]);
  assert.notEqual((await catalog.list([])).snapshot, original.snapshot);
  await writeCatalog(directory, [{ ...first, tags: ['New pool filter'] }, second]);
  assert.notEqual((await catalog.list([])).snapshot, original.snapshot);
  await writeCatalog(directory, [{ ...first, creator: 'New attribution' }, second]);
  assert.notEqual((await catalog.list([])).snapshot, original.snapshot);
});

test('optional snapshot validation binds resolution to the reviewed catalog metadata and provenance', async t => {
  const { directory, catalog } = await setup(t);
  const item = await saveImage(directory, await jpeg());
  await writeCatalog(directory, [item]);
  const reviewed = await catalog.list([]);
  const [id] = reviewed.sources.map(source => source.id);
  const sourceHashes = hashes(reviewed.sources);
  assert.equal((await catalog.resolve([], [id], sourceHashes, { snapshot: reviewed.snapshot }))[0].name, item.title);
  await writeCatalog(directory, [{ ...item, title: 'Updated after review' }]);
  await assert.rejects(catalog.resolve([], [id], sourceHashes, { snapshot: reviewed.snapshot }), status(409, /collection changed/));
  assert.equal((await catalog.resolve([], [id], sourceHashes))[0].name, 'Updated after review');
  await writeCatalog(directory, [{ ...item, creator: 'Updated provenance only' }]);
  await assert.rejects(catalog.resolve([], [id], sourceHashes, { snapshot: reviewed.snapshot }), status(409, /collection changed/));
  const latest = await catalog.list([]);
  assert.equal((await catalog.resolve([], [id], sourceHashes, { snapshot: latest.snapshot }))[0].provenance.creator, 'Updated provenance only');
  await assert.rejects(catalog.resolve([], [id], sourceHashes, { snapshot: 'invalid' }), status(400, /snapshot hash/));
});

test('run-manifest metadata helper bounds nested values, excludes arbitrary keys and rejects non-finite numbers', () => {
  const input = {
    collection: 'Cleveland Museum of Art', tags: Array.from({ length: 50 }, (_, i) => `${i}-` + 'x'.repeat(100)),
    privatePath: '/private/input', provenance: {
      creator: 'A'.repeat(1500), title: 'T'.repeat(200), credit: 'C'.repeat(1500), date: 'D'.repeat(200),
      provider: 'P'.repeat(100), recordId: 'R'.repeat(200), collectedAt: 'W'.repeat(100), discoveredWith: 'Q'.repeat(200),
      url: 'file:///private/input', rightsUrl: 'https://name:password@example.com/secret', licenseUrl: 'https://example.com/license',
      sha256: hash('image'), pixelSha256: 'invalid', rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://example.com/policy', private: 'secret' },
      normalization: { maxEdge: Infinity, quality: NaN, fullImage: true, format: 'jpeg', arbitrary: 'secret' },
      alsoCatalogedAs: Array.from({ length: 50 }, (_, i) => ({ recordId: String(i), file: '/private/alias', title: 'Z'.repeat(200) })),
      file: '/private/image', arbitrary: { secret: 'secret' },
    },
  };
  const safe = safeMaterialMetadata(input);
  assert.deepEqual(Object.keys(safe), ['collection', 'tags', 'provenance']);
  assert.equal(safe.tags.length, 32);
  assert.equal(safe.provenance.creator.length, 1000);
  assert.equal(safe.provenance.title.length, 160);
  assert.equal(safe.provenance.credit.length, 1000);
  assert.equal(safe.provenance.date.length, 160);
  assert.equal(safe.provenance.provider.length, 80);
  assert.equal(safe.provenance.recordId.length, 100);
  assert.equal(safe.provenance.collectedAt.length, 80);
  assert.equal(safe.provenance.discoveredWith.length, 100);
  assert.deepEqual(safe.provenance.normalization, { format: 'jpeg', fullImage: true });
  assert.equal(safe.provenance.alsoCatalogedAs.length, 32);
  assert.ok(safe.provenance.alsoCatalogedAs.every(alias => alias.title.length <= 160));
  assert.ok(!JSON.stringify(safe).includes('/private/'));
  assert.ok(!JSON.stringify(safe).includes('secret'));
  assert.ok(!JSON.stringify(safe).includes('null'));
  assert.equal(safe.provenance.url, undefined);
  assert.equal(safe.provenance.rightsUrl, undefined);
  assert.equal(safe.provenance.pixelSha256, undefined);
  assert.deepEqual(safeMaterialMetadata({ collection: 'Unapproved', provenance: { file: '/tmp/image' } }), {});
  assert.deepEqual(safeMaterialMetadata(null), {});
});

test('concurrent thumbnail requests for one image preserve a usable bounded cache', async t => {
  const { catalog } = await setup(t);
  const bytes = await getSharp()(randomBytes(360 * 360 * 3), { raw: { width: 360, height: 360, channels: 3 } }).png().toBuffer();
  const source = { id: 'noisy', name: 'Noise fixture', width: 360, height: 360, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  const images = await Promise.all(Array.from({ length: 32 }, () => catalog.image([source], source.id, { thumbnail: true })));
  assert.ok(images.every(image => image.mime === 'image/png' && image.bytes.equals(images[0].bytes)));
  assert.deepEqual((await catalog.image([source], source.id, { thumbnail: true })).bytes, images[0].bytes);
});
