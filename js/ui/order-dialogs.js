// Previewed ordering operations: automatic sort and text-based order.
import { h, put, button, modal, plural } from './dom.js';
import { VirtualRows } from './virtual.js';
import { SORT_METHODS, proposeSort, diffOrder } from '../ordering.js';
import { planTextOrder, currentOrderAsText } from '../textorder.js';

/** Scrollable before/after list. Shows new position, old position and what moved. */
export function diffList(project) {
  const host = h('div', { class: 'diff-list', tabindex: 0, role: 'list', 'aria-label': 'Proposed reading order' });
  let rows = [];
  let all = [];
  let onlyMoved = false;
  const vr = new VirtualRows(host, 30, (i) => {
    const r = rows[i];
    const it = project.item(r.id);
    const moved = r.from !== r.to;
    const gname = project.groupName(project.groupOf(r.id));
    return h('div', { class: `diff-row${moved ? ' moved' : ''}`, role: 'listitem' },
      h('span', { class: 'num' }, r.to + 1),
      h('span', { class: 'from' }, moved ? `${r.from > r.to ? '↑' : '↓'} was ${r.from + 1}` : 'unchanged'),
      h('span', { class: 'name' }, it.name),
      h('span', { class: 'path' }, gname ? `${gname} · ${it.path}` : it.path));
  });
  const apply = () => { rows = onlyMoved ? all.filter((r) => r.from !== r.to) : all; vr.setCount(rows.length); };
  return {
    el: host,
    set(oldOrder, newOrder) { const d = diffOrder(oldOrder, newOrder); all = d.rows; apply(); return d; },
    setOnlyMoved(v) { onlyMoved = v; apply(); },
  };
}

export function showSortDialog(project, selection) {
  let m;
  const groupsExist = project.groups().some((g) => g.id != null);
  const state = { method: 'natural-name', scope: groupsExist ? 'groups' : 'all', order: project.order };
  const list = diffList(project);
  const summary = h('p', { class: 'summary', 'aria-live': 'polite' });
  const apply = button('Apply', { class: 'primary' });

  const scopes = [
    { id: 'all', label: 'All pages' },
    groupsExist && { id: 'groups', label: 'Inside each group (groups stay where they are)' },
    selection.length > 1 && { id: 'selection', label: `Selected pages only (${selection.length})` },
  ].filter(Boolean);

  const scopeBox = h('fieldset', { class: 'radios' }, h('legend', {}, 'Apply to'),
    scopes.map((s) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'scope', value: s.id, checked: state.scope === s.id, onchange: () => { state.scope = s.id; update(); } }), s.label)));

  const select = h('select', { id: 'sort-method', onchange: () => { state.method = select.value; update(); } },
    SORT_METHODS.map((s) => h('option', { value: s.id }, s.label)));

  function update() {
    const wholeGroups = state.method === 'groups-natural';
    scopeBox.disabled = wholeGroups;
    state.order = proposeSort(project, state.method, state.scope, selection);
    const d = list.set(project.order, state.order);
    summary.textContent = d.moved ? `${plural(d.moved, 'page')} would move, ${d.unchanged} stay.` : 'This would not change the current order.';
    apply.disabled = d.moved === 0;
  }
  apply.addEventListener('click', () => {
    const label = SORT_METHODS.find((s) => s.id === state.method).label;
    project.applyOrder(state.order, `Sort: ${label}`);
    m.close(true);
  });

  m = modal({
    title: 'Sort pages', wide: true,
    body: [
      h('p', { class: 'muted' }, 'Review the result below. Nothing changes until you press Apply, and you can undo afterwards.'),
      h('div', { class: 'field' }, h('label', { for: 'sort-method' }, 'Method'), select),
      scopeBox,
      summary,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => list.setOnlyMoved(e.target.checked) }), 'Show only pages that move'),
      list.el,
    ],
    footer: [button('Cancel', { onclick: () => m.close(false) }), apply],
  });
  update();
  return m.closed;
}

function problemBlock(title, hint, items, render, kind) {
  if (!items.length) return null;
  const shown = items.slice(0, 100);
  return h('details', { class: `problem ${kind}`, open: items.length <= 12 },
    h('summary', {}, `${title} (${items.length})`),
    h('p', { class: 'muted' }, hint),
    h('ul', { class: 'plain-list mono' }, shown.map(render), items.length > shown.length ? h('li', { class: 'muted' }, `…and ${items.length - shown.length} more`) : null));
}

