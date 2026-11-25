// Small DOM helpers: element builder, toasts, modal dialogs, downloads.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'textContent'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

/** Appends children safely: flattens arrays and skips null/false (native append would print "null"). */
export function put(el, ...children) {
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const plural = (n, word, many = word + 's') => `${n.toLocaleString()} ${n === 1 ? word : many}`;

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export const button = (label, props = {}) =>
  h('button', { type: 'button', ...props, class: `btn ${props.class || ''}`.trim() }, label);

// ----- toast -----
let toastHost;
export function toast(message, { action, kind = 'info', timeout = 6000 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${kind}` }, h('span', {}, message));
  if (action) {
    el.append(button(action.label, { class: 'ghost small', onclick: () => { action.onClick(); el.remove(); } }));
  }
  toastHost.append(el);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  if (timeout) setTimeout(() => el.remove(), kind === 'error' ? Math.max(timeout, 10000) : timeout);
  return el;
}

// ----- modal -----
let modalId = 0;
export function modal({ title, body, footer = [], wide = false }) {
  const id = `modal-title-${++modalId}`;
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-labelledby': id });
  const m = { el: dlg, value: null, close(value = null) { m.value = value; if (dlg.open) dlg.close(); } };
  dlg.append(
    h('header', {}, h('h2', { id }, title), button('×', { class: 'icon', 'aria-label': 'Close', onclick: () => m.close(null) })),
    h('div', { class: 'modal-body' }, body),
    h('footer', {}, footer),
  );
  m.closed = new Promise((resolve) => {
    dlg.addEventListener('close', () => { dlg.remove(); resolve(m.value); });
  });
  document.body.append(dlg);
  dlg.showModal();
  return m;
}

export async function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  let m;
  const ok = button(confirmLabel, { class: danger ? 'danger' : 'primary', onclick: () => m.close(true) });
  m = modal({
    title, body: h('p', {}, message),
    footer: [button('Cancel', { onclick: () => m.close(false) }), ok],
  });
  ok.focus();
  return (await m.closed) === true;
}

/** Offers several outcomes; returns the chosen value or null when dismissed. */
export async function choiceDialog({ title, message, choices }) {
  let m;
  m = modal({
    title, body: h('p', {}, message),
    footer: [button('Cancel', { onclick: () => m.close(null) }), ...choices.map((c) => button(c.label, { class: c.kind || '', onclick: () => m.close(c.value) }))],
  });
  return m.closed;
}

export async function promptDialog({ title, label, value = '', confirmLabel = 'OK', hint }) {
  let m;
  const input = h('input', { type: 'text', value, id: 'prompt-input', autocomplete: 'off', onkeydown: (e) => { if (e.key === 'Enter') submit(); } });
  const submit = () => { const v = input.value.trim(); if (v) m.close(v); else input.focus(); };
  m = modal({
    title,
    body: h('div', { class: 'field' }, h('label', { for: 'prompt-input' }, label), input, hint && h('p', { class: 'hint' }, hint)),
    footer: [button('Cancel', { onclick: () => m.close(null) }), button(confirmLabel, { class: 'primary', onclick: submit })],
  });
  input.focus();
  input.select();
  return m.closed;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const saveText = (text, name, type = 'application/json') => downloadBlob(new Blob([text], { type }), name);
