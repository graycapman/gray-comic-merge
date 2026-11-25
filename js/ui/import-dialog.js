// Import review (structure per source) and the "Change structure" dialog.
import { h, put, button, modal, plural } from './dom.js';
import { PRESETS } from '../structure.js';
import { structureFor, commitImport } from '../importer.js';
import { applyRule, ruleFor } from '../structure.js';

const LEVEL_TEXT = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence: check the order' };
const KIND_TEXT = { cbz: 'CBZ', folder: 'Folder', images: 'Images' };

export function structureSelect(source, savedRules, onChange, suggestedId) {
  const opt = (id, name) => h('option', { value: id, selected: source.selection === id }, name + (id === suggestedId ? ' (suggested)' : ''));
  const sel = h('select', { 'aria-label': `Structure for ${source.label}`, onchange: () => onChange(sel.value) },
    h('optgroup', { label: 'Presets' }, PRESETS.map((p) => opt(p.id, p.name))),
    savedRules.length ? h('optgroup', { label: 'Your rules' }, savedRules.map((r) => opt(r.id, r.name))) : null);
  return sel;
}

export function groupSummary(result, max = 8) {
  const named = result.groups;
  if (named.length === 1 && named[0].name == null) return h('p', { class: 'muted' }, `${plural(named[0].entries.length, 'page')} in one run, no groups.`);
  const chips = named.slice(0, max).map((g) => h('span', { class: 'chip plain' }, `${g.name ?? 'Top folder'} · ${g.entries.length}`));
  if (named.length > max) chips.push(h('span', { class: 'muted' }, `+${named.length - max} more groups`));
  return h('div', { class: 'chips' }, chips);
}

export function skippedList(skipped, limit = 150) {
  const shown = skipped.slice(0, limit);
  return h('ul', { class: 'plain-list mono' },
    shown.map((s) => h('li', {}, h('span', {}, s.path), h('span', { class: 'muted' }, ` — ${s.reason}`))),
    skipped.length > limit ? h('li', { class: 'muted' }, `…and ${skipped.length - limit} more`) : null);
}

export function showImportDialog({ project, sources, topSkipped = [], savedRules }) {
  let m;
  const cards = [];
  const addBtn = button('Add to project', { class: 'primary' });

  function includedCount() {
    return sources.filter((s) => !s.error && !s.empty && !s.skip).reduce((n, s) => n + s.entries.length, 0);
  }
  function updateFooter() {
    const n = includedCount();
    addBtn.textContent = n ? `Add ${plural(n, 'page')}` : 'Nothing to add';
    addBtn.disabled = n === 0;
  }

  function buildCard(s) {
    const body = h('div', { class: 'card-body' });
    const card = h('section', { class: `card${s.error ? ' has-error' : ''}` });
    const head = h('header', {}, h('strong', {}, s.label), h('span', { class: 'chip plain' }, KIND_TEXT[s.kind]),
      h('span', { class: 'muted' }, s.error ? '' : plural(s.entries.length, 'new page')));
    card.append(head, body);

    function renderBody() {
      body.textContent = '';
      if (s.error) { body.append(h('p', { class: 'msg error' }, s.error, ' Remove it from the selection and try again, or re-export the archive.')); return; }
      if (s.empty) {
        body.append(h('p', { class: 'msg warn' }, s.skipped.length ? 'No new pages: everything in this source was skipped (see below).' : 'No images found in this source.'));
      } else {
        const r = structureFor(s, savedRules);
        const d = s.detection;
        const suggested = s.selection === d.presetId;
        put(body,
          h('div', { class: 'row-inline' },
            h('label', {}, 'Structure'),
            structureSelect(s, savedRules, (v) => { s.selection = v; renderBody(); updateFooter(); }, d.presetId),
            suggested ? h('span', { class: `chip ${d.level}` }, LEVEL_TEXT[d.level]) : h('span', { class: 'chip plain' }, 'Chosen by you')),
          suggested ? h('p', { class: 'muted' }, d.reasons.join(' ')) : null,
          groupSummary(r),
          [...r.uncertain, ...(suggested && d.level === 'low' ? ['Detection was not sure about this structure.'] : [])]
            .map((u) => h('p', { class: 'msg warn' }, u)),
          r.excluded.length ? h('details', {}, h('summary', {}, `${plural(r.excluded.length, 'page')} excluded by this rule`), skippedList(r.excluded)) : null,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !s.skip, onchange: (e) => { s.skip = !e.target.checked; updateFooter(); } }), 'Include this source'),
        );
      }
      if (s.skipped.length) {
        body.append(h('details', {}, h('summary', {}, `${plural(s.skipped.length, 'file')} not imported`), skippedList(s.skipped)));
      }
    }
    renderBody();
    return card;
  }

  for (const s of sources) cards.push(buildCard(s));
  const kinds = new Set(sources.map((s) => s.kind));
  const note = sources.length > 1
    ? h('p', { class: 'muted' }, `Sources are added in this order${kinds.size > 1 ? ' (mixed types)' : ''}. You can reorder pages and groups afterwards.`)
    : null;

  addBtn.addEventListener('click', () => {
    const result = commitImport(project, sources, savedRules);
    m.close(result);
  });
  m = modal({
    title: 'Review import', wide: true,
    body: [
      note,
      cards,
      topSkipped.length ? h('details', { class: 'card' }, h('summary', {}, `${plural(topSkipped.length, 'selected file')} not imported`), skippedList(topSkipped)) : null,
    ],
    footer: [button('Cancel', { onclick: () => m.close(null) }), addBtn],
  });
  updateFooter();
  return m.closed;
}

