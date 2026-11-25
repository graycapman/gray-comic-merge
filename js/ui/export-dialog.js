// Export / extract dialog: choose archive structure, review the final reading order, save.
import { h, put, button, modal, plural, fmtBytes, downloadBlob, choiceDialog } from './dom.js';
import { VirtualRows } from './virtual.js';
import {
  STRUCTURES, NAMINGS, defaultExportOptions, planExport, suggestFileName, buildArchive, verifyArchive,
  findExisting, writeImages, ExportError,
} from '../export.js';
import { validateProject, checkReadable } from '../validate.js';
import { sanitizeSegment } from '../paths.js';

const CAN_SAVE_FILE = typeof window.showSaveFilePicker === 'function';
const CAN_SAVE_DIR = typeof window.showDirectoryPicker === 'function';

function radioGroup(legend, name, items, current, onChange) {
  return h('fieldset', { class: 'radios' }, h('legend', {}, legend),
    items.map((it) => h('label', { class: 'check stack' },
      h('input', { type: 'radio', name, value: it.id, checked: current === it.id, onchange: () => onChange(it.id) }),
      h('span', {}, h('strong', {}, it.label), h('span', { class: 'muted block' }, it.hint)))));
}

export function showExportDialog(project) {
  const opts = { ...defaultExportOptions(project), ...(project.exportOptions || {}) };
  opts.fileName = project.exportOptions?.fileName || suggestFileName(project);
  let plan = null;
  let m;
  let readBad = [];
  let readDone = false;
  let abort = new AbortController();

  const messages = h('div', { class: 'messages', 'aria-live': 'polite' });
  const summary = h('dl', { class: 'summary-grid' });
  const ack = h('input', { type: 'checkbox', onchange: () => sync() });
  const ackRow = h('label', { class: 'check', hidden: true }, ack, 'I have reviewed these warnings and want to export anyway');
  const go = button('', { class: 'primary' });
  const pathHost = h('div', { class: 'diff-list', tabindex: 0, role: 'list', 'aria-label': 'Final reading order with file names' });
  let paths = [];
  const vr = new VirtualRows(pathHost, 26, (i) => h('div', { class: 'diff-row simple', role: 'listitem' },
    h('span', { class: 'num' }, i + 1), h('span', { class: 'name mono' }, paths[i].path)));

  const optionsHost = h('div', { class: 'options' });
  const nameInput = h('input', { id: 'out-name', type: 'text', value: opts.fileName, oninput: () => { opts.fileName = nameInput.value; refresh(); } });
  const templateInput = h('input', { id: 'out-template', type: 'text', value: opts.template, spellcheck: false, oninput: () => { opts.template = templateInput.value; refresh(); } });
  const templateRow = h('div', { class: 'field' }, h('label', { for: 'out-template' }, 'Path template'), templateInput,
    h('p', { class: 'hint' }, 'Placeholders: {index} page number, {file} original file name, {name} name without extension, {ext}, {group}, {source}, {dir} original folder. Use / for folders.'));
  const numberRow = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts.numberFolders, onchange: (e) => { opts.numberFolders = e.target.checked; refresh(); } }),
    h('span', {}, 'Number folders (01 - Chapter 1)', h('span', { class: 'muted block' }, 'Keeps folders in reading order in readers that sort by name.')));

  function buildOptions() {
    optionsHost.textContent = '';
    put(optionsHost,
      radioGroup('Output', 'format', [
        { id: 'cbz', label: 'CBZ archive', hint: 'One .cbz file with all pages.' },
        { id: 'images', label: 'Image files', hint: 'Extract the pages as separate files.' },
      ], opts.format, (v) => { opts.format = v; refresh(); }),
      radioGroup('Archive structure', 'structure', STRUCTURES, opts.structure, (v) => { opts.structure = v; refresh(); }),
      opts.structure === 'custom' ? templateRow : radioGroup('File names', 'naming', NAMINGS, opts.naming, (v) => { opts.naming = v; refresh(); }),
      numberRow,
      opts.format === 'cbz' ? h('div', { class: 'field' }, h('label', { for: 'out-name' }, 'File name'), h('div', { class: 'suffix' }, nameInput, h('span', {}, '.cbz'))) : null,
    );
  }

  function warningsList() {
    const issues = validateProject(project).filter((i) => i.severity === 'warning').map((i) => `${i.title}. ${i.detail}`);
    return [...issues, ...(plan?.warnings || [])];
  }

  function sync() {
    const warns = warningsList();
    ackRow.hidden = warns.length === 0;
    const blocked = plan.errors.length > 0 || readBad.length > 0 || !readDone;
    go.disabled = blocked || (warns.length > 0 && !ack.checked);
  }

  function refresh() {
    project.exportOptions = { ...opts };
    plan = planExport(project, opts, { canStream: CAN_SAVE_FILE });
    if (m && optionsHost.dataset.struct !== `${opts.structure}|${opts.format}`) { buildOptions(); }
    optionsHost.dataset.struct = `${opts.structure}|${opts.format}`;
    messages.textContent = '';
    const addMsg = (cls, text) => messages.append(h('p', { class: `msg ${cls}` }, text));
    plan.errors.forEach((e) => addMsg('error', e));
    readBad.slice(0, 5).forEach((b) => addMsg('error', `${b.title}. ${b.detail}`));
    if (readBad.length > 5) addMsg('error', `…and ${readBad.length - 5} more unreadable pages.`);
    if (!readDone) addMsg('info', 'Checking that every page can still be read…');
    warningsList().forEach((w) => addMsg('warn', w));
    if (plan.readerOrder && plan.readerOrder.lexicalOk && plan.readerOrder.naturalOk) addMsg('ok', 'Sorted by name or in natural order, these file names give exactly your reading order.');

    const name = `${sanitizeSegment(opts.fileName || 'comic')}.cbz`;
    summary.textContent = '';
    const row = (k, v) => summary.append(h('dt', {}, k), h('dd', {}, v));
    row('Pages', plural(project.size, 'page'));
    row('Sources', plural(project.activeSources().length, 'source'));
    row('Structure', STRUCTURES.find((s) => s.id === opts.structure).label + (opts.structure === 'custom' ? `: ${opts.template}` : ''));
    if (opts.format === 'cbz') {
      row('File', name);
      row('Destination', CAN_SAVE_FILE ? 'You pick it in the save dialog. The system asks before replacing a file.' : 'Your browser’s download folder. An existing file is never replaced; the browser adds a number.');
    } else {
      row('Destination', CAN_SAVE_DIR ? 'A folder you pick. You are asked before any existing file is replaced.' : 'Downloaded as one ZIP of images (this browser cannot write to folders).');
    }
    row('Size', fmtBytes(plan.totalBytes || 0));

    paths = plan.entries;
    vr.setCount(paths.length);
    go.textContent = opts.format === 'cbz' ? 'Save CBZ…' : CAN_SAVE_DIR ? 'Choose folder…' : 'Download images (ZIP)';
    sync();
  }

  // ----- running the export -----
  const view = h('div', {});
  function showProgress(text) {
    view.textContent = '';
    const bar = h('progress', { max: 1, value: 0 });
    const label = h('p', { 'aria-live': 'polite' }, text);
    view.append(label, bar);
    return { set(done, total, t) { bar.value = total ? done / total : 0; if (t) label.textContent = t; else label.textContent = `${text} ${done} / ${total}`; } };
  }

  async function run() {
    const fresh = planExport(project, opts, { canStream: CAN_SAVE_FILE });
    if (fresh.errors.length) return;
    abort = new AbortController();
    const name = `${sanitizeSegment(opts.fileName || 'comic')}.cbz`;
    let handle = null;
    let dir = null;
    try {
      if (opts.format === 'cbz' && CAN_SAVE_FILE) {
        handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Comic book archive', accept: { 'application/vnd.comicbook+zip': ['.cbz'] } }] });
      } else if (opts.format === 'images' && CAN_SAVE_DIR) {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // user closed the picker; nothing happened
      return finish(false, `The save dialog could not be opened: ${e.message}`);
    }
    body.hidden = true;
    view.hidden = false;
    footerNormal.hidden = true;
    footerBusy.hidden = false;
    const progress = showProgress('Reading pages');
    try {
      let result;
      if (dir) {
        const existing = await findExisting(dir, fresh);
        let overwrite = false;
        if (existing.length) {
          const choice = await choiceDialog({
            title: 'Files already exist',
            message: `${plural(existing.length, 'file')} in this folder already ${existing.length === 1 ? 'has' : 'have'} the same name (for example “${existing[0]}”). Replace them or keep the existing files?`,
            choices: [{ label: 'Keep existing, extract the rest', value: 'skip' }, { label: 'Replace existing files', value: 'replace', kind: 'danger' }],
          });
          if (!choice) return finish(false, 'Extraction cancelled. Nothing was written.');
          overwrite = choice === 'replace';
        }
        const r = await writeImages(dir, project, fresh, { existing, overwrite, signal: abort.signal, onProgress: (d, t) => progress.set(d, t) });
        const parts = [`${plural(r.written, 'file')} written to “${dir.name}”`];
        if (r.skipped) parts.push(`${r.skipped} existing file(s) kept`);
        if (r.errors.length) return finish(false, `${parts.join(', ')}. ${plural(r.errors.length, 'file')} failed:\n${r.errors.slice(0, 5).join('\n')}`);
        result = parts.join(', ') + '.';
      } else {
        const outName = opts.format === 'cbz' ? name : `${sanitizeSegment(opts.fileName || 'comic')}-images.zip`;
        if (handle) {
          // Stream straight to disk. The writable keeps changes in a temporary file until close(),
          // so a failure leaves any existing file untouched.
          const w = await handle.createWritable();
          let size = 0;
          try {
            await buildArchive(project, fresh, { signal: abort.signal, onProgress: (d, t) => progress.set(d, t), sink: { write: (c) => { size += c.size ?? c.length; return w.write(c); } } });
            progress.set(0, 0, 'Writing the file…');
            await w.close();
          } catch (e) {
            await w.abort().catch(() => {});
            throw e;
          }
          progress.set(0, 0, 'Checking the finished archive…');
          const problems = await verifyArchive(await handle.getFile(), fresh);
          if (problems.length) return finish(false, `The saved archive failed its own check: ${problems[0]} Delete “${handle.name}” and try again.`);
          result = `Saved ${plural(project.size, 'page')} as “${handle.name}” (${fmtBytes(size)}). The archive was re-opened and checked: names and order match.`;
        } else {
          const blob = await buildArchive(project, fresh, { signal: abort.signal, onProgress: (d, t) => progress.set(d, t) });
          progress.set(0, 0, 'Checking the finished archive…');
          const problems = opts.format === 'cbz' ? await verifyArchive(blob, fresh) : [];
          if (problems.length) return finish(false, `The archive failed its own check and was not saved: ${problems[0]}`);
          downloadBlob(blob, outName);
          result = `Created “${outName}” (${fmtBytes(blob.size)}) and sent it to your browser’s downloads. The archive was re-opened and checked: names and order match.`;
        }
      }
      finish(true, result);
    } catch (e) {
      if (e.name === 'AbortError') {
        await handle?.remove?.().catch(() => {});
        return finish(false, 'Cancelled. Nothing was saved.' + (handle ? ' If an empty file with the chosen name appeared, you can delete it.' : ''));
      }
      if (handle && e instanceof ExportError) await handle.remove?.().catch(() => {});
      finish(false, e instanceof ExportError ? e.message : `Export failed: ${e.message}`);
    }
  }

  function finish(ok, text) {
    body.hidden = true;
    view.hidden = false;
    view.textContent = '';
    view.append(h('p', { class: `msg ${ok ? 'ok' : 'error'}`, style: 'white-space:pre-line' }, text));
    footerNormal.hidden = true;
    footerBusy.hidden = true;
    footerDone.hidden = false;
    if (!ok) footerDone.prepend(button('Back to options', { onclick: () => { body.hidden = false; view.hidden = true; footerDone.hidden = true; footerNormal.hidden = false; footerDone.firstChild.remove(); refresh(); } }));
  }

  go.addEventListener('click', run);
  const body = h('div', {}, optionsHost, summary, messages, ackRow,
    h('h3', {}, 'Final reading order'), pathHost);
  view.hidden = true;
  const footerNormal = h('div', { class: 'footer-set' }, button('Cancel', { onclick: () => m.close(false) }), go);
  const footerBusy = h('div', { class: 'footer-set', hidden: true }, button('Cancel export', { onclick: () => abort.abort() }));
  const footerDone = h('div', { class: 'footer-set', hidden: true }, button('Close', { class: 'primary', onclick: () => m.close(true) }));

  m = modal({ title: 'Export', wide: true, body: [body, view], footer: [footerNormal, footerBusy, footerDone] });
  buildOptions();
  refresh();
  checkReadable(project, { signal: abort.signal }).then((bad) => { readBad = bad; readDone = true; if (m.el.isConnected) refresh(); });
  m.closed.then(() => abort.abort());
  return m.closed;
}
