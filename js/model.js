// Project state: pages, sources, groups and undo history.
//
// `state` is treated as immutable: every change builds a new state object, so
// undo/redo only has to keep references. `order` is the reading order and is the
// single source of truth for export; groups are labels attached to pages.

const MAX_HISTORY = 200;

export class Project {
  constructor() {
    this.items = new Map(); // registry of every page ever added (removed pages stay for undo)
    this.sources = new Map();
    this.state = { order: [], itemGroup: {}, groupNames: {} };
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.exportOptions = null;
    this._n = { item: 1, source: 1, group: 1, importIndex: 1 };
    this._indexCache = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit() {
    for (const fn of this.listeners) fn(this);
  }

  // ----- reads -----
  get order() { return this.state.order; }
  get size() { return this.state.order.length; }
  item(id) { return this.items.get(id); }
  groupOf(id) { return this.state.itemGroup[id] ?? null; }
  groupName(gid) { return gid == null ? null : this.state.groupNames[gid] ?? ''; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  indexOf(id) {
    if (!this._indexCache || this._indexCache.order !== this.state.order) {
      const map = new Map();
      this.state.order.forEach((x, i) => map.set(x, i));
      this._indexCache = { order: this.state.order, map };
    }
    return this._indexCache.map.get(id) ?? -1;
  }

  /** Groups in order of first appearance. `id: null` collects ungrouped pages. */
  groups() {
    const out = [];
    const seen = new Map();
    for (const id of this.state.order) {
      const gid = this.groupOf(id);
      if (!seen.has(gid)) {
        const g = { id: gid, name: this.groupName(gid), ids: [] };
        seen.set(gid, g);
        out.push(g);
      }
      seen.get(gid).ids.push(id);
    }
    return out;
  }

  activeSources() {
    const counts = new Map();
    for (const id of this.state.order) {
      const sid = this.items.get(id).sourceId;
      counts.set(sid, (counts.get(sid) || 0) + 1);
    }
    return [...this.sources.values()].filter((s) => counts.has(s.id)).map((s) => ({ ...s, pageCount: counts.get(s.id) }));
  }

  currentKeys() {
    return new Set(this.state.order.map((id) => this.items.get(id).key).filter(Boolean));
  }

  // ----- history -----
  commit(label, next) {
    this.undoStack.push({ label, state: this.state });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.state = next;
    this.emit();
  }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, state: this.state });
    this.state = e.state;
    this.emit();
    return e.label;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, state: this.state });
    this.state = e.state;
    this.emit();
    return e.label;
  }

  _next(patch = {}) {
    return {
      order: this.state.order,
      itemGroup: this.state.itemGroup,
      groupNames: this.state.groupNames,
      ...patch,
    };
  }
  _newGroupId() { return 'g' + this._n.group++; }

  // ----- import -----
  /**
   * @param {Array} sources [{label, kind, presetId, presetName, uncertain, skipped, groups:[{name, entries}]}]
   * Groups arrive already ordered; entries carry path, reldir, name, stem, ext, size, key, read, probe.
   */
  addSources(sources, label) {
    const order = [...this.state.order];
    const itemGroup = { ...this.state.itemGroup };
    const groupNames = { ...this.state.groupNames };
    let added = 0;
    for (const src of sources) {
      const sid = 's' + this._n.source++;
      this.sources.set(sid, {
        id: sid, label: src.label, kind: src.kind, presetId: src.presetId, presetName: src.presetName,
        uncertain: src.uncertain || [], acknowledged: false, skipped: src.skipped || [],
      });
      for (const g of src.groups) {
        const gid = g.name == null ? null : this._newGroupId();
        if (gid) groupNames[gid] = g.name;
        for (const e of g.entries) {
          const id = 'p' + this._n.item++;
          this.items.set(id, {
            id, sourceId: sid, name: e.name, stem: e.stem, ext: e.ext, path: e.path, dir: e.reldir,
            size: e.size, key: e.key, read: e.read, probe: e.probe, importIndex: this._n.importIndex++,
          });
          order.push(id);
          if (gid) itemGroup[id] = gid;
          added++;
        }
      }
    }
    if (!added) return 0;
    this.commit(label || `Add ${added} pages`, this._next({ order, itemGroup, groupNames }));
    return added;
  }

  removeItems(ids, label) {
    const set = new Set(ids);
    const order = this.state.order.filter((id) => !set.has(id));
    if (order.length === this.state.order.length) return false;
    this.commit(label || `Remove ${set.size} page${set.size === 1 ? '' : 's'}`, this._next({ order }));
    return true;
  }

  removeSource(sourceId) {
    const ids = this.state.order.filter((id) => this.items.get(id).sourceId === sourceId);
    return this.removeItems(ids, `Remove source "${this.sources.get(sourceId)?.label}"`);
  }

  clear() {
    if (!this.size) return false;
    this.commit('Clear project', this._next({ order: [] }));
    return true;
  }

  // ----- ordering -----
  /** Replaces the whole reading order. Must be a permutation of the current one. */
  applyOrder(newOrder, label) {
    const cur = this.state.order;
    if (newOrder.length !== cur.length || new Set(newOrder).size !== cur.length || !newOrder.every((id) => this.indexOf(id) >= 0)) {
      throw new Error('Internal error: the new order does not contain exactly the current pages.');
    }
    if (newOrder.every((id, i) => id === cur[i])) return false;
    this.commit(label, this._next({ order: [...newOrder] }));
    return true;
  }

  /**
   * Moves pages (keeping their relative order) in front of `beforeId`, or to the end.
   * `groupId` (a group id or null) is assigned when given; `undefined` keeps each page's group.
   */
  moveItems(ids, beforeId, groupId, label = 'Move pages') {
    const set = new Set(ids);
    const moving = this.state.order.filter((id) => set.has(id));
    if (!moving.length) return false;
    const rest = this.state.order.filter((id) => !set.has(id));
    // Dropping onto one of the moving pages themselves: use the next page that is not moving.
    let anchor = beforeId;
    while (anchor != null && set.has(anchor)) anchor = this.state.order[this.indexOf(anchor) + 1] ?? null;
    let at = anchor == null ? rest.length : rest.indexOf(anchor);
    if (at < 0) at = rest.length;
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    let itemGroup = this.state.itemGroup;
    if (groupId !== undefined) {
      itemGroup = { ...itemGroup };
      for (const id of moving) {
        if (groupId === null) delete itemGroup[id];
        else itemGroup[id] = groupId;
      }
    }
    const sameOrder = order.every((id, i) => id === this.state.order[i]);
    const sameGroups = itemGroup === this.state.itemGroup || moving.every((id) => (itemGroup[id] ?? null) === this.groupOf(id));
    if (sameOrder && sameGroups) return false;
    this.commit(label, this._next({ order, itemGroup }));
    return true;
  }

  /** Moves every page of a group, as one block, in front of `beforeId` (or to the end). */
  moveGroup(gid, beforeId) {
    const ids = this.state.order.filter((id) => this.groupOf(id) === gid);
    return this.moveItems(ids, beforeId, undefined, `Move group "${this.groupName(gid) ?? 'Ungrouped'}"`);
  }

  /**
   * Moves selected pages one step up (-1) or down (+1). Crossing a group boundary
   * moves the page into the neighbouring group instead of swapping.
   */
  stepItems(ids, dir) {
    const sel = new Set(ids);
    const order = [...this.state.order];
    const itemGroup = { ...this.state.itemGroup };
    const g = (id) => itemGroup[id] ?? null;
    const setG = (id, gid) => (gid === null ? delete itemGroup[id] : (itemGroup[id] = gid));
    const visit = (i) => {
      const j = i + dir;
      if (j < 0 || j >= order.length || !sel.has(order[i]) || sel.has(order[j])) return;
      if (g(order[i]) === g(order[j])) [order[i], order[j]] = [order[j], order[i]];
      else setG(order[i], g(order[j]));
    };
    if (dir < 0) for (let i = 0; i < order.length; i++) visit(i);
    else for (let i = order.length - 1; i >= 0; i--) visit(i);
    const changed = order.some((id, i) => id !== this.state.order[i]) || order.some((id) => g(id) !== this.groupOf(id));
    if (!changed) return false;
    this.commit(dir < 0 ? 'Move up' : 'Move down', this._next({ order, itemGroup }));
    return true;
  }

  // ----- groups -----
  /** Puts the pages in a new group, placed where the first selected page was. */
  createGroup(ids, name) {
    const set = new Set(ids);
    const first = this.state.order.findIndex((id) => set.has(id));
    if (first < 0) return null;
    const moving = this.state.order.filter((id) => set.has(id));
    const rest = this.state.order.filter((id) => !set.has(id));
    const at = this.state.order.slice(0, first).filter((id) => !set.has(id)).length;
    const gid = this._newGroupId();
    const itemGroup = { ...this.state.itemGroup };
    for (const id of moving) itemGroup[id] = gid;
    this.commit(`Create group "${name}"`, this._next({
      order: [...rest.slice(0, at), ...moving, ...rest.slice(at)],
      itemGroup,
      groupNames: { ...this.state.groupNames, [gid]: name },
    }));
    return gid;
  }

  renameGroup(gid, name) {
    if (gid == null || this.state.groupNames[gid] === name) return false;
    this.commit(`Rename group to "${name}"`, this._next({ groupNames: { ...this.state.groupNames, [gid]: name } }));
    return true;
  }

  /** Merges `fromGid` into `intoGid`; its pages follow the last page of the target. */
  mergeGroups(fromGid, intoGid) {
    if (fromGid === intoGid) return false;
    const from = this.state.order.filter((id) => this.groupOf(id) === fromGid);
    const intoIds = this.state.order.filter((id) => this.groupOf(id) === intoGid);
    if (!from.length) return false;
    const fromSet = new Set(from);
    const rest = this.state.order.filter((id) => !fromSet.has(id));
    const lastInto = intoIds.length ? rest.indexOf(intoIds.at(-1)) : -1;
    const before = lastInto >= 0 ? rest[lastInto + 1] ?? null : null;
    return this.moveItems(from, before, intoGid, `Merge group into "${this.groupName(intoGid) ?? 'Ungrouped'}"`);
  }

  /** Starts a new group at `atId`, taking that page and the later pages of its group. */
  splitGroup(atId, name) {
    const gid = this.groupOf(atId);
    const start = this.indexOf(atId);
    const ids = this.state.order.filter((id, i) => i >= start && this.groupOf(id) === gid);
    if (!ids.length) return null;
    const ngid = this._newGroupId();
    const itemGroup = { ...this.state.itemGroup };
    for (const id of ids) itemGroup[id] = ngid;
    this.commit(`Split group "${name}"`, this._next({ itemGroup, groupNames: { ...this.state.groupNames, [ngid]: name } }));
    return ngid;
  }

  ungroup(gid) {
    const ids = this.state.order.filter((id) => this.groupOf(id) === gid);
    if (!ids.length || gid == null) return false;
    const itemGroup = { ...this.state.itemGroup };
    for (const id of ids) delete itemGroup[id];
    this.commit(`Ungroup "${this.groupName(gid)}"`, this._next({ itemGroup }));
    return true;
  }

  /** Re-labels the pages of one source (used by "Change structure"). `groups` = [{name, ids}] in new order. */
  restructureSource(sourceId, groups, label) {
    const slots = [];
    this.state.order.forEach((id, i) => { if (this.items.get(id).sourceId === sourceId) slots.push(i); });
    const flat = groups.flatMap((g) => g.ids);
    if (flat.length !== slots.length) throw new Error('Internal error: restructure lost pages.');
    const order = [...this.state.order];
    slots.forEach((slot, k) => { order[slot] = flat[k]; });
    const itemGroup = { ...this.state.itemGroup };
    const groupNames = { ...this.state.groupNames };
    for (const g of groups) {
      const gid = g.name == null ? null : this._newGroupId();
      if (gid) groupNames[gid] = g.name;
      for (const id of g.ids) (gid ? (itemGroup[id] = gid) : delete itemGroup[id]);
    }
    this.commit(label, this._next({ order, itemGroup, groupNames }));
  }
}
