// Custom rules: list, create/edit form, JSON import and export.
import { h, button, modal, toast, confirmDialog, saveText } from './dom.js';
import {
  defaultRule, validateRule, parseRulesJson, serializeRule, serializeBundle,
  loadRules, saveRules, newRuleId, TEMPLATE_TOKENS,
} from '../rules.js';

const fileSafe = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'rule';

function field(label, control, hint, id) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

/** Opens the editor. Resolves with the saved rule or null. */
export function showRuleEditor(existing) {
  const base = existing ? { ...existing } : defaultRule();
  let m;
  const r = structuredClone(base);
  const errors = h('div', { class: 'messages', role: 'alert' });
  const txt = (id, value, props = {}) => h('input', { id, type: 'text', value: value ?? '', spellcheck: false, ...props });
  const sel = (id, value, options) => h('select', { id }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

  const name = txt('r-name', r.name);
  const desc = txt('r-desc', r.description);
  const recursive = h('input', { id: 'r-rec', type: 'checkbox', checked: r.scan.recursive });
  const depth = txt('r-depth', r.scan.maxDepth ?? '', { inputmode: 'numeric', placeholder: 'unlimited' });
  const incD = txt('r-incd', r.scan.includeDirs);
  const excD = txt('r-excd', r.scan.excludeDirs);
  const incF = txt('r-incf', r.scan.includeFiles);
  const excF = txt('r-excf', r.scan.excludeFiles);
  const by = sel('r-by', r.grouping.by, [['none', 'No groups'], ['parent-directory', 'One group per folder'], ['directory-depth', 'Group by the first N folder levels'], ['pattern', 'Group by a pattern in the folder path'], ['source', 'One group per source']]);
  const gDepth = txt('r-gdepth', r.grouping.depth ?? 1, { inputmode: 'numeric' });
  const gPattern = txt('r-gpat', r.grouping.pattern, { placeholder: 'chapter[ _-]*(\\d+)' });
  const nameFrom = sel('r-namefrom', r.grouping.nameFrom, [['name', 'Last folder name'], ['path', 'Full folder path (nests folders)']]);
  const pages = sel('r-pages', r.ordering.pages, [['natural-name', 'Natural by file name'], ['alphabetical', 'Alphabetical by file name'], ['natural-path', 'Natural by path'], ['numeric-pattern', 'By a number in the file name']]);
  const pPattern = txt('r-ppat', r.ordering.pagePattern, { placeholder: 'default: last number in the name' });
  const groups = sel('r-groups', r.ordering.groups, [['natural', 'Natural by name'], ['numeric', 'By a number in the folder name'], ['discovered', 'Order found while scanning']]);
  const gnPattern = txt('r-gnpat', r.ordering.groupPattern, { placeholder: 'default: first number in the name' });
  const useOut = h('input', { id: 'r-useout', type: 'checkbox', checked: !!r.output });
  const tmpl = txt('r-tmpl', r.output?.template ?? '{group}/{index}_{file}');
  const numF = h('input', { id: 'r-numf', type: 'checkbox', checked: r.output?.numberFolders !== false });

  const depthField = field('Folder levels to group', gDepth, null, 'r-gdepth');
  const patField = field('Chapter pattern', gPattern, 'Regular expression matched against the folder path. The first () group becomes the chapter name.', 'r-gpat');
  const pPatField = field('Page number pattern', pPattern, 'Regular expression on the file name without extension; the first () group is the number.', 'r-ppat');
  const gnField = field('Chapter number pattern', gnPattern, 'Regular expression on each folder name.', 'r-gnpat');
  const outFields = h('div', {}, field('Path template', tmpl, `Placeholders: ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(' ')}`, 'r-tmpl'),
    h('label', { class: 'check' }, numF, 'Number folders'));

  function toggles() {
    depthField.hidden = by.value !== 'directory-depth';
    patField.hidden = by.value !== 'pattern';
    nameFrom.closest('.field').hidden = by.value === 'none' || by.value === 'source' || by.value === 'pattern';
    pPatField.hidden = pages.value !== 'numeric-pattern';
    gnField.hidden = groups.value !== 'numeric';
    outFields.hidden = !useOut.checked;
  }
  [by, pages, groups, useOut].forEach((el) => el.addEventListener('change', toggles));

  const num = (v) => (String(v).trim() === '' ? null : Number(v));
  const blank = (v) => (v.trim() === '' ? null : v.trim());
  function collect() {
    return {
      schema: 'cbz-compiler-rule', version: 1, name: name.value, description: desc.value,
      scan: { recursive: recursive.checked, maxDepth: num(depth.value), includeDirs: blank(incD.value), excludeDirs: blank(excD.value), includeFiles: blank(incF.value), excludeFiles: blank(excF.value) },
      grouping: { by: by.value, depth: num(gDepth.value) ?? 1, pattern: blank(gPattern.value), nameFrom: nameFrom.value },
      ordering: { pages: pages.value, pagePattern: blank(pPattern.value), groups: groups.value, groupPattern: blank(gnPattern.value) },
      output: useOut.checked ? { template: tmpl.value, numberFolders: numF.checked } : null,
    };
  }

  const save = button('Save rule', { class: 'primary' });
  save.addEventListener('click', () => {
    const v = validateRule(collect());
    errors.textContent = '';
    if (!v.ok) { v.errors.forEach((e) => errors.append(h('p', { class: 'msg error' }, e))); errors.scrollIntoView({ block: 'nearest' }); return; }
    m.close({ ...v.rule, id: existing?.id ?? newRuleId() });
  });

  m = modal({
    title: existing ? `Edit rule “${existing.name}”` : 'New rule', wide: true,
    body: [
      field('Name', name, null, 'r-name'), field('Description', desc, null, 'r-desc'),
      h('fieldset', {}, h('legend', {}, 'Scanning'),
        h('label', { class: 'check' }, recursive, 'Look inside subfolders'),
        field('Maximum folder depth', depth, 'Pages deeper than this are listed as excluded, never dropped silently. Empty = no limit.', 'r-depth'),
        field('Only folders matching', incD, 'Optional regular expression on the folder path.', 'r-incd'), field('Skip folders matching', excD, null, 'r-excd'),
        field('Only files matching', incF, null, 'r-incf'), field('Skip files matching', excF, null, 'r-excf')),
      h('fieldset', {}, h('legend', {}, 'Grouping'), field('Group pages', by, null, 'r-by'), depthField, patField, field('Group name', nameFrom, null, 'r-namefrom')),
      h('fieldset', {}, h('legend', {}, 'Ordering'), field('Pages inside a group', pages, null, 'r-pages'), pPatField, field('Groups', groups, null, 'r-groups'), gnField),
      h('fieldset', {}, h('legend', {}, 'Output structure'), h('label', { class: 'check' }, useOut, 'Suggest an output structure when this rule is used'), outFields),
      errors,
    ],
    footer: [button('Cancel', { onclick: () => m.close(null) }), save],
  });
  toggles();
  name.focus();
  return m.closed;
}

/** Rule manager. Calls onChange(rules) after any change. */
export function showRulesDialog(onChange) {
  let m;
  let rules = loadRules();
  const list = h('div', { class: 'rule-list' });
  const persist = () => {
    if (!saveRules(rules)) toast('Rules could not be stored in this browser (storage is blocked). They will last until you close the page. Export them to keep a copy.', { kind: 'warn' });
    onChange(rules);
    render();
  };

  async function edit(rule) {
    const saved = await showRuleEditor(rule);
    if (!saved) return;
    rules = rule ? rules.map((x) => (x.id === rule.id ? saved : x)) : [...rules, saved];
    persist();
  }

  async function addFromJson(text) {
    const { rules: found, errors } = parseRulesJson(text);
    if (errors.length) { toast(errors.slice(0, 3).join(' '), { kind: 'error' }); }
    if (!found.length) return;
    rules = [...rules, ...found.map((f) => ({ ...f.rule, id: newRuleId() }))];
    persist();
    const warn = found.flatMap((f) => f.warnings);
    toast(`Imported ${found.length} rule${found.length === 1 ? '' : 's'}.${warn.length ? ' ' + warn[0] : ''}`, { kind: errors.length ? 'warn' : 'info' });
  }

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', hidden: true, multiple: true,
    onchange: async () => { for (const f of fileInput.files) await addFromJson(await f.text()); fileInput.value = ''; },
  });
  const paste = h('textarea', { rows: 5, spellcheck: false, placeholder: 'Paste rule JSON here', 'aria-label': 'Rule JSON' });

  function render() {
    list.textContent = '';
    if (!rules.length) list.append(h('p', { class: 'muted' }, 'No saved rules yet. Create one, or import a JSON file. Presets are always available during import.'));
    for (const r of rules) {
      list.append(h('div', { class: 'rule' },
        h('div', { class: 'grow' }, h('strong', {}, r.name), r.description ? h('span', { class: 'muted block' }, r.description) : null),
        button('Edit', { class: 'small', onclick: () => edit(r) }),
        button('Export', { class: 'small', onclick: () => saveText(serializeRule(r), `${fileSafe(r.name)}.rule.json`) }),
        button('Delete', {
          class: 'small danger-text',
          onclick: async () => {
            if (await confirmDialog({ title: 'Delete rule', message: `Delete “${r.name}”? Pages already imported with it are not affected. Export it first if you may need it again.`, confirmLabel: 'Delete', danger: true })) {
              rules = rules.filter((x) => x.id !== r.id);
              persist();
            }
          },
        })));
    }
  }

  m = modal({
    title: 'Custom rules', wide: true,
    body: [
      h('p', { class: 'muted' }, 'Rules decide how folders become groups and how pages are ordered. They run locally and are stored in this browser.'),
      list,
      h('div', { class: 'toolbar-inline' },
        button('New rule', { class: 'primary small', onclick: () => edit(null) }),
        button('Import JSON file', { class: 'small', onclick: () => fileInput.click() }),
        button('Export all', { class: 'small', disabled: false, onclick: () => (rules.length ? saveText(serializeBundle(rules), 'cbz-compiler-rules.json') : toast('There are no rules to export yet.')) }),
        fileInput),
      h('details', {}, h('summary', {}, 'Import from pasted JSON'), paste,
        button('Import pasted JSON', { class: 'small', onclick: async () => { if (paste.value.trim()) { await addFromJson(paste.value); paste.value = ''; } } })),
    ],
    footer: [button('Close', { class: 'primary', onclick: () => m.close(true) })],
  });
  render();
  return m.closed;
}
