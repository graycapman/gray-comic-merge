// The page list: virtualised rows, selection, keyboard control and Photoshop-layers-style
// drag & drop (pages and whole groups) with a visible insertion line.
import { h, plural } from './dom.js';
import { VirtualRows } from './virtual.js';
import * as thumbs from './thumbs.js';

export const ROW_H = 44;
const DRAG_THRESHOLD = 5;

export class PageList {
  /**
   * hooks: onSelect(), onRemove(ids), onGroupAction(action, gid, ids), announce(text)
   */
  constructor(host, project, hooks) {
    this.host = host;
    this.project = project;
    this.hooks = hooks;
    this.selected = new Set();
    this.focusId = null;
    this.anchor = null;
    this.rows = [];
    this.boundaries = [];
    this.rowIndexById = new Map();
    this.drag = null;
    this.dragIds = null;

    host.tabIndex = 0;
    host.setAttribute('role', 'listbox');
    host.setAttribute('aria-multiselectable', 'true');
    host.setAttribute('aria-label', 'Pages in reading order');

    this.vr = new VirtualRows(host, ROW_H, (i) => this.renderRow(i));
    this.vr.afterDraw = () => {
      const visible = new Set();
      for (let i = this.vr.first; i < this.vr.last; i++) if (this.rows[i]?.type === 'item') visible.add(this.rows[i].id);
      thumbs.pruneQueue(visible);
    };
    this.dropLine = h('div', { class: 'drop-line', hidden: true, 'aria-hidden': 'true' });
    this.dropLine.dataset.keep = '1';
    this.vr.inner.append(this.dropLine);
    this.ghost = h('div', { class: 'drag-ghost', hidden: true, 'aria-hidden': 'true' });
    document.body.append(this.ghost);

    host.addEventListener('click', (e) => this.onClick(e));
    host.addEventListener('dblclick', (e) => {
      const g = e.target.closest('.row.group');
      if (g && g.dataset.gid) hooks.onGroupAction('rename', g.dataset.gid, []);
    });
    host.addEventListener('keydown', (e) => this.onKey(e));
    host.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', () => this.cancelDrag());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.drag) { this.cancelDrag(); e.stopPropagation(); } }, true);
    this.rebuild();
  }

  // ----- data -----
  get hasHeaders() { return this.rows.some((r) => r.type === 'group'); }
  selectedIds() { return this.project.order.filter((id) => this.selected.has(id)); }
  /** Group of the focused (or first selected) page; undefined when nothing is focused. */
  currentGroup() {
    const id = this.focusId ?? this.selectedIds()[0];
    return id == null ? undefined : this.project.groupOf(id);
  }

  rebuild() {
    const p = this.project;
    const runs = [];
    let cur = null;
    for (const id of p.order) {
      const gid = p.groupOf(id);
      if (!cur || cur.gid !== gid) { cur = { gid, ids: [] }; runs.push(cur); }
      cur.ids.push(id);
    }
    const showHeaders = runs.some((r) => r.gid != null);
    const rows = [];
    const boundaries = [];
    const seen = new Set();
    let page = 0;
    runs.forEach((run, runIndex) => {
      run.index = runIndex;
      run.continued = run.gid != null && seen.has(run.gid);
      seen.add(run.gid);
      if (showHeaders) {
        boundaries.push(rows.length);
        rows.push({ type: 'group', gid: run.gid, run, name: run.gid == null ? 'Ungrouped' : p.groupName(run.gid) });
      }
      for (const id of run.ids) rows.push({ type: 'item', id, gid: run.gid, page: ++page, run });
    });
    boundaries.push(rows.length);
    this.rows = rows;
    this.boundaries = boundaries;
    this.rowIndexById = new Map();
    rows.forEach((r, i) => { if (r.type === 'item') this.rowIndexById.set(r.id, i); });
    for (const id of [...this.selected]) if (!this.rowIndexById.has(id)) this.selected.delete(id);
    if (!this.rowIndexById.has(this.focusId)) this.focusId = null;
    if (!this.rowIndexById.has(this.anchor)) this.anchor = null;
    this.vr.setCount(rows.length);
  }

