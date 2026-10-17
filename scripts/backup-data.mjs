import { backupDataRoot } from '../lib/data-backup.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Create a verified offline copy of Offcut's durable data.

npm run data:backup -- --from ABS_DIR --out NEW_DIR

Both paths must be absolute. Stop the Offcut server first. The destination
must not exist and must not overlap the source, including through symlinks.
The source is never changed or deleted.`);
  process.exit(0);
}
let from;
let out;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!['--from', '--out'].includes(flag)) throw new Error(`Unknown option: ${flag}. Use --help.`);
  const value = args[++index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs an absolute path.`);
  if (flag === '--from') from = value; else out = value;
}
if (!from || !out) throw new Error('Use --from ABS_DIR --out NEW_DIR.');
const result = await backupDataRoot({ from, out });
console.log(`Verified ${result.manifest.files.length} files.\nBackup: ${result.destination}\nManifest: ${result.destination}/backup-manifest.json`);
