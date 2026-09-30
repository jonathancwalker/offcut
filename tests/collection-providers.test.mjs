import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchClevelandPage } from '../lib/collection-providers/cleveland.mjs';

function artwork(overrides = {}) {
  return {
    id: 160729,
    accession_number: '1998.78.14',
    title: 'Baoyang Lake',
    share_license_status: 'CC0',
    url: 'https://clevelandart.org/art/1998.78.14',
    creation_date: '1500s',
    creators: [{ description: 'Song Xu (Chinese, 1525-c. 1606)' }],
    creditline: 'The Severance and Greta Millikin Purchase Fund',
    department: 'Chinese Art',
    type: 'Painting',
    culture: ['China, Jiaxing, 16th century'],
    images: {
      web: { url: 'https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_web.jpg', width: '956', height: '893' },
      print: { url: 'https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_print.jpg', width: '3400', height: '3177' },
      full: { url: 'https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_full.tif' },
    },
    ...overrides,
  };
}

test('Cleveland requests bounded image search and preserves item-specific reuse evidence', async () => {
  let request;
  const { candidates, nextOffset, total } = await fetchClevelandPage({
    query: 'lake & silk', offset: 12, limit: 250,
    requestJSON: async url => {
      request = new URL(url);
      return { info: { total: 13 }, data: [artwork()] };
    },
  });
  assert.equal(request.origin, 'https://openaccess-api.clevelandart.org');
  assert.equal(request.pathname, '/api/artworks/');
  assert.equal(request.searchParams.get('q'), 'lake & silk');
  assert.ok(request.searchParams.has('cc0'));
  assert.equal(request.searchParams.get('has_image'), '1');
  assert.equal(request.searchParams.get('skip'), '12');
  assert.equal(request.searchParams.get('limit'), '100');
  assert.ok(request.searchParams.get('fields').includes('share_license_status'));
  assert.equal(nextOffset, null);
  assert.equal(total, 13);
  assert.deepEqual(candidates, [{
    provider: 'cleveland', recordId: '160729', id: 'cleveland-160729',
    title: 'Baoyang Lake', creator: 'Song Xu (Chinese, 1525-c. 1606)', date: '1500s',
    credit: 'Song Xu (Chinese, 1525-c. 1606); The Cleveland Museum of Art; The Severance and Greta Millikin Purchase Fund; 1998.78.14',
    license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    url: 'https://clevelandart.org/art/1998.78.14', rightsUrl: 'https://clevelandart.org/art/1998.78.14',
    rightsEvidence: { share_license_status: 'CC0', policyUrl: 'https://openaccess-api.clevelandart.org/' },
    downloadUrl: 'https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_web.jpg',
    higherResolutionUrl: 'https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_print.jpg',
    width: 956, height: 893,
    tags: ['Painting', 'Chinese Art', 'China, Jiaxing, 16th century'],
  }]);
});

test('Cleveland excludes non-CC0 images even when metadata or other fields claim CC0', async () => {
  const records = [
    artwork({ id: 1, share_license_status: 'Copyrighted', license: 'CC0', copyright: null }),
    artwork({ id: 2, share_license_status: 'Other' }),
    artwork({ id: 3, share_license_status: undefined, license: 'CC0' }),
    artwork({ id: 4, share_license_status: 'cc0' }),
    artwork({ id: 5, images: {} }),
    artwork({ id: 6 }),
  ];
  const page = await fetchClevelandPage({ offset: 10, limit: 6, requestJSON: async () => ({ info: { total: 20 }, data: records }) });
  assert.deepEqual(page.candidates.map(candidate => candidate.recordId), ['6']);
  assert.equal(page.nextOffset, 16, 'pagination counts all records, including excluded ones');
});

test('Cleveland never fabricates image URLs and excludes unexpected image origins or formats', async () => {
  const records = [
    artwork({ id: 1, images: { web: { url: 'https://unrelated.example/image.jpg' } } }),
    artwork({ id: 2, images: { web: { url: 'http://openaccess-cdn.clevelandart.org/item.jpg' } } }),
    artwork({ id: 3, images: { web: { url: 'https://openaccess-cdn.clevelandart.org/item.svg' } } }),
    artwork({ id: 4, images: { full: { url: 'https://openaccess-cdn.clevelandart.org/item_full.tif' } } }),
    artwork({ id: 5, images: { print: { url: 'https://openaccess-cdn.clevelandart.org/reported_print.jpg', width: '3400', height: '0' } }, creators: [], creation_date: null }),
    artwork({ id: '../6' }),
    artwork({ id: 7, url: 'javascript:alert(1)' }),
  ];
  const page = await fetchClevelandPage({ requestJSON: async () => ({ data: records }) });
  assert.equal(page.candidates.length, 1);
  assert.equal(page.candidates[0].recordId, '5');
  assert.equal(page.candidates[0].downloadUrl, 'https://openaccess-cdn.clevelandart.org/reported_print.jpg');
  assert.equal(page.candidates[0].width, 3400);
  assert.equal(page.candidates[0].height, null);
  assert.equal(page.candidates[0].creator, null);
  assert.equal(page.candidates[0].date, null);
  assert.ok(!('higherResolutionUrl' in page.candidates[0]));
});

test('Cleveland pagination stops at empty or final pages and supports absent totals', async () => {
  const page = data => async () => ({ data });
  assert.equal((await fetchClevelandPage({ requestJSON: page([]) })).nextOffset, null);
  assert.equal((await fetchClevelandPage({ limit: 2, requestJSON: page([artwork()]) })).nextOffset, null);
  const full = await fetchClevelandPage({ offset: 2, limit: 1, requestJSON: page([artwork()]) });
  assert.equal(full.nextOffset, 3);
  assert.equal(full.total, null);
  const atEnd = await fetchClevelandPage({ offset: 2, limit: 1, requestJSON: async () => ({ info: { total: 3 }, data: [artwork()] }) });
  assert.equal(atEnd.nextOffset, null);
  const emptyWithTotal = await fetchClevelandPage({ requestJSON: async () => ({ info: { total: 200 }, data: [] }) });
  assert.equal(emptyWithTotal.nextOffset, null);
});

test('Cleveland rejects malformed pages and parameters instead of silently finishing collection', async () => {
  for (const response of [null, {}, { data: null }, { data: artwork() }]) {
    await assert.rejects(fetchClevelandPage({ requestJSON: async () => response }), /invalid artwork page/);
  }
  await assert.rejects(fetchClevelandPage({ limit: 1, requestJSON: async () => ({ data: [artwork(), artwork()] }) }), /invalid artwork page/);
  let called = false;
  const requestJSON = async () => { called = true; return { data: [] }; };
  for (const options of [{ query: {} }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: Infinity }]) {
    await assert.rejects(fetchClevelandPage({ ...options, requestJSON }));
  }
  assert.equal(called, false);
  await assert.rejects(fetchClevelandPage(), /requestJSON/);
});