export function showTextOrderDialog(project) {
  let m;
  const list = diffList(project);
  const summary = h('p', { class: 'summary', 'aria-live': 'polite' });
  const problems = h('div', {});
  const apply = button('Apply order', { class: 'primary', disabled: true });
  const ack = h('input', { type: 'checkbox', id: 'ack-problems', onchange: () => sync() });
  const ackRow = h('label', { class: 'check', hidden: true }, ack, 'I have reviewed the problems above and want to apply the order anyway');
  const resolve = h('input', { type: 'checkbox', id: 'resolve-repeated', onchange: () => update() });
  const area = h('textarea', {
    id: 'order-text', rows: 7, spellcheck: false, placeholder: '001.jpg\n002.jpg\nChapter 2/001.jpg',
    'aria-describedby': 'order-help', oninput: () => { clearTimeout(timer); timer = setTimeout(update, 200); },
  });
  let timer;
  let plan = null;

  function sync() {
    const hasProblems = plan && (plan.unmatched.length || plan.duplicates.length || plan.ambiguous.length);
    ackRow.hidden = !hasProblems;
    apply.disabled = !plan || !plan.changed || (hasProblems && !ack.checked);
  }

  function update() {
    ack.checked = false;
    if (!area.value.trim()) {
      plan = null;
      problems.textContent = '';
      summary.textContent = 'Paste one file name per line. Case, extra spaces and missing extensions are tolerated.';
      list.set(project.order, project.order);
      sync();
      return;
    }
    plan = planTextOrder(project, area.value, { resolveRepeated: resolve.checked });
    const d = list.set(project.order, plan.order);
    summary.textContent = `${plural(plan.matches.length, 'line')} matched of ${plural(plan.lineCount, 'line')}. ${plural(plan.remaining.length, 'page')} not mentioned will follow in their current order. ${plural(d.moved, 'page')} would move.`;
    const name = (id) => project.item(id).path;
    problems.textContent = '';
    put(problems,
      problemBlock('Unmatched lines', 'No imported page has this name. They are ignored; no file is created.', plan.unmatched, (u) => h('li', {}, `line ${u.lineNo}: ${u.line}`), 'warn'),
      problemBlock('Duplicate references', 'The page was already placed by an earlier line; the later line is ignored.', plan.duplicates, (u) => h('li', {}, `line ${u.lineNo}: ${u.line} (already placed by line ${u.firstLineNo})`), 'warn'),
      problemBlock('Ambiguous names', 'Several pages share this name, so it was not applied. Use a path such as "Chapter 2/001.jpg", or tick the option below.', plan.ambiguous,
        (u) => h('li', {}, `line ${u.lineNo}: ${u.line} → ${u.candidates.slice(0, 4).map(name).join(' | ')}${u.candidates.length > 4 ? ' …' : ''}`), 'warn'),
      problemBlock('Matched with a note', 'Review these matches.', plan.matches.filter((x) => x.note), (u) => h('li', {}, `line ${u.lineNo}: ${u.line} (${u.note})`), 'info'),
      problemBlock('Pages not in your list', 'These keep their relative order and are placed after the listed pages.', plan.remaining.map((id) => ({ id })), (u) => h('li', {}, name(u.id)), 'info'),
    );
    sync();
  }

  apply.addEventListener('click', () => {
    project.applyOrder(plan.order, `Order from text list (${plan.matches.length} pages)`);
    m.close(true);
  });

  const fileInput = h('input', {
    type: 'file', accept: '.txt,text/plain', hidden: true,
    onchange: async () => { const f = fileInput.files[0]; if (f) { area.value = await f.text(); update(); } fileInput.value = ''; },
  });

  m = modal({
    title: 'Order from a list', wide: true,
    body: [
      h('p', { id: 'order-help', class: 'muted' }, 'One file name per line. Only existing pages are reordered; nothing is renamed, added or deleted.'),
      h('div', { class: 'toolbar-inline' },
        button('Fill with current order', { class: 'small', onclick: () => { area.value = currentOrderAsText(project); update(); } }),
        button('Load .txt file', { class: 'small', onclick: () => fileInput.click() }), fileInput),
      area,
      h('label', { class: 'check' }, resolve, 'Resolve repeated names by current order (only when a name appears in the list as often as it exists)'),
      summary, problems, ackRow,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => list.setOnlyMoved(e.target.checked) }), 'Show only pages that move'),
      list.el,
    ],
    footer: [button('Cancel', { onclick: () => m.close(false) }), apply],
  });
  area.focus();
  update();
  return m.closed;
}
