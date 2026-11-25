import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:8123/');
const r = await page.evaluate(async () => {
  const p = window.__cbz.project;
  const groups = [];
  for (let c = 1; c <= 80; c++) {
    const entries = [];
    for (let i = 1; i <= 100; i++) entries.push({ path: `Comic/Chapter ${c}/${String(i).padStart(3, '0')}.jpg`, reldir: `Chapter ${c}`, name: `${String(i).padStart(3, '0')}.jpg`, stem: String(i).padStart(3, '0'), ext: 'jpg', size: 1000, key: `k${c}-${i}`, read: async () => new Blob(['x']), probe: async () => {} });
    groups.push({ name: `Chapter ${c}`, entries });
  }
  let t = performance.now();
  p.addSources([{ label: 'Big', kind: 'folder', presetName: 'x', groups }], 'big');
  const addMs = performance.now() - t;
  t = performance.now();
  const ids = p.order.slice(3000, 3010);
  p.moveItems(ids, p.order[10], undefined, 'move');
  const moveMs = performance.now() - t;
  const { planExport, defaultExportOptions } = await import('/js/export.js');
  t = performance.now();
  const plan = planExport(p, defaultExportOptions(p));
  const planMs = performance.now() - t;
  const { proposeSort } = await import('/js/ordering.js');
  t = performance.now();
  proposeSort(p, 'natural-name', 'all');
  const sortMs = performance.now() - t;
  return { n: p.size, addMs: Math.round(addMs), moveMs: Math.round(moveMs), planMs: Math.round(planMs), sortMs: Math.round(sortMs), rowsInDom: document.querySelectorAll('.row').length, errors: plan.errors };
});
console.log(JSON.stringify(r));
await page.locator('#page-list').evaluate((el) => { el.scrollTop = 200000; });
await page.waitForTimeout(300);
console.log('rows in DOM after scroll:', await page.locator('.row').count(), 'errors:', JSON.stringify(errs));
await browser.close();
