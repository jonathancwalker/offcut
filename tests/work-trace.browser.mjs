// Self-contained browser regression: node tests/work-trace.browser.mjs
// Starts an isolated temporary server and uses only a simulated provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp } from '../lib/render.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }

const directory = await mkdtemp(join(tmpdir(), 'offcut-trace-browser-'));
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const bytes = await getSharp()({ create: { width: 80, height: 80, channels: 3, background: '#876a52' } }).png().toBuffer();
const source = { id: 'paper', name: 'Paper', width: 80, height: 80, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
let turn = 0;
const providerRegistry = createProviderRegistry({ environmentKey: '', fetchImpl: async () => {
  turn++;
  const output = turn === 1
    ? { decision_note: 'This crossing cut will fail.', actions: [{ type: 'cut', sourceId: 'paper', pieceId: 'bad', polygon: [[0, 0], [60, 60], [0, 60], [60, 0]] }], done: false }
    : turn === 2
      ? { decision_note: 'Try a simple piece.', actions: [{ type: 'cut', sourceId: 'paper', pieceId: 'piece', polygon: [[0, 0], [30, 0], [30, 30], [0, 30]] }, { type: 'place', pieceId: 'piece', x: 500, y: 600 }], done: false }
      : { decision_note: 'Finish after observing it.', actions: [{ type: 'describe', title: 'Trace fixture', statement: 'A recorded test.' }], done: true };
  return Response.json({ id: `response-${turn}`, model: 'fixture-vision', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
} });
const app = await startServer({ port: 0, dataDir: directory, persist: false, initialSources: [source], providerRegistry });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true });
try {
  await fetch(`${origin}/api/providers/openai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'fixture-secret' }) });
  const started = await (await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', model: 'fixture-vision', prompt: 'Make a trace fixture.', maxTurns: 4, maxActions: 10, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 }) })).json();
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = (await (await fetch(`${origin}/api/runs/${started.run.id}`)).json()).run;
    if (run.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(run.status, 'completed');
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const traceCalls = [];
  page.on('request', request => { if (request.url().endsWith('/trace')) traceCalls.push(request.url()); });
  await page.goto(`${origin}/work.html?run=${started.run.id}`, { waitUntil: 'networkidle' });
  assert.equal(traceCalls.length, 0, 'trace stays on demand');
  await page.locator('#trace-tab').click();
  await page.locator('.trace-turn').first().waitFor();
  assert.equal(traceCalls.length, 1);
  assert.equal(await page.locator('.trace-turn').count(), 3);
  assert.match(await page.locator('.trace-turn').first().innerText(), /Rejected/);
  assert.match(await page.locator('.trace-rejection').innerText(), /INVALID_POLYGON/);
  assert.match(await page.locator('.trace-frame img').nth(0).getAttribute('src'), /\/assets\/[a-f0-9]{64}$/);
  assert.match(await page.locator('.trace-frame img').nth(1).getAttribute('src'), /render\.png\?step=0$/);
  await page.locator('.trace-detail .text-button').click();
  assert.equal(await page.locator('#work-timeline').inputValue(), '0', 'a rejected turn never seeks past its observed cursor');
  await page.locator('.trace-turn').nth(1).click();
  assert.match(await page.locator('.trace-frame figcaption').nth(1).innerText(), /accepted replay state/i);
  assert.match(await page.locator('.trace-frame img').nth(1).getAttribute('src'), /render\.png\?step=2$/);
  await page.locator('#trace-tab').focus(); await page.keyboard.press('Home');
  assert.equal(await page.locator('#fragments-tab').getAttribute('aria-selected'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#trace-tab').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: new URL('work-trace-mobile.png', output).pathname, fullPage: true });
  await context.close();
} finally {
  await browser.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
