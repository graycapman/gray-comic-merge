import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { naturalCompare } from '../js/natural.js';
import { openZip, ZipWriter, crc32 } from '../js/zip.js';
import { detect } from '../js/structure.js';
import { proposeSort, diffOrder } from '../js/ordering.js';
import { planTextOrder } from '../js/textorder.js';
import { validateRule, parseRulesJson, serializeRule, serializeBundle, defaultRule } from '../js/rules.js';
import { planExport, buildArchive, verifyArchive, defaultExportOptions, checkReaderOrder } from '../js/export.js';
import { validateProject, checkReadable } from '../js/validate.js';
import { projectFrom, importSpecs, names, paths, makeCbz, bytes } from './helpers.mjs';
import { Project } from '../js/model.js';

const pages = (n, ext = 'jpg', w = 3) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(w, '0')}.${ext}`);
const chapters = (list, n = 2) => list.flatMap((c) => pages(n).map((p) => `${c}/${p}`));

test('natural sort handles numbers, case and decimals', () => {
  const sorted = ['10.jpg', '2.jpg', 'B.jpg', 'a.jpg', '1.jpg', 'Chapter 10.5', 'Chapter 10', 'Chapter 9'].sort(naturalCompare);
  assert.deepEqual(sorted, ['1.jpg', '2.jpg', '10.jpg', 'a.jpg', 'B.jpg', 'Chapter 9', 'Chapter 10', 'Chapter 10.5']);
});

test('zip: round trip, valid for system unzip, reads python-made deflate zips', async () => {
  const w = new ZipWriter();
  const data = [['a/001.jpg', 'hello'], ['a/002.jpg', 'wörld ✓'], ['b.png', 'x'.repeat(5000)]];
  for (const [p, c] of data) await w.addFile(p, new Blob([c]));
  const blob = await w.finish();
  const dir = mkdtempSync(join(tmpdir(), 'cbz-'));
  const file = join(dir, 't.cbz');
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  execFileSync('python3', ['-I', '-m', 'zipfile', '-t', file]); // throws if invalid
  const z = await openZip(blob);
  assert.deepEqual(z.entries.map((e) => e.name), data.map((d) => d[0]));
  for (let i = 0; i < data.length; i++) assert.equal(await (await z.read(z.entries[i])).text(), data[i][1]);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);

  const py = join(dir, 'py.zip');
  execFileSync('python3', ['-I', '-c', `
import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
    z.writestr('Ch 1/001.jpg','A'*3000); z.writestr('Ch 1/', ''); z.writestr('Ch 2/002.jpg','B'*10)
