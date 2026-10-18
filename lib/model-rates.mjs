import { createHash } from 'node:crypto';

const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

function canonicalJSON(value) {
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('Rate snapshot values must be finite JSON.');
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const SOURCE_URLS = Object.freeze([
  'https://developers.openai.com/api/docs/pricing',
  'https://developers.openai.com/api/docs/guides/images-vision',
  'https://developers.openai.com/api/docs/guides/token-counting',
  'https://developers.openai.com/api/docs/models/gpt-6-astra',
  'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
]);

const sharedEstimator = Object.freeze({
  version: 'openai-responses-local-upper-bound-v1',
  endpoint: '/v1/responses',
  imageDetail: 'high',
  imageFormula: 'ceil(min(ceil(width/32)*ceil(height/32),2500)*1.2)',
  textFormula: 'UTF-8 bytes of a base64-free Responses request shape plus 1024 framing tokens',
  framingTokenMargin: 1024,
  limitations: [
    'The local text estimate is deliberately conservative and does not claim to reproduce provider tokenization.',
    'Image bounds apply only to high-detail image inputs under the documented patch rules.',
    'Cached input is charged at the undiscounted input rate because a cache hit is not guaranteed.',
    'Provider invoice adjustments, regional processing uplifts, tools, audio, files, and image generation are not supported.',
    'A returned model route outside the exact reviewed mapping requires operator reconciliation.',
  ],
});

function route(requested, inputRateMicros, outputRateMicros) {
  return Object.freeze({
    provider: 'openai', requestedRoute: requested, returnedRoutes: [requested],
    processing: 'standard', endpoint: '/v1/responses', modalities: { textInput: true, imageInput: true, textOutput: true },
    ratesPerMillionTokens: {
      shortContext: { inputMicros: inputRateMicros, outputMicros: outputRateMicros },
      longContext: { inputMicros: inputRateMicros * 2, outputMicros: outputRateMicros * 3 / 2 },
    },
    longContextThresholdInputTokens: 272000,
    imageInput: { detail: 'high', patchPixels: 32, patchBudget: 2500, multiplierNumerator: 12, multiplierDenominator: 10 },
  });
}

const snapshotBody = Object.freeze({
  version: 1,
  id: 'openai-standard-2026-10-17',
  provider: 'openai',
  currency: 'USD',
  unit: 'microdollar',
  microsPerUSD: 1_000_000,
  reviewedAt: '2026-10-17T00:00:00.000Z',
  sourceUrls: SOURCE_URLS,
  billingSemantics: {
    usage: 'Responses usage.input_tokens and usage.output_tokens; output includes reasoning and other non-visible generated tokens.',
    rounding: 'Each request charge is rounded upward once to a whole microdollar.',
    cachePolicy: 'All input tokens are conservatively charged at the undiscounted input rate.',
  },
  estimator: sharedEstimator,
  routes: [
    route('gpt-6-astra', 10_000_000, 50_000_000),
    route('gpt-5.6-terra', 2_000_000, 12_000_000),
    route('gpt-5.6-luna', 200_000, 1_200_000),
  ],
});

const openaiSnapshot = Object.freeze({ ...snapshotBody, hash: sha256(canonicalJSON(snapshotBody)) });

function googleRoute(requested, inputRateMicros, outputRateMicros, longInputRateMicros = inputRateMicros, longOutputRateMicros = outputRateMicros) {
  return Object.freeze({
    provider: 'google', requestedRoute: requested, returnedRoutes: [requested],
    processing: 'standard', endpoint: '/v1beta/models/{model}:generateContent', modalities: { textInput: true, imageInput: true, textOutput: true },
    ratesPerMillionTokens: {
      shortContext: { inputMicros: inputRateMicros, outputMicros: outputRateMicros },
      longContext: { inputMicros: longInputRateMicros, outputMicros: longOutputRateMicros },
    },
    longContextThresholdInputTokens: 200000,
    imageInput: { smallDimensionPixels: 384, tileTokens: 258, tilePixels: 768 },
  });
}

const googleSnapshotBody = Object.freeze({
  version: 1,
  id: 'google-standard-2026-10-17',
  provider: 'google',
  currency: 'USD', unit: 'microdollar', microsPerUSD: 1_000_000,
  reviewedAt: '2026-10-17T00:00:00.000Z',
  sourceUrls: [
    'https://ai.google.dev/gemini-api/docs/pricing',
    'https://ai.google.dev/gemini-api/docs/image-understanding',
    'https://ai.google.dev/api/generate-content',
  ],
  billingSemantics: {
    usage: 'usageMetadata.promptTokenCount is input; candidatesTokenCount plus thoughtsTokenCount is billable output.',
    rounding: 'Each request charge is rounded upward once to a whole microdollar.',
    cachePolicy: 'All prompt tokens are conservatively charged at the undiscounted input rate.',
  },
  estimator: {
    version: 'google-generate-content-local-upper-bound-v1', endpoint: '/v1beta/models/{model}:generateContent',
    imageFormula: '258 tokens for images at most 384px in both dimensions; otherwise ceil(width/floor(min(width,height)/1.5))*ceil(height/floor(min(width,height)/1.5))*258',
    textFormula: 'UTF-8 bytes of a base64-free GenerateContent request shape plus 1024 framing tokens', framingTokenMargin: 1024,
    limitations: ['The local text estimate is conservative and does not reproduce provider tokenization.', 'Cached input is charged at the undiscounted rate.', 'Tools, audio, video, grounding, and image generation are unsupported.'],
  },
  routes: [
    googleRoute('gemini-3.8-flash', 750_000, 3_750_000),
    googleRoute('gemini-3.1-flash-lite', 250_000, 1_500_000),
    googleRoute('gemini-3.1-pro-preview', 2_000_000, 12_000_000, 4_000_000, 18_000_000),
  ],
});
const googleSnapshot = Object.freeze({ ...googleSnapshotBody, hash: sha256(canonicalJSON(googleSnapshotBody)) });
const snapshots = new Map([[openaiSnapshot.id, openaiSnapshot], [googleSnapshot.id, googleSnapshot]]);
const rateBookBody = Object.freeze({
  version: 1,
  id: 'offcut-reviewed-rates-2026-10-17',
  currency: 'USD',
  unit: 'microdollar',
  reviewedAt: '2026-10-17T00:00:00.000Z',
  snapshots: [openaiSnapshot, googleSnapshot],
});
const rateBook = Object.freeze({ ...rateBookBody, hash: sha256(canonicalJSON(rateBookBody)) });
const rateBooks = new Map([[rateBook.id, rateBook]]);

function fail(message, code = 'UNPRICED_REQUEST', status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  throw error;
}

function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be a safe integer from ${min} to ${max}.`);
  return value;
}

function exactRoute(rateSnapshot, requestedRoute) {
  const match = rateSnapshot.routes.find(candidate => candidate.requestedRoute === requestedRoute);
  if (!match) fail(`The exact model route ${requestedRoute} has no reviewed accounting rule.`);
  return match;
}

function imageTokenBound(routeRule, image) {
  const width = safeInteger(image?.width, 'Image width', { min: 1, max: 65535 });
  const height = safeInteger(image?.height, 'Image height', { min: 1, max: 65535 });
  const rawPatches = Math.ceil(width / routeRule.imageInput.patchPixels) * Math.ceil(height / routeRule.imageInput.patchPixels);
  const patchBound = Math.min(rawPatches, routeRule.imageInput.patchBudget);
  return Math.ceil(patchBound * routeRule.imageInput.multiplierNumerator / routeRule.imageInput.multiplierDenominator);
}

function geminiImageTokenBound(routeRule, image) {
  const width = safeInteger(image?.width, 'Image width', { min: 1, max: 65535 });
  const height = safeInteger(image?.height, 'Image height', { min: 1, max: 65535 });
  if (width <= routeRule.imageInput.smallDimensionPixels && height <= routeRule.imageInput.smallDimensionPixels) return routeRule.imageInput.tileTokens;
  const cropUnit = Math.max(1, Math.floor(Math.min(width, height) / 1.5));
  return Math.ceil(width / cropUnit) * Math.ceil(height / cropUnit) * routeRule.imageInput.tileTokens;
}

function safeImage(image) {
  if (!object(image) || typeof image.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(image.id)
    || typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256)
    || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) fail('Image estimator metadata is invalid.');
  imageTokenBound({ imageInput: { patchPixels: 32, patchBudget: 2500, multiplierNumerator: 12, multiplierDenominator: 10 } }, image);
  return image;
}

function requestDescriptor(request, images) {
  const dimensions = new Map(images.map(image => { safeImage(image); return [image.id, image]; }));
  const messages = request.messages.map(message => ({
    role: message.role,
    text: message.text,
    ...(message.images ? { images: message.images.map(image => {
      const detail = dimensions.get(image.id);
      if (!detail) fail(`Image ${image.id} is missing its estimator dimensions.`);
      return { id: image.id, width: detail.width, height: detail.height, sha256: detail.sha256, mime: detail.mime };
    }) } : {}),
  }));
  return { model: request.model, instructions: request.instructions, messages, maxOutputTokens: request.maxOutputTokens, store: false, imageDetail: 'high' };
}

function textShape(request) {
  const input = request.messages.map(message => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    const content = [{ type: 'input_text', text: message.text }];
    for (const image of message.images || []) {
      content.push({ type: 'input_text', text: `Image: ${image.id}` });
      content.push({ type: 'input_image', image_url: '', detail: 'high' });
    }
    return { role: 'user', content };
  });
  return {
    model: request.model,
    instructions: request.instructions,
    input,
    max_output_tokens: request.maxOutputTokens,
    store: false,
  };
}

function geminiTextShape(request) {
  return {
    systemInstruction: { parts: [{ text: request.instructions }] },
    contents: request.messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.text }, ...(message.images || []).flatMap(image => [{ text: `Image: ${image.id}` }, { inlineData: { mimeType: '', data: '' } }])],
    })),
    generationConfig: { maxOutputTokens: request.maxOutputTokens, responseMimeType: 'application/json' },
  };
}

function chargeMicros(inputTokens, outputTokens, rates) {
  const numerator = BigInt(inputTokens) * BigInt(rates.inputMicros) + BigInt(outputTokens) * BigInt(rates.outputMicros);
  const charge = (numerator + 999_999n) / 1_000_000n;
  if (charge > BigInt(Number.MAX_SAFE_INTEGER)) fail('The estimated request charge is too large to account safely.');
  return Number(charge);
}

export function listRateSnapshots() {
  return [...snapshots.values()].map(clone);
}

export function getRateSnapshot(id) {
  const value = snapshots.get(id);
  if (!value) fail('Choose a reviewed rate snapshot.', 'RATE_SNAPSHOT_NOT_FOUND', 404);
  return clone(value);
}

export function listRateBooks() {
  return [...rateBooks.values()].map(clone);
}

export function getRateBook(id) {
  const value = rateBooks.get(id);
  if (!value) fail('Choose a reviewed rate book.', 'RATE_BOOK_NOT_FOUND', 404);
  return clone(value);
}

function providerSnapshot(rateBookValue, provider) {
  if (!object(rateBookValue) || !Array.isArray(rateBookValue.snapshots) || typeof provider !== 'string') {
    fail('The rate book or provider is invalid.');
  }
  const matches = rateBookValue.snapshots.filter(candidate => candidate?.provider === provider);
  if (matches.length !== 1) fail(`Provider ${provider} has no unique reviewed accounting snapshot in this rate book.`);
  return matches[0];
}

export function estimateProviderRequest(rateBookValue, { provider, request, images }) {
  const estimate = estimateRequest(providerSnapshot(rateBookValue, provider), { request, images });
  return { provider, ...estimate };
}

export function accountProviderUsage(rateBookValue, { provider, requestedRoute, returnedModel, usage }) {
  const accounted = accountUsage(providerSnapshot(rateBookValue, provider), { requestedRoute, returnedModel, usage });
  return { provider, ...accounted };
}

export function estimateRequest(rateSnapshot, { request, images }) {
  if (!object(request) || !Array.isArray(request.messages) || !Array.isArray(images)) fail('The request cannot be safely estimated.');
  const rule = exactRoute(rateSnapshot, request.model);
  if (typeof request.instructions !== 'string' || request.messages.some(message => !object(message) || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.images !== undefined && !Array.isArray(message.images))) fail('The request cannot be safely estimated.');
  safeInteger(request.maxOutputTokens, 'Maximum output tokens', { min: 1, max: 128000 });
  const descriptor = requestDescriptor(request, images);
  const dimensions = new Map(images.map(image => [image.id, image]));
  const textBytes = Buffer.byteLength(JSON.stringify(rateSnapshot.provider === 'google' ? geminiTextShape(request) : textShape(request)), 'utf8');
  const textTokenBound = textBytes + rateSnapshot.estimator.framingTokenMargin;
  const imageDetails = request.messages.flatMap(message => (message.images || []).map(attachment => {
    const image = dimensions.get(attachment.id);
    if (!image) fail(`Image ${attachment.id} is missing its estimator dimensions.`);
    return { id: image.id, width: image.width, height: image.height, sha256: image.sha256, mime: image.mime, tokenBound: rateSnapshot.provider === 'google' ? geminiImageTokenBound(rule, image) : imageTokenBound(rule, image) };
  }));
  const imageTokenBoundTotal = imageDetails.reduce((sum, image) => sum + image.tokenBound, 0);
  const inputTokenBound = safeInteger(textTokenBound + imageTokenBoundTotal, 'Input token bound');
  const tier = inputTokenBound > rule.longContextThresholdInputTokens ? 'longContext' : 'shortContext';
  const rates = rule.ratesPerMillionTokens[tier];
  return {
    requestHash: sha256(canonicalJSON(descriptor)),
    requestedRoute: rule.requestedRoute,
    returnedRoutes: clone(rule.returnedRoutes),
    estimatorVersion: rateSnapshot.estimator.version,
    estimator: { textBytes, framingTokenMargin: rateSnapshot.estimator.framingTokenMargin, textTokenBound, imageTokenBound: imageTokenBoundTotal, inputTokenBound, outputTokenBound: request.maxOutputTokens, tier, images: imageDetails },
    rates: clone(rates),
    reservedMicros: chargeMicros(inputTokenBound, request.maxOutputTokens, rates),
  };
}

export function accountUsage(rateSnapshot, { requestedRoute, returnedModel, usage }) {
  const rule = exactRoute(rateSnapshot, requestedRoute);
  if (typeof returnedModel !== 'string' || !rule.returnedRoutes.includes(returnedModel)) fail('The returned model route is outside the exact reviewed mapping.', 'UNRESOLVED_USAGE');
  if (!object(usage) || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
    fail('The provider response does not contain complete billable usage.', 'UNRESOLVED_USAGE');
  }
  const tier = usage.inputTokens > rule.longContextThresholdInputTokens ? 'longContext' : 'shortContext';
  const rates = rule.ratesPerMillionTokens[tier];
  return { chargeMicros: chargeMicros(usage.inputTokens, usage.outputTokens, rates), tier, rates: clone(rates), accounting: 'undiscounted_input' };
}
