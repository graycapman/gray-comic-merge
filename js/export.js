// Export planning and writing. Page order (project.order) is never re-sorted here;
// the plan only decides what each page is called and which folder it lands in.
import { sanitizeSegment, pad, splitPath } from './paths.js';
import { checkTemplate } from './rules.js';
import { naturalCompare, plainCompare } from './natural.js';
import { ZipWriter, openZip } from './zip.js';

export const STRUCTURES = [
  { id: 'flat', label: 'Flat', hint: 'All pages in the archive root (normalised).' },
  { id: 'groups', label: 'Group by chapter', hint: 'One folder per group; nested groups become nested folders.' },
  { id: 'hierarchy', label: 'Original hierarchy', hint: 'Folders as they were in each source.' },
  { id: 'custom', label: 'Custom template', hint: 'Write your own path template.' },
];
export const NAMINGS = [
  { id: 'sequence-name', label: 'Page number + original name', hint: '0007_page.jpg. Keeps the name and guarantees the order in every reader.' },
  { id: 'sequence', label: 'Page number only', hint: '0007.jpg' },
  { id: 'original', label: 'Original names only', hint: 'Order is only safe if the names already sort correctly.' },
];
const FILE_PART = { 'sequence-name': '{index}_{file}', sequence: '{index}.{ext}', original: '{file}' };

export function defaultExportOptions(project) {
  const hasGroups = project.groups().some((g) => g.id != null);
  return {
    format: 'cbz', structure: hasGroups ? 'groups' : 'flat', naming: 'sequence-name',
    template: '{group}/{index}_{file}', numberFolders: true, fileName: 'comic',
  };
}

export function templateFor(options) {
  const file = FILE_PART[options.naming] ?? FILE_PART['sequence-name'];
  switch (options.structure) {
    case 'flat': return file;
    case 'groups': return `{group}/${file}`;
    case 'hierarchy': return `{source}/{dir}/${file}`;
    default: return options.template;
  }
}

function uniqueGroupLabels(project) {
  const labels = new Map();
  const used = new Set();
  for (const g of project.groups()) {
    if (g.id == null) continue;
    const parts = (g.name || 'Group').split('/').filter(Boolean);
    let label = parts.join('/');
    for (let n = 2; used.has(label.toLowerCase()); n++) {
      label = [...parts.slice(0, -1), `${parts.at(-1)} (${n})`].join('/');
    }
    used.add(label.toLowerCase());
    labels.set(g.id, label);
  }
  return labels;
}

// Prefix folders with their order so folder sorting matches reading order in any reader.
function numberFolders(segmentLists) {
  const tree = new Map();
  const childrenOf = (key) => { if (!tree.has(key)) tree.set(key, new Map()); return tree.get(key); };
  for (const segs of segmentLists) {
    let key = '';
    for (let i = 0; i < segs.length - 1; i++) {
      const kids = childrenOf(key);
      if (!kids.has(segs[i])) kids.set(segs[i], kids.size + 1);
      key += '/' + segs[i];
    }
  }
  return segmentLists.map((segs) => {
    let key = '';
    return segs.map((seg, i) => {
      if (i === segs.length - 1) return seg;
      const kids = childrenOf(key);
      const label = `${pad(kids.get(seg), Math.max(2, String(kids.size).length))} - ${seg}`;
      key += '/' + seg;
      return label;
    });
  });
}

/** Checks whether common reader sort rules (plain and natural) reproduce the reading order. */
export function checkReaderOrder(paths) {
  const check = (cmp) => {
    const sorted = [...paths].sort(cmp);
    const i = sorted.findIndex((p, k) => p !== paths[k]);
    return i < 0 ? null : { index: i, expected: paths[i], found: sorted[i] };
  };
  const lexical = check(plainCompare);
  const natural = check(naturalCompare);
  return { lexicalOk: !lexical, naturalOk: !natural, firstProblem: lexical || natural };
}

/**
 * @returns {{entries:[{id,path}], errors:[string], warnings:[string], template:string, readerOrder}}
 * Errors block export; warnings need the user's acknowledgement.
 */
