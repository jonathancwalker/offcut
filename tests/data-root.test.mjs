import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireDataRoot, readDataRootOwner, recoverStaleDataRootLock, resolveDataRoot, WRITER_LOCK } from '../lib/data-root.mjs';
import { createApp, startServer } from '../server.mjs';

async function workspace(t, prefix = 'offcut-data-root-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('data root selection is absolute and explicit configuration wins', () => {
  assert.equal(resolveDataRoot({ dataDir: './explicit', environmentDataDir: './environment', fallback: './fallback' }), resolve('./explicit'));
  assert.equal(resolveDataRoot({ environmentDataDir: './environment', fallback: './fallback' }), resolve('./environment'));
  assert.equal(resolveDataRoot({ fallback: './fallback' }), resolve('./fallback'));
  assert.throws(() => resolveDataRoot({ dataDir: '', fallback: './fallback' }), { code: 'DATA_ROOT_INVALID' });
});

test('a data root has one owner, release checks its nonce, and distinct roots work', async t => {
  const parent = await workspace(t);
  const firstRoot = join(parent, 'first');
  const secondRoot = join(parent, 'second');
  const first = await acquireDataRoot(firstRoot, { nonce: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(acquireDataRoot(firstRoot), { code: 'DATA_ROOT_LOCKED' });
  const second = await acquireDataRoot(secondRoot);
  await second.release();
  const changed = JSON.parse(await readFile(join(firstRoot, WRITER_LOCK), 'utf8'));
  changed.nonce = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(firstRoot, WRITER_LOCK), JSON.stringify(changed));
  await assert.rejects(first.release(), { code: 'DATA_ROOT_LOCK_CHANGED' });
});

test('stale recovery requires a local absent process and preserves the displaced lock', async t => {
  const parent = await workspace(t);
  const directory = join(parent, 'data');
  const lease = await acquireDataRoot(directory, { host: 'test-host', pid: 424242, nonce: '33333333-3333-4333-8333-333333333333' });
  await assert.rejects(recoverStaleDataRootLock(directory, { host: 'other-host', processAlive: () => false }), { code: 'DATA_ROOT_LOCK_REMOTE' });
  await assert.rejects(recoverStaleDataRootLock(directory, { host: 'test-host', processAlive: () => true }), { code: 'DATA_ROOT_LOCKED' });
  const recovered = await recoverStaleDataRootLock(directory, { host: 'test-host', processAlive: () => false, clock: () => new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(recovered.owner.pid, 424242);
  assert.deepEqual(JSON.parse(await readFile(recovered.displaced, 'utf8')), lease.owner);
  assert.equal(await readDataRootOwner(directory), null);
});

test('servers reject shared roots, accept distinct roots, and release ownership after failed initialization', async t => {
  const parent = await workspace(t);
  const shared = join(parent, 'shared');
  const other = join(parent, 'other');
  const first = await startServer({ port: 0, dataDir: shared, persist: false, initialSources: [] });
  try {
    await assert.rejects(startServer({ port: 0, dataDir: shared, persist: false, initialSources: [] }), { code: 'DATA_ROOT_LOCKED' });
    const second = await startServer({ port: 0, dataDir: other, persist: false, initialSources: [] });
    await second.close();
  } finally { await first.close(); }

  const brokenPublic = join(parent, 'not-a-directory');
  const failedRoot = join(parent, 'failed');
  await writeFile(brokenPublic, 'file');
  await assert.rejects(createApp({ publicDir: brokenPublic, dataDir: failedRoot, persist: false }));
  assert.equal(await readDataRootOwner(failedRoot), null);

  const recoveredRoot = join(parent, 'failed-after-run-recovery');
  const invalidBatch = join(recoveredRoot, 'batches', 'batch-11111111-1111-4111-8111-111111111111');
  await mkdir(invalidBatch, { recursive: true });
  await writeFile(join(invalidBatch, 'batch.json'), '{}');
  await assert.rejects(createApp({ dataDir: recoveredRoot, persist: false, initialSources: [] }), /invalid batch record/);
  assert.equal(await readDataRootOwner(recoveredRoot), null);
});

test('an explicit server data root ignores OFFCUT_DATA_DIR', async t => {
  const parent = await workspace(t);
  const explicit = join(parent, 'explicit');
  const environment = join(parent, 'environment');
  const previous = process.env.OFFCUT_DATA_DIR;
  process.env.OFFCUT_DATA_DIR = environment;
  t.after(() => previous === undefined ? delete process.env.OFFCUT_DATA_DIR : process.env.OFFCUT_DATA_DIR = previous);
  const app = await startServer({ port: 0, dataDir: explicit, persist: false, initialSources: [] });
  assert.equal(app.dataDir, explicit);
  assert.ok(await readDataRootOwner(explicit));
  assert.equal(await readDataRootOwner(environment), null);
  await app.close();
});
