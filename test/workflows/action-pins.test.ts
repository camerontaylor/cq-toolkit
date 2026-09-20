// Slice C — the action-pinning policy, mechanically enforced:
//   1. EVERY `uses:` across every generated workflow (all *.yml and *.yaml
//      under .github/workflows/ — GitHub executes both extensions) and the
//      eight template files under
//      policy/templates/ must be pinned to an immutable commit SHA —
//      exactly 40 lowercase hex chars after the LAST `@` of the ref.
//      A mutable tag (`@v5`) can be retargeted after review; a SHA cannot.
//   2. The persist-credentials split: generated ci.yml, denylist.yml, and
//      install-matrix.yml run repo code, so their checkouts must drop
//      the token (`persist-credentials: false`); the queue-mechanics
//      workflows (init-merge-queue.yml, merge-queue-gate.yml) keep the
//      promote PAT by design and must not declare the key at all — their
//      policy note says so beside the pin (the gate's note mentions the
//      word "persist-credentials" in prose, so the assertion is on the KEY,
//      not the word — and the key match is QUOTE-AWARE, so a quoted
//      `'persist-credentials':` spelling cannot hide).
//   3. policy/templates/README.md documents the policy ("## Action pinning").
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');

// The eight template files (source of truth) that carry `uses:` steps or are
// otherwise part of the pinning policy.
const TEMPLATE_FILES = [
  'policy/templates/init-merge-queue.yml',
  'policy/templates/live-merge.yml',
  'policy/templates/merge-queue-gate.yml',
  'policy/templates/sync-merge-queue.yml',
  'policy/templates/required-check.md',
  'policy/templates/affected-tests.md',
  'policy/templates/self-host/self-review-loop.yml',
  'policy/templates/self-host/self-merge-prs.yml',
];

// Every `uses:` value in the text (quoted `'uses':` keys included — YAML
// allows quoted keys), as { line, ref } — ref is the full
// non-space token (e.g. "actions/checkout@fbc6...c09").
function usesRefs(text: string): Array<{ line: number; ref: string }> {
  const refs: Array<{ line: number; ref: string }> = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const pattern = /["']?uses["']?\s*:\s*(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const ref = match[1];
      if (ref === undefined) throw new Error('uses pattern must capture a reference');
      refs.push({ line: idx + 1, ref });
    }
  });
  return refs;
}

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter((name) => /\.ya?ml$/.test(name)) // GitHub executes both .yml and .yaml
  .sort()
  .map((name) => join(WORKFLOWS_DIR, name));
const pinnedFiles = [...workflowFiles, ...TEMPLATE_FILES.map((rel) => join(ROOT, rel))];

// Split the workflow text into top-level step blocks: a block starts at a
// `- ` item line whose indent equals the steps-list base indent (taken from
// the FIRST `- ` item in the file) and extends until the next item at that
// same indent or a dedent below it. Deeper `- ` lines (script bodies, nested
// lists) never start a block.
function stepBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let base: number | null = null;
  const starts: number[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)- /.exec(line);
    if (m === null) return;
    const indent = m[1];
    if (indent === undefined) throw new Error('step pattern must capture indentation');
    if (base === null) base = indent.length;
    if (indent.length === base) starts.push(i);
  });
  const blocks: string[] = [];
  for (let s = 0; s < starts.length; s++) {
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    blocks.push(lines.slice(starts[s], end).join('\n'));
  }
  return blocks;
}

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

  it('generated ci.yml, denylist.yml, and install-matrix.yml drop the token on EVERY checkout step', () => {
    for (const name of ['ci.yml', 'denylist.yml', 'install-matrix.yml', 'live-merge.yml']) {
      const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      const checkoutBlocks = stepBlocks(text).filter((block) =>
        block.includes('actions/checkout@'),
      );
      // Vacuity guard: a refactor that removed the steps (or the checkout)
      // must not silently turn this assertion into a no-op.
      expect(checkoutBlocks.length, `${name}: at least one checkout step`).toBeGreaterThanOrEqual(
        1,
      );
      for (const block of checkoutBlocks) {
        expect(block, `${name}: a checkout step must set persist-credentials: false`).toMatch(
          /["']?persist-credentials["']?\s*:\s*false/,
        );
      }
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
      expect(text, `${name}: must not declare a persist-credentials key`).not.toMatch(
        /^\s+["']?persist-credentials["']?\s*:/m,
      );
    }
  });

  it('the templates README documents the pinning policy', () => {
    expect(readFileSync(join(ROOT, 'policy/templates/README.md'), 'utf8')).toContain(
      '## Action pinning',
    );
  });

  it('both instantiated self-host workflows carry the automation-window guard', () => {
    // The window-end fail-closed guard: the UTC clock read plus the abort
    // line — a delayed fire must refuse to initiate operations, not run
    // outside the scheduled window.
    for (const name of ['self-review-loop.yml', 'self-merge-prs.yml']) {
      const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      expect(text, `${name}: the window guard's UTC clock read`).toContain('date -u +%H%M');
      expect(text, `${name}: the window guard's abort line`).toContain(
        'outside the scheduled automation window',
      );
    }
  });

  it('the self-host driver-key env NAME is consistent within and across template/instantiation', () => {
    // Batch-gate finding (VB4K #1): the templates declared env
    // `Z_AI_API_KEY:` while their own guard asserted `$ZAI_API_KEY` (the name
    // the drivers read), so an adopter's run refused to start. Pin the
    // declaration and the assertion to the SAME key, and pin each template
    // to its instantiation: the declaration NAME is fixed (`ZAI_API_KEY`);
    // only the secret name is the `{{SELFHOST_DRIVER_KEY}}` placeholder.
    const declared = (text: string): string | undefined =>
      text.match(/^\s*([A-Z_]*AI_API_KEY):\s*\$\{\{\s*secrets\./m)?.[1];
    const asserted = (text: string): string | undefined =>
      text.match(/test -n "\$([A-Z_]*AI_API_KEY)"/)?.[1];
    const pairs = ['self-review-loop.yml', 'self-merge-prs.yml'].map((name) => ({
      name,
      template: join(ROOT, `policy/templates/self-host/${name}`),
      instantiated: join(WORKFLOWS_DIR, name),
    }));
    for (const { name, template, instantiated } of pairs) {
      const templateText = readFileSync(template, 'utf8');
      const instantiatedText = readFileSync(instantiated, 'utf8');
      const templateDecl = declared(templateText);
      const instantiatedDecl = declared(instantiatedText);
      expect(templateDecl, `${name}: template driver env declaration`).toBe('ZAI_API_KEY');
      expect(instantiatedDecl, `${name}: instantiated driver env declaration`).toBe('ZAI_API_KEY');
      expect(templateDecl, `${name}: template declaration must match its guard assert`).toBe(
        asserted(templateText),
      );
      expect(
        instantiatedDecl,
        `${name}: instantiated declaration must match its guard assert`,
      ).toBe(asserted(instantiatedText));
      expect(instantiatedDecl, `${name}: template and instantiation must agree`).toBe(templateDecl);
    }
  });
});