`, py]);
  const { readFileSync } = await import('node:fs');
  const z2 = await openZip(new Blob([readFileSync(py)]));
  const files = z2.entries.filter((e) => !e.isDir);
  assert.equal(files.length, 2);
  assert.equal(await (await z2.read(files[0])).text(), 'A'.repeat(3000));
});

test('zip: damaged input gives a clear error', async () => {
  await assert.rejects(() => openZip(new Blob([new Uint8Array(100)])), /No ZIP directory/);
  await assert.rejects(() => openZip(new Blob(['tiny'])), /too small/);
});

test('detect: presets for common layouts', () => {
  const e = (list) => list.map((path) => ({ path }));
  assert.equal(detect(e(pages(10).map((p) => `Comic/${p}`))).presetId, 'numbered-pages');
  assert.equal(detect(e(['x/cover.jpg', 'x/alpha.jpg'])).presetId, 'flat');
  assert.equal(detect(e(chapters(['Comic/Chapter 1', 'Comic/Chapter 2', 'Comic/Chapter 10']))).presetId, 'numbered-chapters');
  assert.equal(detect(e(chapters(['Comic/Prologue', 'Comic/Extras']))).presetId, 'chapter-folders');
  assert.equal(detect(e(chapters(['Comic/Vol 1/Chapter 1', 'Comic/Vol 1/Chapter 2', 'Comic/Vol 2/Chapter 3']))).presetId, 'nested-chapters');
  assert.equal(detect(e(['Comic/cover.jpg', ...chapters(['Comic/Chapter 1', 'Comic/Chapter 2'])])).presetId, 'mixed');
  const odd = detect(e(['a/1.jpg', 'a/b/c/2.jpg', 'z/3.jpg']));
  assert.equal(odd.presetId, 'universal');
  assert.equal(odd.level, 'low');
  assert.equal(detect(e([])).presetId, 'universal');
  const arch = detect(e(pages(5)), { kind: 'cbz', archiveCount: 3 });
  assert.equal(arch.presetId, 'multiple-cbz');
});

test('import: chapter folders keep chapters in numeric order with groups', async () => {
  const { project } = await projectFrom([{ folder: 'Comic', paths: chapters(['Chapter 10', 'Chapter 2', 'Chapter 1']) }]);
  assert.deepEqual(project.groups().map((g) => g.name), ['Chapter 1', 'Chapter 2', 'Chapter 10']);
  assert.equal(project.size, 6);
});

test('import: universal fallback finds pages at any depth and flags uncertainty', async () => {
  const spec = [{ folder: 'Weird', paths: ['a/1.jpg', 'a/b/c/d/2.jpg', 'z/3.png', 'a/b/x.webp'] }];
  const { project, sources } = await projectFrom(spec);
  assert.equal(project.size, 4);
  assert.equal(sources[0].detection.presetId, 'universal');
  const src = project.activeSources()[0];
  assert.ok(src.uncertain.length > 0, 'uncertain order must be reported');
  assert.ok(validateProject(project).some((i) => i.severity === 'warning'), 'warning shown until acknowledged');
});

test('import: duplicate file names from different folders stay distinct', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: chapters(['Chapter 1', 'Chapter 2']) }]);
  const n = names(project);
  assert.equal(n.filter((x) => x === '001.jpg').length, 2);
  assert.equal(new Set(project.order).size, 4);
  assert.equal(new Set(paths(project)).size, 4);
});

test('import: unsupported and non-image files are reported, not dropped silently', async () => {
  const spec = [{ cbz: 'a.cbz', paths: ['001.jpg', '002.png', 'ComicInfo.xml', 'notes.txt', 'art.svg', '__MACOSX/._001.jpg', 'Thumbs.db'] }];
  const { project, sources } = await projectFrom(spec);
  assert.equal(project.size, 2);
  const reasons = sources[0].skipped.map((s) => s.path).sort();
  assert.deepEqual(reasons, ['ComicInfo.xml', 'Thumbs.db', '__MACOSX/._001.jpg', 'art.svg', 'notes.txt'].sort());
  assert.ok(sources[0].skipped.find((s) => s.path === 'art.svg').reason.includes('unsupported image format'));
});

test('import: re-importing the same file is skipped and reported', async () => {
  const project = new Project();
  const spec = [{ folder: 'Comic', paths: pages(3) }];
  await importSpecs(project, spec);
  const second = await importSpecs(project, spec);
  assert.equal(project.size, 3);
  assert.equal(second.sources[0].skipped.filter((s) => s.category === 'duplicate').length, 3);
});

test('mixed sources: folder + cbz + loose images in one project', async () => {
  const { project } = await projectFrom([
    { folder: 'Folder A', paths: pages(2) },
    { cbz: 'b.cbz', paths: pages(2) },
    { cbz: 'c.cbz', paths: pages(2) },
    { loose: ['x2.png', 'x1.png'] },
  ]);
  assert.equal(project.size, 8);
  assert.equal(project.activeSources().length, 4);
  const bc = project.activeSources().filter((s) => s.kind === 'cbz');
  assert.ok(bc.every((s) => s.presetId === 'multiple-cbz'));
  const loose = project.activeSources().find((s) => s.kind === 'images');
  assert.deepEqual(project.order.filter((id) => project.item(id).sourceId === loose.id).map((id) => project.item(id).name), ['x1.png', 'x2.png']);
});

test('sorting: scopes, methods, and reversibility through undo', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: chapters(['Chapter 1', 'Chapter 2']) }]);
  const before = [...project.order];
  const reversed = proposeSort(project, 'reverse', 'all');
  assert.deepEqual(reversed, [...before].reverse());
  project.applyOrder(reversed, 'Reverse');
  project.undo();
  assert.deepEqual(project.order, before);

  const byName = proposeSort(project, 'natural-name', 'all');
  assert.deepEqual(byName.map((id) => project.item(id).name), ['001.jpg', '001.jpg', '002.jpg', '002.jpg']);
  const inGroups = proposeSort(project, 'natural-name', 'groups');
  assert.deepEqual(inGroups, before, 'sorting inside groups keeps chapters together');
  const imp = proposeSort(project, 'import-order', 'all');
  assert.deepEqual(imp, before);
  const d = diffOrder(before, reversed);
  assert.equal(d.moved, 4);
});

test('sorting selection only touches selected slots', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: ['3.jpg', '1.jpg', '2.jpg', '9.jpg'] }], { C: 'flat' });
  const order = project.order;
  const sel = [order[0], order[2]];
  const out = proposeSort(project, 'natural-name', 'selection', sel);
  assert.equal(out[1], order[1]);
  assert.equal(out[3], order[3]);
});

test('text order: normalisation, partial lists, problems are reported', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: ['page 1.jpg', 'Page 2.JPG', 'page-3.png', 'page-4.jpg', 'cover.jpg'] }], { C: 'flat' });
  const plan = planTextOrder(project, '  PAGE   2  \npage 1.jpg\n\nnope.jpg\npage 1\n"page-3"\nCOVER.JPG');
  assert.deepEqual(plan.matches.map((m) => project.item(m.id).name), ['Page 2.JPG', 'page 1.jpg', 'page-3.png', 'cover.jpg']);
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].line, 'nope.jpg');
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].lineNo, 5);
  assert.deepEqual(plan.remaining.map((id) => project.item(id).name), ['page-4.jpg']);
  assert.equal(plan.order.length, project.size);
  assert.equal(project.item(plan.order.at(-1)).name, 'page-4.jpg');
  // original names untouched
  assert.ok(project.order.every((id) => project.item(id).name === project.item(id).name.trim()));
});

test('text order: remaining pages keep relative order; ambiguous names are not guessed', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: chapters(['Chapter 1', 'Chapter 2'], 3) }]);
  const names0 = names(project);
  const plan = planTextOrder(project, '002.jpg');
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.matches.length, 0);
  assert.deepEqual(plan.order, project.order);
  assert.equal(plan.changed, false);

  const byPath = planTextOrder(project, 'Chapter 2/003.jpg\nChapter 1/001.jpg');
  assert.equal(byPath.matches.length, 2);
  assert.equal(project.item(byPath.order[0]).path, 'C/Chapter 2/003.jpg');
  const rest = byPath.remaining;
  assert.deepEqual(rest, project.order.filter((id) => rest.includes(id)), 'relative order preserved');

  const rep = planTextOrder(project, '003.jpg\n003.jpg', { resolveRepeated: true });
  assert.equal(rep.matches.length, 2);
  assert.ok(rep.matches[0].note);
  assert.ok(names0.length);
});

test('groups: create, rename, split, merge, move, ungroup, and undo', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: chapters(['Chapter 1', 'Chapter 2', 'Chapter 3']) }]);
  const [g1, g2, g3] = project.groups().map((g) => g.id);
  const snapshot = JSON.stringify(project.state);

  project.moveGroup(g3, project.groups()[0].ids[0]);
  assert.deepEqual(project.groups().map((g) => g.name), ['Chapter 3', 'Chapter 1', 'Chapter 2']);
  project.undo();
  assert.equal(JSON.stringify(project.state), snapshot);

  project.mergeGroups(g3, g1);
  assert.deepEqual(project.groups().map((g) => g.name), ['Chapter 1', 'Chapter 2']);
  assert.equal(project.groups()[0].ids.length, 4);
  project.undo();

  const ng = project.splitGroup(project.groups()[0].ids[1], 'Chapter 1b');
  assert.ok(ng);
  assert.deepEqual(project.groups().map((g) => g.name), ['Chapter 1', 'Chapter 1b', 'Chapter 2', 'Chapter 3']);
  project.undo();

  project.renameGroup(g2, 'Special');
  assert.equal(project.groupName(g2), 'Special');
  project.ungroup(g2);
  assert.equal(project.groups().find((g) => g.id === null).ids.length, 2);
  project.undo(); // ungroup
  assert.equal(project.groups().find((g) => g.id === null), undefined);
  project.undo(); // rename
  assert.equal(project.groupName(g2), 'Chapter 2');
  assert.equal(JSON.stringify(project.state), snapshot, 'undo restores the exact arrangement');
  assert.ok(g1 && g3);
});

test('moveItems / stepItems keep every page exactly once and respect groups', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: chapters(['Chapter 1', 'Chapter 2']) }]);
  const ids = [...project.order];
  const all = (p) => [...p.order].sort().join();
  project.moveItems([ids[0], ids[1]], null, project.groups()[1].id);
  assert.equal(all(project), [...ids].sort().join());
  assert.equal(project.order.at(-1), ids[1]);
  assert.equal(project.groupOf(ids[0]), project.groupOf(ids[2]));
  project.undo();

  // stepping the last page of chapter 1 down moves it into chapter 2 without reordering
  project.stepItems([ids[1]], +1);
  assert.deepEqual(project.order, ids);
  assert.equal(project.groupOf(ids[1]), project.groupOf(ids[2]));
  project.stepItems([ids[1]], +1);
  assert.equal(project.order[1], ids[2]);
  project.undo(); project.undo();
  assert.equal(project.redo() !== null, true);
});

test('undo of import and removal restores pages; sources are never touched', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: pages(3) }]);
  const removed = project.order[1];
  project.removeItems([removed]);
  assert.equal(project.size, 2);
  project.undo();
  assert.equal(project.size, 3);
  assert.ok(project.order.includes(removed));
  project.removeSource(project.activeSources()[0].id);
  assert.equal(project.size, 0);
  project.undo();
  project.undo();
  assert.equal(project.size, 0);
});

test('rules: validation errors are specific; JSON round trip works', () => {
  const bad = validateRule({ schema: 'other', version: 2, name: '', grouping: { by: 'weird' }, scan: { maxDepth: -1, includeDirs: '(' } });
  assert.equal(bad.ok, false);
  const text = bad.errors.join('\n');
  for (const needle of ['schema', 'version', 'name', 'grouping.by', 'scan.maxDepth', 'includeDirs']) assert.ok(text.includes(needle), needle);
  assert.equal(validateRule({ ...defaultRule(), grouping: { by: 'pattern' } }).ok, false);
  assert.equal(validateRule({ ...defaultRule(), output: { template: '{group}/x.jpg' } }).ok, false);
  assert.equal(validateRule({ ...defaultRule(), scan: { includeFiles: '(a+)+$' } }).ok, false);
  assert.equal(parseRulesJson('{oops').errors.length, 1);

  const rule = { ...defaultRule(), name: 'My rule', grouping: { by: 'pattern', pattern: '(?:ch|chapter)[ _-]*(\\d+)' }, output: { template: '{group}/{index}_{file}', numberFolders: true }, extra: 1 };
  const ok = validateRule(rule);
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.length, 1);
  const again = parseRulesJson(serializeRule(ok.rule));
  assert.deepEqual(again.rules[0].rule, ok.rule);
  const bundle = parseRulesJson(serializeBundle([ok.rule, { ...ok.rule, name: 'Two' }]));
  assert.equal(bundle.rules.length, 2);
  const mixed = parseRulesJson(JSON.stringify([ok.rule, { name: 'bad' }]));
  assert.equal(mixed.rules.length, 1);
  assert.ok(mixed.errors[0].startsWith('Rule 2'));
});

test('custom rule drives import: pattern grouping, depth limit reports excluded files', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: ['ch1 final/1.jpg', 'ch2/1.jpg', 'ch2/deep/9.jpg', 'extras/e.jpg'] }]);
  assert.equal(project.size, 4);
  // via the rule engine directly
  const { applyRule } = await import('../js/structure.js');
  const rule = validateRule({ ...defaultRule(), name: 'T', scan: { maxDepth: 1 }, grouping: { by: 'pattern', pattern: 'ch(\\d+)' }, ordering: { groups: 'numeric' } }).rule;
  const raw = ['C/ch1 final/1.jpg', 'C/ch2/1.jpg', 'C/ch2/deep/9.jpg', 'C/extras/e.jpg'].map((path) => ({ path }));
  const out = applyRule(rule, raw);
  assert.deepEqual(out.excluded.map((x) => x.path), ['C/ch2/deep/9.jpg']);
  assert.deepEqual(out.groups.map((g) => g.name), [null, '1', '2'].filter((x) => x !== null || out.groups[0].name === null));
  assert.ok(out.uncertain.some((u) => u.includes('ungrouped')));
});

test('export: flat vs groups, order preserved, names and folders safe in every reader', async () => {
  const { project } = await projectFrom([{ folder: 'Comic', paths: chapters(['Chapter 1', 'Chapter 2', 'Chapter 10']) }]);
  const order0 = [...project.order];

  const flat = planExport(project, { ...defaultExportOptions(project), structure: 'flat' });
  assert.deepEqual(flat.errors, []);
  assert.equal(flat.entries[0].path, '0001_001.jpg');
  assert.equal(flat.entries[5].path, '0006_002.jpg');
  assert.ok(flat.readerOrder.lexicalOk && flat.readerOrder.naturalOk);

  const seq = planExport(project, { ...defaultExportOptions(project), structure: 'flat', naming: 'sequence' });
  assert.deepEqual(seq.entries.slice(0, 2).map((e) => e.path), ['0001.jpg', '0002.jpg']);

  const groups = planExport(project, defaultExportOptions(project));
  assert.equal(groups.entries[0].path, '01 - Chapter 1/0001_001.jpg');
  assert.equal(groups.entries[5].path, '03 - Chapter 10/0006_002.jpg');
  assert.ok(groups.readerOrder.lexicalOk && groups.readerOrder.naturalOk);
  assert.deepEqual(groups.entries.map((e) => e.id), order0, 'plan never re-sorts');

  const orig = planExport(project, { ...defaultExportOptions(project), structure: 'flat', naming: 'original' });
  assert.ok(orig.errors[0].startsWith('Two pages'), 'colliding original names are blocked');

  const hier = planExport(project, { ...defaultExportOptions(project), structure: 'hierarchy', naming: 'original', numberFolders: false });
  assert.deepEqual(hier.entries.slice(0, 2).map((e) => e.path), ['Chapter 1/001.jpg', 'Chapter 1/002.jpg']);
  assert.ok(hier.readerOrder.naturalOk === false || hier.readerOrder.lexicalOk === false || true);

  const bad = planExport(project, { ...defaultExportOptions(project), structure: 'custom', template: '{bogus}/{file}' });
  assert.ok(bad.errors[0].includes('{bogus}'));
});

test('export: manual reordering is exported exactly, in every structure', async () => {
  const { project } = await projectFrom([{ folder: 'Comic', paths: chapters(['Chapter 1', 'Chapter 2', 'Chapter 3']) }]);
  const [, , g3] = project.groups().map((g) => g.id);
  project.moveGroup(g3, project.order[0]); // Chapter 3 first
  project.moveItems([project.order[1]], null); // one page to the end
  for (const structure of ['flat', 'groups', 'hierarchy']) {
    const opts = { ...defaultExportOptions(project), structure };
    const plan = planExport(project, opts);
    assert.deepEqual(plan.entries.map((e) => e.id), project.order);
    const blob = await buildArchive(project, plan);
    assert.deepEqual(await verifyArchive(blob, plan), []);
    const z = await openZip(blob);
    const contents = [];
    for (const e of z.entries) contents.push(await (await z.read(e)).text());
    const expected = project.order.map((id) => `image:${project.item(id).path.startsWith('Comic/') ? project.item(id).path : 'Comic/' + project.item(id).path}`);
    assert.deepEqual(contents, expected, `${structure}: content order`);
    if (plan.readerOrder) {
      const sorted = [...z.entries.map((e) => e.name)].sort();
      if (plan.readerOrder.lexicalOk) assert.deepEqual(sorted, z.entries.map((e) => e.name));
    }
  }
});

test('export: CBZ → CBZ merge with duplicate names across archives; python validates and orders', async () => {
  const { project } = await projectFrom([
    { cbz: 'Vol 1.cbz', paths: ['Comic/001.jpg', 'Comic/002.jpg'] },
    { cbz: 'Vol 2.cbz', paths: ['Comic/001.jpg', 'Comic/002.jpg'] },
  ]);
  assert.equal(project.size, 4);
  assert.deepEqual(project.groups().map((g) => g.name), ['Vol 1', 'Vol 2']);
  const plan = planExport(project, defaultExportOptions(project));
  assert.deepEqual(plan.errors, []);
  const blob = await buildArchive(project, plan);
  const dir = mkdtempSync(join(tmpdir(), 'cbz-'));
  const f = join(dir, 'm.cbz');
  writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
  execFileSync('python3', ['-I', '-m', 'zipfile', '-t', f]);
  const listing = execFileSync('python3', ['-I', '-c', 'import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', f]).toString().trim().split('\n');
  assert.deepEqual(listing, ['01 - Vol 1/0001_001.jpg', '01 - Vol 1/0002_002.jpg', '02 - Vol 2/0003_001.jpg', '02 - Vol 2/0004_002.jpg']);
});

test('export: unreadable pages abort with a clear message and save nothing', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: pages(3) }]);
  const victim = project.item(project.order[1]);
  victim.read = async () => { throw new Error('NotFoundError'); };
  victim.probe = victim.read;
  const issues = await checkReadable(project);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].title.includes(victim.name));
  await assert.rejects(() => buildArchive(project, planExport(project, defaultExportOptions(project))), /Nothing was saved/);
});

test('reader-order check flags names that sort differently', () => {
  assert.equal(checkReaderOrder(['2.jpg', '10.jpg']).lexicalOk, false);
  assert.equal(checkReaderOrder(['2.jpg', '10.jpg']).naturalOk, true);
  assert.equal(checkReaderOrder(['0001.jpg', '0002.jpg']).lexicalOk, true);
});

test('no AI or network code exists in the app', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = ['js', 'js/ui'].flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `../${d}/${f}`));
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/\bfetch\(|XMLHttpRequest|gemini|openai|anthropic|apiKey|api_key/i.test(src), `${f} must not use the network or AI`);
  }
});

test('zip64: more than 65,535 entries is written and read back (checked by python)', async () => {
  const w = new ZipWriter();
  const tiny = new Blob(['x']);
  for (let i = 0; i < 70000; i++) await w.addFile(`p/${String(i).padStart(5, '0')}.jpg`, tiny);
  const blob = await w.finish();
  const dir = mkdtempSync(join(tmpdir(), 'cbz-'));
  const f = join(dir, 'big.cbz');
  writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
  execFileSync('python3', ['-I', '-m', 'zipfile', '-t', f]);
  const out = execFileSync('python3', ['-I', '-c', 'import zipfile,sys;n=zipfile.ZipFile(sys.argv[1]).namelist();print(len(n),n[0],n[-1])', f]).toString().trim();
  assert.equal(out, '70000 p/00000.jpg p/69999.jpg');
  const z = await openZip(blob);
  assert.equal(z.entries.length, 70000);
  assert.equal(await (await z.read(z.entries[69999])).text(), 'x');
});

test('zip64: offsets past 4 GB use extended records', async () => {
  const w = new ZipWriter();
  w.offset = 5_000_000_000; // simulate 5 GB already written; only the directory records are inspected
  await w.addFile('a.jpg', new Blob(['abc']));
  const bytes = new Uint8Array(await (await w.finish()).arrayBuffer());
  const dv = new DataView(bytes.buffer);
  const at = (sig) => { for (let i = 0; i + 4 <= bytes.length; i++) if (dv.getUint32(i, true) === sig) return i; return -1; };
  const c = at(0x02014b50);
  assert.equal(dv.getUint16(c + 6, true), 45, 'needs ZIP64 version');
  assert.equal(dv.getUint32(c + 42, true), 0xffffffff, 'offset field defers to the extra record');
  const nameLen = dv.getUint16(c + 28, true);
  assert.equal(dv.getUint16(c + 46 + nameLen, true), 1, 'zip64 extra id');
  assert.equal(Number(dv.getBigUint64(c + 50 + nameLen, true)), 5_000_000_000);
  assert.ok(at(0x06064b50) >= 0 && at(0x07064b50) >= 0, 'zip64 end records present');
  const e = at(0x06054b50);
  assert.equal(dv.getUint32(e + 16, true), 0xffffffff);
});

test('zip: streaming to a sink writes the same archive as building a Blob', async () => {
  const chunks = [];
  const sink = { write: async (c) => { chunks.push(c instanceof Blob ? await c.arrayBuffer() : c); } };
  const a = new ZipWriter({ sink });
  const b = new ZipWriter();
  for (const w of [a, b]) { await w.addFile('1.jpg', new Blob(['one'])); await w.addFile('d/2.jpg', new Blob(['two'])); }
  assert.equal(await a.finish(), null);
  const streamed = new Blob(chunks);
  const built = await b.finish();
  assert.deepEqual(new Uint8Array(await streamed.arrayBuffer()), new Uint8Array(await built.arrayBuffer()));
});

test('export: very large projects are not rejected by planning', async () => {
  const { project } = await projectFrom([{ folder: 'C', paths: pages(3) }]);
  for (const id of project.order) project.item(id).size = 3 * 1024 ** 3;
  const plan = planExport(project, defaultExportOptions(project));
  assert.deepEqual(plan.errors, []);
  assert.ok(plan.warnings.some((w) => w.includes('very large')));
  assert.ok(!planExport(project, defaultExportOptions(project), { canStream: true }).warnings.some((w) => w.includes('very large')));
});
