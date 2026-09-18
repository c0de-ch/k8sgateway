// Renders auth-flow.html frame by frame with Playwright's Chromium and assembles
// docs/images/auth-flow.gif with ffmpeg. Run from the repo root after
// `cd e2e && npm install && npx playwright install chromium`:
//   node docs/images/animation/render.mjs
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../e2e/package.json'));
const { chromium } = require('playwright');

const FPS = Number(process.env.FPS ?? 10);
const OUT = process.env.OUT ?? path.join(here, '..', 'auth-flow.gif');
const frames = path.join(process.env.TMPDIR ?? '/tmp', 'k8sgateway-auth-flow-frames');
rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.join(here, 'auth-flow.html'));
const total = await page.evaluate(() => window.TOTAL);
const n = Math.round(total * FPS);
for (let i = 0; i <= n; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
}
await browser.close();
// two-pass palette for a small, clean GIF
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png'),
  '-vf', `fps=${FPS},split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  '-loop', '0', OUT]);
console.log(`wrote ${OUT} (${n + 1} frames at ${FPS} fps)`);
