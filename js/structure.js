// Structure presets, automatic detection and rule application (including Universal Import).
// Every preset is just a rule, so presets and custom rules go through the same code.
import { naturalKey, compareKeys, comparePathKeys, pathKey, plainCompare } from './natural.js';
import { splitPath, commonDirPrefix } from './paths.js';
import { defaultRule } from './rules.js';

function preset(id, name, description, grouping, ordering, extra = {}) {
  const base = defaultRule();
  return {
    id, name, description,
    universal: !!extra.universal,
    rule: {
      ...base, name,
      grouping: { ...base.grouping, ...grouping },
      ordering: { ...base.ordering, ...ordering },
    },
  };
}

export const PRESETS = [
  preset('flat', 'Flat structure', 'All pages in one folder.', { by: 'none' }, { pages: 'natural-name' }),
  preset('chapter-folders', 'Chapter folders', 'One folder per chapter.', { by: 'parent-directory', nameFrom: 'name' }, { pages: 'natural-name', groups: 'natural' }),
  preset('nested-chapters', 'Nested chapter folders', 'Chapters spread over several folder levels.', { by: 'parent-directory', nameFrom: 'path' }, { pages: 'natural-name', groups: 'natural' }),
  preset('numbered-chapters', 'Numbered chapters', 'Chapter folders ordered by the number in their name.', { by: 'parent-directory', nameFrom: 'name' }, { pages: 'natural-name', groups: 'numeric' }),
  preset('numbered-pages', 'Numbered pages', 'Pages ordered by the number in their file name.', { by: 'none' }, { pages: 'numeric-pattern' }),
  preset('mixed', 'Mixed structure', 'Pages and folders side by side.', { by: 'parent-directory', nameFrom: 'name' }, { pages: 'natural-name', groups: 'natural' }),
  preset('multiple-cbz', 'Multiple CBZ archives', 'Each archive becomes one group.', { by: 'source' }, { pages: 'natural-path' }),
  preset('universal', 'Custom / unknown (universal import)', 'Finds every image at any depth and orders by path and name.', { by: 'parent-directory', nameFrom: 'path' }, { pages: 'natural-name', groups: 'natural' }, { universal: true }),
];

export const getPreset = (id) => PRESETS.find((p) => p.id === id);

// ---------- entry preparation ----------

/** Adds name/stem/ext and a folder path relative to the folder shared by all pages. */
export function prepareEntries(raw) {
  const base = commonDirPrefix(raw.map((e) => splitPath(e.path).dir));
  const entries = raw.map((e) => {
    const { dir, base: name, stem, ext } = splitPath(e.path);
    const reldir = base ? dir.slice(base.length + 1) : dir;
    return { ...e, name, stem, ext, reldir, rel: reldir ? `${reldir}/${name}` : name, depth: reldir ? reldir.split('/').length : 0 };
  });
  return { entries, base };
}

