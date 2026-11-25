import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SP = process.argv[2];
const log = (...a) => console.log(...a);
const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.addInitScript(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
await page.goto('http://localhost:8123/');
const state = () => page.evaluate(() => { const p = window.__cbz.project; return { n: p.size, names: p.order.map((id) => p.item(id).path), groups: p.groups().map((g) => [g.name, g.ids.length]) }; });

// 1. folder import (has a notes.txt -> review dialog)
await page.setInputFiles('#input-folder', SP + '/fx/Comic');
await page.waitForSelector('dialog[open]');
log('dialog title:', await page.textContent('dialog[open] h2'));
const dlgText = await page.textContent('dialog[open]');
log('mentions notes.txt skipped:', dlgText.includes('notes.txt') || dlgText.includes('not imported'));
log('suggests numbered chapters:', dlgText.includes('Numbered chapters'));
await page.click('dialog[open] button.primary');
await page.waitForSelector('dialog[open]', { state: 'detached' });
let s = await state();
log('after folder import:', s.n, JSON.stringify(s.groups));
await page.screenshot({ path: SP + '/shot-desktop.png' });

// 2. drag a page: first row -> after 5th item (rows: header,3 items,header,3...)
const rows = await page.$$eval('.row', (r) => r.map((x) => x.className + '|' + x.textContent.slice(0, 20)));
log('rows rendered:', rows.length);
const box = await page.locator('.row.item').first().boundingBox();
const lbox = await page.locator('#page-list').boundingBox();
const before = (await state()).names.slice();
await page.mouse.move(box.x + 120, box.y + 20);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + 60, { steps: 4 });
await page.mouse.move(box.x + 120, lbox.y + 44 * 6 + 5, { steps: 6 });
log('drop line visible:', await page.locator('.drop-line').isVisible());
await page.mouse.up();
s = await state();
log('order changed by drag:', JSON.stringify(before) !== JSON.stringify(s.names), '| first now:', s.names[0]);
await page.click('#btn-undo');
s = await state();
log('undo restores:', JSON.stringify(s.names) === JSON.stringify(before));

// 3. group drag: move 'Chapter 10' group header to the top
const hdr = page.locator('.row.group', { hasText: 'Chapter 10' });
const hb = await hdr.boundingBox();
await page.mouse.move(hb.x + 60, hb.y + 20);
await page.mouse.down();
await page.mouse.move(hb.x + 60, hb.y - 40, { steps: 4 });
await page.mouse.move(hb.x + 60, lbox.y + 4, { steps: 10 });
await page.mouse.up();
s = await state();
log('group order after drag:', JSON.stringify(s.groups.map((g) => g[0])));
await page.click('#btn-undo');

// 4. add CBZ + loose images
await page.setInputFiles('#input-files', [SP + '/fx/Vol 1.cbz']);
await page.waitForTimeout(400);
let open = await page.$('dialog[open]');
if (open) { log('cbz dialog:', (await page.textContent('dialog[open]')).slice(0, 160).replace(/\s+/g, ' ')); await page.click('dialog[open] button.primary'); await page.waitForSelector('dialog[open]', { state: 'detached' }); }
await page.setInputFiles('#input-files', [1, 2, 3, 4].map((i) => `${SP}/fx/loose/x${i}.png`));
await page.waitForTimeout(400);
open = await page.$('dialog[open]');
if (open) { await page.click('dialog[open] button.primary'); await page.waitForSelector('dialog[open]', { state: 'detached' }); }
s = await state();
log('mixed project:', s.n, JSON.stringify(s.groups));

// 5. text order
await page.click('#btn-text-order');
await page.fill('#order-text', '  x3.PNG\nX1\nnope.png\nx3\nVol/002.png');
await page.waitForTimeout(400);
const t = await page.textContent('dialog[open]');
log('text-order reports unmatched:', t.includes('Unmatched lines (1)'), '| duplicates:', t.includes('Duplicate references (1)'), '| remaining listed:', t.includes('Pages not in your list'));
log('apply disabled until ack:', await page.locator('dialog[open] button.primary').isDisabled());
await page.check('#ack-problems');
await page.click('dialog[open] button.primary');
await page.waitForSelector('dialog[open]', { state: 'detached' });
s = await state();
log('first pages after text order:', s.names.slice(0, 3).join(' , '));
await page.click('#btn-undo');

// 6. sort dialog preview + cancel
await page.click('#btn-sort');
await page.waitForSelector('dialog[open] #sort-method');
await page.selectOption('#sort-method', 'reverse');
await page.waitForTimeout(200);
log('sort summary:', await page.textContent('dialog[open] .summary'));
await page.click('dialog[open] button:has-text("Cancel")');
await page.waitForSelector('dialog[open]', { state: 'detached' });

// 7. export (download fallback)
await page.click('#btn-export');
await page.waitForSelector('dialog[open] #out-name');
await page.waitForTimeout(600);
log('export msgs:', (await page.textContent('dialog[open] .messages')).replace(/\s+/g, ' ').slice(0, 300));
await page.screenshot({ path: SP + '/shot-export.png' });
const warnBox = await page.locator('#ack-problems, dialog[open] .check input[type=checkbox]').count();
const goBtn = page.locator('dialog[open] .footer-set .btn.primary').first();
if (await goBtn.isDisabled()) { await page.locator('dialog[open] label.check:has-text("reviewed these warnings") input').check(); }
const [dl] = await Promise.all([page.waitForEvent('download'), goBtn.click()]);
await dl.saveAs(SP + '/out.cbz');
await page.waitForSelector('dialog[open] .msg.ok');
log('export result:', (await page.textContent('dialog[open] .msg.ok')).slice(0, 140));
await page.click('dialog[open] button:has-text("Close")');

// 8. mobile layout
await page.setViewportSize({ width: 390, height: 780 });
await page.waitForTimeout(300);
await page.screenshot({ path: SP + '/shot-mobile.png' });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
log('mobile horizontal overflow:', overflow);

log('errors:', JSON.stringify(errors));
await browser.close();
