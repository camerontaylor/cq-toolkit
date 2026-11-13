import { mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { describe, expect, test } from 'vitest';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address candidate isolation', () => {
  test.each(['unused', 'unsafe'] as const)(
    'an %s worker leaves no asynchronous lock setup beyond its lifetime',
    async (mode) => {
      const f = await fixture();
      try {
        if (mode !== 'unused') {
          const item = finding(mode === 'unsafe' ? '../outside.ts' : undefined);
          const fix = await f.engine.fix(item, 1);
          expect(fix.finding.status).toBe('deferred');
          expect(fix.commit).toBeUndefined();
        }
        // Let constructor-started I/O settle before the fixture is disposed.
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(f.identityRequests()).toBe(mode === 'unused' ? 0 : 1);
        expect(f.calls()).toBe(0);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('an unanchored deferral reads a verified head through the mutation lock', async () => {
    // T19: the unanchored deferral is a durable disposition, so before it
    // returns it must read the observation head exactly the way the dispatch
    // loop does — through withMutation, accepted only from verifiedHeads. A
    // direct call with no prior admission (the local dispatch path, which
    // calls fix without withVerifiedHead) takes the same memoized initialize
    // admission and defers with the verified head instead of refusing; the
    // composition-level outcome is covered by address-local.full-cycle. The
    // The surrounding checkout lifetime verifies identity once at admission;
    // the worker FIFO does not create an independent cross-process mutex.
    const f = await fixture();
    try {
      const item = finding();
      delete item.file;
      const fix = await f.engine.fix(item, 1);
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toBe('unanchored finding needs human scope');
      expect(fix.failure).toBeUndefined();
      expect(fix.observedHead).toBe(f.initial);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(f.identityRequests()).toBe(1);
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  });
  test('unavailable checkout identity refuses every mutation and worker dispatch', async () => {
    const f = await fixture(undefined, '', { indexIdentityUnavailable: true });
    try {
      await expect(
        Promise.all([f.engine.fix(finding(), 1), f.engine.fix(finding('src/b.ts'), 1)]),
      ).rejects.toThrow('checkout ownership Git identity unavailable');
      expect(f.identityRequests()).toBe(1);
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('status', '--porcelain')).toBe('');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['tracked', 'untracked'] as const)(
    'pre-existing %s edits are never adopted as worker output or erased',
    async (mode) => {
      const f = await fixture();
      const path = mode === 'tracked' ? 'src/a.ts' : 'src/owner.ts';
      try {
        await f.repo.write(path, 'OWNER CONTENT\n');
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(/clean tracked worker tree|no unknown worker files/);
        expect(f.calls()).toBe(0);
        expect(f.attempts).toEqual([]);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        expect(await readFile(join(f.repo.root, path), 'utf8')).toBe('OWNER CONTENT\n');
      } finally {
        await f.cleanup();
      }
    },
  );

  test.each(['positive', 'missing', 'fault'] as const)(
    'a %s tool-result scan refuses provider send and preserves sibling eligibility',
    async (mode) => {
      let providerSends = 0;
      let blocked = false;
      const f = await fixture(
        async (input) => {
          providerSends++;
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'verified sibling' };
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/b.ts'), 'GOOD\n');
          return { disposition: 'fixed', reason: 'sibling fixed', evidence: [] };
        },
        '',
        {
          providerRequest: true,
          scanner: async (components) => {
            const tool = components.find((c) => c.text === 'synthetic tool output');
            if (tool && !blocked) {
              blocked = true;
              if (mode === 'fault') throw new Error('tool scanner unavailable');
              if (mode === 'missing') return [];
              return components.map((c) => ({
                component: c.component,
                hits: c === tool ? [{ ruleId: 'synthetic-policy', lines: [1] }] : [],
              }));
            }
            return components.map((c) => ({ component: c.component, hits: [] }));
          },
        },
      );
      try {
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(/upload refused|upload scanner failed/);
        expect(providerSends).toBe(0);
        expect(f.attempts).toHaveLength(1);
        expect(refused.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
        expect(providerSends).toBe(3);
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    'missing-evidence',
    'missing-line',
    'edited-disposition',
    'missing-reviewer',
  ] as const)('a rejection cannot close without engine-verifiable evidence: %s', async (mode) => {
    const f = await fixture(
      async (input) => {
        if (mode === 'edited-disposition')
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        return {
          disposition: 'rejected',
          reason: 'model asserts false positive',
          evidence:
            mode === 'missing-evidence'
              ? []
              : [{ path: 'src/a.ts', line: mode === 'missing-line' ? 1000 : 1 }],
        };
      },
      '',
      {
        configure: (config) => {
          if (mode === 'missing-reviewer') delete config.roles!.reviewer;
        },
      },
    );
    try {
      const refused = await f.engine.fix(finding(), 1);
      expect(refused.finding.status).toBe('deferred');
      expect(refused.reason).toMatch(
        /execution-head evidence|missing at execution head|accompanied by edits|roles.reviewer required/,
      );
      expect(f.calls()).toBe(mode === 'missing-reviewer' ? 0 : 1);
      expect(refused.commit).toBeUndefined();
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['reviewer', 'check-cwd', 'check-spawn'] as const)(
    'a changed candidate cannot commit with unavailable trusted validation: %s',
    async (mode) => {
      const f = await fixture(undefined, '', {
        configure: (config) => {
          if (mode === 'reviewer') delete config.roles!.reviewer;
          if (mode === 'check-cwd') config.checks[0]!.command.cwd = '..';
          if (mode === 'check-spawn')
            config.checks[0]!.command.command = join(tmpdir(), 'cq-missing-executable', 'check');
        },
      });
      try {
        const refused = await f.engine.fix(finding(), 1);
        expect(refused.finding.status).toBe('deferred');
        expect(refused.reason).toMatch(
          /roles.reviewer required|check.cwd escapes|configured check was/,
        );
        expect(f.calls()).toBe(0);
        expect(refused.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        expect(f.attempts).toEqual([]);
      } finally {
        await f.cleanup();
      }
    },
  );

  test('literal magic filename failure preserves an active sibling edit and captures only its own leaf', async () => {
    const file = ':(exclude)never.ts';
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (input) => {
      if (input.prompt.includes('"file":"src/b.ts"')) {
        await writeFile(join(input.workspace!.path, 'src/b.ts'), 'SIBLING\n');
        entered();
        await held;
        return { disposition: 'deferred', reason: 'held sibling', evidence: [] };
      }
      await writeFile(join(input.workspace!.path, file), 'OWN PARTIAL\n');
      throw new Error('owned failure');
    });
    let sibling: ReturnType<typeof f.engine.fix> | undefined;
    try {
      await f.repo.write(file, 'OWN PARENT\n');
      f.repo.commitAll('literal magic filename');
      sibling = f.engine.fix(finding('src/b.ts'), 1);
      await ready;
      const result = await f.engine.fix(finding(file), 1);
      expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('SIBLING\n');
      expect(await readFile(join(f.repo.root, file), 'utf8')).toBe('OWN PARENT\n');
      const failed = result.failedAttempts![0]!;
      expect(f.repo.git('show', `${failed.sha}:${file}`)).toBe('OWN PARTIAL\n');
      expect(
        f.repo.git('--literal-pathspecs', 'diff', '--name-only', failed.parent, failed.sha),
      ).toBe(`${file}\n`);
    } finally {
      release();
      await sibling;
      await f.cleanup();
    }
  });

  test('ten identical baseline failures run the check once without semantic attempts', async () => {
    const external = await realTmpDir('cq-baseline-refusal-');
    const count = join(external, 'count');
    const f = await fixture(
      undefined,
      `const fs = require('node:fs'); const p = ${JSON.stringify(count)};
fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 0) + 1));
console.error('deterministic baseline unavailable'); process.exitCode = 1;`,
      { workerAttempts: 10, rescueBase: 10 },
    );
    try {
      for (let i = 0; i < 10; i++) {
        const result = await f.engine.fix({ ...finding(), id: `finding-${i}` }, 1);
        expect(result.reason).toMatch(/baseline precondition failed: configured check was/);
        expect(result.finding.status).toBe('deferred');
        expect(result.commit).toBeUndefined();
      }
      expect(await readFile(count, 'utf8')).toBe('1');
      expect(f.calls()).toBe(0);
      expect(f.attempts).toEqual([]);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
      await rm(external, { recursive: true, force: true });
    }
  });
  test('baseline worktree setup failure stops the leg once before model dispatch', async () => {
    let adds = 0;
    const f = await fixture(undefined, '', {
      gitHook: (args, run) => {
        if (
          args.includes('worktree') &&
          args.includes('add') &&
          args.some((a) => a.includes('baseline-'))
        ) {
          adds++;
          return Promise.resolve({ code: 1, stdout: '', stderr: 'baseline setup unavailable' });
        }
        return run(args);
      },
    });
    try {
      for (let i = 0; i < 10; i++) {
        const result = await f.engine.fix({ ...finding(), id: `finding-${i}` }, 1);
        expect(result.reason).toContain('baseline setup unavailable');
      }
      expect(adds).toBe(1);
      expect(f.calls()).toBe(0);
      expect(f.engine.preconditionFailure?.()).toContain('baseline setup unavailable');
    } finally {
      await f.cleanup();
    }
  });

  test.each([false, true])(
    'canonical and aliased roots preserve task identity (alias=%s)',
    async (aliasRoot) => {
      const f = await fixture(undefined, '', { aliasRoot });
      try {
        const result = await f.engine.fix(finding('src/./a.ts'), 1);
        expect(result.commit, result.reason).toBeTruthy();
        expect(result.finding.file).toBe('src/a.ts');
        expect(f.calls()).toBe(3);
        expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      } finally {
        await f.cleanup();
      }
    },
  );
  test('outside symlink and missing files refuse before worker dispatch even through an aliased root', async () => {
    const f = await fixture(undefined, '', { aliasRoot: true });
    const outside = await realTmpDir('cq-address-outside-');
    try {
      await writeFile(join(outside, 'private.ts'), 'PRIVATE\n');
      await symlink(join(outside, 'private.ts'), join(f.repo.root, 'src/outside.ts'));
      for (const file of ['src/outside.ts', 'src/missing.ts']) {
        const result = await f.engine.fix(finding(file), 1);
        expect(result.commit).toBeUndefined();
        expect(result.finding.status).toBe('deferred');
      }
      expect(f.calls()).toBe(0);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(outside, 'private.ts'), 'utf8')).toBe('PRIVATE\n');
    } finally {
      await f.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('commits only a staged candidate that passed mandatory feedback, broader and closure gates', async () => {
    const f = await fixture();
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status, fix.reason).toBe('fixed');
      expect(fix.observedHead).toBe(f.initial);
      expect(fix.commit).toBe(f.repo.git('rev-parse', 'HEAD').trim());
      expect(f.repo.git('show', '--format=', '--name-only', 'HEAD').trim()).toBe('src/a.ts');
      expect(f.attempts.map((a) => a.invocation)).toEqual(['edit', 'feedback', 'closure']);
      expect(fix.validation[0]?.gates.map((g) => g.gate)).toEqual([
        'related',
        'broader',
        'paths',
        'tamper',
        'commit',
      ]);
      expect(f.repo.git('status', '--porcelain').trim()).toBe('');
    } finally {
      await f.cleanup();
    }
  });
  test('a provider exception after editing preserves evidence and restores the owned file', async () => {
    const f = await fixture(async (input) => {
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
      throw new Error('provider failed');
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toContain('provider failed');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
      expect(f.attempts[0]?.failedAttempt?.branch).toMatch(
        /^cq-address\/[^/]+\/failed\/review-[0-9a-f]{16}\/fixture-[0-9a-f]{16}\/src-a-ts-[0-9a-f]{16}\/a[1-9][0-9]*$/,
      );
      expect(f.repo.git('show', `${f.attempts[0]!.failedAttempt?.sha}:src/a.ts`)).toContain(
        'PARTIAL',
      );
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
    } finally {
      await f.cleanup();
    }
  });
  test('scanner faults and parent cancellation dispatch no worker', async () => {
    for (const cancelled of [false, true]) {
      const controller = new AbortController();
      if (cancelled) controller.abort();
      const f = await fixture(undefined, '', {
        scannerFails: !cancelled,
        parentSignal: controller.signal,
      });
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe('deferred');
        expect(f.calls()).toBe(0);
        expect(fix.reason).toMatch(/scanner unavailable|parent cancelled/);
      } finally {
        await f.cleanup();
      }
    }
  });
  test('protected scope refuses before dispatch or configured check execution', async () => {
    const f = await fixture();
    try {
      // The protected path must EXIST and be committed: a nonexistent one
      // fails safeFile first, and the unit never reaches the stage-path
      // policy (the pre-fix shape of this test never exercised :classify).
      await f.repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
      f.repo.commitAll('lockfile');
      const protectedHead = f.repo.git('rev-parse', 'HEAD').trim();
      const fix = await f.engine.fix(finding('pnpm-lock.yaml'), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(f.calls()).toBe(0);
      // T19 classification rule: the protected-scope refusal is decided from
      // the finding's own path and policy before any attempt, so it is a
      // deliberate deferral — no `failure` discriminator — and it carries the
      // verified head initialize() admitted.
      expect(fix.failure).toBeUndefined();
      expect(fix.observedHead).toBe(protectedHead);
    } finally {
      await f.cleanup();
    }
  });
  // #1194 follow-up: invoke() builds the edit allowlist from the finding
  // path, so `*` and `?` — the two characters compilePathPatterns treats as
  // wildcards — must refuse before any dispatch; brackets stay literal.
  test.each(['src/a?.ts', 'src/a*.ts'] as const)(
    'a finding with an edit-allowlist wildcard refuses before dispatch: %s',
    async (file) => {
      const f = await fixture();
      try {
        const fix = await f.engine.fix(finding(file), 1);
        expect(fix.finding.status).toBe('deferred');
        expect(fix.reason).toContain('edit-allowlist wildcards');
        expect(f.calls()).toBe(0);
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('a finding on a bracketed name dispatches and fixes like an ordinary file', async () => {
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      await mkdir(join(input.workspace!.path, 'pages'), { recursive: true });
      await writeFile(join(input.workspace!.path, 'pages/[id].tsx'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'fixed', evidence: [] };
    });
    try {
      await f.repo.write('pages/[id].tsx', 'BAD\n');
      f.repo.commitAll('bracketed finding fixture');
      const fix = await f.engine.fix(finding('pages/[id].tsx'), 1);
      // Dispatch reached the worker: safeFile admitted the bracketed name
      // (refusals above show 0 calls; a full fix runs edit, closure and any
      // reviewer round through this driver).
      expect(f.calls()).toBeGreaterThan(0);
      expect(fix.finding.status, fix.reason).toBe('fixed');
      expect(fix.commit).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });
  test('out-of-scope edits refuse and cannot be absorbed into a commit', async () => {
    const f = await fixture(async (input) => {
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      await writeFile(join(input.workspace!.path, 'src/b.ts'), 'ALIEN\n');
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status).toBe('deferred');
      expect(fix.reason).toContain('out-of-scope');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('diff', '--cached', '--name-only').trim()).toBe('');
    } finally {
      await f.cleanup();
    }
  });

  test('a candidate reviewer mutation refuses the commit and retains the worker evidence', async () => {
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1') {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'TAMPER\n');
        return { closed: true, reason: 'claim despite mutation' };
      }
      if (!input.prompt.startsWith('related-check feedback'))
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    });
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.commit).toBeUndefined();
      expect(fix.reason).toContain('mutated');
      const calls = f.calls();
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.reason).toContain('mutated');
      expect(sibling.commit).toBeUndefined();
      expect(f.calls()).toBe(calls);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each([true, false])(
    'unchanged rejection requires reviewer confirmation: %s',
    async (closed) => {
      const f = await fixture(async (input) =>
        input.outputSchema?.name === 'review.address.closure/v1'
          ? { closed, reason: 'execution-head review' }
          : {
              disposition: 'rejected',
              reason: 'false positive',
              evidence: [{ path: 'src/a.ts', line: 1 }],
            },
      );
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe(closed ? 'rejected' : 'deferred');
        expect(fix.commit).toBeUndefined();
        expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      } finally {
        await f.cleanup();
      }
    },
  );
  test('cancellation after worker editing restores evidence and starts no checks or feedback', async () => {
    const parent = new AbortController();
    const f = await fixture(
      async (input) => {
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
        parent.abort();
        return { disposition: 'fixed', reason: 'late', evidence: [] };
      },
      '',
      { parentSignal: parent.signal },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.reason).toContain('cancelled');
      expect(f.calls()).toBe(1);
      const sibling = await f.engine.fix(finding('src/b.ts'), 1);
      expect(sibling.reason).toContain('cancelled');
      expect(f.calls()).toBe(1);
      expect(fix.validation).toEqual([]);
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.attempts[0]?.failedAttempt?.branch).toBeTruthy();
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
    } finally {
      await f.cleanup();
    }
  });
});
