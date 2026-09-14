// Slice C — the action-pinning policy, mechanically enforced:
//   1. EVERY `uses:` across every generated workflow (all *.yml under
//      .github/workflows/) and the five template files under
//      policy/templates/ must be pinned to an immutable commit SHA —
//      exactly 40 lowercase hex chars after the LAST `@` of the ref.
//      A mutable tag (`@v5`) can be retargeted after review; a SHA cannot.
//   2. The persist-credentials split: generated ci.yml and denylist.yml are
//      required-check jobs that run repo code, so their checkouts must drop
//      the token (`persist-credentials: false`); the queue-mechanics
//      workflows (init-merge-queue.yml, merge-queue-gate.yml) keep the
//      promote PAT by design and must not declare the key at all — their
//      policy note says so beside the pin (the gate's note mentions the
//      word "persist-credentials" in prose, so the assertion is on the KEY,
//      not the word).
//   3. policy/templates/README.md documents the policy ("## Action pinning").
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');

// The five template files (source of truth) that carry `uses:` steps or are
// otherwise part of the pinning policy.
const TEMPLATE_FILES = [
  'policy/templates/init-merge-queue.yml',
  'policy/templates/merge-queue-gate.yml',
  'policy/templates/sync-merge-queue.yml',
  'policy/templates/required-check.md',
  'policy/templates/affected-tests.md',
];

// Every `uses:` value in the text, as { line, ref } — ref is the full
// non-space token (e.g. "actions/checkout@fbc6...c09").
function usesRefs(text: string): Array<{ line: number; ref: string }> {
  const refs: Array<{ line: number; ref: string }> = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const pattern = /uses:\s*(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      refs.push({ line: idx + 1, ref: match[1] });
    }
  });
  return refs;
}

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml'))
  .sort()
  .map((name) => join(WORKFLOWS_DIR, name));
const pinnedFiles = [...workflowFiles, ...TEMPLATE_FILES.map((rel) => join(ROOT, rel))];

describe('action pins: every uses: is an immutable commit SHA', () => {
  it.each(pinnedFiles)('pins every uses: in %s to exactly 40 lowercase hex chars', (file) => {
    const failures: string[] = [];
    for (const { line, ref } of usesRefs(readFileSync(file, 'utf8'))) {
      const tag = ref.slice(ref.lastIndexOf('@') + 1); // ref after the LAST '@'
      if (!/^[0-9a-f]{40}$/.test(tag)) {
        failures.push(`${file}:${line} pins "${ref}"`);
      }
    }
    expect(failures, 'mutable or missing action pins').toEqual([]);
  });

  it('generated ci.yml and denylist.yml drop the checkout token (persist-credentials: false)', () => {
    for (const name of ['ci.yml', 'denylist.yml']) {
      const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      expect(text, `${name}: required-check checkout must set persist-credentials: false`).toMatch(/^(\s+)persist-credentials: false$/m);
    }
  });

  it('queue-mechanics workflows keep the promote PAT (no persist-credentials key)', () => {
    for (const name of ['init-merge-queue.yml', 'merge-queue-gate.yml']) {
      const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      // These two push with the promote PAT, so the checkout keeps its
      // persisted credential BY DEFAULT — the pin comment says why. The
      // policy assertion is that neither file DECLARES the key (which would
      // have to be `true` to matter, and `false` would break the push); the
      // gate's prose comment mentioning the word is not a declaration.
      expect(text, `${name}: must not declare a persist-credentials key`).not.toMatch(/^\s+persist-credentials\s*:/m);
    }
  });

  it('the templates README documents the pinning policy', () => {
    expect(readFileSync(join(ROOT, 'policy/templates/README.md'), 'utf8')).toContain('## Action pinning');
  });
});