const CHAPTER_WORD = /(?:^|[\s_.#\-[(])(?:ch(?:apter|p)?|ep(?:isode)?|vol(?:ume)?|issue|part|book|no|#)\.?[\s_\-.#]*\d+/i;
const LEADING_NUMBER = /^[\s#[(]*\d+(?:\.\d+)?(?:[\s\]).:_-]|$)/;
const TRAILING_NUMBER = /\d+(?:\.\d+)?\s*$/;
export const isChapterLike = (name) => CHAPTER_WORD.test(name) || LEADING_NUMBER.test(name) || TRAILING_NUMBER.test(name);

const ratio = (list, fn) => (list.length ? list.filter(fn).length / list.length : 0);
const firstNumber = (s) => { const m = /(\d+(?:\.\d+)?)/.exec(s); return m ? parseFloat(m[1]) : null; };

export function analyze(rawEntries) {
  const { entries } = prepareEntries(rawEntries);
  const dirs = [...new Set(entries.map((e) => e.reldir))];
  const nonRoot = dirs.filter(Boolean);
  const leaf = (d) => d.split('/').pop();
  const byName = new Map();
  for (const e of entries) byName.set(e.name.toLowerCase(), (byName.get(e.name.toLowerCase()) || 0) + 1);
  return {
    total: entries.length,
    dirCount: dirs.length,
    hasRoot: dirs.includes(''),
    depths: new Set(nonRoot.map((d) => d.split('/').length)),
    maxDepth: Math.max(0, ...nonRoot.map((d) => d.split('/').length)),
    chapterLikeRatio: ratio(nonRoot, (d) => isChapterLike(leaf(d))),
    numericNameRatio: ratio(entries, (e) => /\d/.test(e.stem)),
    duplicateNames: [...byName.values()].filter((n) => n > 1).length,
  };
}

// ---------- detection ----------

const levelOf = (c) => (c >= 0.85 ? 'high' : c >= 0.65 ? 'medium' : 'low');

/**
 * Suggests a preset. `ctx.archiveCount` is the number of archives in the same import batch.
 * Low confidence means "check this"; the caller must show it, never hide it.
 */
export function detect(rawEntries, ctx = {}) {
  const a = analyze(rawEntries);
  const done = (presetId, confidence, reasons) => ({ presetId, confidence, level: levelOf(confidence), reasons, analysis: a });

  if (!a.total) return done('universal', 0, ['No pages were found.']);
  const flat = a.dirCount === 1 && a.hasRoot;

  if (flat && ctx.kind === 'cbz' && ctx.archiveCount >= 2) {
    return done('multiple-cbz', 0.9, [`${ctx.archiveCount} archives imported together; each holds one run of pages.`]);
  }
  if (flat) {
    if (a.numericNameRatio >= 0.8) return done('numbered-pages', 0.95, ['All pages are in one folder and file names contain numbers.']);
    return done('flat', 0.6, ['All pages are in one folder, but file names have no clear numbers.']);
  }
  if (a.hasRoot) {
    return done('mixed', 0.6, [`Pages sit both in the top folder and in ${a.dirCount - 1} subfolder(s).`]);
  }
  if (a.depths.size > 1) {
    return done('universal', 0.4, ['Folders have different depths, so no standard chapter layout fits.']);
  }
  if (a.maxDepth === 1) {
    if (a.chapterLikeRatio >= 0.8) return done('numbered-chapters', 0.9, [`${a.dirCount} chapter folders with numbers in their names.`]);
    return done('chapter-folders', 0.65, [`${a.dirCount} folders, but their names do not clearly contain chapter numbers.`]);
  }
  if (a.chapterLikeRatio >= 0.8) return done('nested-chapters', 0.8, [`Chapters are nested ${a.maxDepth} levels deep.`]);
  return done('nested-chapters', 0.6, [`Folders are nested ${a.maxDepth} levels deep and names are not clearly chapters.`]);
}

// ---------- applying a rule ----------

function re(value) {
  return value ? new RegExp(value, 'i') : null;
}

function excludeReason(e, rule, rx) {
  const maxDepth = rule.scan.recursive === false ? 0 : rule.scan.maxDepth;
  if (maxDepth != null && e.depth > maxDepth) return `deeper than ${maxDepth} folder level${maxDepth === 1 ? '' : 's'} (rule limit)`;
  if (rx.includeDirs && !rx.includeDirs.test(e.reldir)) return 'folder does not match the rule\'s include pattern';
  if (rx.excludeDirs && rx.excludeDirs.test(e.reldir)) return 'folder matches the rule\'s exclude pattern';
  if (rx.includeFiles && !rx.includeFiles.test(e.name)) return 'file name does not match the rule\'s include pattern';
  if (rx.excludeFiles && rx.excludeFiles.test(e.name)) return 'file name matches the rule\'s exclude pattern';
  return null;
}

function extractNumber(text, pattern, fallback) {
  const m = (pattern || fallback).exec(text);
  if (!m) return null;
  const n = parseFloat(m[1] ?? m[0]);
  return Number.isFinite(n) ? n : null;
}
const LAST_NUMBER = /(\d+(?:\.\d+)?)(?!.*\d)/;
const FIRST_NUMBER = /(\d+(?:\.\d+)?)/;

function sortPages(list, rule, uncertain) {
  const method = rule.ordering.pages;
  const deco = list.map((e, i) => ({ e, i, nk: naturalKey(e.name), pk: pathKey(`${e.reldir ? e.reldir + '/' : ''}${e.name}`) }));
  let cmp;
  if (method === 'alphabetical') {
    cmp = (a, b) => plainCompare(a.e.name.toLowerCase(), b.e.name.toLowerCase());
  } else if (method === 'natural-path') {
    cmp = (a, b) => comparePathKeys(a.pk, b.pk);
  } else if (method === 'numeric-pattern') {
    const rx = rule.ordering.pagePattern ? new RegExp(rule.ordering.pagePattern, 'i') : null;
    for (const d of deco) d.num = extractNumber(d.e.stem, rx, LAST_NUMBER);
    const missing = deco.filter((d) => d.num == null).length;
    if (missing === deco.length && deco.length) uncertain.add('No file name matched the page-number pattern; pages are ordered by name only.');
    else if (missing) uncertain.add(`${missing} page(s) have no number in their name and are placed after the numbered pages.`);
    cmp = (a, b) => (a.num == null) - (b.num == null) || (a.num ?? 0) - (b.num ?? 0) || compareKeys(a.nk, b.nk);
  } else {
    cmp = (a, b) => compareKeys(a.nk, b.nk);
  }
  const noDigits = deco.filter((d) => !/\d/.test(d.e.stem)).length;
  if (method !== 'numeric-pattern' && deco.length > 1 && noDigits / deco.length > 0.5) {
    uncertain.add('Most file names contain no numbers, so alphabetical order may not match the reading order.');
  }
  return deco.sort((a, b) => cmp(a, b) || comparePathKeys(a.pk, b.pk) || a.i - b.i).map((d) => d.e);
}

/**
 * @param ctx {sourceLabel}
 * @returns {{groups:[{key,name,entries}], excluded:[{path,reason}], uncertain:[string]}}
 *   Groups are in final order; name null = ungrouped. Entries are prepared (reldir etc.).
 */
export function applyRule(rule, rawEntries, ctx = {}, universal = false) {
  const { entries } = prepareEntries(rawEntries);
  const rx = {
    includeDirs: re(rule.scan.includeDirs), excludeDirs: re(rule.scan.excludeDirs),
    includeFiles: re(rule.scan.includeFiles), excludeFiles: re(rule.scan.excludeFiles),
  };
  const uncertain = new Set();
  const excluded = [];
  const kept = [];
  for (const e of entries) {
    const reason = excludeReason(e, rule, rx);
    if (reason) excluded.push({ path: e.path, reason }); else kept.push(e);
  }
  if (universal) uncertain.add('Universal import: the reading order is a best guess from folder and file names. Review it before export.');

  // discovery order = natural path order; gives 'discovered' group ordering and stable ties
  const discovered = kept
    .map((e) => ({ e, k: pathKey(e.rel) }))
    .sort((a, b) => comparePathKeys(a.k, b.k))
    .map((x) => x.e);

  const g = rule.grouping;
  const groupRx = g.by === 'pattern' ? new RegExp(g.pattern, 'i') : null;
  let patternMisses = 0;
  const groups = new Map();
  const place = (key, name, e) => {
    if (!groups.has(key)) groups.set(key, { key, name, entries: [] });
    groups.get(key).entries.push(e);
  };
  for (const e of discovered) {
    const dir = e.reldir;
    if (g.by === 'none') place('', null, e);
    else if (g.by === 'source') place('\u0000source', ctx.sourceLabel ?? 'Source', e);
    else if (!dir) place('', null, e);
    else if (g.by === 'parent-directory') place(dir, g.nameFrom === 'path' ? dir : dir.split('/').pop(), e);
    else if (g.by === 'directory-depth') {
      const key = dir.split('/').slice(0, g.depth).join('/');
      place(key, g.nameFrom === 'name' ? key.split('/').pop() : key, e);
    } else {
      const m = groupRx.exec(dir);
      if (m) { const name = (m[1] ?? m[0]).trim() || dir; place(name.toLowerCase(), name, e); }
      else { patternMisses++; place('', null, e); }
    }
  }
  if (patternMisses) uncertain.add(`${patternMisses} page(s) are in folders that do not match the chapter pattern and stay ungrouped.`);

  let list = [...groups.values()];
  const root = list.find((x) => x.key === '');
  const named = list.filter((x) => x.key !== '');
  if (root && named.length) uncertain.add('Pages in the top folder are placed before the folders. Check that this is the intended position.');

  const how = rule.ordering.groups;
  if (named.length > 1 && how !== 'discovered') {
    const nameless = named.filter((x) => !/\d/.test(x.key)).length;
    if (nameless / named.length > 0.5 && g.by !== 'source') uncertain.add('Folder names contain no numbers, so chapters are ordered alphabetically. Check the chapter order.');
  }
  if (how === 'numeric' && named.length > 1) {
    const rxg = rule.ordering.groupPattern ? new RegExp(rule.ordering.groupPattern, 'i') : null;
    const deco = named.map((x) => ({
      x,
      parts: x.key.split('/').map((seg) => ({ n: extractNumber(seg, rxg, FIRST_NUMBER), k: naturalKey(seg) })),
    }));
    const missing = deco.filter((d) => d.parts.some((p) => p.n == null)).length;
    if (missing) uncertain.add(`${missing} folder(s) have no number in their name; they are ordered by name relative to numbered folders.`);
    deco.sort((a, b) => {
      for (let i = 0; i < Math.min(a.parts.length, b.parts.length); i++) {
        const p = a.parts[i], q = b.parts[i];
        const c = p.n != null && q.n != null ? p.n - q.n : compareKeys(p.k, q.k);
        if (c) return c;
      }
      return a.parts.length - b.parts.length;
    });
    list = deco.map((d) => d.x);
  } else if (how === 'natural') {
    const deco = named.map((x) => ({ x, k: pathKey(x.key) })).sort((a, b) => comparePathKeys(a.k, b.k));
    list = deco.map((d) => d.x);
  } else {
    list = named;
  }
  if (root) list.unshift(root);

  for (const grp of list) grp.entries = sortPages(grp.entries, rule, uncertain);
  const dupNames = new Set();
  if (g.by === 'none') {
    const seen = new Set();
    for (const e of list.flatMap((x) => x.entries)) {
      const n = e.name.toLowerCase();
      if (seen.has(n)) dupNames.add(n); else seen.add(n);
    }
    if (dupNames.size) uncertain.add(`${dupNames.size} file name(s) occur in several folders; ties are broken by folder path.`);
  }
  return { groups: list, excluded, uncertain: [...uncertain] };
}

/** Rule for a preset id ('auto' entries are resolved by the caller) or a saved rule object. */
export function ruleFor(selection, savedRules = []) {
  const p = getPreset(selection);
  if (p) return { rule: p.rule, universal: p.universal, name: p.name };
  const r = savedRules.find((x) => x.id === selection);
  if (r) return { rule: r, universal: false, name: r.name };
  const u = getPreset('universal');
  return { rule: u.rule, universal: true, name: u.name };
}
