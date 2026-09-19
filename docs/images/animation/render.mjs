// Renders an animation scene frame by frame with Playwright's Chromium and
// assembles a GIF (8 fps) and an MP4 video (H.264, full frame rate - pause,
// scrub, change the speed) with ffmpeg. Run from the repo root after
// `cd e2e && npm install && npx playwright install chromium`:
//   node docs/images/animation/render.mjs                                   # auth-flow.html -> docs/images/auth-flow.{gif,mp4}
//   node docs/images/animation/render.mjs login-flow-k8s.html login-flow-k8s.gif
// Environment: FPS (captured frames per second, default 16), GIF_FPS (default 8).
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../e2e/package.json'));
const { chromium } = require('playwright');

const FPS = Number(process.env.FPS ?? 16);
const GIF_FPS = Number(process.env.GIF_FPS ?? 8);
// Scene and output: given as paths (relative to the current directory) or as bare
// file names inside docs/images/animation (scene) and docs/images (output).
const sceneArg = process.argv[2] ?? 'auth-flow.html';
const SCENE = sceneArg.includes('/') ? path.resolve(sceneArg) : path.join(here, sceneArg);
const outArg = process.argv[3] ?? path.basename(SCENE).replace(/\.html$/, '.gif');
const OUT = outArg.includes('/') ? path.resolve(outArg) : path.join(here, '..', outArg);
const WANT_GIF = process.env.GIF !== '0';   // GIF=0 -> video only (long presentations)
const frames = path.join(process.env.TMPDIR ?? '/tmp', 'k8sgateway-frames-' + path.basename(SCENE).replace(/\.html$/, ''));
rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 1 });
await page.goto('file://' + SCENE);
const size = await page.evaluate(() => { const r = document.querySelector('svg').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
await page.setViewportSize({ width: size.w, height: size.h });
const total = await page.evaluate(() => window.TOTAL);
const n = Math.round(total * FPS);
for (let i = 0; i <= n; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
}
await browser.close();
// two-pass palette for a small, clean GIF (at GIF_FPS)
if (WANT_GIF) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
  '-vf', `fps=${GIF_FPS},split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  '-loop', '0', OUT]);
if (WANT_GIF) console.log(`wrote ${OUT} (${Math.round((n + 1) * GIF_FPS / FPS)} frames at ${GIF_FPS} fps)`);
// H.264 video at the full frame rate: pause, scrub and slow down in any player / on GitHub
const MP4 = OUT.replace(/\.gif$/, '.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', MP4]);
console.log(`wrote ${MP4} (${n + 1} frames at ${FPS} fps)`);
