// Natural ordering shared by sorting, structure detection and export checks.
// Digit runs compare by value ("2" < "10"), text compares case-insensitively.

const TOKENS = /(\d+)|(\D+)/g;

export function plainCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function naturalKey(value) {
  const key = [];
  for (const m of String(value).normalize('NFC').matchAll(TOKENS)) {
    if (m[1] !== undefined) key.push({ num: true, v: m[1].replace(/^0+(?=\d)/, '') });
    else key.push({ num: false, v: m[2].toLowerCase() });
  }
  return key;
}

export function compareKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x.num !== y.num) return x.num ? -1 : 1;
    if (x.num && x.v.length !== y.v.length) return x.v.length - y.v.length;
    if (x.v !== y.v) return x.v < y.v ? -1 : 1;
  }
  return a.length - b.length;
}

export function naturalCompare(a, b) {
  return compareKeys(naturalKey(a), naturalKey(b)) || plainCompare(a, b);
}

// Path keys compare folder by folder, so "Ch 2/x" sorts before "Ch 10/x".
export function pathKey(path) {
  return String(path).split('/').map(naturalKey);
}

export function comparePathKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** Stable sort that computes each key once. `compare` receives two keys. */
export function sortByKey(list, keyFn, compare) {
  return list
    .map((value, i) => ({ value, i, key: keyFn(value) }))
    .sort((a, b) => compare(a.key, b.key) || a.i - b.i)
    .map((x) => x.value);
}
