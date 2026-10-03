// The pnpm setup policy, mechanically enforced over every generated
// workflow and every template that installs pnpm:
//   1. CI opts out of pnpm-workspace.yaml's global virtual store
//      (PNPM_CONFIG_VIRTUAL_STORE_TYPE: project) — CI detection does NOT
//      disable an explicit virtualStoreType, and the shared-store mode
//      injects a NODE_PATH/NODE_OPTIONS resolve hook into every pnpm child.
//   2. A workflow that runs pnpm installs it (pnpm/action-setup) first.
//   3. A pnpm/action-setup step never restores a cache or installs on its
//      own (no `cache:`/`run_install:` input) — deciding jobs restore
//      nothing (D-C.7), and installs are explicit, flag-checked steps.
//   4. Where the trusted toolkit is checked out to `trust/`, the pnpm
//      version comes from trust/package.json, never the head's copy.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');
const TEMPLATE_DIRS = ['policy/templates', 'policy/templates/self-host'];

const files = [
  ...readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(WORKFLOWS_DIR, name)),
  ...TEMPLATE_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      // READMEs are prose about the templates, not workflow bodies.
      .filter((name) => /\.(?:ya?ml|md)$/.test(name) && name !== 'README.md')
      .map((name) => join(ROOT, dir, name)),
  ),
]
  .map((path) => ({ path, rel: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }))
  .filter(({ text }) => /\bpnpm (?:install|run|exec|add|pack|test)\b/.test(text))
  .sort((a, b) => a.rel.localeCompare(b.rel));

/** Each `- ` step item whose body names pnpm/action-setup, up to the next sibling item. */
function setupSteps(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes('pnpm/action-setup@')) return;
    let start = i;
    while (start > 0 && !/^\s*- /.test(lines[start] ?? '')) start--;
    const indent = /^(\s*)- /.exec(lines[start] ?? '')?.[1]?.length ?? 0;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end] ?? '';
      const m = /^(\s*)\S/.exec(next);
      if (m && (m[1]?.length ?? 0) <= indent) break;
      end++;
    }
    blocks.push(lines.slice(start, end).join('\n'));
  });
  return blocks;
}

describe('pnpm setup policy', () => {
  it('covers the pnpm-using workflows and templates', () => {
    expect(files.map((f) => f.rel)).toContain('.github/workflows/ci.yml');
    expect(files.map((f) => f.rel)).toContain('policy/templates/required-check.md');
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.rel, f.text] as const))(
    '%s: opts CI out of the global virtual store',
    (_rel, text) => {
      expect(text).toMatch(/^\s*PNPM_CONFIG_VIRTUAL_STORE_TYPE: project$/m);
    },
  );

  it.each(files.map((f) => [f.rel, f.text] as const))(
    '%s: installs pnpm with an inert, correctly sourced setup step',
    (_rel, text) => {
      const steps = setupSteps(text);
      expect(steps.length).toBeGreaterThan(0);
      const trusted = /^\s*path: trust$/m.test(text);
      for (const step of steps) {
        expect(step).not.toMatch(/^\s*(?:cache|run_install|cache_dependency_path):/m);
        if (trusted) expect(step).toMatch(/^\s*package_json_file: trust\/package\.json$/m);
      }
    },
  );
});
