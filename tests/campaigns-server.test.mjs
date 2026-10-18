import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server.mjs';
import { createProviderRegistry } from '../lib/providers.mjs';

test('campaign APIs expose reviewed snapshots and durable idempotent Study allowances without provider calls', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'offcut-campaign-api-'));
  let transportCalls = 0;
  let app = await startServer({ port: 0, dataDir, persist: false, initialSources: [], providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl: async () => { transportCalls++; throw new Error('must not call'); } }) });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };

  const rates = await request('/api/study-rates');
  assert.equal(rates.status, 200);
  assert.equal(rates.data.defaultLimitMicros, 50_000_000);
  assert.equal(rates.data.rateSnapshots[0].currency, 'USD');
  assert.match(rates.data.rateSnapshots[0].hash, /^[a-f0-9]{64}$/);
  const qualifications = await request('/api/study-qualifications');
  assert.equal(qualifications.status, 200);
  assert.equal(qualifications.data.qualifications.format, 'offcut-provider-qualification');
  assert.ok(qualifications.data.qualifications.routes.some(route => route.provider === 'openai' && route.priced && !route.calibrated));
  assert.equal(transportCalls, 0, 'building the report must not call a provider');
  const clientRequestId = randomUUID();
  const body = { clientRequestId, limitMicros: 50_000_000, rateSnapshotId: rates.data.rateSnapshots[0].id };
  const created = await request('/api/campaigns', body);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.campaign.allowanceLabel, 'Study allowance');
  assert.equal(created.data.campaign.availableMicros, 50_000_000);
  const duplicate = await request('/api/campaigns', body);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.campaign.id, created.data.campaign.id);
  const conflict = await request('/api/campaigns', { ...body, limitMicros: 50_000_001 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'RECEIPT_CONFLICT');
  assert.equal((await request('/api/campaigns')).data.campaigns.length, 1);
  const detail = await request(`/api/campaigns/${created.data.campaign.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.campaign.rateSnapshot.hash, rates.data.rateSnapshots[0].hash);
  assert.equal(transportCalls, 0);

  await app.close();
  app = await startServer({ port: 0, dataDir, persist: false, initialSources: [], providerRegistry: createProviderRegistry({ environmentKey: '', fetchImpl: async () => { transportCalls++; throw new Error('must not call'); } }) });
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await request(`/api/campaigns/${created.data.campaign.id}`)).data.campaign.availableMicros, 50_000_000);
  const config = await readFile(join(dataDir, 'campaigns', created.data.campaign.id, 'config.json'), 'utf8');
  assert.ok(!config.includes('apiKey'));
  assert.equal(transportCalls, 0);
});
