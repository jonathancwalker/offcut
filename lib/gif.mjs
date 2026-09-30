import { fork } from 'node:child_process';
import { createState, applyAction } from './engine.mjs';
import { getSharp, renderSVG } from './render.mjs';

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_EDGE = 640;
const MAX_SOURCE_PIXELS = 32_000_000;
const MAX_IMAGE_PIXELS = 20_000_000;
const FRAME_DELAY = 650;
const FINAL_DELAY = 2500;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const usedSources = project => new Set(project.actions.slice(0, project.cursor)
  .filter(record => record?.action?.type === 'cut').map(record => record.action.sourceId));

/** Fixed export settings: preserve every action, reducing dimensions for long histories. */
export function gifSettings(project) {
  if (!project || project.format !== 'offcut-project' || project.version !== 1
      || !Array.isArray(project.actions) || !Number.isSafeInteger(project.cursor)
      || project.cursor < 0 || project.cursor > project.actions.length) {
    throw error('The saved work has an invalid playback history.');
  }
  if (project.actions.length > 240) throw error('GIF export supports up to 240 saved actions.', 413);
  if (!Array.isArray(project.sources)) throw error('The saved work has an invalid source inventory.');
  if (project.sources.length > 24 || project.sources.reduce((sum, source) => sum + (source?.dataUrl?.length || 0), 0) > 32 * 1024 * 1024) {
    throw error('The saved source inventory is too large for GIF export.', 413);
  }
  const used = usedSources(project);
  const sourcePixels = project.sources.filter(source => used.has(source?.id))
    .reduce((sum, source) => sum + source.width * source.height, 0);
  if (sourcePixels > MAX_SOURCE_PIXELS) {
    throw error('These source images are too large for GIF export. Download the final image instead.', 413);
  }
  const { width, height } = project.canvas || {};
  if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 8192)
      || !/^#[0-9a-f]{6}$/i.test(project.canvas.background)) {
    throw error('The saved work has invalid canvas dimensions.');
  }
  const frames = project.cursor + 1;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_RAW_BYTES / (width * height * frames * 3)));
  const outputWidth = Math.max(1, Math.floor(width * scale));
  const outputHeight = Math.max(1, Math.floor(height * scale));
  return { width: outputWidth, height: outputHeight, frames, frameBytes: outputWidth * outputHeight * 3 };
}

/** Reuse the same engine and SVG renderer as the viewer, with no saved-data writes. */
export async function renderGIF(project) {
  const { width, height, frames, frameBytes } = gifSettings(project);
  const sharp = getSharp();
  let state = createState({ id: project.id, sources: project.sources, rules: project.rules, canvas: project.canvas });
  const sources = state.sources;
  // The SVG output limit does not bound its embedded images. Check their actual
  // headers before librsvg can decode them, including files with false dimensions.
  const used = usedSources(project);
  for (const source of sources.filter(source => used.has(source.id))) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source.dataUrl);
    if (!match) throw error('Every fragment must refer to an embedded raster source.');
    let metadata;
    try {
      metadata = await sharp(Buffer.from(match[1], 'base64'), { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
    } catch { throw error('A saved source image could not be opened.'); }
    if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw error('A source image is too large for GIF export.', 413);
    if (metadata.width !== source.width || metadata.height !== source.height || metadata.pages > 1
        || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
      throw error('A saved source image has inconsistent dimensions or an unsupported format.');
    }
  }
  // One allocation for the whole timeline, plus one temporary frame, never a second raw stack.
  const pixels = Buffer.alloc(frameBytes * frames);
  const delay = Array(frames).fill(FRAME_DELAY);
  delay[frames - 1] = FINAL_DELAY;
  for (let step = 0; step < frames; step++) {
    const action = step ? project.actions[step - 1]?.action : null;
    if (step) {
      state = applyAction(state, action);
      state.sources = sources;
    }
    // Cuts and descriptions change the record but do not change the painted canvas.
    if (step && ['cut', 'describe'].includes(action.type)) {
      pixels.copy(pixels, step * frameBytes, (step - 1) * frameBytes, step * frameBytes);
      continue;
    }
    const frame = await sharp(Buffer.from(renderSVG(state, { width, height })), { limitInputPixels: MAX_EDGE * MAX_EDGE })
      .flatten({ background: state.canvas.background }).removeAlpha().raw().timeout({ seconds: 15 }).toBuffer();
    if (frame.length !== frameBytes) throw new Error('Unexpected GIF frame dimensions.');
    frame.copy(pixels, step * frameBytes);
  }
  return sharp(pixels, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
    .gif({ loop: 0, delay, colours: 256, effort: 2, dither: 0.5, interPaletteMaxError: 0, keepDuplicateFrames: true })
    .timeout({ seconds: 60 }).toBuffer();
}

/** One isolated export at a time; cancellation also stops native rendering/encoding. */
export function createGIFExporter({ timeoutMs = 120_000 } = {}) {
  let active;
  let closed = false;
  return {
    render(project, { signal } = {}) {
      if (closed) return Promise.reject(error('GIF export is unavailable while the server closes.', 503));
      if (signal?.aborted) return Promise.reject(error('GIF export was cancelled.', 499));
      if (active) return Promise.reject(error('Another GIF is being prepared. Try again shortly.', 409));
      try { gifSettings(project); } catch (cause) { return Promise.reject(cause); }
      const child = fork(new URL('./gif-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', execArgv: [],
      });
      let result;
      let failure;
      let timer;
      let settle;
      const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      const stop = cause => {
        failure ??= cause;
        child.kill('SIGKILL');
      };
      const abort = () => stop(error('GIF export was cancelled.', 499));
      active = { done, stop };
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active = null;
        if (failure || !result) settle.reject(failure || error('GIF export could not be completed. Try again.', 500));
        else settle.resolve(result);
      };
      child.once('error', cause => { failure = cause; });
      child.once('close', finish);
      child.once('message', message => {
        if (message.error) failure = error(message.error, message.status || 500);
        else if (Buffer.isBuffer(message.bytes)) result = message.bytes;
      });
      timer = setTimeout(() => stop(error('GIF export took too long. Try again.', 504)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.send(project, cause => { if (cause) stop(cause); });
      return done;
    },
    async close() {
      closed = true;
      const job = active;
      if (job) {
        job.stop(error('GIF export stopped because the server closed.', 503));
        await job.done.catch(() => {});
      }
    },
  };
}
