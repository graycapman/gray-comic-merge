// Automatic ordering tools. All functions are pure: they return a proposed order
// and never touch the project, so the UI can preview them and Cancel is free.
import { naturalKey, compareKeys, comparePathKeys, pathKey, plainCompare, sortByKey } from './natural.js';

export const SORT_METHODS = [
  { id: 'natural-name', label: 'Natural by file name (2 before 10)' },
  { id: 'alphabetical', label: 'Alphabetical by file name' },
  { id: 'natural-path', label: 'By original path' },
  { id: 'import-order', label: 'By import order' },
  { id: 'reverse', label: 'Reverse current order' },
  { id: 'groups-natural', label: 'Group order (natural by group name)' },
];

function comparatorFor(project, method) {
  const it = (id) => project.item(id);
  switch (method) {
    case 'natural-name':
      return { key: (id) => [naturalKey(it(id).name), pathKey(`${project.sources.get(it(id).sourceId).label}/${it(id).path}`)],
               cmp: (a, b) => compareKeys(a[0], b[0]) || comparePathKeys(a[1], b[1]) };
    case 'alphabetical':
      return { key: (id) => it(id).name.toLowerCase(), cmp: plainCompare };
    case 'natural-path':
      return { key: (id) => pathKey(`${project.sources.get(it(id).sourceId).label}/${it(id).path}`), cmp: comparePathKeys };
    case 'import-order':
      return { key: (id) => it(id).importIndex, cmp: (a, b) => a - b };
    default:
      throw new Error(`Unknown sort method "${method}".`);
  }
}

/** Sorts the pages occupying `slots` (indexes into order) and puts them back into the same slots. */
function sortSlots(order, slots, project, method) {
  const ids = slots.map((i) => order[i]);
  const sorted = method === 'reverse'
    ? [...ids].reverse()
    : (({ key, cmp }) => sortByKey(ids, key, cmp))(comparatorFor(project, method));
  const out = [...order];
  slots.forEach((slot, k) => { out[slot] = sorted[k]; });
  return out;
}

/** Moves each group's pages together and orders the groups by name. Ungrouped pages stay first. */
function sortGroups(project) {
  const groups = project.groups();
  const named = groups.filter((g) => g.id != null);
  const sorted = sortByKey(named, (g) => pathKey(g.name || ''), comparePathKeys);
  const ungrouped = groups.filter((g) => g.id == null);
  return [...ungrouped, ...sorted].flatMap((g) => g.ids);
}

/**
 * @param scope 'all' | 'groups' (sort inside each group) | 'selection'
 * @returns {string[]} proposed order
 */
export function proposeSort(project, method, scope = 'all', selection = []) {
  const order = project.order;
  if (method === 'groups-natural') return sortGroups(project);
  if (scope === 'selection') {
    const sel = new Set(selection);
    const slots = order.map((id, i) => (sel.has(id) ? i : -1)).filter((i) => i >= 0);
    return sortSlots(order, slots, project, method);
  }
  if (scope === 'groups') {
    let out = order;
    for (const g of project.groups()) {
      const slots = g.ids.map((id) => project.indexOf(id)).sort((a, b) => a - b);
      out = sortSlots(out, slots, project, method);
    }
    return out;
  }
  return sortSlots(order, order.map((_, i) => i), project, method);
}

/** Describes how a proposed order differs from the current one (for the preview list). */
export function diffOrder(oldOrder, newOrder) {
  const oldIndex = new Map(oldOrder.map((id, i) => [id, i]));
  let moved = 0;
  const rows = newOrder.map((id, i) => {
    const from = oldIndex.get(id);
    if (from !== i) moved++;
    return { id, from, to: i, delta: from - i };
  });
  return { rows, moved, unchanged: newOrder.length - moved };
}
