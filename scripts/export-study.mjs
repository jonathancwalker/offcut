import { resolve } from 'node:path';
import { exportStudy } from '../lib/study-export.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Create a portable, provider-free Offcut Study exhibit.\n\nnpm run studies:export -- --data ABS_ROOT --study STUDY_ID --out NEW_DIR [--analysis DIR] [--annotations DIR]');
  process.exit(0);
}
const values = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!['--data', '--study', '--out', '--analysis', '--annotations'].includes(flag) || !value || value.startsWith('--')) throw new Error('Use --data, --study, --out, and optional --analysis/--annotations.');
  if (Object.hasOwn(values, flag)) throw new Error(`Duplicate option ${flag}.`);
  values[flag] = value;
}
if (!values['--data'] || !values['--study'] || !values['--out']) throw new Error('--data, --study, and --out are required.');
const result = await exportStudy({
  dataDir: resolve(values['--data']), studyId: values['--study'], outDir: resolve(values['--out']),
  ...(values['--analysis'] ? { analysisDir: resolve(values['--analysis']) } : {}),
  ...(values['--annotations'] ? { annotationsDir: resolve(values['--annotations']) } : {}),
});
console.log(`Exported ${result.cells} cells, ${result.attempted} attempted works, and ${result.assets} deduplicated assets to ${result.directory}.`);
