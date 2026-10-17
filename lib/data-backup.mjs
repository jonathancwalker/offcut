import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireDataRoot } from './data-root.mjs';

const INCLUDED_ROOTS = new Set(['runs', 'batches', 'source-library', 'studies', 'campaigns', 'annotations', 'analysis']);
const INCLUDED_FILES = new Set(['session.json']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};

async function canonicalMissingPath(path) {
  let cursor = path;
  const suffix = [];
  while (true) {
    try { return resolve(await realpath(cursor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function selectedFiles(source) {
  const files = [];
  async function walk(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Backup refuses symbolic links inside data: ${relativePath}`);
      if (entry.isDirectory()) await walk(fullPath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && (INCLUDED_ROOTS.has(entry.name) || INCLUDED_FILES.has(entry.name))) throw new Error(`Backup refuses symbolic links inside data: ${entry.name}`);
    if (entry.isDirectory() && INCLUDED_ROOTS.has(entry.name)) await walk(join(source, entry.name), entry.name);
    if (entry.isFile() && (INCLUDED_FILES.has(entry.name) || /^session-recovery-\d+\.json$/.test(entry.name))) files.push(entry.name);
  }
  return files.sort();
}

export async function backupDataRoot({ from, out, clock = () => new Date() } = {}) {
  if (!isAbsolute(from || '') || !isAbsolute(out || '')) throw new Error('Backup paths must be absolute. Use --from ABS_DIR --out NEW_DIR.');
  const source = await realpath(from);
  if (!(await stat(source)).isDirectory()) throw new Error(`Backup source is not a directory: ${source}`);
  const destination = await canonicalMissingPath(out);
  if (inside(source, destination) || inside(destination, source)) throw new Error('Backup source and destination must not overlap, including through symbolic links.');
  try { await lstat(out); throw new Error(`Backup destination already exists: ${out}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.offcut-backup-${randomUUID()}.pending`);
  let lease;
  try {
    try { lease = await acquireDataRoot(source); }
    catch (error) {
      if (error.code === 'DATA_ROOT_LOCKED' || error.code === 'DATA_ROOT_LOCK_INVALID') throw new Error(`Backup requires a stopped server; ${source} has an Offcut writer lock.`, { cause: error });
      throw error;
    }
    const files = await selectedFiles(source);
    const manifest = { format: 'offcut-data-backup', version: 1, createdAt: clock().toISOString(), files: [] };
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const path of files) {
        const input = join(source, ...path.split('/'));
        const output = join(staging, ...path.split('/'));
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await copyFile(input, output);
        const bytes = await readFile(input);
        manifest.files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      }
      await writeFile(join(staging, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      for (const expected of manifest.files) {
        const bytes = await readFile(join(staging, ...expected.path.split('/')));
        if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Backup verification failed for ${expected.path}.`);
      }
      await rename(staging, destination);
      return { destination, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } finally { await lease?.release(); }
}
