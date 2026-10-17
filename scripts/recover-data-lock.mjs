import { isAbsolute } from 'node:path';
import { recoverStaleDataRootLock } from '../lib/data-root.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Preserve and displace a provably stale local Offcut writer lock.

npm run data:recover-lock -- --data ABS_DIR

Use this only after an unclean shutdown. Recovery succeeds only when the lock
names this machine and its recorded PID is absent. The old lock is preserved.`);
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--data' || !isAbsolute(args[1])) throw new Error('Use --data ABS_DIR.');
const result = await recoverStaleDataRootLock(args[1]);
console.log(`Preserved stale lock from PID ${result.owner.pid}.\n${result.displaced}`);