  refresh() {
    this.rebuild();
    this.hooks.onSelect();
  }

  // ----- rendering -----
  renderRow(i) {
    const r = this.rows[i];
    return r.type === 'group' ? this.renderGroup(r, i) : this.renderItem(r);
  }

  sourceLabel(item) {
    return this.project.sources.get(item.sourceId)?.label ?? '';
  }

  renderItem(r) {
    const item = this.project.item(r.id);
    const sel = this.selected.has(r.id);
    const img = h('img', { alt: '', draggable: false });
    const box = h('span', { class: 'thumb' }, img);
    const cached = thumbs.peek(r.id);
    if (cached) img.src = cached;
    else {
      box.classList.add('ph');
      box.textContent = item.ext.toUpperCase().slice(0, 4);
      const queued = thumbs.requestThumb(item, (url) => {
        if (!box.isConnected && !url) return;
        if (url) { box.classList.remove('ph'); box.textContent = ''; img.src = url; box.append(img); }
        else { box.classList.add('bad'); box.textContent = '!'; box.title = 'This image could not be decoded'; }
      });
      if (!queued && thumbs.broken.has(r.id)) { box.classList.add('bad'); box.textContent = '!'; box.title = 'This image could not be decoded'; }
    }
    return h('div', {
      class: `row item${sel ? ' selected' : ''}${this.focusId === r.id ? ' focused' : ''}${this.dragIds?.has(r.id) ? ' drag-source' : ''}`,
      role: 'option', id: `row-${r.id}`, 'aria-selected': sel ? 'true' : 'false', 'data-id': r.id,
    },
    h('span', { class: 'grip', 'aria-hidden': 'true', title: 'Drag to reorder' }, '⠿'),
    h('span', { class: 'num' }, r.page),
    box,
    h('span', { class: 'names' }, h('span', { class: 'name' }, item.name), h('span', { class: 'path' }, `${this.sourceLabel(item)} · ${item.path}`)));
  }

  renderGroup(r) {
    const first = this.project.item(r.run.ids[0]);
    const named = r.gid != null;
    const btn = (act, label, title) => h('button', { type: 'button', class: 'mini', 'data-act': act, title }, label);
    return h('div', { class: `row group${this.dragIds && r.run.ids.every((id) => this.dragIds.has(id)) ? ' drag-source' : ''}`, role: 'presentation', 'data-gid': r.gid ?? '', 'data-run': r.run.index },
      h('span', { class: 'grip', 'aria-hidden': 'true', title: 'Drag to move the whole group' }, '⠿'),
      h('span', { class: 'gname' }, r.name + (r.run.continued ? ' (continued)' : '')),
      h('span', { class: 'gmeta' }, `${plural(r.run.ids.length, 'page')} · ${this.sourceLabel(first)}`),
      h('span', { class: 'spacer' }),
      named && btn('rename', 'Rename', 'Rename this group (original files keep their names)'),
      r.run.index > 0 && btn('merge-up', 'Merge up', 'Merge this group into the one above'),
      named && btn('ungroup', 'Ungroup', 'Remove the group, keep the pages'));
  }

  draw() { this.vr.draw(); }

  scrollToId(id) {
    const i = this.rowIndexById.get(id);
    if (i != null) { this.vr.scrollToIndex(i); this.vr.draw(); }
  }

  // ----- selection -----
  setSelection(ids, focus = ids[0] ?? null) {
    this.selected = new Set(ids);
    this.focusId = focus;
    this.anchor = focus;
    this.draw();
    this.hooks.onSelect();
  }
  selectAll() { this.setSelection(this.project.order, this.focusId ?? this.project.order[0] ?? null); }
  clearSelection() { this.setSelection([], null); }

