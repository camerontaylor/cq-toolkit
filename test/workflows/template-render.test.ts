// W1.10 Decision 15 — the template render-diff test. Every workflow under
// .github/workflows/ is either the exact render of its policy/templates/
// source (policy/templates/instances.json records the template and token
// values) or listed as non-templated with a reason; every template is either
// instantiated or listed as adopter-only. The render is the README's "How
// instantiation works": literal `{{TOKEN}}` replacement plus the provenance
// header. Re-instantiate with `node scripts/render-templates.mjs --write`.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TABLE_PATH,
  TEMPLATES_DIR,
  WORKFLOWS_DIR,
  collectRenders,
  firstDifference,
  listYaml,
  renderTemplate,
  templateTokens,
  validateTable,
} from '../../scripts/lib/render-templates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { errors, results } = collectRenders(ROOT);

describe('template render-diff: every instance is its exact render', () => {
  it('the table is sound and every template renders', () => {
    expect(errors).toEqual([]);
  });

  it.each(results.map((r) => [r.workflow, r] as const))(
    '%s is byte-for-byte the render of its template',
    (_workflow, { workflow, template, expected, actual }) => {
      expect(expected, `${template} failed to render`).not.toBeNull();
      expect(actual, `${WORKFLOWS_DIR}/${workflow} is missing`).not.toBeNull();
      const hint = firstDifference(expected ?? '', actual ?? '');
      expect(
        hint,
        `${WORKFLOWS_DIR}/${workflow} drifted from ${TEMPLATES_DIR}/${template} — edit the template, then run \`node scripts/render-templates.mjs --write\``,
      ).toBeNull();
      expect(actual).toBe(expected);
    },
  );

  it('the header line matches the committed provenance form', () => {
    const cqPolicy = readFileSync(join(ROOT, WORKFLOWS_DIR, 'cq-policy.yml'), 'utf8');
    expect(cqPolicy.split('\n')[0]).toBe(
      '# instantiated from policy/templates/cq-policy.yml — edit the template, not this file',
    );
  });
});

describe('template render-diff: coverage', () => {
  const table = JSON.parse(readFileSync(join(ROOT, TABLE_PATH), 'utf8')) as unknown;
  const workflows = listYaml(join(ROOT, WORKFLOWS_DIR), false);
  const templates = listYaml(join(ROOT, TEMPLATES_DIR), true);

  it('finds the workflows and the templates, including the self-host subdirectory', () => {
    expect(workflows).toContain('ci.yml');
    expect(templates).toContain('merge-queue-gate.yml');
    expect(templates).toContain('self-host/self-review-loop.yml');
  });

  it('accounts for every workflow and every template exactly once', () => {
    expect(validateTable(table, workflows, templates)).toEqual([]);
  });

  it('reports unaccounted, duplicate, phantom and unknown entries', () => {
    const bad = {
      schemaVersion: 1,
      extra: true,
      instances: [
        { workflow: 'a.yml', template: 'a.yml', tokens: {}, note: 'x' },
        { workflow: 'a.yml', template: 'b.yml', tokens: { lower: 'v' } },
      ],
      nonTemplated: [{ workflow: 'ghost.yml', reason: '' }],
      adopterOnly: [],
    };
    expect(validateTable(bad, ['a.yml', 'c.yml'], ['a.yml', 'b.yml', 'd.yml'])).toEqual([
      'unknown top-level field "extra"',
      'instances[0]: unknown field "note"',
      'instances[1]: token "lower" is not UPPER_SNAKE',
      'nonTemplated[0]: "reason" must be a non-empty string',
      'workflow a.yml is listed 2 times (exactly once allowed)',
      'workflow c.yml is not accounted for (add it to "instances" or "nonTemplated")',
      'workflow ghost.yml is listed but does not exist',
      'template d.yml is not accounted for (add it to "instances" or "adopterOnly")',
    ]);
    expect(validateTable({ schemaVersion: 2 }, [], [])).toEqual([
      'schemaVersion must be 1',
      '"instances" must be an array',
      '"nonTemplated" must be an array',
      '"adopterOnly" must be an array',
    ]);
  });
});

describe('renderTemplate', () => {
  const header = '# instantiated from policy/templates/t.yml — edit the template, not this file\n';

  it('prepends the provenance header and replaces every token literally', () => {
    expect(renderTemplate('a: {{X}}\nb: {{X}}-{{Y_2}}\n', 't.yml', { X: '1', Y_2: '$&' })).toBe(
      `${header}a: 1\nb: 1-$&\n`,
    );
  });

  it('leaves GitHub expressions untouched and replaces a token inside one', () => {
    const text = 'k: ${{ github.sha }}\nt: ${{ secrets.{{SECRET}} }}\nu: ${{SECRET}}\n';
    expect(templateTokens(text)).toEqual(['SECRET']);
    expect(renderTemplate(text, 't.yml', { SECRET: 'PROMOTE_TOKEN' })).toBe(
      `${header}k: \${{ github.sha }}\nt: \${{ secrets.PROMOTE_TOKEN }}\nu: \${{SECRET}}\n`,
    );
  });

  it('ignores non-token braces ({{COMMANDS...}}, lowercase, spaced)', () => {
    expect(templateTokens('{{COMMANDS...}} {{lower}} {{ SPACED }}')).toEqual([]);
  });

  it('throws on a template token missing from the table', () => {
    expect(() => renderTemplate('a: {{X}} {{Y}}\n', 't.yml', { X: '1' })).toThrow(
      't.yml: template token(s) missing from the table: Y',
    );
  });

  it('throws on a table token the template does not use', () => {
    expect(() => renderTemplate('a: {{X}}\n', 't.yml', { X: '1', STALE: '2' })).toThrow(
      't.yml: table token(s) the template does not use: STALE',
    );
  });

  it('points at the first differing line', () => {
    expect(firstDifference('a\nb\n', 'a\nb\n')).toBeNull();
    expect(firstDifference('a\nb\n', 'a\nc\n')).toBe(
      'first difference at line 2: rendered "b", committed "c"',
    );
    expect(firstDifference('a\n', 'a')).toBe(
      'first difference at line 2: rendered "", committed <end of file>',
    );
  });
});
