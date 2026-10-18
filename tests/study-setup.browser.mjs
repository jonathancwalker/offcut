import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { readFile } from 'node:fs/promises';
import { planStudy } from '../public/study-plan.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const publicRoot = join(import.meta.dirname, '..', 'public');
const tiny = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#b94b2f"/></svg>');
const sources = Array.from({ length: 24 }, (_, index) => ({ id: `source-${index + 1}`, name: `Source ${index + 1}`, width: 8, height: 8, sha256: (index + 1).toString(16).padStart(64, '0'), previewUrl: tiny, license: 'CC0' }));
const campaign = { id: 'campaign-11111111-1111-4111-8111-111111111111', availableMicros: 50_000_000, accountedMicros: 0, reservedMicros: 0 };
let lastPreviewDraft = null, frozen = null, startBodies = [], failFirstStart = true, providerConfigured = false;
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
const body = request => new Promise((resolve, reject) => { let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => raw += chunk); request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch (error) { reject(error); } }); request.on('error', reject); });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture');
  if (url.pathname === '/api/source-catalog') return json(response, 200, { snapshot: 'a'.repeat(64), sources });
  if (url.pathname === '/api/study-rates') return json(response, 200, { rateBooks: [{ id: 'rates-v1' }], rateSnapshots: [{ id: 'rates-openai-v1', provider: 'openai', routes: [{ provider: 'openai', requestedRoute: 'gpt-5.6-luna' }, { provider: 'openai', requestedRoute: 'gpt-6-astra' }] }, { id: 'rates-google-v1', provider: 'google', routes: [{ provider: 'google', requestedRoute: 'gemini-3.8-flash' }] }] });
  if (url.pathname === '/api/providers') return json(response, 200, { providers: [
    { id: 'openai', name: 'OpenAI', configured: providerConfigured, keySource: providerConfigured ? 'session' : null },
    { id: 'google', name: 'Google Gemini', configured: false, keySource: null },
    { id: 'anthropic', name: 'Anthropic Claude', configured: false, keySource: null },
    { id: 'alibaba', name: 'Alibaba Qwen', configured: false, keySource: null },
    { id: 'xai', name: 'xAI Grok', configured: false, keySource: null },
    { id: 'huggingface', name: 'Hugging Face', configured: false, keySource: null },
  ] });
  if (url.pathname === '/api/providers/openai' && request.method === 'POST') { const input = await body(request); assert.ok(input.apiKey); providerConfigured = true; return json(response, 200, { configured: true }); }
  if (url.pathname === '/api/providers/openai' && request.method === 'DELETE') { providerConfigured = false; return json(response, 200, { configured: false }); }
  if (url.pathname === '/api/providers/openai/test' && request.method === 'POST') return providerConfigured ? json(response, 200, { models: ['gpt-5.6-luna', 'gpt-6-astra', 'unpriced-vision'] }) : json(response, 400, { error: 'Enter an API key first.' });
  if (url.pathname === '/api/campaigns' && request.method === 'GET') return json(response, 200, { campaigns: [campaign] });
  if (url.pathname === '/api/campaigns' && request.method === 'POST') return json(response, 201, { campaign });
  if (url.pathname === '/api/studies/preview' && request.method === 'POST') {
    const input = await body(request); lastPreviewDraft = input.draft;
    return json(response, 200, { preview: await planStudy(input.draft) });
  }
  if (url.pathname === '/api/studies' && request.method === 'GET') return json(response, 200, { studies: [{ id: 'study-calibration', kind: 'calibration', status: 'completed' }] });
  if (url.pathname === '/api/studies/study-calibration' && request.method === 'GET') return json(response, 200, { study: { id: 'study-calibration', kind: 'calibration', status: 'completed', state: { entries: [{ cellId: 'cell-luna', status: 'completed', runId: 'run-luna' }] }, manifest: { cells: [{ cellId: 'cell-luna', modelId: 'gpt-5-6-luna' }], plan: { normalizedDraft: { models: [{ id: 'gpt-5-6-luna', provider: 'openai', model: 'gpt-5.6-luna' }] } } } } });
  if (url.pathname === '/api/study-qualifications') return json(response, 200, { qualifications: { routes: [{ provider: 'openai', requestedRoute: 'gpt-5.6-luna', calibrated: true, primaryEligible: true, calibrationEvidence: [{ campaignId: campaign.id, studyStatus: 'completed', status: 'completed', nativeImage: true, parseableActionJSON: true, completeUsage: true, settledUsage: true, deterministicReplay: true, credentialFree: true }] }] } });
  if (url.pathname === '/api/studies' && request.method === 'POST') {
    const input = await body(request);
    assert.deepEqual(input.draft, lastPreviewDraft, 'freeze must use the reviewed draft');
    frozen = { id: 'study-11111111-1111-4111-8111-111111111111', status: 'ready', manifestHash: 'b'.repeat(64), manifest: { manifestHash: 'b'.repeat(64) } };
    return json(response, 201, { study: frozen });
  }
  if (url.pathname === '/api/studies/study-11111111-1111-4111-8111-111111111111' && request.method === 'GET') return json(response, 200, { study: frozen });
  if (url.pathname.endsWith('/start') && request.method === 'POST') {
    startBodies.push(await body(request));
    if (failFirstStart) { failFirstStart = false; return json(response, 503, { error: 'Simulated uncertain response.' }); }
    return json(response, 200, { study: { ...frozen, status: 'running' } });
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = normalize(join(publicRoot, relative));
  if (!file.startsWith(publicRoot)) return json(response, 404, { error: 'Not found.' });
  try {
    const bytes = await readFile(file);
    const type = ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' })[extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type }); response.end(bytes);
  } catch { json(response, 404, { error: 'Not found.' }); }
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }); const page = await context.newPage();
    await page.goto(`${origin}/study-new.html`);
    await page.waitForFunction(() => document.querySelectorAll('#source-grid .study-source').length === 24);
    assert.equal(await page.locator('#selected-tray .tray-chip').count(), 6);
    await page.locator('[data-source-id="source-7"]').click();
    assert.equal(await page.locator('#selected-tray .tray-chip').count(), 7, 'manual Study sets may contain more than six images');
    await page.locator('[data-source-id="source-7"]').click();
    await page.getByLabel('Images per set').fill('8');
    await page.getByLabel('Random sets').fill('3');
    await page.getByRole('button', { name: 'Generate draws' }).click();
    assert.equal(await page.locator('.pack-tabs [role=tab]').count(), 4);
    for (let index = 0; index < 3; index++) assert.equal(await page.locator('.pack-tabs [role=tab]').nth(index).getAttribute('data-count'), '8');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#source-grid .study-source').length === 24);
    assert.equal(await page.locator('.provider-card').count(), 6);
    const openai = page.locator('.provider-card[data-provider="openai"]');
    assert.match(await openai.locator('.connection-state').textContent(), /not connected/i);
    await openai.getByLabel('OpenAI API key').fill('test-session-key');
    await openai.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.provider-card[data-provider="openai"] .field-help')?.textContent.includes('3 routes loaded'));
    assert.match(await page.locator('.route-status').first().textContent(), /Accessible: Yes/);
    assert.match(await page.locator('.route-status').first().textContent(), /Priced: Yes/);
    await page.getByLabel('Exact API route 1').fill('unpriced-vision');
    await page.getByLabel('Exact API route 1').press('Tab');
    assert.match(await page.locator('.route-status').first().textContent(), /Accessible: Yes/);
    assert.match(await page.locator('.route-status').first().textContent(), /Priced: No/);
    await page.getByLabel('Exact API route 1').fill('gpt-5.6-luna');
    await page.getByLabel('Exact API route 1').press('Tab');
    assert.equal(await page.locator('.pack-tabs [role=tab]').count(), 3);
    await page.locator('.pack-tabs [role=tab]').first().focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.pack-tabs [role=tab]').nth(1).getAttribute('aria-selected'), 'true');
    await page.getByLabel('Add primary material set').click();
    assert.equal(await page.locator('.pack-tabs [role=tab]').count(), 4);
    await page.locator('[data-source-id="source-19"]').click();
    await page.locator('[data-source-id="source-20"]').click();
    await page.locator('[data-source-id="source-21"]').click();
    await page.locator('[data-source-id="source-22"]').click();
    await page.locator('[data-source-id="source-23"]').click();
    await page.locator('[data-source-id="source-24"]').click();
    await page.getByLabel('Set name').fill('Maps and marks');
    await page.getByRole('button', { name: 'Duplicate' }).click();
    assert.equal(await page.locator('.pack-tabs [role=tab]').count(), 5);
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    assert.equal(await page.locator('.pack-tabs [role=tab]').count(), 4);
    await page.locator('#preview-study').click(); await page.waitForFunction(() => document.querySelector('#freeze-study')?.disabled === false);
    assert.equal(lastPreviewDraft.packs.length, 3);
    assert.equal(lastPreviewDraft.packs[2].label, 'Maps and marks');
    assert.deepEqual(lastPreviewDraft.packs[2].sourceIds, sources.slice(18, 24).map(source => source.id));
    await page.getByLabel('Calibration one prompt, pack, repetition').check();
    assert.equal(await page.locator('.pack-tabs [role=tab]').nth(3).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#selected-tray .tray-chip').count(), 6);
    await page.locator('#add-model').click(); assert.equal(await page.locator('.model-row').count(), 2);
    await page.getByLabel('Display label 2').fill('Second route'); await page.getByLabel('Exact API route 2').fill('gpt-6-astra');
    if (viewport.width < 500) {
      const route = await page.getByLabel('Exact API route 2').boundingBox(), remove = await page.getByLabel('Remove model 2').boundingBox();
      assert.ok(route && remove && (route.x + route.width <= remove.x || remove.x + remove.width <= route.x || route.y + route.height <= remove.y || remove.y + remove.height <= route.y), 'mobile route and remove controls must not overlap');
    }
    await page.locator('#preview-study').click(); await page.waitForFunction(() => document.querySelector('#freeze-study')?.disabled === false);
    assert.equal(new Set(lastPreviewDraft.packs[0].sourceIds).size, 6);
    assert.ok(lastPreviewDraft.packs[0].sourceIds.every(id => !sources.slice(0, 12).some(source => source.id === id)));
    await page.locator('#freeze-study').click(); await page.waitForFunction(() => !document.querySelector('#start-actions')?.hidden);
    await page.locator('#start-study').click(); await page.waitForFunction(() => !document.querySelector('#start-study')?.disabled);
    await page.locator('#start-study').click(); await page.waitForFunction(() => document.querySelector('#frozen-review')?.textContent.includes('starting'));
    assert.equal(startBodies.at(-1).clientRequestId, startBodies.at(-2).clientRequestId, 'start retries must reuse their idempotency key');
    await context.close(); failFirstStart = true; startBodies = []; frozen = null; providerConfigured = false;
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
console.log('PASS study setup desktop/mobile review, freeze, and start retry flow');
