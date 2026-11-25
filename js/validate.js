// Project validation: problems the user should see before exporting.
// severity: error (blocks export), warning (needs acknowledgement), info.
import { PREVIEW_EXTS } from './paths.js';

export function validateProject(project) {
  const issues = [];
  if (!project.size) {
    issues.push({ id: 'empty', severity: 'error', title: 'No pages in the project', detail: 'Add images, folders or CBZ files first.' });
    return issues;
  }

  for (const s of project.activeSources()) {
    if (s.uncertain.length && !s.acknowledged) {
      issues.push({
        id: `uncertain-${s.id}`, severity: 'warning', sourceId: s.id,
        title: `Page order of "${s.label}" is a guess`,
        detail: s.uncertain.join(' '),
        action: 'acknowledge',
      });
    }
    if (s.skipped.length) {
      const real = s.skipped.filter((x) => x.category !== 'system');
      const system = s.skipped.length - real.length;
      issues.push({
        id: `skipped-${s.id}`, severity: 'info', sourceId: s.id,
        title: `${s.skipped.length} file(s) from "${s.label}" were not imported`,
        detail: `${real.length} not usable as pages${system ? `, ${system} system file(s) ignored` : ''}.`,
        action: 'skipped',
      });
    }
  }

  const byName = new Map();
  let noPreview = 0;
  for (const id of project.order) {
    const it = project.item(id);
    const k = it.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(id);
    if (!PREVIEW_EXTS.has(it.ext)) noPreview++;
  }
  const dupes = [...byName.values()].filter((l) => l.length > 1);
  if (dupes.length) {
    issues.push({
      id: 'dup-names', severity: 'info', title: `${dupes.length} file name(s) appear more than once`,
      detail: 'Pages stay separate (they come from different folders or sources). Exported names include the page number, so they do not collide.',
      itemIds: dupes.flat(),
    });
  }
  if (noPreview) {
    issues.push({ id: 'no-preview', severity: 'info', title: `${noPreview} page(s) cannot be previewed`, detail: 'The format (such as TIFF or JXL) is not shown by browsers. The file is still packaged unchanged.' });
  }
  return issues;
}

/** Tries to open every page. Returns issues for pages that cannot be read now. */
export async function checkReadable(project, { onProgress, signal } = {}) {
  const ids = project.order;
  const bad = [];
  let done = 0;
  const queue = [...ids];
  async function worker() {
    while (queue.length) {
      if (signal?.aborted) return;
      const id = queue.shift();
      const it = project.item(id);
      try { await it.probe(); } catch (e) { bad.push({ id, message: e.message }); }
      onProgress?.(++done, ids.length);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return bad.map(({ id, message }) => {
    const it = project.item(id);
    return {
      id: `unreadable-${id}`, severity: 'error', itemIds: [id],
      title: `Cannot read "${it.name}"`,
      detail: `${project.sources.get(it.sourceId).label}: ${message}. The file may have been moved or deleted. Remove the page or add the source again.`,
    };
  });
}
