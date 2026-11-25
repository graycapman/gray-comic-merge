// Text-based ordering: a pasted list of file names defines the reading order.
// Matching is done on normalised copies; page names are never modified, and
// only existing pages can be reordered.
import { splitPath, SUPPORTED_IMAGE_EXTS } from './paths.js';

export function normalizeLine(raw) {
  let s = raw.normalize('NFC').replace(/^﻿/, '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  const q = s.match(/^(["'])(.*)\1$/);
  if (q) s = q[2].trim();
  return s.toLowerCase();
}

const hasImageExt = (s) => SUPPORTED_IMAGE_EXTS.has(splitPath(s).ext);
const stripExt = (s) => (hasImageExt(s) ? s.slice(0, s.lastIndexOf('.')) : s);

/**
 * @returns {{order, matches, unmatched, duplicates, ambiguous, remaining, notes, lineCount, changed}}
 *  order      proposed full order (matched pages first, then the rest in current order)
 *  matches    [{lineNo, line, id, note?}]
 *  unmatched  [{lineNo, line}]
 *  duplicates [{lineNo, line, id, firstLineNo}]      later lines pointing at an already-placed page
 *  ambiguous  [{lineNo, line, candidates:[id]}]      several pages share the name; left in `remaining`
 *  remaining  ids of pages the list did not place
 */
export function planTextOrder(project, text, { resolveRepeated = false } = {}) {
  const current = project.order;
  const pages = current.map((id) => {
    const it = project.item(id);
    const path = it.path.toLowerCase().normalize('NFC').replace(/\s+/g, ' ');
    return { id, name: it.name.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim(), path, pathNoExt: stripExt(path) };
  });
  pages.forEach((p) => { p.stem = stripExt(p.name); });

  const byName = new Map();
  const byStem = new Map();
  const push = (map, k, p) => (map.has(k) ? map.get(k).push(p) : map.set(k, [p]));
  for (const p of pages) { push(byName, p.name, p); push(byStem, p.stem, p); }

  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const norm = normalizeLine(raw);
    if (norm) lines.push({ lineNo: i + 1, line: raw.trim(), norm });
  });
  const lineTotals = new Map();
  for (const l of lines) lineTotals.set(l.norm, (lineTotals.get(l.norm) || 0) + 1);

  function candidates(norm) {
    if (norm.includes('/')) {
      const wantsExt = hasImageExt(norm);
      return pages.filter((p) => {
        const full = p.path === norm || p.path.endsWith('/' + norm);
        const bare = !wantsExt && (p.pathNoExt === norm || p.pathNoExt.endsWith('/' + norm));
        return full || bare;
      });
    }
    const exact = byName.get(norm);
    if (exact?.length) return { list: exact };
    const stem = byStem.get(norm);
    if (stem?.length) return { list: stem };
    if (hasImageExt(norm)) {
      const loose = byStem.get(stripExt(norm));
      if (loose?.length) return { list: loose, note: 'extension differs from the page' };
    }
    return { list: [] };
  }

  const placed = new Map(); // id -> lineNo
  const seen = new Map(); // norm -> occurrences processed
  const out = { matches: [], unmatched: [], duplicates: [], ambiguous: [], notes: [] };

  for (const l of lines) {
    const occurrence = seen.get(l.norm) || 0;
    seen.set(l.norm, occurrence + 1);
    let found = candidates(l.norm);
    if (Array.isArray(found)) found = { list: found };
    const list = found.list;
    let target = null;
    let note = found.note;

    if (list.length === 1) target = list[0];
    else if (list.length > 1) {
      if (resolveRepeated && lineTotals.get(l.norm) === list.length) {
        target = list[occurrence];
        note = 'repeated name resolved by current order';
      } else {
        out.ambiguous.push({ lineNo: l.lineNo, line: l.line, candidates: list.map((p) => p.id) });
        continue;
      }
    } else {
      out.unmatched.push({ lineNo: l.lineNo, line: l.line });
      continue;
    }

    if (placed.has(target.id)) {
      out.duplicates.push({ lineNo: l.lineNo, line: l.line, id: target.id, firstLineNo: placed.get(target.id) });
      continue;
    }
    placed.set(target.id, l.lineNo);
    out.matches.push({ lineNo: l.lineNo, line: l.line, id: target.id, note });
  }

  const matchedIds = out.matches.map((m) => m.id);
  const matchedSet = new Set(matchedIds);
  const remaining = current.filter((id) => !matchedSet.has(id));
  const order = [...matchedIds, ...remaining];
  return {
    ...out,
    order,
    remaining,
    lineCount: lines.length,
    changed: order.some((id, i) => id !== current[i]),
  };
}

/** The current order as a pasteable list (original file names, one per line). */
export function currentOrderAsText(project) {
  return project.order.map((id) => project.item(id).name).join('\n');
}
