import { createRequire } from 'node:module';
import fs from 'node:fs';
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
// in-memory File System Access mocks
await page.addInitScript(() => {
  window.__saved = {}; window.__dirs = { existing: ['0002.png'] };
  window.showSaveFilePicker = async (o) => ({ name: o.suggestedName, async getFile() { return new File([window.__saved[o.suggestedName]], o.suggestedName); },
    async createWritable() { const parts = []; return { async write(b) { parts.push(b); }, async close() { window.__saved[o.suggestedName] = new Blob(parts); }, async abort() {} }; } });
  const mkdir = (path, files) => ({ name: 'out', async getDirectoryHandle(n, { create }) { const d = mkdir(path + n + '/', files); return d; },
    async getFileHandle(n, { create } = {}) { const key = path + n; if (!create && !files.has(key)) { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; }
      return { async createWritable() { const parts = []; return { async write(b) { parts.push(b); }, async close() { files.set(key, parts.length); } }; } }; } });
  window.showDirectoryPicker = async () => { const files = new Map(window.__dirs.existing.map((n) => [n, 1])); window.__files = files; return mkdir('', files); };
});
await page.goto('http://localhost:8123/');
const state = () => page.evaluate(() => { const p = window.__cbz.project; return { n: p.size, names: p.order.map((id) => p.item(id).name), paths: p.order.map((id) => p.item(id).path), groups: p.groups().map((g) => [g.name, g.ids.length]) }; });
const closeDlg = async () => { await page.click('dialog[open] button.primary'); await page.waitForSelector('dialog[open]', { state: 'detached' }); };

await page.setInputFiles('#input-folder', SP + '/fx/Comic');
await page.waitForSelector('dialog[open]'); await closeDlg();
await page.setInputFiles('#input-files', [SP + '/fx/Vol 1.cbz']);
await page.waitForTimeout(500);
if (await page.$('dialog[open]')) await closeDlg();
log('thumb layout ok (no .thumb.empty):', await page.locator('.thumb.empty').count() === 0);

// keyboard: focus list, arrow down x2, Alt+ArrowDown moves page down
await page.click('.row.item >> nth=0');
await page.keyboard.press('ArrowDown');
const sel = await page.textContent('#sel-info');
await page.keyboard.press('Alt+ArrowDown');
let s = await state();
log('selection info:', sel, '| after Alt+Down, 2nd page now at:', s.paths.indexOf('Comic/Chapter 1/002.png') + 1);
await page.keyboard.press('Control+z');
// group ops via UI
await page.click('.row.item >> nth=0');
await page.keyboard.down('Shift'); await page.click('.row.item >> nth=1'); await page.keyboard.up('Shift');
await page.click('#btn-group');
await page.fill('#prompt-input', 'Prologue'); await page.click('dialog[open] button.primary');
await page.waitForSelector('dialog[open]', { state: 'detached' });
s = await state(); log('groups after create:', JSON.stringify(s.groups));
await page.locator('.row.group', { hasText: 'Prologue' }).locator('button[data-act=rename]').click();
await page.fill('#prompt-input', 'Intro/Prologue'); await page.click('dialog[open] button.primary');
await page.waitForSelector('dialog[open]', { state: 'detached' });
s = await state(); log('renamed (originals untouched):', s.groups[0][0], '|', s.names[0]);
await page.click('#btn-undo'); await page.click('#btn-undo');

