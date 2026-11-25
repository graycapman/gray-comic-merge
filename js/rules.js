// Custom structure rules: schema, validation, JSON import/export and local storage.
// Rules are plain data and run entirely offline.

export const RULE_SCHEMA = 'cbz-compiler-rule';
export const BUNDLE_SCHEMA = 'cbz-compiler-rules';
export const TEMPLATE_TOKENS = ['index', 'name', 'ext', 'file', 'group', 'source', 'dir'];

const GROUPING = ['none', 'parent-directory', 'directory-depth', 'pattern', 'source'];
const PAGE_ORDER = ['natural-name', 'alphabetical', 'natural-path', 'numeric-pattern'];
const GROUP_ORDER = ['natural', 'numeric', 'discovered'];

export function defaultRule() {
  return {
    schema: RULE_SCHEMA,
    version: 1,
    name: 'New rule',
    description: '',
    scan: { recursive: true, maxDepth: null, includeDirs: null, excludeDirs: null, includeFiles: null, excludeFiles: null },
    grouping: { by: 'parent-directory', depth: 1, pattern: null, nameFrom: 'name' },
    ordering: { pages: 'natural-name', pagePattern: null, groups: 'natural', groupPattern: null },
    output: null,
  };
}

/** Returns an error string, or null when the template is usable. */
export function checkTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) return 'The output template is empty.';
  const tokens = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const unknown = tokens.filter((t) => !TEMPLATE_TOKENS.includes(t));
  if (unknown.length) {
    return `Unknown placeholder {${unknown[0]}}. Available: ${TEMPLATE_TOKENS.map((t) => `{${t}}`).join(', ')}.`;
  }
  if (!tokens.some((t) => ['index', 'file', 'name'].includes(t))) {
    return 'The template must contain {index}, {file} or {name}, otherwise pages would share one name.';
  }
  if (!tokens.includes('ext') && !tokens.includes('file')) return 'The template must contain {file} or {ext} so pages keep their file extension.';
  if (template.trim().endsWith('/')) return 'The template must end with a file name, not a folder.';
  return null;
}

function checkRegex(value, label, errors) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') { errors.push(`${label} must be text (a regular expression) or empty.`); return null; }
  if (value.length > 200) { errors.push(`${label} is longer than 200 characters.`); return null; }
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(value)) {
    errors.push(`${label} contains nested repetition such as "(a+)+", which can freeze the page. Simplify it.`);
    return null;
  }
  try { new RegExp(value, 'i'); } catch (e) { errors.push(`${label} is not a valid regular expression (${e.message}).`); return null; }
  return value;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates one rule object. Never throws.
 * @returns {{ok:boolean, errors:string[], warnings:string[], rule:object|null}}
 */
