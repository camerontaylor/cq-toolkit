// C3 T3 (ADR-0004 D-D.2/D-D.3) — every automation consumer mints the
// `cq-automation` App installation token PER RUN. This pins the credential
// identity across the whole automation family, template and instantiation
// alike, so a later edit cannot quietly reintroduce a stored PAT, a PAT
// fallback, a privileged mint, or a wider-than-this-repository token:
//
//   1. Each consumer carries the per-run mint step (the PR #307 pattern:
//      `actions/create-github-app-token`, gated on
//      `vars.CQ_AUTOMATION_APP_CLIENT_ID`, reading `secrets.CQ_AUTOMATION_APP_KEY`),
//      scoped to this repository only.
//   2. The mint is the credential's ONLY source: no `{{SELFHOST_TOKEN}}`
//      placeholder, no `secrets.CQ_AUTOMATION_TOKEN`/`secrets.GH_TOKEN`, and
//      no `CQ_AUTOMATION_INTERIM_FALLBACK` opt-in survive.
//   3. The mint's requested permissions are EXACTLY the set the consumer
//      needs (no Workflows/Checks/Statuses write — ADR-0004 D-D.2 — and no
//      missing read: a 403 on a required read that the code isolates per item
//      would masquerade as per-item data failure).
//   4. The token flows out of the mint step exactly once, with no `||`
//      fallback branch, and the mint cannot run without a repository name
//      (`owner` without `repositories` mints installation-wide).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The pinned create-github-app-token release (v3.2.0, repo policy). */
const MINT_PIN = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';

/** The fail-closed scope clause: never mint without a repository name. */
const SCOPE_GUARD = "github.event.repository.name != ''";

/**
 * Each automation consumer: its template, its instantiation, its mint step id,
 * and the EXACT `permission-*` grant set its run step requires.
 */
const CONSUMERS: ReadonlyArray<{
  name: string;
  template: string;
  instance: string;
  id: string;
  permissions: readonly string[];
}> = [
  {
    name: 'self-merge-prs',
    template: 'policy/templates/self-host/self-merge-prs.yml',
    instance: '.github/workflows/self-merge-prs.yml',
    id: 'self-merge-app',
    // Merges + cq-state writes + the PR's top-level conversation comments
    // (`GET /issues/{pr}/comments` in src/ops/review/fetchReviewState.ts).
    permissions: [
      'permission-contents: write',
      'permission-issues: read',
      'permission-pull-requests: write',
    ],
  },
  {
    name: 'self-review-loop',
    template: 'policy/templates/self-host/self-review-loop.yml',
    instance: '.github/workflows/self-review-loop.yml',
    id: 'self-review-app',
    // Review replies/thread resolves, review-fix pushes, top-level comments.
    permissions: [
      'permission-contents: write',
      'permission-issues: write',
      'permission-pull-requests: write',
    ],
  },
  {
    name: 'sync-merge-queue',
    template: 'policy/templates/sync-merge-queue.yml',
    instance: '.github/workflows/sync-merge-queue.yml',
    id: 'sync-app',
    // List + open the sync PR only (reads/dispatches keep GITHUB_TOKEN).
    permissions: ['permission-pull-requests: write'],
  },
  {
    name: 'init-merge-queue',
    template: 'policy/templates/init-merge-queue.yml',
    instance: '.github/workflows/init-merge-queue.yml',
    id: 'init-app',
    // Creating the merge-queue branch is a write.
    permissions: ['permission-contents: write'],
  },
  {
    name: 'ratchet-propose',
    template: 'policy/templates/ratchet-propose.yml',
    instance: '.github/workflows/ratchet-propose.yml',
    id: 'propose-app',
    // Proposal-branch push + create/edit the proposal PR.
    permissions: ['permission-contents: write', 'permission-pull-requests: write'],
  },
];

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The `permission-<name>: <level>` grants declared in a workflow text. */
const grantsIn = (text: string): string[] =>
  [...text.matchAll(/^\s*permission-[a-z-]+:\s*\w+\s*$/gm)].map((m) => m[0].trim()).sort();

describe('C3 T3: automation consumers mint the cq-automation App per run', () => {
  it.each(CONSUMERS.flatMap((c) => [c.template, c.instance].map((path) => [c, path] as const)))(
    '%s mint invariants hold in %s',
    (consumer, path) => {
      const text = read(path);
      const where = `${consumer.name} (${path})`;

      // (1) The per-run mint step, gated and repo-scoped.
      expect(text, `${where}: mint step id`).toContain(`id: ${consumer.id}`);
      expect(text, `${where}: mint action pin`).toContain(`uses: ${MINT_PIN}`);
      expect(text, `${where}: mint client-id gate`).toContain(
        "vars.CQ_AUTOMATION_APP_CLIENT_ID != ''",
      );
      expect(text, `${where}: mint scope guard`).toContain(SCOPE_GUARD);
      expect(text, `${where}: mint client id`).toContain(
        'client-id: ${{ vars.CQ_AUTOMATION_APP_CLIENT_ID }}',
      );
      expect(text, `${where}: mint private key`).toContain(
        'private-key: ${{ secrets.CQ_AUTOMATION_APP_KEY }}',
      );
      expect(text, `${where}: owner scope`).toContain('owner: ${{ github.repository_owner }}');
      expect(text, `${where}: repository scope`).toContain(
        'repositories: ${{ github.event.repository.name }}',
      );

      // (2) The mint is the credential's only source — no stored token, no
      // placeholder, no interim opt-in.
      expect(text, `${where}: retired placeholder`).not.toContain('{{SELFHOST_TOKEN}}');
      expect(text, `${where}: stored automation PAT`).not.toMatch(/secrets\.CQ_AUTOMATION_TOKEN\b/);
      expect(text, `${where}: stored automation PAT (GH_TOKEN)`).not.toMatch(/secrets\.GH_TOKEN\b/);
      expect(text, `${where}: interim fallback opt-in`).not.toContain(
        'CQ_AUTOMATION_INTERIM_FALLBACK',
      );

      // (3) The mint's grants are EXACTLY the consumer's required set — no
      // privileged grant, and no missing read.
      expect(grantsIn(text), `${where}: exact permission set`).toEqual(
        [...consumer.permissions].sort(),
      );

      // (4) One token source, no fallback branch off the mint.
      expect(text, `${where}: minted token consumed`).toContain(
        `steps.${consumer.id}.outputs.token`,
      );
      expect(text, `${where}: token fallback branch`).not.toMatch(/outputs\.token\s*\|\|/);
      expect(text, `${where}: secret fallback branch`).not.toMatch(
        /outputs\.token\s*\)?\s*\|\|\s*secrets\./,
      );
    },
  );

  it('the rendered consumers really are the newer shape (non-vacuous)', () => {
    // A vacuity guard: the family-wide assertions above must find the mint in
    // every consumer, so a rename that dropped one would fail here first.
    for (const consumer of CONSUMERS) {
      expect(read(consumer.instance), consumer.name).toContain(
        `steps.${consumer.id}.outputs.token`,
      );
      expect(grantsIn(read(consumer.instance)), consumer.name).toEqual(
        [...consumer.permissions].sort(),
      );
    }
  });
});