export function planExport(project, options, { canStream = false } = {}) {
  const errors = [];
  const warnings = [];
  const ids = project.order;
  const template = templateFor(options);
  const problem = checkTemplate(template);
  if (!ids.length) errors.push('There are no pages to export. Add images or a CBZ first.');
  if (problem) errors.push(problem);
  if (errors.length) return { entries: [], errors, warnings, template, readerOrder: null };

  const width = Math.max(4, String(ids.length).length);
  const labels = uniqueGroupLabels(project);
  const multiSource = project.activeSources().length > 1;
  const sourceLabel = (sid) => project.sources.get(sid).label;

  let changedNames = 0;
  let segLists = ids.map((id, i) => {
    const it = project.item(id);
    const ctx = {
      index: pad(i + 1, width), name: it.stem, ext: it.ext, file: it.name,
      group: labels.get(project.groupOf(id)) ?? '',
      source: multiSource ? sourceLabel(it.sourceId) : '',
      dir: it.dir,
    };
    const raw = template.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');
    const segs = raw.split('/').filter(Boolean);
    const clean = segs.map(sanitizeSegment);
    if (clean.some((s, k) => s !== segs[k])) changedNames++;
    return clean;
  });
  if (changedNames) warnings.push(`${changedNames} name(s) contained characters that are not allowed on every system (such as : * ? " < > |) and were replaced with "_".`);
  if (options.numberFolders && segLists.some((s) => s.length > 1)) segLists = numberFolders(segLists);

  const entries = ids.map((id, i) => ({ id, path: segLists[i].join('/') }));

  const seen = new Map();
  for (const e of entries) {
    const k = e.path.toLowerCase();
    if (seen.has(k)) {
      errors.push(`Two pages would both be saved as "${e.path}". Choose "Page number + original name" or add {index} to the template.`);
      break;
    }
    seen.set(k, e.id);
  }
  const total = ids.reduce((n, id) => n + (project.item(id).size || 0), 0);
  if (options.format === 'cbz' && !canStream && total > 1.5 * 1024 ** 3) {
    warnings.push('This archive is very large. This browser has to build it in memory before downloading, which can fail. Chrome or Edge write large files straight to disk.');
  }
  if (entries.some((e) => e.path.length > 240)) warnings.push('Some paths are longer than 240 characters; Windows and some readers may fail to open them.');

  let readerOrder = null;
  if (options.format === 'cbz') {
    readerOrder = checkReaderOrder(entries.map((e) => e.path));
    if (!readerOrder.lexicalOk || !readerOrder.naturalOk) {
      const p = readerOrder.firstProblem;
      const rootFiles = entries.some((e) => !e.path.includes('/'));
      const folders = entries.some((e) => e.path.includes('/'));
      warnings.push(rootFiles && folders
        ? 'Some pages have no group, so they sit in the archive root while others are in folders. Readers list root files and folders separately, so the order can differ. Put every page in a group (Group selection…) or choose the Flat structure.'
        : `Some readers would show pages in a different order: sorted by name, "${p.found}" would come where "${p.expected}" should be. Use "Page number + original name" and numbered folders, or accept the risk.`);
    }
  }
  return { entries, errors, warnings, template, readerOrder, totalBytes: total };
}

export function suggestFileName(project) {
  const sources = project.activeSources();
  const base = sources.length === 1 ? splitPath(sources[0].label).stem : 'Merged comic';
  return sanitizeSegment(base.replace(/\.(cbz|zip)$/i, '')) || 'comic';
}

export class ExportError extends Error {
  constructor(message, id) {
    super(message);
    this.name = 'ExportError';
    this.itemId = id;
  }
}

async function readPage(project, id) {
  const it = project.item(id);
  try {
    return await it.read();
  } catch (e) {
    throw new ExportError(`Could not read "${it.name}" (${project.sources.get(it.sourceId).label}): ${e.message}. Nothing was saved. Check that the source still exists, or remove the page and try again.`, id);
  }
}

/** Builds the ZIP/CBZ in plan order. Throws ExportError on the first unreadable page. */
export async function buildArchive(project, plan, { onProgress, signal, sink = null } = {}) {
  const zip = new ZipWriter({ sink });
  for (let i = 0; i < plan.entries.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const { id, path } = plan.entries[i];
    await zip.addFile(path, await readPage(project, id));
    onProgress?.(i + 1, plan.entries.length);
  }
  return zip.finish(); // Blob, or null when streamed to `sink`
}

/** Re-opens the finished archive and confirms names and order match the plan. */
export async function verifyArchive(blob, plan) {
  const problems = [];
  try {
    const { entries } = await openZip(blob);
    if (entries.length !== plan.entries.length) problems.push(`Archive has ${entries.length} entries, expected ${plan.entries.length}.`);
    for (let i = 0; i < Math.min(entries.length, plan.entries.length); i++) {
      if (entries[i].name !== plan.entries[i].path) { problems.push(`Entry ${i + 1} is "${entries[i].name}", expected "${plan.entries[i].path}".`); break; }
    }
  } catch (e) {
    problems.push(`The finished archive could not be re-opened: ${e.message}`);
  }
  return problems;
}

// ----- extraction to a folder (File System Access API) -----
async function dirFor(root, segments, create) {
  let d = root;
  for (const s of segments) d = await d.getDirectoryHandle(s, { create });
  return d;
}

export async function findExisting(root, plan) {
  const found = [];
  for (const e of plan.entries) {
    const segs = e.path.split('/');
    const file = segs.pop();
    try {
      await (await dirFor(root, segs, false)).getFileHandle(file);
      found.push(e.path);
    } catch (err) {
      if (err.name !== 'NotFoundError') {
        if (err.name === 'TypeMismatchError') found.push(e.path); else throw err;
      }
    }
  }
  return found;
}

/** Writes pages as files. Existing files are only replaced when `overwrite` is true. */
export async function writeImages(root, project, plan, { existing = [], overwrite = false, onProgress, signal } = {}) {
  const skip = overwrite ? new Set() : new Set(existing);
  const result = { written: 0, skipped: 0, errors: [] };
  for (let i = 0; i < plan.entries.length; i++) {
    if (signal?.aborted) throw new DOMException('Extraction cancelled', 'AbortError');
    const { id, path } = plan.entries[i];
    if (skip.has(path)) { result.skipped++; onProgress?.(i + 1, plan.entries.length); continue; }
    try {
      const blob = await readPage(project, id);
      const segs = path.split('/');
      const file = segs.pop();
      const fh = await (await dirFor(root, segs, true)).getFileHandle(file, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      result.written++;
    } catch (e) {
      result.errors.push(`${path}: ${e.message}`);
    }
    onProgress?.(i + 1, plan.entries.length);
  }
  return result;
}
