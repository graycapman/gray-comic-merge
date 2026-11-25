// Application wiring: toolbar, sources panel, preview/issues, drag-and-drop import.
import { Project } from './model.js';
import { PageList } from './ui/pagelist.js';
import { h, $, button, toast, confirmDialog, promptDialog, modal, plural, fmtBytes } from './ui/dom.js';
import { groupFileList, collectFromDrop, prepareImport, commitImport, structureFor } from './importer.js';
import { loadRules } from './rules.js';
import { validateProject, checkReadable } from './validate.js';
import { defaultExportOptions } from './export.js';
import { showImportDialog, showStructureDialog, skippedList } from './ui/import-dialog.js';
import { showSortDialog, showTextOrderDialog } from './ui/order-dialogs.js';
import { showExportDialog } from './ui/export-dialog.js';
import { showRulesDialog } from './ui/rules-dialog.js';

const project = new Project();
let savedRules = loadRules();
let readIssues = [];

const el = {
  app: $('#app'), list: $('#page-list'), empty: $('#empty-state'), selInfo: $('#sel-info'),
  sources: $('#source-list'), sourceCount: $('#source-count'), preview: $('#pane-preview'),
  issues: $('#pane-issues'), issueCount: $('#issue-count'), undo: $('#btn-undo'), redo: $('#btn-redo'),
  moveToGroup: $('#move-to-group'), announcer: $('#announcer'),
};

const announce = (text) => { el.announcer.textContent = ''; setTimeout(() => { el.announcer.textContent = text; }, 30); };

const list = new PageList(el.list, project, {
  onSelect: () => { updateSelectionUI(); },
  onRemove: (ids) => removePages(ids),
  onGroupAction: (act, gid, ids) => groupAction(act, gid, ids),
  announce,
});

// ---------------------------------------------------------------- import

function applySuggestedOutput(output) {
  if (!output) return;
  project.exportOptions = { ...defaultExportOptions(project), ...(project.exportOptions || {}), structure: 'custom', template: output.template, numberFolders: output.numberFolders };
  toast('This rule suggests an output structure. Check it in Export.');
}

function undoAction() {
  return { label: 'Undo', onClick: () => { project.undo(); } };
}

async function runImport({ raws, skipped }) {
  if (!raws.length) {
    if (skipped.length) {
      const m = modal({ title: 'Nothing to import', body: [h('p', {}, 'None of the selected files can be used as pages:'), skippedList(skipped)], footer: [button('Close', { class: 'primary', onclick: () => m.close() })] });
    } else toast('No files were selected.');
    return;
  }
  const busy = toast('Reading files…', { timeout: 0 });
  let sources;
  try {
    sources = await prepareImport(project, raws, savedRules);
  } finally { busy.remove(); }

  const only = sources[0];
  const quiet = sources.length === 1 && !only.error && !only.empty && !only.skipped.length && !skipped.length
    && only.detection.level === 'high' && structureFor(only, savedRules).uncertain.length === 0;
  if (quiet) {
    const { added, output } = commitImport(project, sources, savedRules);
    toast(`Added ${plural(added, 'page')} from “${only.label}”.`, { action: undoAction() });
    applySuggestedOutput(output);
    return;
  }
  const result = await showImportDialog({ project, sources, topSkipped: skipped, savedRules });
  if (result?.added) {
    toast(`Added ${plural(result.added, 'page')}.`, { action: undoAction() });
    applySuggestedOutput(result.output);
  }
}

const inputFiles = $('#input-files');
const inputFolder = $('#input-folder');
for (const input of [inputFiles, inputFolder]) {
  input.addEventListener('change', async () => {
    const grouped = groupFileList(input.files);
    input.value = '';
    await runImport(grouped);
  });
}
for (const id of ['#btn-add-files', '#empty-files']) $(id).addEventListener('click', () => inputFiles.click());
for (const id of ['#btn-add-folder', '#empty-folder']) $(id).addEventListener('click', () => inputFolder.click());

let dragDepth = 0;
const overlay = $('#drop-overlay');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; overlay.hidden = false; } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  try {
    await runImport(await collectFromDrop(e.dataTransfer));
  } catch (err) {
    toast(`The dropped items could not be read: ${err.message}`, { kind: 'error' });
  }
});

// ---------------------------------------------------------------- page actions

