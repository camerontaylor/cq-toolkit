// The template instantiation mechanics (W1.10 Decision 15), shared by
// scripts/render-templates.mjs and test/workflows/template-render.test.ts.
// policy/templates/instances.json is this repo's instantiation table; every
// workflow under .github/workflows/ must be the exact render of its template
// or be listed as non-templated, and every template must be instantiated or
// listed as adopter-only. The render is the README's "How instantiation
// works": literal `{{TOKEN}}` replacement plus the provenance header —
// nothing else in the file changes.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A token is `{{` + an UPPER_SNAKE name + `}}` NOT preceded by `$`: a GitHub
// expression `${{ ... }}` is never a token, but a token may sit INSIDE one
// (`${{ secrets.{{PROMOTE_SECRET}} }}` — the inner `{{` follows a `.`).
export const TOKEN_PATTERN = /(?<!\$)\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export const TEMPLATES_DIR = 'policy/templates';
export const WORKFLOWS_DIR = '.github/workflows';
export const TABLE_PATH = 'policy/templates/instances.json';

/** The provenance header line every instance starts with. */
export function provenanceHeader(template) {
  return `# instantiated from ${TEMPLATES_DIR}/${template} — edit the template, not this file\n`;
}

/** The distinct tokens a template text uses, in first-use order. */
export function templateTokens(text) {
  return [...new Set([...text.matchAll(TOKEN_PATTERN)].map((m) => m[1]))];
}

/**
 * Render one template: the provenance header plus the template text with
 * every token replaced by its literal table value. Throws when the template
 * uses a token the table lacks, or the table holds a token the template does
 * not use (so a table can never go stale).
 */
export function renderTemplate(text, template, tokens) {
  const used = templateTokens(text);
  const missing = used.filter((name) => !Object.hasOwn(tokens, name));
  if (missing.length > 0) {
    throw new Error(`${template}: template token(s) missing from the table: ${missing.join(', ')}`);
  }
  const unused = Object.keys(tokens).filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new Error(`${template}: table token(s) the template does not use: ${unused.join(', ')}`);
  }
  return provenanceHeader(template) + text.replace(TOKEN_PATTERN, (_m, name) => tokens[name]);
}

const TOP_KEYS = ['schemaVersion', 'instances', 'nonTemplated', 'adopterOnly'];
const ENTRY_KEYS = {
  instances: ['workflow', 'template', 'tokens'],
  nonTemplated: ['workflow', 'reason'],
  adopterOnly: ['template', 'reason'],
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Validate the table's shape and its coverage of the on-disk workflows and
 * templates (both lists relative: `ci.yml`, `self-host/self-merge-prs.yml`).
 * Returns every error found; an empty list means the table is sound.
 */
export function validateTable(table, workflows, templates) {
  if (!isObject(table)) return ['the table must be a JSON object'];
  const errors = [];
  for (const key of Object.keys(table)) {
    if (!TOP_KEYS.includes(key)) errors.push(`unknown top-level field "${key}"`);
  }
  if (table.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const workflowSeen = new Map();
  const templateSeen = new Map();
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const section of ['instances', 'nonTemplated', 'adopterOnly']) {
    const entries = table[section];
    if (!Array.isArray(entries)) {
      errors.push(`"${section}" must be an array`);
      continue;
    }
    entries.forEach((entry, index) => {
      const at = `${section}[${index}]`;
      if (!isObject(entry)) {
        errors.push(`${at} must be an object`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!ENTRY_KEYS[section].includes(key)) errors.push(`${at}: unknown field "${key}"`);
      }
      for (const key of ENTRY_KEYS[section]) {
        if (key === 'tokens') continue;
        if (!isNonEmptyString(entry[key]))
          errors.push(`${at}: "${key}" must be a non-empty string`);
      }
      if (section === 'instances') {
        if (!isObject(entry.tokens)) {
          errors.push(`${at}: "tokens" must be an object`);
        } else {
          for (const [name, value] of Object.entries(entry.tokens)) {
            if (!/^[A-Z][A-Z0-9_]*$/.test(name))
              errors.push(`${at}: token "${name}" is not UPPER_SNAKE`);
            if (typeof value !== 'string') errors.push(`${at}: token "${name}" must be a string`);
          }
        }
      }
      if (isNonEmptyString(entry.workflow)) count(workflowSeen, entry.workflow);
      if (isNonEmptyString(entry.template)) count(templateSeen, entry.template);
    });
  }
  const coverage = (kind, seen, onDisk, sections) => {
    for (const name of onDisk) {
      const n = seen.get(name) ?? 0;
      if (n === 0) errors.push(`${kind} ${name} is not accounted for (add it to ${sections})`);
      if (n > 1) errors.push(`${kind} ${name} is listed ${n} times (exactly once allowed)`);
    }
    for (const name of seen.keys()) {
      if (!onDisk.includes(name)) errors.push(`${kind} ${name} is listed but does not exist`);
    }
  };
  coverage('workflow', workflowSeen, workflows, '"instances" or "nonTemplated"');
  coverage('template', templateSeen, templates, '"instances" or "adopterOnly"');
  return errors;
}

/** `.yml`/`.yaml` files under `dir` (recursive when asked), relative to it, sorted. */
export function listYaml(dir, recursive) {
  return readdirSync(dir, { recursive, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

/**
 * Read the table, the templates and the workflows under `root`; validate the
 * table and render every instance. Each result carries the rendered text
 * (`expected`, null when the render threw) and the committed text (`actual`,
 * null when the workflow is missing).
 */
export function collectRenders(root) {
  const workflows = listYaml(join(root, WORKFLOWS_DIR), false);
  const templates = listYaml(join(root, TEMPLATES_DIR), true);
  let table;
  try {
    table = JSON.parse(readFileSync(join(root, TABLE_PATH), 'utf8'));
  } catch (error) {
    return { errors: [`${TABLE_PATH}: ${error.message}`], results: [] };
  }
  const errors = validateTable(table, workflows, templates).map((e) => `${TABLE_PATH}: ${e}`);
  const results = [];
  for (const entry of Array.isArray(table?.instances) ? table.instances : []) {
    if (!isObject(entry) || !templates.includes(entry.template) || !isObject(entry.tokens))
      continue;
    let expected = null;
    try {
      const text = readFileSync(join(root, TEMPLATES_DIR, entry.template), 'utf8');
      expected = renderTemplate(text, entry.template, entry.tokens);
    } catch (error) {
      errors.push(error.message);
    }
    const actual = workflows.includes(entry.workflow)
      ? readFileSync(join(root, WORKFLOWS_DIR, entry.workflow), 'utf8')
      : null;
    results.push({ workflow: entry.workflow, template: entry.template, expected, actual });
  }
  return { errors, results };
}

/** A one-line hint at the first differing line of two texts, or null when equal. */
export function firstDifference(expected, actual) {
  if (expected === actual) return null;
  const want = expected.split('\n');
  const got = actual.split('\n');
  let line = 0;
  while (line < want.length && line < got.length && want[line] === got[line]) line += 1;
  const show = (value) => (value === undefined ? '<end of file>' : JSON.stringify(value));
  return `first difference at line ${line + 1}: rendered ${show(want[line])}, committed ${show(got[line])}`;
}
