import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeRunDirectory, analysisMarkdown } from '../lib/run-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Offline analysis of saved Offcut runs. No server or model API required.\n\nnpm run runs:analyze -- [--runs DIRECTORY] [--out NEW_DIRECTORY]\n\nDefaults: read project .data/runs and write a new timestamped .data/analysis folder.\nExisting output folders are never overwritten. Running records are skipped.');
} else {
  let runs = resolve(root, '.data/runs');
  let out = resolve(root, '.data/analysis', new Date().toISOString().replace(/[:.]/g, '-'));
  for (let index = 0; index < args.length; index++) {
    const flag = args[index], value = args[++index];
    if (!['--runs', '--out'].includes(flag) || !value || value.startsWith('--')) throw new Error('Use --runs DIRECTORY and/or --out NEW_DIRECTORY.');
    if (flag === '--runs') runs = resolve(value); else out = resolve(value);
  }
  const withinRuns = relative(runs, out);
  if (!withinRuns || (!isAbsolute(withinRuns) && withinRuns !== '..' && !withinRuns.startsWith('../'))) throw new Error('The analysis output must be outside the input run directory.');
  const report = await analyzeRunDirectory(runs);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Refuse to replace any existing output, including run data.
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(resolve(out, 'summary.md'), analysisMarkdown(report), { flag: 'wx' });
  console.log(`${report.runs.length} runs analyzed, ${report.skipped.length} skipped, ${report.errors.length} unreadable.\n${out}/summary.md\n${out}/report.json`);
  if (report.errors.length || report.runs.some(run => run.issues.length)) process.exitCode = 2;
}