/** Re-applies a preset or rule to the pages of one source already in the project. */
export function showStructureDialog({ project, source, savedRules }) {
  let m;
  const ids = project.order.filter((id) => project.item(id).sourceId === source.id);
  const entries = ids.map((id) => { const it = project.item(id); return { id, path: it.path }; });
  const state = { selection: source.presetId || 'universal' };
  const preview = h('div', {});
  const apply = button('Apply structure', { class: 'primary' });

  function compute() {
    const { rule, universal } = ruleFor(state.selection, savedRules);
    return applyRule(rule, entries, { sourceLabel: source.label.replace(/\.(cbz|zip)$/i, '') }, universal);
  }
  function render() {
    const r = compute();
    preview.textContent = '';
    put(preview, groupSummary(r, 12), r.uncertain.map((u) => h('p', { class: 'msg warn' }, u)));
    if (r.excluded.length) preview.append(h('p', { class: 'msg error' }, `${plural(r.excluded.length, 'page')} would be excluded by this rule. Pages are never removed here, so choose a rule that includes them.`));
    apply.disabled = r.excluded.length > 0;
    state.result = r;
  }
  const select = structureSelect({ selection: state.selection, label: source.label }, savedRules, (v) => { state.selection = v; render(); });
  apply.addEventListener('click', () => {
    const r = state.result;
    source.uncertain = r.uncertain;
    source.acknowledged = false;
    source.presetName = ruleFor(state.selection, savedRules).name;
    project.restructureSource(source.id, r.groups.map((g) => ({ name: g.name, ids: g.entries.map((e) => e.id) })), `Change structure of "${source.label}"`);
    m.close(true);
  });
  m = modal({
    title: `Structure of “${source.label}”`,
    body: [
      h('p', { class: 'muted' }, 'This re-groups and re-orders only the pages of this source. Pages from other sources keep their positions. You can undo it.'),
      h('div', { class: 'row-inline' }, h('label', {}, 'Structure'), select),
      preview,
    ],
    footer: [button('Cancel', { onclick: () => m.close(false) }), apply],
  });
  render();
  return m.closed;
}
