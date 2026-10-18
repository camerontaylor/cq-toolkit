import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureSnapshot, snapshotHead } from '../../../src/ops/dev/internal/snapshot.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { DevReviewInputSchema } from '../../../src/ops/dev/registry.js';

const exec = promisify(execFile);

describe('tree snapshot worker and real Python admission', () => {
  it('captures immutable trees, leaves HEAD/index/files alone and plans at the same SHA', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cq-tree-wire-'));
    try {
      const worker = join(root, 'worker');
      const server = join(root, 'server');
      const state = join(root, 'state');
      const git = async (cwd: string, ...args: string[]) =>
        (await exec('git', args, { cwd })).stdout.trim();
      await exec('git', ['init', '-q', '--template=', worker]);
      await git(worker, 'config', 'user.name', 'Fixture');
      await git(worker, 'config', 'user.email', 'fixture@example.invalid');
      await writeFile(join(worker, 'file.txt'), 'baseline\n');
      await git(worker, 'add', 'file.txt');
      await git(worker, 'commit', '-qm', 'base');
      const base = await git(worker, 'rev-parse', 'HEAD');
      await exec('git', ['clone', '-q', '--no-hardlinks', worker, server]);
      await writeFile(join(worker, 'file.txt'), 'staged change\n');
      await git(worker, 'add', 'file.txt');
      const tree = await git(worker, 'write-tree');
      await writeFile(join(worker, 'file.txt'), 'unstaged content stays here\n');
      const indexBefore = await readFile(join(worker, '.git/index'));
      const fileBefore = await readFile(join(worker, 'file.txt'));
      const scanner = join(root, 'scan');
      await writeFile(
        scanner,
        '#!/bin/sh\n[ "$#" = 3 ] || exit 1\n[ "$GIT_NO_REPLACE_OBJECTS" = 1 ] || exit 1\ngit -C "$1" cat-file -e "$3^{commit}"\n',
        { mode: 0o700 },
      );
      const captured = await captureSnapshot(worker, base, tree, scanner);
      expect(captured.head).toBe(snapshotHead(base, tree));
      expect((await captureSnapshot(worker, base, tree, scanner)).snapshot).toEqual(
        captured.snapshot,
      );
      expect(await readFile(join(worker, '.git/index'))).toEqual(indexBefore);
      expect(await readFile(join(worker, 'file.txt'))).toEqual(fileBefore);
      expect(await git(worker, 'rev-parse', 'HEAD')).toBe(base);
      await exec('mkdir', [state]);
      await writeFile(join(state, 'queue.json'), JSON.stringify({ items: [], starts: [] }));
      await writeFile(
        join(state, 'policy.json'),
        JSON.stringify({ review: { reviewerTimeoutMin: 25 } }),
      );
      const op = makeDevReview(
        async (request) => {
          const result = await new Promise<string>((resolve, reject) => {
            const child = execFile(
              'python3',
              [
                '-B',
                '-c',
                'from test_author_snapshot import wire_fixture_main; wire_fixture_main()',
                server,
                state,
              ],
              {
                cwd: fileURLToPath(new URL('../../../apps/crq-python/', import.meta.url)),
                timeout: 30_000,
                maxBuffer: 8192,
              },
              (error, stdout) => (error ? reject(error) : resolve(stdout)),
            );
            child.stdin?.end(request);
          });
          return result;
        },
        async () => captured,
      );
      const input = {
        action: 'enroll' as const,
        requestId: 'tree-wire',
        base,
        tree,
        target: 'origin/merge-queue',
        cycle: 1,
      };
      const result = await op(input);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.binding.head).toBe(captured.head);
        expect(result.value.issuer).toBe('waiting');
        expect(result.value.dispatch).toBe(false);
      }
      expect(await git(server, 'rev-parse', 'refs/crq/author-snapshots/v1/' + captured.head)).toBe(
        captured.head,
      );
      expect(await git(server, 'show', captured.head + ':file.txt')).toBe('staged change');
      const persisted = JSON.parse(await readFile(join(state, 'queue.json'), 'utf8')) as {
        starts: unknown;
      };
      expect(persisted.starts).toEqual([]);
      expect(DevReviewInputSchema.safeParse({ ...input, head: captured.head }).success).toBe(false);
      expect(DevReviewInputSchema.safeParse({ ...input, tree: undefined }).success).toBe(false);
      // Status/fallback derive the same commit without scanning or retransmitting objects.
      let sent = '';
      await makeDevReview(
        async (request) => {
          sent = request;
          throw new Error('offline');
        },
        async () => {
          throw new Error('status must not capture');
        },
      )({ ...input, action: 'status' });
      expect(JSON.parse(sent)).toEqual({
        v: 1,
        op: 'status',
        binding: {
          request_id: input.requestId,
          base,
          head: captured.head,
          target: input.target,
          cycle: 1,
        },
      });
      await expect(captureSnapshot(worker, base, tree)).rejects.toThrow('scanner');
      await writeFile(scanner, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      await expect(captureSnapshot(worker, base, tree, scanner)).rejects.toThrow('scan refused');
      let sentAfterRefusal = false;
      expect(
        (
          await makeDevReview(
            async () => {
              sentAfterRefusal = true;
              return '';
            },
            () => captureSnapshot(worker, base, tree, scanner),
          )(input)
        ).status,
      ).toBe('failed');
      expect(sentAfterRefusal).toBe(false);
      // A scanner that backgrounds a child must not leave it running after the deadline.
      const marker = join(root, 'late-marker');
      await writeFile(scanner, `#!/bin/sh\n(sleep 2; touch "${marker}") &\nwait\n`, {
        mode: 0o700,
      });
      await expect(captureSnapshot(worker, base, tree, scanner, 300)).rejects.toThrow(
        'scan refused',
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await expect(readFile(marker)).rejects.toThrow();
      // An absolute but missing scanner is operator configuration, not an unknown admission.
      const missing = await makeDevReview(
        async () => {
          sentAfterRefusal = true;
          return '';
        },
        () => captureSnapshot(worker, base, tree, join(root, 'no-such-scanner')),
      )(input);
      expect(missing.status).toBe('needs-human');
      expect(sentAfterRefusal).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('asks the operator to configure the scanner instead of reporting an unknown admission', async () => {
    let sent = false;
    const op = makeDevReview(
      async () => {
        sent = true;
        return '';
      },
      (base, tree) => captureSnapshot('/nonexistent-repo', base, tree, undefined),
    );
    const result = await op({
      action: 'enroll',
      requestId: 'scanner-unset',
      base: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      target: 'merge-queue',
      cycle: 1,
    });
    expect(result.status).toBe('needs-human');
    expect('reason' in result ? result.reason : '').toContain('CQ_AUTHOR_SNAPSHOT_SCANNER');
    expect(sent).toBe(false);
  });
});
