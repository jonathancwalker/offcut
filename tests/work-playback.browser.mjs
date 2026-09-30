// Run against an isolated local server: PORT=4322 npm start
// Then: node tests/work-playback.browser.mjs
// Uses an installed Playwright, or the bundled Codex runtime; no provider calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createState, applyAction } from '../lib/engine.mjs';
import { getSharp } from '../lib/render.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const origin = process.env.OFFCUT_TEST_URL || 'http://127.0.0.1:4322';
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.playbackSamples = [];
  function sample() {
    const image = document.getElementById('work-canvas');
    const outline = document.getElementById('work-change-outline');
    if (image?.naturalWidth && outline) {
      window.playbackSamples.push({ imageStep: new URL(image.src).searchParams.get('step'), outlineStep: outline.hasAttribute('hidden') ? null : outline.dataset.step, opacity: getComputedStyle(image).opacity, imageCount: document.querySelectorAll('#work-stage img').length });
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const responseBytes = async path => { const response = await context.request.get(`${origin}${path}`); assert.equal(response.status(), 200); return response.body(); };
const archivePath = '/api/archives/archive-003';
const projectBefore = await responseBytes(`${archivePath}/project`);
const pngBefore = await responseBytes(`${archivePath}/render.png`);
const project = JSON.parse(projectBefore);
const frames = [createState({ id: project.id, sources: project.sources, canvas: project.canvas, rules: project.rules })];
for (const record of project.actions.slice(0, project.cursor)) frames.push(applyAction(frames.at(-1), record.action));
const finalStep = frames.length - 1;
const dispatchStep = step => page.locator('#work-timeline').evaluate((input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(step));
const waitFrame = step => page.waitForFunction(value => {
  const image = document.querySelector('#work-canvas');
  return image.naturalWidth > 0 && new URL(image.src).searchParams.get('step') === String(value) && document.querySelector('#work-stage').getAttribute('aria-busy') === 'false';
}, step);
async function seek(step) { await dispatchStep(step); await waitFrame(step); }
const outlineInfo = () => page.locator('#work-change-outline').evaluate(element => ({ hidden: element.hasAttribute('hidden'), step: element.dataset.step, pieceId: element.dataset.pieceId, points: element.querySelector('.changed-piece-boundary')?.getAttribute('points').split(' ').map(point => point.split(',').map(Number)), occluders: [...element.querySelectorAll('[data-occluder]')].map(item => item.dataset.occluder), animations: element.getAnimations().length, stroke: element.querySelector('.changed-piece-boundary') && getComputedStyle(element.querySelector('.changed-piece-boundary')).strokeWidth }));
async function expectOutline(step) {
  const info = await outlineInfo();
  const action = project.actions[step - 1].action;
  const piece = frames[step].pieces.find(item => item.id === action.pieceId);
  assert.equal(info.hidden, false);
  assert.equal(info.step, String(step));
  assert.equal(info.pieceId, action.pieceId);
  assert.equal(info.points.length, piece.polygon.length);
  // Independent renderer transform: translate to crop origin/center, scale,
  // rotate, then translate onto the canvas. Do not use the highlight helper.
  const radians = piece.rotation * Math.PI / 180;
  for (const [index, [x, y]] of piece.polygon.entries()) {
    const local = [(x - piece.bounds.x - piece.bounds.width / 2) * piece.scale, (y - piece.bounds.y - piece.bounds.height / 2) * piece.scale];
    const expected = [piece.x + Math.cos(radians) * local[0] - Math.sin(radians) * local[1], piece.y + Math.sin(radians) * local[0] + Math.cos(radians) * local[1]];
    assert.ok(expected.every((value, axis) => Math.abs(value - info.points[index][axis]) < 1e-8));
  }
  assert.deepEqual(info.occluders, frames[step].pieces.slice(frames[step].pieces.indexOf(piece) + 1).filter(item => item.visible).map(item => item.id));
  assert.equal(info.stroke, '2px');
  return info;
}
async function expectAligned() {
  const measurements = await page.evaluate(() => {
    const image = document.querySelector('#work-canvas'), overlay = document.querySelector('#work-change-outline');
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = scale * image.naturalWidth, height = scale * image.naturalHeight;
    return { expected: { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height }, actual: overlay.getBoundingClientRect().toJSON() };
  });
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(measurements.expected[key] - measurements.actual[key]) < .05, `${key}: ${JSON.stringify(measurements)}`);
  return measurements;
}
async function screenshot(name) { await page.screenshot({ path: new URL(name, output).pathname, fullPage: true }); }
async function stagePixels() { return digest(await page.locator('#work-canvas').screenshot({ animations: 'allow' })); }
async function mark(check) { checks.push(check); console.log(`PASS ${check}`); }
try {
  await page.goto(`${origin}/work.html?run=archive-003`);
  await waitFrame(finalStep);
  assert.equal((await outlineInfo()).hidden, true);
  await mark('Initial final view is clean');

  await seek(24);
  await expectOutline(24);
  await expectAligned();
  assert.equal(await page.locator('#work-change-outline image').count(), 0);
  const sourcePixels = await page.locator('#work-canvas').evaluate(image => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1]; });
  const expectedPNG = await responseBytes(`${archivePath}/render.png?step=24`);
  const raw = async bytes => getSharp()(bytes).ensureAlpha().raw().toBuffer();
  assert.deepEqual(await raw(Buffer.from(sourcePixels, 'base64')), await raw(expectedPNG));
  await screenshot('a003-24-outline-desktop.png');
  await page.waitForTimeout(820);
  assert.equal((await outlineInfo()).hidden, true);
  await screenshot('a003-24-outline-expired.png');
  await mark('A003 action 24: 16-point canopy, 2px stroke, aligned desktop, 750ms expiry, unchanged image pixels');

  // Delay a real response. The prior decoded image must remain on screen at
  // full opacity until both the new frame and its outline can be committed.
  const oldImage = await page.locator('#work-canvas').getAttribute('src');
  const beforeDelayPixels = await stagePixels();
  let releaseDelayed, delayArrived;
  const arrived = new Promise(resolve => { delayArrived = resolve; });
  const delayRoute = async route => { if (new URL(route.request().url()).searchParams.get('step') === '36') { releaseDelayed = () => route.continue(); delayArrived(); } else await route.continue(); };
  await page.route('**/render.png?**', delayRoute);
  await dispatchStep(36);
  await arrived;
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#work-canvas').getAttribute('src'), oldImage);
  assert.equal(await stagePixels(), beforeDelayPixels);
  assert.equal((await outlineInfo()).hidden, true);
  await screenshot('a003-delayed-frame-steady.png');
  await releaseDelayed();
  await waitFrame(36);
  await expectOutline(36);
  await page.unroute('**/render.png?**', delayRoute);
  await mark('Delayed PNG retains identical old scene; rotated shell outline starts with decoded swap');

  // An old request may finish after a newer seek. Neither it nor its outline
  // may overwrite the newer frame.
  let staleRoute, staleArrived;
  const staleReady = new Promise(resolve => { staleArrived = resolve; });
  const holdStale = async route => { if (new URL(route.request().url()).searchParams.get('step') === '24') { staleRoute = route; staleArrived(); } else await route.continue(); };
  await page.route('**/render.png?**', holdStale);
  await dispatchStep(24); await staleReady;
  await seek(39); await expectOutline(39);
  await staleRoute.continue(); await page.waitForTimeout(120);
  assert.equal(new URL(await page.locator('#work-canvas').getAttribute('src'), origin).searchParams.get('step'), '39');
  await expectOutline(39);
  await page.unroute('**/render.png?**', holdStale);
  await mark('Stale network response cannot replace newer frame or outline');

  // Also cover the async decode boundary, where onload has already fired.
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.originalImageDecode = decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (this.src.includes('step=24&')) await new Promise(resolve => { window.releaseOldDecode = resolve; });
    };
  });
  await dispatchStep(24);
  await page.waitForFunction(() => Boolean(window.releaseOldDecode));
  await seek(36); await expectOutline(36);
  await page.evaluate(() => { window.releaseOldDecode(); HTMLImageElement.prototype.decode = window.originalImageDecode; });
  await page.waitForTimeout(50);
  await expectOutline(36);
  await mark('Stale decoded image cannot commit after a newer seek');

  // Previous boundary's timeout must not erase a replacement outline.
  await seek(24);
  await page.waitForTimeout(430);
  await seek(30);
  await page.waitForTimeout(330);
  await expectOutline(30);
  await screenshot('a003-30-layer-mask.png');
  await mark('Reordered bridge outline follows new z-order and survives old expiry timer');

  await seek(28); assert.equal((await outlineInfo()).hidden, true);
  await seek(0); assert.equal((await outlineInfo()).hidden, true);
  await seek(44); assert.equal((await outlineInfo()).hidden, true);
  await seek(25); await page.locator('#previous-step').click(); await waitFrame(24); await expectOutline(24);
  await page.locator('#final-step').click(); assert.equal((await outlineInfo()).hidden, true); await waitFrame(finalStep);
  await mark('Cuts, blank canvas, describe/final clear; backward seek marks destination action');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seek(24);
  assert.equal((await expectOutline(24)).animations, 0);
  await screenshot('a003-24-reduced-motion.png');
  await page.waitForTimeout(810); assert.equal((await outlineInfo()).hidden, true);
  await mark('Reduced motion is static and still expires');

  await seek(24);
  await page.setViewportSize({ width: 980, height: 750 });
  await page.waitForTimeout(50); await expectAligned();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(50); await expectAligned();
  await screenshot('a003-24-outline-mobile.png');
  // Explicitly force image-element letterboxing while retaining current source.
  await page.locator('#work-canvas').evaluate(image => { image.style.width = '270px'; image.style.height = '350px'; });
  await page.setViewportSize({ width: 400, height: 844 });
  await page.waitForTimeout(50); await expectAligned();
  await mark('Live resize, mobile viewport, and object-fit letterboxing stay aligned');
  await page.locator('#work-canvas').evaluate(image => { image.style.width = ''; image.style.height = ''; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Failing latest load clears observer chrome, then retry restores only the
  // requested frame. It cannot resume a stopped playback timer.
  let failOnce = true;
  const failureRoute = async route => { if (failOnce && new URL(route.request().url()).searchParams.get('step') === '24') { failOnce = false; await route.abort(); } else await route.continue(); };
  await page.route('**/render.png?**', failureRoute);
  await dispatchStep(24);
  await page.waitForSelector('#work-stage.has-error');
  assert.equal((await outlineInfo()).hidden, true);
  await page.locator('#canvas-message button').click(); await waitFrame(24); await expectOutline(24);
  await page.unroute('**/render.png?**', failureRoute);
  await mark('Failed load clears outline; retry commits the right frame');

  // Exercise the persisted page lifecycle even when the browser's automation
  // configuration disables its back/forward cache. Leave during a decoded
  // image wait, discard that request, then restore the selected action.
  await seek(36);
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.originalImageDecode = decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (this.src.includes('step=24&')) await new Promise(resolve => { window.releaseHiddenDecode = resolve; });
    };
  });
  await dispatchStep(24);
  await page.waitForFunction(() => Boolean(window.releaseHiddenDecode));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.releaseHiddenDecode();
    HTMLImageElement.prototype.decode = window.originalImageDecode;
  });
  await page.waitForTimeout(50);
  assert.equal((await outlineInfo()).hidden, true);
  assert.equal(new URL(await page.locator('#work-canvas').getAttribute('src'), origin).searchParams.get('step'), '36');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await waitFrame(24); await expectOutline(24);
  await mark('Persisted page restoration recovers an invalidated in-flight seek and clears busy state');

  await page.locator('#playback-speed').selectOption('8');
  await seek(22); await page.locator('#play-work').click();
  await page.waitForFunction(() => Number(document.querySelector('#work-timeline').value) >= 25);
  await page.locator('#play-work').click();
  const paused = await page.locator('#work-timeline').inputValue();
  await page.waitForTimeout(220);
  assert.equal(await page.locator('#work-timeline').inputValue(), paused);
  await page.locator('#play-work').click();
  await page.locator('#playback-speed').selectOption('4');
  await page.waitForFunction(() => Number(document.querySelector('#work-timeline').value) >= 27);
  await dispatchStep(24); await dispatchStep(36); await dispatchStep(39); await waitFrame(39); await expectOutline(39);
  await page.locator('#playback-speed').selectOption('8');
  await page.locator('#play-work').click();
  await waitFrame(finalStep);
  await page.waitForFunction(() => document.querySelector('#play-work').textContent.includes('Play'));
  assert.equal((await outlineInfo()).hidden, true);
  await page.locator('#play-work').click(); await waitFrame(0);
  assert.equal((await outlineInfo()).hidden, true);
  await page.locator('#play-work').click();
  await mark('Fast playback, pause/restart, speed changes, rapid seek, final, and replay remain synchronized');

  const samples = await page.evaluate(() => window.playbackSamples);
  assert.ok(samples.length > 100);
  assert.deepEqual(samples.filter(sample => sample.outlineStep !== null && sample.outlineStep !== sample.imageStep), []);
  assert.ok(samples.every(sample => sample.opacity === '1' && sample.imageCount === 1));
  assert.equal(digest(await responseBytes(`${archivePath}/project`)), digest(projectBefore));
  assert.equal(digest(await responseBytes(`${archivePath}/render.png`)), digest(pngBefore));
  assert.deepEqual(errors, []);
  await mark(`${samples.length} paint samples show matching image/outline and full image opacity; saved project and final PNG unchanged; no page errors`);
  await writeFile(new URL('playback-outline-qa.json', output), JSON.stringify({ origin, checks, paintSamples: samples.length, projectSHA256: digest(projectBefore), finalPNGSHA256: digest(pngBefore), errors }, null, 2));
} finally {
  await browser.close();
}