function removePages(ids) {
  if (project.removeItems(ids)) {
    toast(`Removed ${plural(ids.length, 'page')} from the project. Your original files are untouched.`, { action: undoAction() });
  }
}

async function groupAction(act, gid, runIds) {
  if (act === 'rename') {
    const name = await promptDialog({ title: 'Rename group', label: 'Group name', value: project.groupName(gid) ?? '', confirmLabel: 'Rename', hint: 'Only the group label changes; page files keep their names. Use / to nest groups into folders.' });
    if (name) project.renameGroup(gid, name);
  } else if (act === 'ungroup') {
    if (project.ungroup(gid)) toast(`Ungrouped “${project.groupName(gid)}”. Pages stay in place.`, { action: undoAction() });
  } else if (act === 'merge-up') {
    const first = runIds[0];
    const rows = list.rows;
    const idx = rows.findIndex((r) => r.type === 'item' && r.id === first);
    const prevRun = rows.slice(0, idx).reverse().find((r) => r.type === 'group');
    if (!prevRun) return;
    if (prevRun.gid === gid) { toast('The group above is the same group.'); return; }
    if (project.mergeGroups(gid, prevRun.gid)) toast(`Merged into “${prevRun.name}”.`, { action: undoAction() });
  }
}

function moveSelectedToGroup(gid) {
  const ids = list.selectedIds();
  if (!ids.length) return;
  const set = new Set(ids);
  const order = project.order;
  let last = -1;
  order.forEach((id, i) => { if (!set.has(id) && project.groupOf(id) === gid) last = i; });
  let before = null;
  if (last >= 0) before = order.slice(last + 1).find((id) => !set.has(id)) ?? null;
  project.moveItems(ids, before, gid, `Move to “${project.groupName(gid) ?? 'Ungrouped'}”`);
}

$('#btn-up').addEventListener('click', () => list.moveSelection(-1));
$('#btn-down').addEventListener('click', () => list.moveSelection(1));
$('#btn-top').addEventListener('click', () => {
  const ids = list.selectedIds();
  const first = project.order.find((id) => !ids.includes(id));
  project.moveItems(ids, first ?? null, first ? project.groupOf(first) : undefined, 'Move to top');
});
$('#btn-bottom').addEventListener('click', () => {
  const ids = list.selectedIds();
  const rest = project.order.filter((id) => !ids.includes(id));
  project.moveItems(ids, null, rest.length ? project.groupOf(rest.at(-1)) : undefined, 'Move to bottom');
});
$('#btn-remove').addEventListener('click', () => removePages(list.selectedIds()));
$('#btn-group').addEventListener('click', async () => {
  const ids = list.selectedIds();
  const name = await promptDialog({ title: 'Group selection', label: 'Group name', value: 'New group', confirmLabel: 'Create group', hint: `${plural(ids.length, 'page')} will be gathered into one group at the position of the first selected page.` });
  if (name) project.createGroup(ids, name);
});
$('#btn-split').addEventListener('click', async () => {
  if (!list.focusId) return;
  const name = await promptDialog({ title: 'Split group', label: 'Name of the new group', value: 'New group', confirmLabel: 'Split', hint: 'The focused page and the following pages of its group move into the new group.' });
  if (name) project.splitGroup(list.focusId, name);
});
el.moveToGroup.addEventListener('change', () => {
  const v = el.moveToGroup.value;
  el.moveToGroup.selectedIndex = 0;
  if (v === '') return;
  moveSelectedToGroup(v === '__none' ? null : v);
});

// ---------------------------------------------------------------- toolbar

el.undo.addEventListener('click', () => { const l = project.undo(); if (l) announce(`Undid: ${l}`); });
el.redo.addEventListener('click', () => { const l = project.redo(); if (l) announce(`Redid: ${l}`); });
$('#btn-sort').addEventListener('click', () => (project.size ? showSortDialog(project, list.selectedIds()) : toast('Add pages first.')));
$('#btn-text-order').addEventListener('click', () => (project.size ? showTextOrderDialog(project) : toast('Add pages first.')));
$('#btn-rules').addEventListener('click', () => showRulesDialog((rules) => { savedRules = rules; }));
$('#btn-export').addEventListener('click', () => (project.size ? showExportDialog(project) : toast('Add pages first, then export.')));
$('#btn-clear').addEventListener('click', async () => {
  if (!project.size) return;
  if (await confirmDialog({ title: 'Clear project', message: `Remove all ${plural(project.size, 'page')} from the project? Your original files are not touched, and you can undo this.`, confirmLabel: 'Clear project', danger: true })) {
    project.clear();
    toast('Project cleared.', { action: undoAction() });
  }
});