export function validateRule(input) {
  const errors = [];
  const warnings = [];
  if (!isObj(input)) return { ok: false, errors: ['This is not a rule: expected a JSON object.'], warnings, rule: null };
  const base = defaultRule();

  if (input.schema !== RULE_SCHEMA) errors.push(`"schema" must be "${RULE_SCHEMA}"${input.schema ? ` (found "${String(input.schema).slice(0, 40)}")` : ''}. The file may not be a CBZ Compiler rule.`);
  if (input.version !== 1) errors.push(`Unsupported rule version ${JSON.stringify(input.version)}. This app reads version 1.`);

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) errors.push('"name" is required and must be 1–80 characters.');
  const description = typeof input.description === 'string' ? input.description.slice(0, 500) : '';

  const scan = { ...base.scan };
  if (input.scan !== undefined) {
    if (!isObj(input.scan)) errors.push('"scan" must be an object.');
    else {
      if (input.scan.recursive !== undefined) {
        if (typeof input.scan.recursive !== 'boolean') errors.push('scan.recursive must be true or false.');
        else scan.recursive = input.scan.recursive;
      }
      const d = input.scan.maxDepth;
      if (d !== undefined && d !== null) {
        if (!Number.isInteger(d) || d < 0 || d > 30) errors.push(`scan.maxDepth must be a whole number from 0 to 30, or null for unlimited (found ${JSON.stringify(d)}).`);
        else scan.maxDepth = d;
      }
      for (const k of ['includeDirs', 'excludeDirs', 'includeFiles', 'excludeFiles']) {
        if (input.scan[k] !== undefined) scan[k] = checkRegex(input.scan[k], `scan.${k}`, errors);
      }
    }
  }

  const grouping = { ...base.grouping };
  if (input.grouping !== undefined) {
    if (!isObj(input.grouping)) errors.push('"grouping" must be an object.');
    else {
      const g = input.grouping;
      if (g.by !== undefined) {
        if (!GROUPING.includes(g.by)) errors.push(`grouping.by must be one of: ${GROUPING.join(', ')} (found ${JSON.stringify(g.by)}).`);
        else grouping.by = g.by;
      }
      if (g.depth !== undefined && g.depth !== null) {
        if (!Number.isInteger(g.depth) || g.depth < 1 || g.depth > 10) errors.push(`grouping.depth must be a whole number from 1 to 10 (found ${JSON.stringify(g.depth)}).`);
        else grouping.depth = g.depth;
      }
      if (g.nameFrom !== undefined) {
        if (!['name', 'path'].includes(g.nameFrom)) errors.push('grouping.nameFrom must be "name" or "path".');
        else grouping.nameFrom = g.nameFrom;
      }
      if (g.pattern !== undefined) grouping.pattern = checkRegex(g.pattern, 'grouping.pattern', errors);
    }
  }
  if (grouping.by === 'pattern' && !grouping.pattern) errors.push('grouping.pattern is required when grouping.by is "pattern".');

  const ordering = { ...base.ordering };
  if (input.ordering !== undefined) {
    if (!isObj(input.ordering)) errors.push('"ordering" must be an object.');
    else {
      const o = input.ordering;
      if (o.pages !== undefined) {
        if (!PAGE_ORDER.includes(o.pages)) errors.push(`ordering.pages must be one of: ${PAGE_ORDER.join(', ')} (found ${JSON.stringify(o.pages)}).`);
        else ordering.pages = o.pages;
      }
      if (o.groups !== undefined) {
        if (!GROUP_ORDER.includes(o.groups)) errors.push(`ordering.groups must be one of: ${GROUP_ORDER.join(', ')} (found ${JSON.stringify(o.groups)}).`);
        else ordering.groups = o.groups;
      }
      if (o.pagePattern !== undefined) ordering.pagePattern = checkRegex(o.pagePattern, 'ordering.pagePattern', errors);
      if (o.groupPattern !== undefined) ordering.groupPattern = checkRegex(o.groupPattern, 'ordering.groupPattern', errors);
    }
  }

  let output = null;
  if (input.output !== undefined && input.output !== null) {
    if (!isObj(input.output)) errors.push('"output" must be an object or null.');
    else {
      const problem = checkTemplate(input.output.template);
      if (problem) errors.push(`output.template: ${problem}`);
      output = { template: String(input.output.template ?? ''), numberFolders: input.output.numberFolders !== false };
    }
  }

  const known = new Set(['schema', 'version', 'id', 'name', 'description', 'scan', 'grouping', 'ordering', 'output']);
  for (const k of Object.keys(input)) if (!known.has(k)) warnings.push(`Ignored unknown setting "${k}".`);

  if (errors.length) return { ok: false, errors, warnings, rule: null };
  return {
    ok: true, errors, warnings,
    rule: { schema: RULE_SCHEMA, version: 1, name, description, scan, grouping, ordering, output },
  };
}

/** Parses JSON text holding one rule or a bundle. Returns {rules:[{rule, warnings}], errors:[string]}. */
export function parseRulesJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) {
    return { rules: [], errors: [`The file is not valid JSON (${e.message}).`] };
  }
  const list = Array.isArray(data) ? data : data?.schema === BUNDLE_SCHEMA && Array.isArray(data.rules) ? data.rules : [data];
  const rules = [];
  const errors = [];
  list.forEach((item, i) => {
    const r = validateRule(item);
    const label = list.length > 1 ? `Rule ${i + 1}${item?.name ? ` ("${String(item.name).slice(0, 40)}")` : ''}: ` : '';
    if (r.ok) rules.push({ rule: r.rule, warnings: r.warnings });
    else errors.push(...r.errors.map((e) => label + e));
  });
  return { rules, errors };
}

export const serializeRule = (rule) => JSON.stringify({ ...rule, id: undefined }, null, 2);
export const serializeBundle = (rules) =>
  JSON.stringify({ schema: BUNDLE_SCHEMA, version: 1, rules: rules.map((r) => ({ ...r, id: undefined })) }, null, 2);

// ----- local storage (falls back to memory when storage is blocked) -----
const KEY = 'cbz-compiler.rules.v1';
let memory = [];

export function loadRules() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return memory;
    const list = JSON.parse(raw);
    return list.map((r) => ({ id: r.id, ...validateRule(r).rule })).filter((r) => r.name);
  } catch {
    return memory;
  }
}

export function saveRules(rules) {
  memory = rules;
  try {
    localStorage.setItem(KEY, JSON.stringify(rules));
    return true;
  } catch {
    return false; // kept in memory for this session only
  }
}

export const newRuleId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
