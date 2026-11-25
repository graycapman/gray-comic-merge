// Import engine: turns files, folders and archives into raw sources, then into
// project sources via a structure rule. Nothing is dropped silently: every file
// that is not imported is recorded in `skipped` with a reason.
import { openZip } from './zip.js';
import { classifyEntry, normalizeArchivePath, splitPath } from './paths.js';
import { naturalCompare } from './natural.js';
import { detect, applyRule, ruleFor, getPreset } from './structure.js';

/** Groups {path, file} pairs into raw sources. Paths use "/" and start with the folder name for folders. */
export function groupFiles(pairs) {
  const folders = new Map();
  const archives = [];
  const loose = [];
  const skipped = [];
  for (const p of pairs) {
    const path = normalizeArchivePath(p.path);
    const kind = classifyEntry(path);
    if (kind.kind === 'archive') {
      archives.push({ kind: 'cbz', label: splitPath(path).base, file: p.file });
      continue;
    }
    if (kind.kind === 'skip') { skipped.push({ path, reason: kind.reason, category: kind.category }); continue; }
    const root = path.includes('/') ? path.split('/')[0] : null;
    if (root) {
      if (!folders.has(root)) folders.set(root, { kind: 'folder', label: root, files: [] });
      folders.get(root).files.push({ path, file: p.file });
    } else {
      loose.push({ path, file: p.file });
    }
  }
  const raws = [...archives, ...folders.values()].sort((a, b) => naturalCompare(a.label, b.label));
  if (loose.length) raws.push({ kind: 'images', label: loose.length === 1 ? loose[0].path : `Selected images (${loose.length})`, files: loose });
  return { raws, skipped };
}

export const groupFileList = (fileList) =>
  groupFiles([...fileList].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));

async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Reads a drop event. Entries must be captured synchronously, before any await. */
export async function collectFromDrop(dataTransfer) {
  const entries = [...(dataTransfer.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return groupFileList(dataTransfer.files || []);
  const pairs = [];
  for (const e of entries) await walk(e, '', pairs);
  return groupFiles(pairs);
}

function fileEntry(path, file, keyPrefix = '') {
  return {
    path, size: file.size, ext: splitPath(path).ext,
    key: `${keyPrefix}${path}|${file.size}|${file.lastModified}`,
    read: async () => file,
    probe: async () => { await file.slice(0, 1).arrayBuffer(); },
  };
}

/** Opens a raw source and lists its pages. Never throws: failures are returned as `error`. */
export async function openRaw(raw) {
  const out = { kind: raw.kind, label: raw.label, entries: [], skipped: [], error: null };
  try {
    if (raw.kind === 'cbz') {
      const zip = await openZip(raw.file);
      const keyPrefix = `${raw.file.name}|${raw.file.size}|${raw.file.lastModified}!`;
      for (const e of zip.entries) {
        if (e.isDir) continue;
        const path = normalizeArchivePath(e.name);
        const kind = classifyEntry(path);
        if (kind.kind !== 'image') { out.skipped.push({ path, reason: kind.kind === 'archive' ? 'nested archive (not opened)' : kind.reason, category: kind.category || 'not-image' }); continue; }
        if (e.encrypted) { out.skipped.push({ path, reason: 'password-protected', category: 'inaccessible' }); continue; }
        out.entries.push({
          path, size: e.size, ext: kind.ext, key: keyPrefix + path,
          read: () => zip.read(e), probe: () => zip.probe(e),
        });
      }
    } else {
      for (const f of raw.files) {
        const kind = classifyEntry(f.path);
        if (kind.kind === 'image') out.entries.push(fileEntry(f.path, f.file));
        else out.skipped.push({ path: f.path, reason: kind.reason || 'nested archive (not opened)', category: kind.category || 'not-image' });
      }
    }
  } catch (e) {
    out.error = `"${raw.label}" could not be read: ${e.message}`;
  }
  return out;
}

/**
 * Opens all raw sources and proposes a structure for each.
 * Pages already in the project (same file, same path) are skipped and reported.
 */
export async function prepareImport(project, raws, savedRules = []) {
  const opened = [];
  for (const raw of raws) opened.push(await openRaw(raw));
  const have = project.currentKeys();
  const archiveCount = opened.filter((s) => s.kind === 'cbz' && !s.error).length;
  const seenInBatch = new Set();
  for (const s of opened) {
    if (s.error) continue;
    const fresh = [];
    for (const e of s.entries) {
      if (have.has(e.key) || seenInBatch.has(e.key)) s.skipped.push({ path: e.path, reason: 'already in the project', category: 'duplicate' });
      else { fresh.push(e); seenInBatch.add(e.key); }
    }
    s.entries = fresh;
    const d = detect(s.entries, { kind: s.kind, archiveCount });
    s.detection = d;
    s.selection = d.presetId;
    s.empty = s.entries.length === 0;
  }
  return opened;
}

/** Runs the chosen preset/rule for one prepared source. */
export function structureFor(source, savedRules) {
  const { rule, universal, name } = ruleFor(source.selection, savedRules);
  const result = applyRule(rule, source.entries, { sourceLabel: splitPath(source.label).stem }, universal);
  return { ...result, rule, ruleName: name };
}

/** Adds the confirmed sources to the project as one undoable step. Returns {added, output}. */
export function commitImport(project, sources, savedRules) {
  const payload = [];
  let output = null;
  for (const s of sources) {
    if (s.error || s.empty || s.skip) continue;
    const r = structureFor(s, savedRules);
    if (r.rule.output && !output) output = r.rule.output;
    const autoChosen = s.selection === s.detection.presetId;
    const uncertain = [...r.uncertain];
    if (autoChosen && s.detection.level === 'low') uncertain.unshift(`Structure detection was uncertain (${s.detection.reasons[0] || 'no clear pattern'}).`);
    payload.push({
      label: s.label, kind: s.kind, presetId: s.selection, presetName: r.ruleName, uncertain,
      skipped: [...s.skipped, ...r.excluded.map((x) => ({ ...x, category: 'rule' }))],
      groups: r.groups.map((g) => ({ name: g.name, entries: g.entries })),
    });
  }
  const added = project.addSources(payload, payload.length === 1 ? `Add "${payload[0].label}"` : `Add ${payload.length} sources`);
  return { added, output };
}

export { getPreset };
