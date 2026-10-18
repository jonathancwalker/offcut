/** Browser-safe validation shared by run launchers and study planning. */
export const RUN_SPEC_LIMITS = Object.freeze({
  maxTurns: Object.freeze([12, 1, 40]),
  maxActions: Object.freeze([120, 1, 240]),
  maxPieces: Object.freeze([24, 1, 64]),
  maxOutputTokens: Object.freeze([4096, 256, 16384]),
  maxMinutes: Object.freeze([10, 1, 60]),
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

/** Validate resource limits without inventing a provider route or prompt. */
export function normalizeRunLimits(input, { requireAll = false } = {}) {
  if (!object(input)) fail('Run limits are required.');
  const limits = {};
  for (const [key, [fallback, min, max]] of Object.entries(RUN_SPEC_LIMITS)) {
    if (requireAll && !Object.hasOwn(input, key)) fail(`${key} is required.`);
    const value = input[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) fail(`${key} must be an integer from ${min} to ${max}.`);
    limits[key] = value;
  }
  return limits;
}

export function normalizeSpec(input) {
  if (!object(input)) fail('An experiment spec is required.');
  const allowed = new Set(['provider', 'model', 'prompt', ...Object.keys(RUN_SPEC_LIMITS)]);
  for (const key of Reflect.ownKeys(input)) if (typeof key !== 'string' || !allowed.has(key)) fail(`Unknown experiment setting: ${String(key)}.`);
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(input.provider)) fail('Choose a valid provider identifier.');
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.model)) fail('Choose a valid model identifier.');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) fail('The experiment prompt must contain 1–12000 characters.');
  return {
    provider: input.provider,
    model: input.model,
    prompt: input.prompt.trim(),
    ...normalizeRunLimits(input),
  };
}
