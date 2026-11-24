// Rasterize SVG/HTML files to PNG (with alpha) using headless Chromium via Playwright.
//
// Driven by scripts/make_icons.py, but usable directly:
//   NODE_PATH=/opt/node22/lib/node_modules node scripts/icon/render.cjs jobs.json
// where jobs.json is [{"in": "a.svg", "out": "a.png", "width": 1024, "height": 1024}, ...]
// or, for a single file:
//   NODE_PATH=... node scripts/icon/render.cjs in.svg out.png 1024 [height]
//
// SVG inputs are wrapped in a zero-margin HTML page and drawn at exactly width x height
// CSS pixels (deviceScaleFactor 1), so every icon size is rendered from vectors natively.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const args = process.argv.slice(2);
  let jobs;
  if (args.length === 1) {
    jobs = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  } else {
    const [inp, out, w, h] = args;
    jobs = [{ in: inp, out, width: +w, height: +(h || w) }];
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
  for (const job of jobs) {
    const width = job.width, height = job.height || job.width;
    await page.setViewportSize({ width, height });
    const file = path.resolve(job.in);
    if (file.endsWith('.svg')) {
      const svg = fs.readFileSync(file, 'utf8');
      await page.setContent(
        `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${width}px;height:${height}px}</style></head><body>${svg}</body></html>`,
        { waitUntil: 'load' });
    } else {
      await page.goto('file://' + file, { waitUntil: 'load' });
    }
    await page.screenshot({ path: job.out, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