window.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  if (typing || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? project.redo() : project.undo()); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); project.redo(); }
});

window.addEventListener('beforeunload', (e) => {
  if (project.size) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- panels

function updateSelectionUI() {
  const ids = list.selectedIds();
  const n = ids.length;
  el.selInfo.textContent = project.size ? (n ? `${plural(n, 'page')} selected of ${project.size.toLocaleString()}` : `${plural(project.size, 'page')}`) : '';
  for (const id of ['#btn-up', '#btn-down', '#btn-top', '#btn-bottom', '#btn-remove', '#btn-group']) $(id).disabled = n === 0;
  $('#btn-split').disabled = !list.focusId;
  el.moveToGroup.disabled = n === 0;
  renderPreview();
}

function updateProjectUI() {
  el.undo.disabled = !project.canUndo;
  el.redo.disabled = !project.canRedo;
  el.undo.title = project.canUndo ? `Undo: ${project.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
  el.redo.title = project.canRedo ? `Redo: ${project.redoLabel} (Ctrl+Y)` : 'Nothing to redo';
  el.empty.hidden = project.size > 0;
  for (const id of ['#btn-sort', '#btn-text-order', '#btn-export', '#btn-clear']) $(id).disabled = project.size === 0;

  const groups = project.groups().filter((g) => g.id != null);
  el.moveToGroup.textContent = '';
  el.moveToGroup.append(h('option', { value: '' }, groups.length ? 'Move to group…' : 'No groups'));
  groups.forEach((g) => el.moveToGroup.append(h('option', { value: g.id }, g.name)));
  if (groups.length) el.moveToGroup.append(h('option', { value: '__none' }, 'Ungrouped'));
  el.moveToGroup.hidden = groups.length === 0;

  renderSources();
  renderIssues();
}

function renderSources() {
  const sources = project.activeSources();
  el.sourceCount.textContent = sources.length ? plural(sources.length, 'source') : '';
  el.sources.textContent = '';
  if (!sources.length) { el.sources.append(h('p', { class: 'muted' }, 'Nothing imported yet.')); return; }
  for (const s of sources) {
    const live = project.sources.get(s.id);
    const guess = live.uncertain.length && !live.acknowledged;
    el.sources.append(h('div', { class: 'source' },
      h('div', { class: 'title' }, h('span', {}, guess ? h('span', { class: 'dot', title: 'Order is a guess' }) : null, s.label)),
      h('div', { class: 'meta' }, `${{ cbz: 'CBZ', folder: 'Folder', images: 'Images' }[s.kind]} · ${plural(s.pageCount, 'page')} · ${s.presetName}`),
      h('div', { class: 'actions' },
        button('Structure…', { class: 'small', onclick: async () => { await showStructureDialog({ project, source: live, savedRules }); updateProjectUI(); } }),
        guess ? button('Order is OK', { class: 'small', title: live.uncertain.join(' '), onclick: () => { live.acknowledged = true; updateProjectUI(); } }) : null,
        button('Remove', { class: 'small danger-text', onclick: () => { project.removeSource(s.id); toast(`Removed “${s.label}” from the project. The original is untouched.`, { action: undoAction() }); } }))));
  }
}

let previewToken = 0;
let previewUrl = null;
async function renderPreview() {
  const id = list.focusId;
  const token = ++previewToken;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  el.preview.textContent = '';
  if (!id || !project.item(id) || project.indexOf(id) < 0) {
    el.preview.append(h('p', { class: 'preview-empty' }, project.size ? 'Select a page to preview it.' : 'Add pages to see a preview here.'));
    return;
  }
  const it = project.item(id);
  const src = project.sources.get(it.sourceId);
  const gname = project.groupName(project.groupOf(id));
  const dims = h('dd', {}, '…');
  const imgHost = h('div', {});
  el.preview.append(imgHost, h('dl', { class: 'kv' },
    h('dt', {}, 'Name'), h('dd', {}, it.name),
    h('dt', {}, 'Position'), h('dd', {}, `${project.indexOf(id) + 1} of ${project.size.toLocaleString()}`),
    h('dt', {}, 'Group'), h('dd', {}, gname ?? 'Ungrouped'),
    h('dt', {}, 'Source'), h('dd', {}, src.label),
    h('dt', {}, 'Path'), h('dd', { class: 'mono' }, it.path),
    h('dt', {}, 'Size'), h('dd', {}, fmtBytes(it.size || 0)),
    h('dt', {}, 'Dimensions'), dims));
  try {
    const blob = await it.read();
    if (token !== previewToken) return;
    previewUrl = URL.createObjectURL(blob);
    const img = h('img', { class: 'preview-img', alt: `Preview of ${it.name}`, src: previewUrl });
    img.onload = () => { dims.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`; };
    img.onerror = () => { img.remove(); dims.textContent = 'not available'; imgHost.append(h('p', { class: 'msg warn' }, 'This browser cannot display this image. It will still be packaged unchanged.')); };
    imgHost.append(img);
  } catch (e) {
    if (token === previewToken) imgHost.append(h('p', { class: 'msg error' }, `The file could not be read: ${e.message}. It may have been moved or deleted.`));
  }
}