// structure dialog
await page.locator('.source', { hasText: 'Vol 1.cbz' }).locator('button:has-text("Structure")').click();
await page.waitForSelector('dialog[open] select');
await page.selectOption('dialog[open] select', 'universal');
await page.waitForTimeout(100);
log('structure dialog warns:', (await page.textContent('dialog[open]')).includes('best guess'), '| literal null/object text:', /null|\[object/.test(await page.textContent('dialog[open]')));
await page.click('dialog[open] button.primary'); await page.waitForSelector('dialog[open]', { state: 'detached' });
log('issues badge after uncertain structure:', await page.textContent('#issue-count'));

// rules: create, export, invalid import
await page.click('#btn-rules');
await page.click('dialog[open] button:has-text("New rule")');
await page.fill('#r-name', 'My chapters');
await page.selectOption('#r-by', 'pattern');
await page.fill('#r-gpat', '(');
await page.click('dialog[open] >> nth=-1 >> button:has-text("Save rule")');
log('invalid regex message:', (await page.textContent('dialog[open] >> nth=-1 >> .messages')).slice(0, 90));
await page.fill('#r-gpat', 'chapter[ _-]*(\\d+)');
await page.click('dialog[open] >> nth=-1 >> button:has-text("Save rule")');
await page.waitForTimeout(300);
log('rule listed:', (await page.textContent('.rule-list')).includes('My chapters'));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.rule button:has-text("Export")')]);
await dl.saveAs(SP + '/rule.json');
log('rule json:', fs.readFileSync(SP + '/rule.json', 'utf8').replace(/\s+/g, ' ').slice(0, 110));
await page.click('dialog[open] summary');
await page.fill('dialog[open] textarea', '{"schema":"nope","version":3}');
await page.click('dialog[open] button:has-text("Import pasted JSON")');
await page.waitForTimeout(300);
log('bad import toast:', (await page.textContent('.toasts')).slice(0, 140));
await page.fill('dialog[open] textarea', fs.readFileSync(SP + '/rule.json', 'utf8'));
await page.click('dialog[open] button:has-text("Import pasted JSON")');
await page.waitForTimeout(200);
log('rules after reimport:', await page.locator('.rule').count());
await page.click('dialog[open] button:has-text("Close")');
await page.waitForSelector('dialog[open]', { state: 'detached' });
// saved rule offered at import
await page.setInputFiles('#input-folder', SP + '/fx/loose');
await page.waitForTimeout(500);
if (await page.$('dialog[open]')) { log('saved rule in select:', (await page.textContent('dialog[open] select')).includes('My chapters')); await page.click('dialog[open] button:has-text("Cancel")'); await page.waitForSelector('dialog[open]', { state: 'detached' }); }

// export through FSA mock
await page.click('#btn-export');
await page.waitForSelector('dialog[open] #out-name'); await page.waitForTimeout(500);
await page.selectOption ? null : null;
await page.check('dialog[open] input[name=structure][value=flat]');
await page.waitForTimeout(200);
const ackBox = page.locator('dialog[open] label:has-text("reviewed these warnings") input');
if (await ackBox.isVisible()) await ackBox.check();
await page.click('dialog[open] .footer-set .btn.primary >> nth=0');
await page.waitForSelector('dialog[open] .msg.ok >> visible=true', { timeout: 15000 });
log('FSA save result:', (await page.textContent('dialog[open] .msg.ok >> visible=true')).slice(0, 120));
const saved = await page.evaluate(async () => { const o = {}; for (const [k, b] of Object.entries(window.__saved)) o[k] = Array.from(new Uint8Array(await b.arrayBuffer())); return o; });
const name = Object.keys(saved)[0]; fs.writeFileSync(SP + '/fsa.cbz', Buffer.from(saved[name]));
log('saved name:', name);
await page.click('dialog[open] button:has-text("Close")');

// extraction through directory mock, with an existing file
await page.click('#btn-export'); await page.waitForSelector('dialog[open] #out-name'); await page.waitForTimeout(400);
await page.check('dialog[open] input[name=format][value=images]');
await page.check('dialog[open] input[name=structure][value=flat]');
await page.check('dialog[open] input[name=naming][value=sequence]');
await page.waitForTimeout(200);
const ack2 = page.locator('dialog[open] label:has-text("reviewed these warnings") input');
if (await ack2.isVisible()) await ack2.check();
await page.click('dialog[open] .footer-set .btn.primary >> nth=0');
await page.waitForSelector('dialog[open] button:has-text("Keep existing")');
log('overwrite prompt shown:', (await page.locator('dialog[open]').last().textContent()).includes('already'));
await page.click('button:has-text("Keep existing")');
await page.waitForSelector('dialog[open] .msg.ok >> visible=true', { timeout: 15000 });
log('extract result:', (await page.textContent('dialog[open] .msg.ok >> visible=true')).slice(0, 120));
log('files written:', JSON.stringify(await page.evaluate(() => [...window.__files.keys()].slice(0, 5))), 'existing kept as-is value:', await page.evaluate(() => window.__files.get('0002_002.png')));
await page.click('dialog[open] button:has-text("Close")');

// offline: service worker caches the app
await page.waitForTimeout(500);
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await navigator.serviceWorker.ready; return !!r; });
log('service worker registered:', sw);
await ctx.setOffline(true);
const off = await ctx.newPage();
await off.goto('http://localhost:8123/');
log('offline load title:', await off.title(), '| toolbar present:', await off.locator('#btn-export').count());
await ctx.setOffline(false);
log('errors:', JSON.stringify(errors));
await browser.close();
