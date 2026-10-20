// Slice C — the action-pinning policy, mechanically enforced:
//   1. EVERY `uses:` across every generated workflow (all *.yml and *.yaml
//      under .github/workflows/ — GitHub executes both extensions) and the
//      template files under
//      policy/templates/ must be pinned to an immutable commit SHA —
//      exactly 40 lowercase hex chars after the LAST `@` of the ref.
//      A mutable tag (`@v5`) can be retargeted after review; a SHA cannot.
//      The one non-SHA form is a LOCAL action (`uses: ./.github/actions/<name>`):
//      GitHub reads it from the checked-out workspace, i.e. the same commit
//      as the workflow itself, so it is exactly as immutable — but only when
//      it names a directory under .github/actions/ that carries an
//      action.yml. Every such local action file is itself scanned here, so
//      its own `uses:` steps must be SHA-pinned like any workflow's.
//   2. The persist-credentials split: generated ci.yml, denylist.yml, and
//      install-matrix.yml run repo code, so their checkouts must drop
//      the token (`persist-credentials: false`); the queue-mechanics
//      workflow (init-merge-queue.yml) keeps the
//      promote PAT by design and must not declare the key at all — their
//      policy note says so beside the pin (the gate's note mentions the
//      word "persist-credentials" in prose, so the assertion is on the KEY,
//      not the word — and the key match is QUOTE-AWARE, so a quoted
//      `'persist-credentials':` spelling cannot hide).
//   3. policy/templates/README.md documents the policy ("## Action pinning").
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS_DIR = join(ROOT, '.github/workflows');
const ACTIONS_DIR = join(ROOT, '.github/actions');

