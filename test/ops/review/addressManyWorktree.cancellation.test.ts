import { createHash } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  readFile,
  readlink,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import * as ownershipModule from '../../../src/ops/review/internal/addressCheckoutOwnership.js';

import { deferred, fixture, terminalInput, terminalReport } from './addressManyWorktree.helpers.js';

// Regression: a real sibling commit is allowed, but its source bytes are never restored.
test.each(['normal', 'bookkeeping-after-cancel', 'checkpoint-after-cancel', 'symlink-root'])(
  'cancelled edit accepts a verified sibling successor: %s',
  async (scenario) => {
    const bookkeeping = scenario === 'bookkeeping-after-cancel';
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'successor-cancel.json'));
    try {
      let successor = '';
      const result = await withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const input = terminalInput(f.repo);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
          const edited = deferred(),
            committed = deferred();
          await Promise.all([
            (async () => {
              await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
              edited.resolve();
              await committed.promise;
            })(),
            (async () => {
              await edited.promise;
              await writeFile(join(f.repo.root, 'src/sibling.ts'), 'VERIFIED SIBLING\n');
              f.repo.git('add', '--', 'src/sibling.ts');
              f.repo.git('commit', '-m', 'verified sibling');
              successor = f.repo.git('rev-parse', 'HEAD').trim();
              if (scenario === 'checkpoint-after-cancel') parent.abort();
              let root = f.repo.root;
              if (scenario === 'symlink-root') {
                root = join(f.root, 'checkpoint-alias');
                await symlink(f.repo.root, root);
              }
              expect(
                await ownershipModule.checkpointAddressTerminalWorker(binding, root, undefined, {
                  parent: input.parent,
                  tree: f.repo.git('rev-parse', `${successor}^{tree}`).trim(),
                }),
              ).toBe(successor);
              committed.resolve();
            })(),
          ]);
          if (bookkeeping) {
            await mkdir(join(f.repo.root, '.cq'), { recursive: true });
            const entries = new Map<string, string>();
            for (const name of ['findings.json', 'ledger.json']) {
              const path = join(f.repo.root, '.cq', name);
              await writeFile(path, '{}\n');
              entries.set(path, createHash('sha256').update('{}\n').digest('hex'));
            }
            parent.abort();
            await ownershipModule.addressTerminalBookkeeping(lease, f.repo.root, entries);
          }
          parent.abort();
          ownershipModule.deferAddressTerminalAttempt(binding, attempt);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      expect(result.status).toBe('needs-human');
      expect(report.failed).toHaveLength(1);
      expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(await readFile(join(f.repo.root, 'src/sibling.ts'), 'utf8')).toBe(
        'VERIFIED SIBLING\n',
      );
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(successor);
      // A successful cancellation releases admission rather than quarantining it.
      await withAddressOwnership(
        { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
        async () => {},
      );
    } finally {
      await f.repo.cleanup();
    }
  },
);
test('a cancelled attempt on a glob-named own file settles and restores literally', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'glob-own-cancel.json'));
  try {
    await f.repo.write('app/[slug]/page.tsx', 'export const page = 1;\n');
    f.repo.commitAll('track glob-named own file');
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, {
          ...terminalInput(f.repo),
          file: 'app/[slug]/page.tsx',
        });
        await writeFile(join(f.repo.root, 'app/[slug]/page.tsx'), 'CANCELLED OWN FILE\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:app/[slug]/page.tsx`)).toBe(
      'CANCELLED OWN FILE\n',
    );
    expect(await readFile(join(f.repo.root, 'app/[slug]/page.tsx'), 'utf8')).toBe(
      'export const page = 1;\n',
    );
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('cancelled settlement verifies a tracked symlink by its link target', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'symlink-cancel.json'));
  try {
    await symlink('src/a.ts', join(f.repo.root, 'link.ts'));
    f.repo.git('add', '--', 'link.ts');
    f.repo.commitAll('track a symlink');
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const restored = await lstat(join(f.repo.root, 'link.ts'));
    expect(restored.isSymbolicLink()).toBe(true);
    expect(await readlink(join(f.repo.root, 'link.ts'), 'utf8')).toBe('src/a.ts');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('cancelled settlement verifies a symlink checked out as a plain file', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'symlink-plain-cancel.json'));
  try {
    // The core.symlinks=false checkout shape: the index carries a 120000
    // entry whose worktree representation is an ordinary file holding the
    // link-target text. Staged with cacheinfo so `add -A` cannot re-type it.
    await f.repo.write('link.ts', 'src/a.ts');
    const sha = f.repo.git('hash-object', '-w', 'link.ts').trim();
    f.repo.git('update-index', '--add', '--cacheinfo', `120000,${sha},link.ts`);
    f.repo.git('commit', '-q', '-m', 'track a symlink without checkout support');
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(f.repo.root, 'link.ts'), 'utf8')).toBe('src/a.ts');
    expect((await lstat(join(f.repo.root, 'link.ts'))).isSymbolicLink()).toBe(false);
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('cancelled settlement skips a submodule pointer without losing the report', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'gitlink-cancel.json'));
  try {
    f.repo.git('init', '-q', 'sub');
    await f.repo.write('sub/inner.txt', 'inner\n');
    f.repo.git('-C', 'sub', 'add', '-A');
    f.repo.git('-C', 'sub', 'commit', '-q', '-m', 'inner');
    f.repo.commitAll('add a gitlink');
    expect(f.repo.git('ls-files', '-s', 'sub').trim()).toMatch(/^160000 /);
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(f.repo.root, 'sub/inner.txt'), 'utf8')).toBe('inner\n');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('cancelled settlement accepts a hard-linked foreign file', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'hardlink-cancel.json'));
  try {
    await f.repo.write('src/twin.ts', 'export const twin = 3;\n');
    await f.repo.write('src/twin2.ts', 'export const twin = 3;\n');
    f.repo.commitAll('track twin copies');
    await unlink(join(f.repo.root, 'src/twin2.ts'));
    await link(join(f.repo.root, 'src/twin.ts'), join(f.repo.root, 'src/twin2.ts'));
    expect((await lstat(join(f.repo.root, 'src/twin2.ts'))).nlink).toBe(2);
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED OWN FILE\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED OWN FILE\n');
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test.each(['direct', 'aliased-parent'])(
  'cancellation adopts the ordinary report through %s and removes an owned candidate',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const alias = join(f.root, 'report-alias');
    if (mode === 'aliased-parent') await symlink(f.root, alias, 'dir');
    const report = terminalReport(join(mode === 'direct' ? f.root : alias, 'ordinary-cancel.json'));
    const candidate = join(f.root, 'owned-candidate');
    try {
      const result = await withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          f.repo.git('worktree', 'add', '--detach', candidate, 'HEAD');
          await ownershipModule.addressTerminalCandidate(binding, f.repo.root, candidate, false);
          const bytes = JSON.stringify(report);
          // The abort lands before the ordinary write promise returns to finish().
          await writeFile(report.reportPath, bytes).then(() => parent.abort());
          await ownershipModule.addressOrdinaryReport(lease, report.reportPath, bytes);
          ownershipModule.deferAddressTerminalAttempt(binding, attempt);
          await ownershipModule.addressTerminalCandidate(binding, f.repo.root, candidate, true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      expect(result.status).toBe('needs-human');
      expect(
        (JSON.parse(await readFile(report.reportPath, 'utf8')) as ReviewAddressReport).reasons,
      ).toContain('parent cancelled');
      await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain(candidate);
    } finally {
      await f.repo.cleanup();
    }
  },
);
test('a failing sibling restore may rewrite index stats before cancellation', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'restore-sibling-cancel.json'));
  try {
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        const index = join(f.repo.root, '.git', 'index');
        const originalIndex = createHash('sha256')
          .update(await readFile(index))
          .digest('hex');
        await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED A\n');
        await writeFile(join(f.repo.root, 'src/sibling.ts'), 'FAILED B\n');
        f.repo.git('restore', `--source=${head}`, '--staged', '--worktree', '--', 'src/sibling.ts');
        expect(
          createHash('sha256')
            .update(await readFile(index))
            .digest('hex'),
        ).not.toBe(originalIndex);
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe('CANCELLED A\n');
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(f.repo.root, 'src/sibling.ts'), 'utf8')).toBe(
      'export const sibling = 2;\n',
    );
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(f.repo.git('diff', '--cached', '--name-only')).toBe('');
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async () => {},
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('ordinary reports larger than the cancellation copy cap still succeed', async () => {
  const f = await fixture();
  const path = join(f.root, 'large-ordinary-report.json');
  try {
    const bytes = JSON.stringify({ reason: 'x'.repeat(16 * 1024 * 1024 + 1) });
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async (lease) => {
        await writeFile(path, bytes);
        await ownershipModule.addressOrdinaryReport(lease, path, bytes);
      },
    );
    expect((await lstat(path)).size).toBe(Buffer.byteLength(bytes));
  } finally {
    await f.repo.cleanup();
  }
});
