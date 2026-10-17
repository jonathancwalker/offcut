import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const WRITER_LOCK = '.offcut-writer.lock';
const RECOVERY_LOCK = '.offcut-writer-recovery.lock';

function dataRootError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveDataRoot({ dataDir, environmentDataDir, fallback }) {
  const selected = dataDir ?? environmentDataDir ?? fallback;
  if (typeof selected !== 'string' || !selected.trim()) throw dataRootError('Offcut needs a data directory.', 'DATA_ROOT_INVALID');
  return resolve(selected);
}

export async function prepareDataRoot(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw dataRootError('The Offcut data directory must be an absolute path.', 'DATA_ROOT_INVALID');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await stat(directory);
  if (!details.isDirectory()) throw dataRootError(`The Offcut data path is not a directory: ${directory}`, 'DATA_ROOT_INVALID');
  return directory;
}

export async function readDataRootOwner(directory) {
  try {
    return JSON.parse(await readFile(join(directory, WRITER_LOCK), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw dataRootError(`The writer lock in ${directory} is unreadable. Recover it only after proving no Offcut process owns it.`, 'DATA_ROOT_LOCK_INVALID');
    throw error;
  }
}

function validOwner(owner) {
  return owner?.format === 'offcut-writer-lock' && owner.version === 1 &&
    typeof owner.hostname === 'string' && Number.isInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.nonce === 'string' && owner.nonce.length >= 16 && typeof owner.startedAt === 'string';
}

export async function acquireDataRoot(directory, { host = hostname(), pid = process.pid, nonce = randomUUID(), clock = () => new Date() } = {}) {
  await prepareDataRoot(directory);
  const path = join(directory, WRITER_LOCK);
  const owner = { format: 'offcut-writer-lock', version: 1, hostname: host, pid, nonce, startedAt: clock().toISOString() };
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
    await handle.sync();
  } catch (error) {
    if (handle) await unlink(path).catch(() => {});
    if (error.code === 'EEXIST') {
      const existing = await readDataRootOwner(directory).catch(() => null);
      const detail = validOwner(existing) ? ` It belongs to PID ${existing.pid} on ${existing.hostname}, started ${existing.startedAt}.` : '';
      throw dataRootError(`Offcut data is already owned by another server: ${directory}.${detail}`, 'DATA_ROOT_LOCKED');
    }
    throw error;
  } finally {
    await handle?.close();
  }

  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      const current = await readDataRootOwner(directory);
      if (!current) { released = true; return; }
      if (current.nonce !== nonce) throw dataRootError(`Refusing to release a writer lock this process does not own: ${path}`, 'DATA_ROOT_LOCK_CHANGED');
      await unlink(path);
      released = true;
    },
  };
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function recoverStaleDataRootLock(directory, { host = hostname(), processAlive = defaultProcessAlive, clock = () => new Date() } = {}) {
  await prepareDataRoot(directory);
  const writerPath = join(directory, WRITER_LOCK);
  const recoveryPath = join(directory, RECOVERY_LOCK);
  let guard;
  try {
    guard = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw dataRootError('Writer-lock recovery is already in progress.', 'DATA_ROOT_RECOVERY_LOCKED');
    throw error;
  }
  try {
    const owner = await readDataRootOwner(directory);
    if (!owner) throw dataRootError(`No writer lock exists in ${directory}.`, 'DATA_ROOT_LOCK_MISSING');
    if (!validOwner(owner)) throw dataRootError('The writer lock is malformed, so Offcut cannot prove which process owns it.', 'DATA_ROOT_LOCK_INVALID');
    if (owner.hostname !== host) throw dataRootError(`The writer lock belongs to ${owner.hostname}; this machine cannot prove that process is absent.`, 'DATA_ROOT_LOCK_REMOTE');
    if (processAlive(owner.pid)) throw dataRootError(`Offcut PID ${owner.pid} is still running on this machine.`, 'DATA_ROOT_LOCKED');
    const stamp = clock().toISOString().replace(/[:.]/g, '-');
    const displaced = join(directory, `${WRITER_LOCK}.stale-${stamp}-${owner.nonce}.json`);
    await rename(writerPath, displaced);
    return { owner, displaced };
  } finally {
    await guard.close();
    await unlink(recoveryPath);
  }
}