// The template files (source of truth) that carry `uses:` steps or are
// otherwise part of the pinning policy — the ratchet family included (W1.7).
const TEMPLATE_FILES = [
  'policy/templates/cq-measure.yml',
  'policy/templates/cq-verify.yml',
  'policy/templates/cq-signal.yml',
  'policy/templates/cq-policy.yml',
  'policy/templates/cq-accept.yml',
  'policy/templates/gate.yml',
  'policy/templates/settings-drift.yml',
  'policy/templates/ratchet.yml',
  'policy/templates/ratchet-propose.yml',
  'policy/templates/ratchet-propose-measure.yml',
  'policy/templates/init-merge-queue.yml',
  'policy/templates/live-merge.yml',
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
    // Left boundary: `statuses: read` (a permissions key) ends in `uses:` but
    // is not a `uses:` key; a real key is preceded by space, `-`, `{`, `,` or
    // a quote, never by a word character.
    const pattern = /(?<![A-Za-z0-9_])["']?uses["']?\s*:\s*(\S+)/g;
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
// Local composite actions (.github/actions/<name>/action.yml): their own
// `uses:` steps run with the calling job, so they are pinned too.
const localActionFiles = existsSync(ACTIONS_DIR)
  ? readdirSync(ACTIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ACTIONS_DIR, entry.name, 'action.yml'))
      .sort()
  : [];
const pinnedFiles = [
  ...workflowFiles,
  ...localActionFiles,
  ...TEMPLATE_FILES.map((rel) => join(ROOT, rel)),
];

// A local action ref is accepted only in its exact in-repo form and only
// when the action it names exists in this commit as a real directory: a
// symlinked action directory is skipped by the scan above (Dirent
// isDirectory() does not follow links), so accepting a ref to one would let
// its unpinned `uses:` escape the pin check.
function isLocalAction(ref: string): boolean {
  const m = /^\.\/\.github\/actions\/([A-Za-z0-9._-]+)$/.exec(ref);
  if (m === null || m[1] === '.' || m[1] === '..') return false;
  const dir = join(ROOT, ref);
  return existsSync(dir) && lstatSync(dir).isDirectory() && existsSync(join(dir, 'action.yml'));
}

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
  it('scans every local action directory, and each carries an action.yml', () => {
    for (const file of localActionFiles) expect(existsSync(file), file).toBe(true);
  });

  it.each(pinnedFiles)('pins every uses: in %s to exactly 40 lowercase hex chars', (file) => {
    const failures: string[] = [];
    for (const { line, ref } of usesRefs(readFileSync(file, 'utf8'))) {
      if (isLocalAction(ref)) continue; // same-commit workspace action (header §1)
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
    // init-merge-queue.yml pushes with the promote PAT, so the checkout keeps its
    // persisted credential BY DEFAULT — the pin comment says why. The
    // policy assertion is that the file does NOT DECLARE the key (which would
    // have to be `true` to matter, and `false` would break the push); the
    // prose comment mentioning the word is not a declaration.
    for (const name of ['init-merge-queue.yml']) {
      const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
      // This pushes with the promote PAT, so the checkout keeps its
      // persisted credential BY DEFAULT — the pin comment says why. The
      // policy assertion is that the file does NOT DECLARE the key (which would
      // have to be `true` to matter, and `false` would break the push); the
      // file's prose comment mentioning the word is not a declaration.
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

  it('the merge-dispatch instantiation carries its automation-window guard', () => {
    // The window-end fail-closed guard: the UTC clock read plus the abort
    // line — a delayed fire must refuse to initiate operations, not run
    // outside the scheduled window. The REVIEW loop's guard was retired by
    // the 2026-10-12 all-hours + peak-aware-model change (its start
    // exclusion no longer exists, so neither does the guard) and is covered
    // by the peak-aware-selection test below.
    const text = readFileSync(join(WORKFLOWS_DIR, 'self-merge-prs.yml'), 'utf8');
    expect(text, `self-merge-prs.yml: the window guard's UTC clock read`).toContain(
      'date -u +%H%M',
    );
    expect(text, `self-merge-prs.yml: the window guard's abort line`).toContain(
      'outside the scheduled automation window',
    );
  });

  it('the self-review-loop instantiation is dispatch-only, dry by default, with peak-aware model selection (D11a)', () => {
    // DEVELOPMENT POSTURE 2026-10-20: no schedule — the loop is opt-in by
    // workflow_dispatch, and a dispatch is a dry run unless cleared, until
    // it shows a fixes-per-run rate above zero. The MODEL still switches
    // from the run's clock (src/selfhost/config.ts resolveSelfhostDriver).
    const text = readFileSync(join(WORKFLOWS_DIR, 'self-review-loop.yml'), 'utf8');
    expect(text).not.toMatch(/^ {2}schedule:/m);
    expect(text).not.toMatch(/^\s*- cron:/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(text).toMatch(/ {6}dry_run:\n(?: {8}.*\n)*? {8}default: true\n/);
    // The three exclusion crons and the headroom guard are gone.
    expect(text).not.toContain("cron: '*/15 0-4,10-23 * * 1-5'");
    expect(text).not.toContain("cron: '0,15,30 5 * * 1-5'");
    expect(text).not.toContain("cron: '*/15 * * * 0,6'");
    expect(text).not.toContain('outside the scheduled automation window');
    expect(text).not.toContain('date -u +%u');
    // BOTH provider keys ride the loop step; each provider reads its own.
    expect(text).toContain('ZAI_API_KEY: ${{ secrets.Z_AI_API_KEY }}');
    expect(text).toContain('DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}');
    // The fail-closed assert asks the toolkit WHICH key this clock needs and
    // requires exactly that one — no window arithmetic in YAML.
    expect(text).toContain('node dist/selfhost/self-review-loop.js --print-driver-key-env');
    expect(text).toMatch(/REQUIRED_KEY=\$\(.*\)\n\s*test -n "\$\(printenv "\$REQUIRED_KEY"\)"/);
    // A dry run posts and dispatches nothing, so it needs no provider key —
    // the handshake is skipped for it (matching main()'s exemption).
    expect(text).toContain('if [ "$DRY_RUN" != "true" ]; then');
    // D11b: the usage-report wiring — the entry's artifact path and the
    // always() upload (an over-budget run is exactly the tuning evidence).
    expect(text).toContain('SWEEP_USAGE_OUT');
    expect(text).toContain('Upload the sweep token-usage report');
    expect(text).toMatch(/if: always\(\)\n\s*with:\n\s*name: self-review-usage-/);
  });

  it('review-loop usage upload uses the same visible runner-temp path as the writer', () => {
    for (const file of [
      'policy/templates/self-host/self-review-loop.yml',
      '.github/workflows/self-review-loop.yml',
    ]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text).toContain('SWEEP_USAGE_OUT: ${{ runner.temp }}/sweep-usage.json');
      const upload = text.slice(text.indexOf('- name: Upload the sweep token-usage report'));
      expect(upload).toContain('path: ${{ runner.temp }}/sweep-usage.json');
      expect(upload).toContain('if: always()');
      expect(upload).toContain('if-no-files-found: warn');
      expect(upload).not.toContain('if-no-files-found: ignore');
    }
  });

  it('the self-host driver-key env NAMES stay consistent within and across template/instantiation', () => {
    // Batch-gate finding (VB4K #1): a template once declared env
    // `Z_AI_API_KEY:` while its own guard asserted `$ZAI_API_KEY` (the name
    // the drivers read), so an adopter's run refused to start. Pin every
    // declaration NAME (fixed: what the drivers read) to its adopter secret
    // placeholder, and pin each template to its instantiation. The review
    // loop now exports BOTH provider keys and its run step requires the one
    // the toolkit's peak-aware resolution selects (via
    // --print-driver-key-env), so both names must be declared.
    const declaredNames = (text: string): string[] =>
      [...text.matchAll(/^ {10}([A-Z][A-Z0-9_]*_API_KEY):/gm)].map((match) => String(match[1]));
    const templateText = readFileSync(
      join(ROOT, 'policy/templates/self-host/self-review-loop.yml'),
      'utf8',
    );
    const instantiatedText = readFileSync(join(WORKFLOWS_DIR, 'self-review-loop.yml'), 'utf8');
    expect(declaredNames(templateText), 'template driver env declarations').toEqual([
      'ZAI_API_KEY',
      'DEEPSEEK_API_KEY',
    ]);
    expect(declaredNames(instantiatedText), 'instantiated driver env declarations').toEqual([
      'ZAI_API_KEY',
      'DEEPSEEK_API_KEY',
    ]);
    // Each NAME pairs with the adopter's secret placeholder, verbatim.
    expect(templateText).toContain('ZAI_API_KEY: ${{ secrets.{{SELFHOST_DRIVER_KEY}} }}');
    expect(templateText).toContain('DEEPSEEK_API_KEY: ${{ secrets.{{SELFHOST_PEAK_DRIVER_KEY}} }}');
    expect(instantiatedText).toContain('ZAI_API_KEY: ${{ secrets.Z_AI_API_KEY }}');
    expect(instantiatedText).toContain('DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}');
    // The disabled conflict stage (self-merge-prs) declares no driver key.
    expect(
      declaredNames(
        readFileSync(join(ROOT, 'policy/templates/self-host/self-merge-prs.yml'), 'utf8'),
      ),
      'self-merge-prs template: no driver key',
    ).toEqual([]);
    expect(
      declaredNames(readFileSync(join(WORKFLOWS_DIR, 'self-merge-prs.yml'), 'utf8')),
      'self-merge-prs instantiation: no driver key',
    ).toEqual([]);
  });
});