  selectRange(from, to) {
    const a = this.project.indexOf(from);
    const b = this.project.indexOf(to);
    return this.project.order.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  clickItem(id, e) {
    if (e.shiftKey && this.anchor && this.rowIndexById.has(this.anchor)) {
      const range = this.selectRange(this.anchor, id);
      this.selected = e.ctrlKey || e.metaKey ? new Set([...this.selected, ...range]) : new Set(range);
    } else if (e.ctrlKey || e.metaKey) {
      this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
      this.anchor = id;
    } else {
      this.selected = new Set([id]);
      this.anchor = id;
    }
    this.focusId = id;
    this.draw();
    this.hooks.onSelect();
  }

  onClick(e) {
    if (this._suppressClick) { this._suppressClick = false; return; }
    const act = e.target.closest('button[data-act]');
    const row = e.target.closest('.row');
    if (!row) return;
    if (act) {
      const run = this.rows.find((r) => r.type === 'group' && String(r.run.index) === row.dataset.run)?.run;
      this.hooks.onGroupAction(act.dataset.act, run.gid, run.ids);
      return;
    }
    this.host.focus({ preventScroll: true });
    if (row.classList.contains('group')) {
      const run = this.rows.find((r) => r.type === 'group' && String(r.run.index) === row.dataset.run).run;
      this.setSelection(run.ids, run.ids[0]);
    } else {
      this.clickItem(row.dataset.id, e);
    }
  }

  // ----- keyboard -----
  moveFocus(delta, extend, absolute) {
    const order = this.project.order;
    if (!order.length) return;
    const cur = this.focusId == null ? (delta > 0 ? -1 : order.length) : this.project.indexOf(this.focusId);
    const idx = Math.max(0, Math.min(order.length - 1, absolute ?? cur + delta));
    const id = order[idx];
    if (extend && this.anchor) this.selected = new Set(this.selectRange(this.anchor, id));
    else { this.selected = new Set([id]); this.anchor = id; }
    this.focusId = id;
    this.scrollToId(id);
    this.draw();
    this.host.setAttribute('aria-activedescendant', `row-${id}`);
    this.hooks.onSelect();
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor(this.host.clientHeight / ROW_H) - 1);
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        if (e.altKey) this.moveSelection(dir);
        else this.moveFocus(dir, e.shiftKey);
        break;
      }
      case 'PageUp': this.moveFocus(-page, e.shiftKey); break;
      case 'PageDown': this.moveFocus(page, e.shiftKey); break;
      case 'Home': this.moveFocus(0, e.shiftKey, 0); break;
      case 'End': this.moveFocus(0, e.shiftKey, this.project.size - 1); break;
      case ' ':
        if (this.focusId) this.clickItem(this.focusId, { ctrlKey: true });
        break;
      case 'a':
      case 'A':
        if (!mod) return;
        this.selectAll();
        break;
      case 'Delete':
      case 'Backspace':
        if (this.selected.size) this.hooks.onRemove(this.selectedIds());
        break;
      case 'F2': {
        const gid = this.currentGroup();
        if (gid) this.hooks.onGroupAction('rename', gid, []);
        break;
      }
      case 'Escape': if (this.selected.size) this.clearSelection(); return;
      default: return;
    }
    e.preventDefault();
  }

  moveSelection(dir) {
    const ids = this.selectedIds();
    if (this.project.stepItems(ids, dir)) {
      this.scrollToId(this.focusId ?? ids[0]);
      this.hooks.announce(`Moved ${plural(ids.length, 'page')} ${dir < 0 ? 'up' : 'down'}`);
    }
  }

  // ----- drag & drop -----
  onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button, input, select')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.pointerType !== 'mouse' && !e.target.closest('.grip')) return; // keep touch scrolling
    this.drag = { x: e.clientX, y: e.clientY, row, started: false, pointerId: e.pointerId };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
      if (!this.startDrag(d)) { this.drag = null; return; }
    }
    d.last = e;
    this.updateDrag(e);
    this.autoScroll(e);
  }

  startDrag(d) {
    const row = d.row;
    if (row.classList.contains('group')) {
      const r = this.rows.find((x) => x.type === 'group' && String(x.run.index) === row.dataset.run);
      d.kind = 'group';
      d.gid = r.gid;
      d.ids = this.project.order.filter((id) => this.project.groupOf(id) === r.gid);
      d.label = `Group “${r.name}” · ${plural(d.ids.length, 'page')}`;
    } else {
      const id = row.dataset.id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.anchor = id; this.focusId = id; }
      d.kind = 'item';
      d.ids = this.selectedIds();
      d.label = d.ids.length === 1 ? this.project.item(d.ids[0]).name : plural(d.ids.length, 'page');
    }
    d.started = true;
    this.dragIds = new Set(d.ids);
    this.host.classList.add('dragging');
    document.body.classList.add('is-dragging');
    this.ghost.hidden = false;
    this.draw();
    return true;
  }

  resolveDrop(e) {
    const rect = this.host.getBoundingClientRect();
    const y = e.clientY - rect.top + this.host.scrollTop;
    let slot = Math.max(0, Math.min(this.rows.length, Math.round(y / ROW_H)));
    const rows = this.rows;
    if (this.drag.kind === 'group') {
      slot = this.boundaries.reduce((best, b) => (Math.abs(b - slot) < Math.abs(best - slot) ? b : best), this.boundaries[0]);
      const before = rows[slot];
      return { slot, beforeId: before ? before.run.ids[0] : null, gid: undefined };
    }
    const before = rows[slot];
    const prev = rows[slot - 1];
    if (!before) return { slot, beforeId: null, gid: rows.length ? rows[rows.length - 1].gid : null };
    if (before.type === 'item') return { slot, beforeId: before.id, gid: before.gid };
    return { slot, beforeId: before.run.ids[0], gid: prev ? prev.gid : before.gid };
  }

  updateDrag(e) {
    const drop = this.resolveDrop(e);
    this.drag.drop = drop;
    this.dropLine.hidden = false;
    this.dropLine.style.top = `${drop.slot * ROW_H - 1}px`;
    this.dropLine.classList.toggle('group-line', this.drag.kind === 'group');
    let label = this.drag.label;
    if (this.drag.kind === 'item' && this.hasHeaders) label += `  →  ${this.project.groupName(drop.gid) ?? 'Ungrouped'}`;
    this.ghost.textContent = label;
    this.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  }

  autoScroll(e) {
    const rect = this.host.getBoundingClientRect();
    const edge = 48;
    let v = 0;
    if (e.clientY < rect.top + edge) v = -Math.min(22, 3 + (rect.top + edge - e.clientY) / 3);
    else if (e.clientY > rect.bottom - edge) v = Math.min(22, 3 + (e.clientY - (rect.bottom - edge)) / 3);
    this.scrollVel = v;
    if (v && !this._raf) {
      const tick = () => {
        if (!this.drag?.started || !this.scrollVel) { this._raf = 0; return; }
        this.host.scrollTop += this.scrollVel;
        this.updateDrag(this.drag.last);
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
  }

  onPointerUp() {
    const d = this.drag;
    if (!d) return;
    if (!d.started) { this.drag = null; return; }
    const { drop, kind, ids, gid } = d;
    this.endDrag();
    this._suppressClick = true;
    setTimeout(() => { this._suppressClick = false; }, 0);
    if (!drop) return;
    let moved = false;
    if (kind === 'group') moved = this.project.moveGroup(gid, drop.beforeId);
    else moved = this.project.moveItems(ids, drop.beforeId, this.hasHeaders ? drop.gid : undefined);
    if (moved) {
      this.hooks.announce(kind === 'group' ? 'Group moved' : `Moved ${plural(ids.length, 'page')}`);
      this.scrollToId(ids[0]);
    }
  }

  cancelDrag() {
    if (this.drag?.started) this.endDrag();
    this.drag = null;
  }

  endDrag() {
    this.drag = null;
    this.dragIds = null;
    this.scrollVel = 0;
    this.dropLine.hidden = true;
    this.ghost.hidden = true;
    this.host.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    this.draw();
  }
}
