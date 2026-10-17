import { resolve } from 'node:path';
import { verifyStudyExport } from '../lib/study-export.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Verify a portable Offcut Study exhibit.\n\nnpm run studies:verify -- --export ABS_DIR');
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--export' || !args[1]) throw new Error('Use --export ABS_DIR.');
const result = await verifyStudyExport(resolve(args[1]));
console.log(`Verified ${result.cells} cells, ${result.attempted} attempted works, and ${result.assets} assets for ${result.studyId}.`);
