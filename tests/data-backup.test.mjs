import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDataRoot } from '../lib/data-backup.mjs';
import { acquireDataRoot } from '../lib/data-root.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'offcut-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('backup copies durable records, hashes them in sorted order, and leaves transient files out', async t => {
  const parent = await workspace(t);
  const source = join(parent, 'source');
  const out = join(parent, 'copy');
  await mkdir(join(source, 'runs', 'run-b'), { recursive: true });
  await mkdir(join(source, 'source-library'), { recursive: true });
  await writeFile(join(source, 'session.json'), '{"saved":true}\n');
  await writeFile(join(source, 'runs', 'run-b', 'summary.json'), '{"id":"run-b"}\n');
  await writeFile(join(source, 'source-library', 'catalog.json'), '{"version":1}\n');
  await writeFile(join(source, '.session-temporary.tmp'), 'exclude');
  const result = await backupDataRoot({ from: source, out, clock: () => new Date('2026-02-03T04:05:06.000Z') });
  assert.deepEqual(result.manifest.files.map(file => file.path), ['runs/run-b/summary.json', 'session.json', 'source-library/catalog.json']);
  assert.equal((await readFile(join(out, 'session.json'), 'utf8')), '{"saved":true}\n');
  await assert.rejects(readFile(join(out, '.session-temporary.tmp')), error => error.code === 'ENOENT');
  assert.deepEqual(JSON.parse(await readFile(join(out, 'backup-manifest.json'), 'utf8')), result.manifest);
  assert.ok(result.manifest.files.every(file => file.sha256.length === 64 && file.bytes > 0));
  await assert.rejects(backupDataRoot({ from: source, out }), /already exists/);
});

test('backup refuses active data and overlapping paths through symlinks', async t => {
  const parent = await workspace(t);
  const source = join(parent, 'source');
  await mkdir(source);
  const lease = await acquireDataRoot(source);
  await assert.rejects(backupDataRoot({ from: source, out: join(parent, 'active-copy') }), /stopped server/);
  await lease.release();

  await assert.rejects(backupDataRoot({ from: source, out: join(source, 'nested-copy') }), /must not overlap/);
  const alias = join(parent, 'source-alias');
  await symlink(source, alias);
  await assert.rejects(backupDataRoot({ from: source, out: join(alias, 'alias-copy') }), /must not overlap/);
  assert.deepEqual((await readdir(parent)).sort(), ['source', 'source-alias']);
});

test('backup refuses symbolic links in included durable trees', async t => {
  const parent = await workspace(t);
  const source = join(parent, 'source');
  const external = join(parent, 'external.json');
  await mkdir(join(source, 'runs'), { recursive: true });
  await writeFile(external, '{}');
  await symlink(external, join(source, 'runs', 'linked.json'));
  await assert.rejects(backupDataRoot({ from: source, out: join(parent, 'copy') }), /refuses symbolic links/);
});
