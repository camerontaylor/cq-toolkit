// W1.10 Decision 15 — the template render-diff test. Every workflow under
// .github/workflows/ is either the exact render of its policy/templates/
// source (policy/templates/instances.json records the template and token
// values) or listed as non-templated with a reason; every template is either
// instantiated or listed as adopter-only. The render is the README's "How
// instantiation works": literal `{{TOKEN}}` replacement plus the provenance
// header. Re-instantiate with `node scripts/render-templates.mjs --write`.
// The table's names are file names (a workflow directly under
// .github/workflows/, a template at most one directory under
// policy/templates/, never a `..` segment), and --write writes nothing
// while any table error but "listed but does not exist" stands.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  writeBlockers,
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
    expect(
      validateTable(
        {
          schemaVersion: 1,
          instances: [
            { workflow: '../../package.json', template: 'a.yml', tokens: {} },
            { workflow: 'sub/x.yml', template: '../a.yml', tokens: {} },
            { workflow: 'x.txt', template: 'a/b/c.yml', tokens: {} },
          ],
          nonTemplated: [{ workflow: '..', reason: 'r' }],
          adopterOnly: [{ template: './a.yml', reason: 'r' }],
        },
        [],
        [],
      ).filter((e) => !/listed|accounted/.test(e)),
    ).toEqual([
      'instances[0]: workflow "../../package.json" is not a file name directly under .github/workflows/',
      'instances[1]: workflow "sub/x.yml" is not a file name directly under .github/workflows/',
      'instances[1]: template "../a.yml" is not a .yml/.yaml path under policy/templates/ (at most one directory, no \'..\')',
      'instances[2]: workflow "x.txt" is not a file name directly under .github/workflows/',
      'instances[2]: template "a/b/c.yml" is not a .yml/.yaml path under policy/templates/ (at most one directory, no \'..\')',
      'nonTemplated[0]: workflow ".." is not a file name directly under .github/workflows/',
      'adopterOnly[0]: template "./a.yml" is not a .yml/.yaml path under policy/templates/ (at most one directory, no \'..\')',
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

describe('render-templates --write refuses an invalid table', () => {
  it('writeBlockers passes only a missing workflow through', () => {
    expect(
      writeBlockers([
        `${TABLE_PATH}: workflow new.yml is listed but does not exist`,
        `${TABLE_PATH}: template gone.yml is listed but does not exist`,
        `${TABLE_PATH}: instances[0]: workflow "../x" is not a file name directly under .github/workflows/`,
      ]),
    ).toEqual([
      `${TABLE_PATH}: template gone.yml is listed but does not exist`,
      `${TABLE_PATH}: instances[0]: workflow "../x" is not a file name directly under .github/workflows/`,
    ]);
  });

  /** A scratch repo root with the CLI, its lib, one template and `table`. */
  function scratch(table: unknown): string {
    const root = mkdtempSync(join(tmpdir(), 'cq-render-'));
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    mkdirSync(join(root, TEMPLATES_DIR), { recursive: true });
    mkdirSync(join(root, WORKFLOWS_DIR), { recursive: true });
    copyFileSync(
      join(ROOT, 'scripts/render-templates.mjs'),
      join(root, 'scripts/render-templates.mjs'),
    );
    copyFileSync(
      join(ROOT, 'scripts/lib/render-templates.mjs'),
      join(root, 'scripts/lib/render-templates.mjs'),
    );
    writeFileSync(join(root, TEMPLATES_DIR, 'a.yml'), 'name: a\n');
    writeFileSync(join(root, 'package.json'), '{"keep":true}\n');
    writeFileSync(join(root, TABLE_PATH), JSON.stringify(table));
    return root;
  }
  const write = (root: string) =>
    spawnSync(process.execPath, [join(root, 'scripts/render-templates.mjs'), '--write'], {
      encoding: 'utf8',
    });

  it('an escaping workflow path writes nothing and exits 1', { timeout: 30_000 }, () => {
    const root = scratch({
      schemaVersion: 1,
      instances: [{ workflow: '../../package.json', template: 'a.yml', tokens: {} }],
      nonTemplated: [],
      adopterOnly: [],
    });
    try {
      const r = write(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--write refused \(nothing written\)/);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{"keep":true}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a new instance whose workflow does not exist yet is created', { timeout: 30_000 }, () => {
    const root = scratch({
      schemaVersion: 1,
      instances: [{ workflow: 'a.yml', template: 'a.yml', tokens: {} }],
      nonTemplated: [],
      adopterOnly: [],
    });
    try {
      const r = write(root);
      expect(r.stderr).toMatch(/workflow a\.yml is listed but does not exist/);
      expect(existsSync(join(root, WORKFLOWS_DIR, 'a.yml'))).toBe(true);
      expect(readFileSync(join(root, WORKFLOWS_DIR, 'a.yml'), 'utf8')).toBe(
        `# instantiated from ${TEMPLATES_DIR}/a.yml — edit the template, not this file\nname: a\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
