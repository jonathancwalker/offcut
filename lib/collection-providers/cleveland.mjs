const API_URL = 'https://openaccess-api.clevelandart.org/api/artworks/';
const POLICY_URL = 'https://openaccess-api.clevelandart.org/';
const LICENSE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
const FIELDS = [
  'id', 'accession_number', 'title', 'url', 'creation_date', 'creators',
  'creditline', 'share_license_status', 'images', 'type', 'department', 'culture',
].join(',');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function officialURL(value, hosts, isImage = false) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) return null;
    if (isImage && !/\.jpe?g$/i.test(url.pathname)) return null;
    return value;
  } catch {
    return null;
  }
}

function imageAsset(value) {
  if (!value || typeof value !== 'object') return null;
  const url = officialURL(value.url, ['openaccess-cdn.clevelandart.org'], true);
  return url ? { url, width: positiveInteger(value.width), height: positiveInteger(value.height) } : null;
}

function candidateFromRecord(record) {
  // The dataset itself is CC0, including records whose images are copyrighted.
  // Only this per-artwork field establishes eligibility for image collection.
  if (!record || record.share_license_status !== 'CC0') return null;
  const recordId = typeof record.id === 'number' || typeof record.id === 'string' ? String(record.id) : '';
  if (!/^[1-9]\d*$/.test(recordId)) return null;
  const title = text(record.title);
  const url = officialURL(record.url, ['clevelandart.org', 'www.clevelandart.org']);
  const webImage = imageAsset(record.images?.web);
  const printImage = imageAsset(record.images?.print);
  const image = webImage || printImage;
  if (!title || !url || !image) return null;

  const creators = Array.isArray(record.creators)
    ? record.creators.map(creator => text(creator?.description)).filter(Boolean)
    : [];
  const creator = [...new Set(creators)].join('; ') || null;
  const credit = [creator, 'The Cleveland Museum of Art', text(record.creditline), text(record.accession_number)]
    .filter(Boolean).join('; ');
  const tags = [record.type, record.department, ...(Array.isArray(record.culture) ? record.culture : [])]
    .map(text).filter(Boolean);

  return {
    provider: 'cleveland',
    recordId,
    id: `cleveland-${recordId}`,
    title,
    creator,
    date: text(record.creation_date) || null,
    credit,
    license: 'CC0 1.0',
    licenseUrl: LICENSE_URL,
    url,
    rightsUrl: url,
    rightsEvidence: { share_license_status: 'CC0', policyUrl: POLICY_URL },
    downloadUrl: image.url,
    ...(printImage && printImage.url !== image.url ? { higherResolutionUrl: printImage.url } : {}),
    width: image.width,
    height: image.height,
    tags: [...new Set(tags)],
  };
}

/** Discover one bounded page. Networking, retries, and throttling belong to the caller. */
export async function fetchClevelandPage({ query = '', offset = 0, limit = 50, requestJSON } = {}) {
  if (typeof requestJSON !== 'function') throw new TypeError('requestJSON must be a function.');
  if (typeof query !== 'string' || query.length > 500) throw new TypeError('query must be a string of at most 500 characters.');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer.');
  const pageLimit = Math.min(limit, 100);
  const url = new URL(API_URL);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('cc0', '');
  url.searchParams.set('has_image', '1');
  url.searchParams.set('skip', String(offset));
  url.searchParams.set('limit', String(pageLimit));
  url.searchParams.set('fields', FIELDS);

  const response = await requestJSON(url.href);
  if (!response || !Array.isArray(response.data) || response.data.length > pageLimit) {
    throw new Error('Cleveland returned an invalid artwork page.');
  }
  const reportedTotal = response.info?.total;
  const total = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : null;
  const rawCount = response.data.length;
  const next = offset + rawCount;
  const hasMore = rawCount > 0 && (total === null ? rawCount === pageLimit : next < total);

  return {
    candidates: response.data.map(candidateFromRecord).filter(Boolean),
    // Advance over every API record, including records excluded by our checks.
    nextOffset: hasMore ? next : null,
    total,
  };
}
