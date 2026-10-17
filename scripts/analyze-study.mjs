import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStudyDirectory, studyRecoveryCSV, studyRunsCSV, studySummaryMarkdown } from '../lib/study-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Offline analysis of one frozen Offcut Study. No server or model API required.\n\nnpm run studies:analyze -- --study STUDY_ID [--data-root DIRECTORY] [--out NEW_DIRECTORY]\n\nDefaults: read project .data and write a new timestamped .data/study-analysis folder. Existing output folders are never overwritten.');
  process.exit(0);
}

let dataRoot = resolve(root, '.data');
let studyId;
let out = resolve(root, '.data/study-analysis', new Date().toISOString().replace(/[:.]/g, '-'));
for (let index = 0; index < args.length; index++) {
  const flag = args[index], value = args[++index];
  if (!['--data-root', '--study', '--out'].includes(flag) || !value || value.startsWith('--')) throw new Error('Use --study STUDY_ID and optionally --data-root DIRECTORY and/or --out NEW_DIRECTORY.');
  if (flag === '--data-root') dataRoot = resolve(value);
  else if (flag === '--study') studyId = value;
  else out = resolve(value);
}
if (!studyId) throw new Error('--study STUDY_ID is required.');
const withinData = relative(dataRoot, out);
if (!withinData || (!isAbsolute(withinData) && withinData !== '..' && !withinData.startsWith('../'))) throw new Error('The analysis output must be outside the input data root.');
const result = await analyzeStudyDirectory({ dataRoot, studyId });
const studyDirectory = resolve(dataRoot, 'studies', studyId);
const manifest = JSON.parse(await readFile(resolve(studyDirectory, 'manifest.json'), 'utf8'));
await mkdir(dirname(out), { recursive: true });
await mkdir(out);
await writeFile(resolve(out, 'report.json'), JSON.stringify(result.report, null, 2) + '\n', { flag: 'wx' });
await writeFile(resolve(out, 'measurements.json'), JSON.stringify(result.measurements, null, 2) + '\n', { flag: 'wx' });
await writeFile(resolve(out, 'runs.csv'), studyRunsCSV(result.report, manifest), { flag: 'wx' });
await writeFile(resolve(out, 'recoveries.csv'), studyRecoveryCSV(result.report), { flag: 'wx' });
await writeFile(resolve(out, 'summary.md'), studySummaryMarkdown(result.report, manifest), { flag: 'wx' });
console.log(`${result.report.counts.cells} cells planned, ${result.report.counts.analysisStatus.measured ?? 0} measured.\n${out}/summary.md`);
if (result.report.issues.length || result.report.cells.some(cell => cell.issues.length)) process.exitCode = 2;