function renderIssues() {
  const live = new Set(project.order);
  const unreadable = readIssues.filter((i) => i.itemIds.every((id) => live.has(id)));
  const issues = [...unreadable, ...validateProject(project)].filter((i) => i.id !== 'empty');
  const flagged = issues.filter((i) => i.severity !== 'info').length;
  el.issueCount.textContent = flagged ? String(flagged) : '';
  el.issues.textContent = '';
  el.issues.append(
    h('div', { class: 'toolbar-inline' }, button('Check that all files are readable', {
      class: 'small', disabled: !project.size,
      onclick: async () => {
        const t = toast('Checking files…', { timeout: 0 });
        readIssues = await checkReadable(project);
        t.remove();
        toast(readIssues.length ? `${plural(readIssues.length, 'page')} cannot be read.` : 'All pages can be read.', { kind: readIssues.length ? 'error' : 'info' });
        renderIssues();
      },
    })));
  if (!issues.length) { el.issues.append(h('p', { class: 'muted' }, project.size ? 'No problems found.' : 'Problems with imported pages appear here.')); return; }
  for (const i of issues) {
    const actions = [];
    if (i.action === 'acknowledge') actions.push(button('Order is OK', { class: 'small', onclick: () => { project.sources.get(i.sourceId).acknowledged = true; updateProjectUI(); } }));
    if (i.action === 'skipped') actions.push(button('Show files', { class: 'small', onclick: () => {
      const s = project.sources.get(i.sourceId);
      const m = modal({ title: `Not imported from “${s.label}”`, body: skippedList(s.skipped, 500), footer: [button('Close', { class: 'primary', onclick: () => m.close() })] });
    } }));
    if (i.itemIds?.length) actions.push(button('Select pages', { class: 'small', onclick: () => { list.setSelection(project.order.filter((id) => i.itemIds.includes(id))); list.scrollToId(list.focusId); } }));
    el.issues.append(h('div', { class: `issue ${i.severity}` }, h('strong', {}, i.title), h('span', {}, i.detail), actions.length ? h('div', { class: 'actions' }, actions) : null));
  }
}

// tabs (inspector) and narrow-screen navigation
function selectTab(which) {
  const preview = which === 'preview';
  $('#tab-preview').setAttribute('aria-selected', String(preview));
  $('#tab-issues').setAttribute('aria-selected', String(!preview));
  $('#pane-preview').hidden = !preview;
  $('#pane-issues').hidden = preview;
}
$('#tab-preview').addEventListener('click', () => selectTab('preview'));
$('#tab-issues').addEventListener('click', () => selectTab('issues'));
document.querySelectorAll('.bottom-tabs button').forEach((b) => b.addEventListener('click', () => {
  el.app.dataset.view = b.dataset.view;
  document.querySelectorAll('.bottom-tabs button').forEach((x) => x.setAttribute('aria-current', String(x === b)));
  if (b.dataset.view === 'pages') list.draw();
}));

project.subscribe(() => { list.refresh(); updateProjectUI(); });
list.refresh();
updateProjectUI();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
}

// test hook for automated checks; harmless in normal use
window.__cbz = { project, list };
