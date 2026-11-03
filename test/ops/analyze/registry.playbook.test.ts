// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the G3 playbook entries: their
// boundary mirrors, the shared-singleton MUST, the deny-all refusal, and the
// fail-close MUST across entries.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  PlaybookDispatchInputSchema,
  PlaybookQuarantineListInputSchema,
  PlaybookRegisterInputSchema,
  registry,
  setAnalyzeApprovalAuthority,
} from '../../../src/ops/analyze/registry.js';
import { dispatchEvidence, trustedAuthorityFor } from './registry.helpers.js';

// The authority binding is PROCESS-WIDE module state (the same reason the
// playbook registry and quarantine ledger are shared), so every test must
// hand it back. Without this, one test binding an authority would silently
// authorize writes in the next — the exact failure the deny-all default
// exists to prevent.
afterEach(() => {
  setAnalyzeApprovalAuthority(undefined);
});

describe('the G3 playbook entries (boundary mirrors + the shared-singleton MUST)', () => {
  test('all three importers resolve to ops (the lazy dynamic-import composition path)', async () => {
    for (const name of [
      'analyze.playbookRegister',
      'analyze.playbookDispatch',
      'analyze.playbookQuarantineList',
    ]) {
      const entry = registry.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`${name} missing from the registry`);
      expect(typeof entry.inputSchema).toBe('object');
      const op = await entry.importer();
      expect(typeof op).toBe('function');
    }
  });

  test('PlaybookDispatchInputSchema: timeoutMs defaults to 600_000 at this boundary; strict on the rest', () => {
    const valid = { playbookId: 'pb', dir: 'ws', targets: ['src/a.ts'] };
    expect(PlaybookDispatchInputSchema.parse(valid)).toEqual({ ...valid, timeoutMs: 600_000 });
    expect(PlaybookDispatchInputSchema.parse({ ...valid, timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
    expect(PlaybookDispatchInputSchema.safeParse({ ...valid, targets: [] }).success).toBe(false);
    expect(PlaybookDispatchInputSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(
      PlaybookDispatchInputSchema.safeParse({ playbookId: '', dir: 'ws', targets: ['src/a.ts'] })
        .success,
    ).toBe(false);
    expect(PlaybookQuarantineListInputSchema.safeParse({}).success).toBe(true);
    expect(PlaybookQuarantineListInputSchema.safeParse({ filter: 'x' }).success).toBe(false);
    // The register boundary carries the strict format schema: a playbook
    // asset with an unknown key is rejected BEFORE the op sees it.
    expect(
      PlaybookRegisterInputSchema.safeParse({
        playbook: {
          schemaVersion: 1,
          id: 'pb',
          description: 'd',
          rule: { language: 'ts' },
          verifier: { command: { command: 'x', args: [] } },
          smuggled: true,
        },
      }).success,
    ).toBe(false);
  });

  test('MUST (shared singletons): a playbook registered through the register entry is visible to a freshly-resolved dispatch entry — re-binding the importers to fresh instances would report an empty population', async () => {
    const registerEntry = registry.find(
      (candidate) => candidate.name === 'analyze.playbookRegister',
    );
    const dispatchEntry = registry.find(
      (candidate) => candidate.name === 'analyze.playbookDispatch',
    );
    if (registerEntry === undefined || dispatchEntry === undefined) {
      throw new Error('playbook entries missing from the registry');
    }
    const register = await registerEntry.importer();
    const registered = await register({
      playbook: {
        schemaVersion: 1,
        id: 'pb-shared-must',
        description: 'pins the shared-singleton MUST across entries',
        rule: { id: 'r', language: 'ts', rule: { pattern: 'zzz_never' } },
        verifier: { command: { command: 'verify-tool', args: [] } },
      },
    });
    expect(registered.status).toBe('ok');
    // A SECOND importer resolution must compose its op over the SAME
    // singletons; an unknown-id dispatch through the fresh op names the
    // population its OWN registry instance sees — 'pb-shared-must' must be
    // in it (registered through the OTHER entry), never '(none)'.
    const dispatch = await dispatchEntry.importer();
    const ghost = (await dispatch({
      playbookId: 'definitely-not-registered',
      dir: '/ws',
      targets: ['src/a.ts'],
    })) as { status: string; error?: string };
    expect(ghost.status).toBe('failed');
    expect(ghost.error ?? '').toContain('registered: pb-shared-must');
    expect(ghost.error ?? '').not.toContain('(none)');
  });

  // The other half of the contract, and the reason the MUST above needs an
  // injected authority at all: with NO authority bound, the same registry
  // path authorizes NOTHING. A forged `approved: true` in the op input is not
  // a substitute, so this proves the refusal is the authority's doing.
  test.runIf(process.platform !== 'win32')(
    'deny-all: with no approval authority bound, the registry path refuses the write and quarantines nothing',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'pb-denyall-'));
      const shimDir = await mkdtemp(join(tmpdir(), 'pb-denyall-shim-'));
      const oldPath = process.env.PATH;
      try {
        await mkdir(join(fixture, 'src'), { recursive: true });
        await writeFile(join(fixture, 'src', 'a.ts'), 'export const x = 1;\n', 'utf8');
        await writeFile(
          join(shimDir, 'ast-grep'),
          '#!/usr/bin/env node\nprocess.stdout.write("[]");\n',
          { mode: 0o755 },
        );
        process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
        const playbook = {
          schemaVersion: 1,
          id: 'pb-deny-all',
          description: 'a forged approved:true must not authorize a write',
          rule: { id: 'r', language: 'ts', rule: { pattern: 'zzz_never' } },
          verifier: { command: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
        };
        const opOf = async (name: string) => {
          const entry = registry.find((candidate) => candidate.name === name);
          if (entry === undefined) throw new Error(`${name} missing`);
          return entry.importer();
        };
        // No setAnalyzeApprovalAuthority call: this is the shipped default.
        const register = await opOf('analyze.playbookRegister');
        await register({ playbook });
        const dispatch = await opOf('analyze.playbookDispatch');
        // The op input carries an explicit approval-shaped surface, and the
        // registry still refuses — the flag is a declared intent, never a
        // proof (ADR-0003).
        const refused = (await dispatch({
          playbookId: playbook.id,
          dir: fixture,
          targets: ['src/a.ts'],
          approved: true,
        } as unknown as { playbookId: string; dir: string; targets: string[] })) as {
          status: string;
          reason?: string;
        };
        expect(refused.status).toBe('needs-human');
        expect(refused.reason ?? '').toContain('DECLARED INTENT');
        // The verifier never ran (the refusal precedes the engine), so
        // nothing was quarantined and the workspace is untouched.
        const list = await opOf('analyze.playbookQuarantineList');
        const listed = (await list({})) as {
          status: string;
          value?: { records?: Array<{ playbookId: string }> };
        };
        expect(listed.status).toBe('ok');
        expect(listed.value?.records ?? []).toEqual([]);
        expect(await readFile(join(fixture, 'src', 'a.ts'), 'utf8')).toBe('export const x = 1;\n');
      } finally {
        process.env.PATH = oldPath;
        await rm(fixture, { recursive: true, force: true });
        await rm(shimDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // The codemod engine scans through the REAL subprocess runner, so this
  // registry-path flow needs an executable 'ast-grep' on PATH; a POSIX
  // shim (shebang script) provides a deterministic empty plan without the
  // real binary. Shebang execution is POSIX-only — the test is conditional
  // on that (the repo's supported test platforms).
  test.runIf(process.platform !== 'win32')(
    'MUST (fail-close across entries): a verifier failure dispatched through the registry path quarantines, a freshly-resolved dispatch entry refuses the re-dispatch, and the list entry sees the record',
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'pb-must-'));
      const shimDir = await mkdtemp(join(tmpdir(), 'pb-shim-'));
      const oldPath = process.env.PATH;
      try {
        await mkdir(join(fixture, 'src'), { recursive: true });
        await writeFile(join(fixture, 'src', 'a.ts'), 'export const x = 1;\n', 'utf8');
        await writeFile(
          shimDir + '/ast-grep',
          '#!/usr/bin/env node\nprocess.stdout.write("[]");\n',
          {
            mode: 0o755,
          },
        );
        process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
        const playbook = {
          schemaVersion: 1,
          id: 'pb-must-quarantine',
          description: 'pins the fail-close MUST through the registry path',
          rule: { id: 'r', language: 'ts', rule: { pattern: 'zzz_never' } },
          // The verifier fails FOR REAL (a real node subprocess).
          verifier: { command: { command: process.execPath, args: ['-e', 'process.exit(1)'] } },
        };
        const opOf = async (name: string) => {
          const entry = registry.find((candidate) => candidate.name === name);
          if (entry === undefined) throw new Error(`${name} missing`);
          return entry.importer();
        };
        // The registry authorizes this dispatch's write ONLY because a real
        // authority is bound here — never because the input says so. Binding
        // it is what makes the fail-close MUST below reachable at all.
        setAnalyzeApprovalAuthority(trustedAuthorityFor(fixture));
        const register = await opOf('analyze.playbookRegister');
        const registered = (await register({ playbook })) as {
          status: string;
          value?: { id?: string; total?: number };
        };
        expect(registered.status).toBe('ok');
        expect(registered.value?.id).toBe(playbook.id);
        expect(typeof registered.value?.total).toBe('number');
        // Dispatch #1 through a freshly-resolved dispatch entry: the empty
        // plan applies nothing, the verifier FAILS, the playbook quarantines.
        const dispatch = await opOf('analyze.playbookDispatch');
        const first = (await dispatch({
          playbookId: playbook.id,
          dir: fixture,
          targets: ['src/a.ts'],
        })) as { status: string; error?: string };
        // W4.3: an observed verifier failure is a FAILED dispatch, not an
        // `ok` carrying a bad outcome — the rollback restores the workspace
        // first, so there is no applied state left to report as success. The
        // MUST this test pins is unchanged and still exercised: the verifier
        // ran for real and its failure quarantined the playbook.
        expect(first.status).toBe('failed');
        const evidence = dispatchEvidence(first.error ?? '');
        expect(evidence.outcome).toBe('verifier-failed');
        expect(evidence.quarantined).toBe(true);
        // And the failed remediation was rolled back, so the workspace is
        // exactly as it started.
        expect(evidence.restore.stranded).toEqual([]);
        // The list entry — ANOTHER fresh resolution — sees the record (one
        // shared ledger).
        const list = await opOf('analyze.playbookQuarantineList');
        const listed = (await list({})) as {
          status: string;
          value?: { records?: Array<{ playbookId: string }> };
        };
        expect(listed.status).toBe('ok');
        expect(listed.value?.records?.map((record) => record.playbookId)).toContain(playbook.id);
        // Dispatch #2 through ANOTHER fresh resolution: refused before
        // anything runs — the quarantine fails-closes across entries.
        const dispatchAgain = await opOf('analyze.playbookDispatch');
        const second = (await dispatchAgain({
          playbookId: playbook.id,
          dir: fixture,
          targets: ['src/a.ts'],
        })) as { status: string; reason?: string };
        expect(second.status).toBe('needs-human');
        expect(second.reason ?? '').toContain('never re-dispatched automatically');
      } finally {
        process.env.PATH = oldPath;
        await rm(fixture, { recursive: true, force: true });
        await rm(shimDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
