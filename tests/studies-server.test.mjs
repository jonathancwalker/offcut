import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';
import { getSharp } from '../lib/render.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function source() {
  const bytes = await getSharp()({ create: { width: 48, height: 40, channels: 4, background: { r: 160, g: 70, b: 35, alpha: 1 } } }).png().toBuffer();
  return { bytes, record: { id: 'study-paper', name: 'Study paper', width: 48, height: 40, dataUrl: `data:image/png;base64,${bytes.toString('base64')}`, license: 'CC0' } };
}

function draft(catalog) {
  const selected = catalog.sources.find(item => item.id === 'study-paper');
  return {
    version: 1, label: 'Frozen study fixture', kind: 'calibration', seed: 72,
    commonBrief: 'Create a collage using only the supplied material.',
    prompts: [{ id: 'self', label: 'Self portrait', text: 'Make a portrait of yourself.' }],
    models: [{ id: 'route-a', label: 'Route A', provider: 'openai', model: 'gpt-5.6-luna' }],
    packs: [{ id: 'pack-a', label: 'Pack A', catalogSnapshot: catalog.snapshot, sourceIds: [selected.id], sourceHashes: { [selected.id]: selected.sha256 } }],
    repetitions: 1,
    profiles: [{ id: 'standard', label: 'Standard', maxTurns: 2, maxActions: 12, maxPieces: 4, maxOutputTokens: 512, maxMinutes: 1 }],
    notePolicy: 'short-v1',
  };
}

test('Study HTTP APIs preview and freeze immutable inputs without provider calls', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-studies-api-'));
  const fixture = await source();
  let transportCalls = 0;
  const launch = () => startServer({
    port: 0, dataDir, persist: false, initialSources: [fixture.record],
    providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl: async () => {
      transportCalls++;
      return Response.json({
        id: `response-${transportCalls}`, model: 'gpt-5.6-luna',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision_note: 'The single source becomes the subject.', actions: [{ type: 'describe', title: 'Calibration', statement: 'A finished calibration work.' }], done: true }) }] }],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      });
    } }),
  });
  let app = await launch();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const type = response.headers.get('content-type');
    return { response, status: response.status, data: type?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };

  const catalog = (await request('/api/source-catalog')).data;
  const studyDraft = draft(catalog);
  const preview = await request('/api/studies/preview', { draft: studyDraft });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.preview.counts.cells, 1);
  assert.equal((await request('/api/studies')).data.studies.length, 0);

  const rates = (await request('/api/study-rates')).data;
  const campaign = (await request('/api/campaigns', { clientRequestId: randomUUID(), limitMicros: 5_000_000, rateSnapshotId: rates.rateSnapshots[0].id })).data.campaign;
  const clientRequestId = randomUUID();
  const body = { clientRequestId, draft: studyDraft, campaignId: campaign.id };
  const created = await request('/api/studies', body);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.study.id;
  assert.equal(created.data.study.status, 'ready');
  assert.equal(created.data.study.manifest.campaign.id, campaign.id);
  assert.equal(created.data.study.manifest.cells.length, 1);
  assert.ok(!JSON.stringify(created.data).includes('base64'));
  assert.ok(!JSON.stringify(created.data).toLowerCase().includes('apikey'));

  const retry = await request('/api/studies', body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.study.id, id);
  const conflict = await request('/api/studies', { ...body, draft: { ...studyDraft, label: 'Changed' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'RECEIPT_CONFLICT');
  assert.equal((await request('/api/studies')).data.studies.length, 1);
  assert.equal((await request(`/api/studies/${id}`)).data.study.manifest.manifestHash, created.data.study.manifest.manifestHash);

  const image = await request(`/api/studies/${id}/sources/study-paper`);
  assert.equal(image.status, 200);
  assert.equal(image.response.headers.get('content-type'), 'image/png');
  assert.equal(hash(image.data), hash(fixture.bytes));
  assert.equal((await request(`/api/studies/${id}/sources/missing`)).status, 404);
  assert.equal(transportCalls, 0);

  await request('/api/providers/openai', { apiKey: 'test-secret-key' });
  const started = await request(`/api/studies/${id}/start`, { clientRequestId: randomUUID(), manifestHash: created.data.study.manifest.manifestHash });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  let finished;
  for (let attempt = 0; attempt < 100; attempt++) {
    finished = (await request(`/api/studies/${id}`)).data.study;
    if (!['running', 'pausing'].includes(finished.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.state.entries[0].runId.startsWith('run-'), true);
  assert.ok(transportCalls > 0);

  await app.close();
  app = await launch();
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await request(`/api/studies/${id}`)).data.study.status, 'completed');
  const reopenedImage = await request(`/api/studies/${id}/sources/study-paper`);
  assert.equal(hash(reopenedImage.data), hash(fixture.bytes));
  const callsAfterRestart = transportCalls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(transportCalls, callsAfterRestart);
});
