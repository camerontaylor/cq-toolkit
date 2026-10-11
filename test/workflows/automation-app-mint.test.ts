// C3 T3 (ADR-0004 D-D.2/D-D.3) — every automation consumer mints the
// `cq-automation` App installation token PER RUN. This pins the credential
// identity across the whole automation family, template and instantiation
// alike, so a later edit cannot quietly reintroduce a stored PAT, a PAT
// fallback, or a privileged mint:
//
//   1. Each consumer carries the per-run mint step (the PR #307 pattern:
//      `actions/create-github-app-token`, variable-gated on
//      `vars.CQ_AUTOMATION_APP_CLIENT_ID`, reading `secrets.CQ_AUTOMATION_APP_KEY`),
//      scoped to this repository only.
//   2. The mint is the credential's ONLY source: no `{{SELFHOST_TOKEN}}`
//      placeholder, no `secrets.CQ_AUTOMATION_TOKEN`/`secrets.GH_TOKEN`, and
//      no `CQ_AUTOMATION_INTERIM_FALLBACK` opt-in survive.
//   3. The mint requests no Workflows/Checks/Statuses write (ADR-0004 D-D.2:
//      the automation App has none, and repo-driven code must not be able to
//      rewrite its own definition or satisfy a verdict).
//   4. The token flows out of the mint step exactly once, with no `||`
//      fallback branch.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The pinned create-github-app-token release (v3.2.0, repo policy). */
const MINT_PIN = 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1';

/** Each automation consumer: its template, its instantiation, its mint step id. */
const CONSUMERS: ReadonlyArray<{ name: string; template: string; instance: string; id: string }> = [
  {
    name: 'self-merge-prs',
    template: 'policy/templates/self-host/self-merge-prs.yml',
    instance: '.github/workflows/self-merge-prs.yml',
    id: 'self-merge-app',
  },
  {
    name: 'self-review-loop',
    template: 'policy/templates/self-host/self-review-loop.yml',
    instance: '.github/workflows/self-review-loop.yml',
    id: 'self-review-app',
  },
  {
    name: 'sync-merge-queue',
    template: 'policy/templates/sync-merge-queue.yml',
    instance: '.github/workflows/sync-merge-queue.yml',
    id: 'sync-app',
  },
  {
    name: 'init-merge-queue',
    template: 'policy/templates/init-merge-queue.yml',
    instance: '.github/workflows/init-merge-queue.yml',
    id: 'init-app',
  },
  {
    name: 'ratchet-propose',
    template: 'policy/templates/ratchet-propose.yml',
    instance: '.github/workflows/ratchet-propose.yml',
    id: 'propose-app',
  },
];

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('C3 T3: automation consumers mint the cq-automation App per run', () => {
  it.each(CONSUMERS.flatMap((c) => [c.template, c.instance].map((path) => [c, path] as const)))(
    '%s mint invariants hold in %s',
    (consumer, path) => {
      const text = read(path);
      const where = `${consumer.name} (${path})`;

      // (1) The per-run mint step, variable-gated and repo-scoped.
      expect(text, `${where}: mint action pin`).toContain(`uses: ${MINT_PIN}`);
      expect(text, `${where}: mint gate`).toContain("if: vars.CQ_AUTOMATION_APP_CLIENT_ID != ''");
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

      // (3) No Workflows/Checks/Statuses write on the mint.
      expect(text, `${where}: privileged mint grant`).not.toMatch(
        /permission-(workflows|checks|statuses)/,
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
    }
  });
});
