// S2b-i fake-transport end-to-end (plan §S2b-i): the REAL managed seam
// (submit → wait → fetch) over a scripted review-v1 server on a REAL git
// repo — no direct CLI launch anywhere on this route.
//
// submit → complete → receipt read → no second start:
//  1. submit CREATES the queue item (action=created, deterministic
//     requestId hashes the resolved inputs), the fake server starts one review;
//  2. completion arrives through status polling; the result fetch verifies
//     chunk digests, persists receipt.json, and the seam maps the receipt
//     outcome/findings (completed + findings, findings verbatim);
//  3. a second submit with the same pins REJOINS (action=joined): the fake
//     server starts NO second review, and both submits resolve completed
//     with the same receipt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeSubmit } from '../../../src/ops/review/submit.js';
import { captureWorkingTree } from '../../../src/ops/dev/internal/snapshot.js';
import { makeManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import {
  canonicalReview,
  reviewDigest,
  ReceiptSchema,
} from '../../../src/ops/review/internal/reviewOperation.js';
import { makeTestRepo, type TestRepo } from './repo.js';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const caps = {
  v: 1,
  command: 'review-v1',
  operations: ['capabilities', 'submit', 'status', 'result', 'cancel'],
  features: ['original-commit-snapshot-v1', 'chunked-result-v1', 'repeat-generations-v1'],
  limits: {
    max_request_bytes: 6291456,
    max_snapshot_bytes: 5242880,
    max_content_bytes: 3145728,
    max_objects: 4096,
    chunk_bytes: 3072,
  },
};

test.each(['committed', 'full', 'uncommitted'] as const)(
  'S2b-i e2e: %s submit completes, rejoins, and checks real PR association',
  async (scope) => {
    const root = repo.root;
    if (scope === 'full') repo.git('commit', '--allow-empty', '-qm', 'outgoing-metadata-marker');
    const actualHead = repo.git('rev-parse', 'HEAD').trim();
    if (scope === 'uncommitted') repo.git('push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
    const working = scope === 'committed' ? undefined : scope;
    if (working) {
      await repo.write('src/staged.ts', 'export const staged = 1;\n');
      repo.git('add', 'src/staged.ts');
      await repo.write('README.md', '# final disk\n');
      await repo.write('untracked.txt', 'untracked body\n');
    }
    const base =
      scope === 'uncommitted' ? actualHead : repo.git('rev-parse', 'origin/merge-queue').trim();
    const captured = working ? await captureWorkingTree(root, actualHead) : undefined;
    const head = captured?.head ?? actualHead;
    const baseTree = repo.git('rev-parse', `${base}^{tree}`).trim();
    const headTree = repo.git('rev-parse', `${head}^{tree}`).trim();
    const projection = working ? `working-tree-${working}-v1` : 'full-diff';
    const requestId = `dev-${createHash('sha256')
      .update(
        JSON.stringify(
          working
            ? ['owner/repo', 'merge-queue', base, head, projection]
            : ['owner/repo', 'merge-queue', base, head],
        ),
      )
      .digest('hex')}`;

    // The fake review-v1 server: one review per request id. Submit CREATES on
    // first sight and JOINS after; status reports running until the review is
    // marked done; result serves the receipt in 3072-byte chunks.
    let reviewsStarted = 0;
    let done = false;
    const receipt = ReceiptSchema.parse({
      v: 1,
      kind: 'local-review-full-diff',
      identity: '0'.repeat(64),
      identity_inputs: {
        v: 1,
        repo: 'owner/repo',
        base_commit: base,
        base_tree: baseTree,
        head_commit: head,
        head_tree: headTree,
        scope: 'full-diff',
        projection,
        config_digest: '0'.repeat(64),
        profile: { adapter: 'coderabbit-cli', revision: 'fake' },
      },
      profile: { adapter: 'coderabbit-cli', revision: 'fake', flags: [] },
      run_id: 'fake-run-1',
      outcome: 'findings',
      scope_adequate: true,
      findings: [
        {
          type: 'finding',
          severity: 'major',
          fileName: 'src/a.ts',
          comment: 'fake finding',
          startLine: 1,
          rule: 'fake-rule',
        },
      ],
      report: '# fake report\n',
      observed: {},
      independent_acceptance: false,
    });
    receipt.identity = reviewDigest(receipt.identity_inputs);
    const bytes = Buffer.from(canonicalReview(receipt));
    // chunk.sha256 === chunk.receipt_id is a result-op integrity rule, so
    // the fake server carries the BYTES digest in both wire fields; the seam
    // binds findings to that transport receipt id, which also names the
    // persisted receipt file.
    const receiptId = sha256(bytes);
    const chunks = Math.max(1, Math.ceil(bytes.length / 3072));
    const submitWires: unknown[] = [];
    const seen = new Set<string>();
    let capabilityCalls = 0;
    const transport = async (raw: string): Promise<string> => {
      const wire = JSON.parse(raw) as { op: string; request_id?: string; index?: number };
      if (wire.op === 'capabilities') {
        capabilityCalls++;
        return JSON.stringify(caps);
      }
      if (wire.op === 'submit') {
        submitWires.push(wire);
        if (!seen.has(wire.request_id!)) {
          seen.add(wire.request_id!);
          reviewsStarted += 1;
          return JSON.stringify({
            v: 1,
            action: 'created',
            notify: { state: 'error', reason: 'unsupported-destination' },
            state: 'queued',
            request_id: wire.request_id,
          });
        }
        // A rejoin of the same request: no second review starts.
        return JSON.stringify({
          v: 1,
          action: 'joined',
          state: done ? 'completed' : 'running',
          request_id: wire.request_id,
        });
      }
      if (wire.op === 'status')
        return JSON.stringify({
          v: 1,
          action: 'observed',
          state: done ? 'completed' : 'running',
          request_id: wire.request_id,
        });
      if (wire.op === 'result') {
        if (!done) return JSON.stringify({ v: 1, action: 'observed', state: 'running' });
        const index = wire.index ?? 0;
        const data = bytes.subarray(index * 3072, (index + 1) * 3072);
        return JSON.stringify({
          v: 1,
          receipt_id: receiptId,
          index,
          chunks,
          bytes: bytes.length,
          sha256: receiptId,
          encoding: 'base64-utf8-json',
          data: data.toString('base64'),
          chunk_sha256: sha256(data),
          next_index: index + 1 === chunks ? null : index + 1,
        });
      }
      throw new Error(`unexpected op ${wire.op}`);
    };

    const submit = makeManagedReviewSubmit(
      () => transport,
      async () => 'owner/repo',
    );

    // The D11 wait polls every ~15 s; complete the review as soon as the first
    // status poll lands so the test never sleeps the real interval.
    const completing = (async () => {
      for (let i = 0; i < 200 && !done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (submitWires.length > 0) done = true;
      }
    })();

    const first = await submit({
      cwd: root,
      target: 'merge-queue',
      base,
      head: actualHead,
      ...(working ? { workingTree: working, scanner: '/bin/true' } : {}),
      remainingWallMs: () => 60_000,
      // Caller-attested: this fake server resolves the commits by
      // construction (same repo), so no snapshot proof is needed. Absent
      // any attestation the seam forwards nothing and the submit leg
      // takes its honest snapshot default.
      reachable: true,
    });
    await completing;
    expect(first).toMatchObject({
      status: 'completed',
      value: {
        // value.receiptId is the transport receipt id (the bytes digest the
        // result op verified); the findings' evidence binding is the receipt
        // document's own identity field, pinned for provenance.
        receiptId,
        completion: { kind: 'terminal' },
        findings: [
          {
            severity: 'major',
            fileName: 'src/a.ts',
            excerpt: 'fake finding',
            line: 1,
            rule: 'fake-rule',
            evidence: receipt.identity,
          },
        ],
      },
    });
    expect(first).toMatchObject({
      value: { advisories: ['queue completion notification failed — unsupported-destination'] },
    });
    expect(capabilityCalls).toBe(1);
    // The read-back document the seam mapped is exactly the verified bytes.
    expect(
      await readFile(join(root, '.cq/queue-evidence/results', receiptId, 'receipt.json'), 'utf8'),
    ).toBe(bytes.toString());
    // The receipt id IS the sha256 of the canonical receipt the result op
    // verified — the transport id arrives on the wire and names the file.
    expect(reviewsStarted).toBe(1);
    expect(submitWires[0]).toMatchObject({
      op: 'submit',
      request_id: requestId,
      inputs: { repo: 'owner/repo', target: 'merge-queue', base_commit: base, head_commit: head },
    });
    // No silent reachability inference: absent proof forwards neither, so
    // the submit leg takes its honest snapshot default (explicit scanner,
    // else CQ_AUTHOR_SNAPSHOT_SCANNER, else a configuration refusal). The
    // first submit below attests reachable explicitly - the caller knows
    // this fake server resolves the commits (same repo). Proof the
    // attestation reached the submit leg: the submit succeeds with no
    // scanner configured (without it, the leg would fail closed demanding
    // one). The snapshot path is covered by the test below.
    if (working) expect(submitWires[0]).toHaveProperty('snapshot');
    else expect(submitWires[0]).not.toHaveProperty('snapshot');

    // The second submit rejoins the same queue item: the server starts no
    // second review and the same completed receipt resolves again. The
    // durable request file persists, so the rejoin spends no new mutation.
    // The persisted request replays the first submit's replay wire,
    // including its reachable attestation.
    const second = await submit({
      cwd: root,
      target: 'merge-queue',
      base,
      head: actualHead,
      ...(working ? { workingTree: working, scanner: '/bin/true' } : {}),
    });
    expect(second).toMatchObject({ status: 'completed', value: { receiptId } });
    expect(reviewsStarted).toBe(1);
    expect(submitWires).toHaveLength(2);
    expect(submitWires[1]).toMatchObject({ op: 'submit', request_id: requestId });
    // Feed the actual TS submit wire into Python admission, retain its completed
    // receipt, then open the PR through real enrollment. No handcrafted facts
    // bypass the client/server identity boundary.
    const associated = execFileSync(
      'python3',
      [
        '-c',
        `
import copy, json, sys, tempfile, subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import author_snapshot, crq, review_transport, review_receipt
payload = json.load(sys.stdin)
wire, doc = payload['wire'], payload['receipt']
root = Path(payload['root'])
q = {'items': [], 'starts': []}
with tempfile.TemporaryDirectory() as directory:
    state = Path(directory)
    if payload['working']:
        # Distinct clone: full scope has only its published comparison base;
        # uncommitted scope has the published actual HEAD. Neither has the synthetic commit.
        runner_clone = state / 'clone'
        origin = author_snapshot.git(root, 'remote', 'get-url', 'origin').decode().strip()
        subprocess.run(['git', 'clone', '--bare', origin, str(runner_clone)], check=True, capture_output=True)
        assert author_snapshot.git(runner_clone, 'cat-file', '-t', wire['inputs']['base_commit']).strip() == b'commit'
        assert subprocess.run(['git', '-C', str(runner_clone), 'cat-file', '-e', wire['inputs']['head_commit']], capture_output=True).returncode != 0
        if wire['inputs']['projection'] == 'working-tree-full-v1':
            assert subprocess.run(['git', '-C', str(runner_clone), 'cat-file', '-e', payload['actualHead']], capture_output=True).returncode != 0
    else:
        runner_clone = root
    def git(*args, **kw):
        return author_snapshot.git(root, *args).decode().strip()
    runner = SimpleNamespace(CLONE=runner_clone, STATE=state, WT_ROOT=state / 'worktrees', REPO='owner/repo', CONFIG={}, ALLOWLIST_PATHS=[], denylist_rules=lambda: [{'regex': '(?!)'}], secret_scan_diff=lambda *a, **kw: (True, {}),
        load_queue=lambda: q, save_queue=lambda value: None,
        iso=lambda: '2026-11-08T00:00:00Z')
    policy = dict(repo='owner/repo', enabled=True, write=['test'], branches=['merge-queue'])
    if payload['working'] and wire['inputs']['projection'] == 'working-tree-full-v1':
        runner.denylist_rules = lambda: [{'regex': 'outgoing-metadata-marker'}]
        try:
            review_transport.handle(json.dumps(wire).encode(), runner, principal='test', policy=policy)
            raise AssertionError('metadata scan must refuse')
        except author_snapshot.AuthorRefused as error:
            assert 'metadata secret scan' in str(error), error
        assert not q['items'], q
        runner.denylist_rules = lambda: [{'regex': '(?!)'}]
    admitted = json.loads(review_transport.handle(json.dumps(wire).encode(), runner, principal='test', policy=policy))
    assert admitted['action'] == 'created', admitted
    item = q['items'][0]
    doc.update(identity=item['identity'], identity_inputs=item['identity_inputs'], profile=item['profile'])
    item.update(state='done', scope_adequate=True, receipt_id=review_receipt.write_receipt(state / 'receipts', doc))
    assert review_transport.retained(runner, item)
    author_snapshot.git(root, 'update-ref', 'refs/remotes/origin/main', wire['inputs']['base_commit'])
    real_head = payload['actualHead']
    if payload['working']:
        body = ('tree ' + payload['headTree'] + '\\nparent ' + real_head + '\\nauthor Author <author@example.invalid> 1 +0000\\ncommitter Author <author@example.invalid> 1 +0000\\n\\nreal published commit\\n').encode()
        real_head = author_snapshot.git(root, 'hash-object', '-w', '-t', 'commit', '--stdin', data=body).decode().strip()
        assert real_head != wire['inputs']['head_commit']
        assert git('rev-parse', real_head + '^{tree}') == payload['headTree']
    opened = [dict(number=7, isDraft=False, baseRefName='main', headRefName='feature', headRefOid=real_head)]
    with mock.patch.multiple(crq, CLONE=root, STATE=state, REPO='owner/repo', CONFIG={}), mock.patch.object(crq, 'gh_json', return_value=opened), mock.patch.object(crq, 'ensure_commit', return_value=True), mock.patch.object(crq, 'event'):
        crq.enroll(q, False)
    if payload['working']:
        assert [i['kind'] for i in q['items']] == ['local-review', 'open'], q
        assert not q.get('review_pr_links'), q
        # Equal final trees still cannot substitute a real commit for the synthetic identity.
        assert git('rev-parse', wire['inputs']['head_commit'] + '^{tree}') == payload['headTree']
    else:
        assert [i['kind'] for i in q['items']] == ['local-review'], q
        assert q['review_pr_links']['owner/repo#7']['item'] == item['id'], q
    print('associated-without-second-start')
`,
      ],
      {
        input: JSON.stringify({
          wire: submitWires[0],
          receipt,
          root,
          actualHead,
          working: !!working,
          headTree,
        }),
        env: { ...process.env, PYTHONPATH: join(process.cwd(), 'apps/crq-python') },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(associated.trim()).toBe('associated-without-second-start');
  },
);

test('S2b-i e2e: explicit scanner rides snapshot transport for unpublished work', async () => {
  // Unpublished commits (the runner cannot resolve them) ride the snapshot
  // transport: an explicit absolute scanner produces the original-commit
  // snapshot the server installs. This proves the preserved snapshot path
  // through the managed seam - the seam never infers reachability, and the
  // default above forwards no silent reachable:true claim.
  const root = repo.root;
  const base = repo.git('rev-parse', 'origin/merge-queue').trim();
  const head = repo.git('rev-parse', 'HEAD').trim();
  const scanner = join(root, 'scan');
  await writeFile(scanner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const seen: unknown[] = [];
  const transport = async (raw: string): Promise<string> => {
    const wire = JSON.parse(raw) as { op: string; request_id?: string; snapshot?: unknown };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    if (wire.op === 'submit') {
      seen.push(wire);
      return JSON.stringify({
        v: 1,
        action: 'created',
        state: 'completed',
        reviewedHead: head,
        request_id: wire.request_id,
      });
    }
    if (wire.op === 'result')
      return JSON.stringify({
        v: 1,
        action: 'observed',
        state: 'completed',
        receipt_id: '0'.repeat(64),
        index: 0,
        chunks: 0,
        bytes: 0,
        sha256: '0'.repeat(64),
        encoding: 'base64-utf8-json',
        data: '',
        chunk_sha256: '0'.repeat(64),
        next_index: null,
        reviewedHead: head,
        reviewOutcome: 'unknown',
        scopeAdequate: false,
      });
    throw new Error(`unexpected op ${wire.op}`);
  };
  const submit = makeManagedReviewSubmit(
    () => transport,
    async () => 'owner/repo',
  );
  // The submission is refused for inadequate scope (no fetchable receipt),
  // but that refusal PROVES the wire carried the snapshot: the real
  // captureSnapshot ran the scanner over the repo and attached the
  // original-commit objects to the submit wire.
  const refused = await submit({
    cwd: root,
    target: 'merge-queue',
    base,
    head,
    scanner,
  });
  expect(refused.status).toBe('refused');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toHaveProperty('snapshot');
  expect(seen[0]).toMatchObject({
    op: 'submit',
    inputs: { repo: 'owner/repo', base_commit: base, head_commit: head },
  });
  const snapshot = (seen[0] as { snapshot: { v: number; tree: string; objects: unknown[] } })
    .snapshot;
  expect(snapshot.v).toBe(1);
  // The snapshot tree pins exactly the submitted head tree.
  expect(snapshot.tree).toBe(repo.git('rev-parse', `${head}^{tree}`).trim());
  expect(snapshot.objects.length).toBeGreaterThan(0);
});

test('an exhausted wall budget makes no transport or repo-resolution call', async () => {
  const submit = makeManagedReviewSubmit(
    () => {
      throw new Error('must not connect');
    },
    async () => {
      throw new Error('must not resolve');
    },
  );
  expect(
    await submit({
      cwd: repo.root,
      target: 'main',
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      remainingWallMs: () => 0,
    }),
  ).toEqual({ status: 'refused', reason: 'the review wall budget expired before submission' });
});

test('production defaults detect advertised heads, separate targets, and return explicit failed-attempt recovery', async () => {
  // Advertise this head on the origin without injecting reachable or a scanner.
  repo.git('config', 'remote.origin.url', repo.root);
  const base = repo.git('rev-parse', 'origin/merge-queue').trim();
  const head = repo.git('rev-parse', 'HEAD').trim();
  const wires: { request_id: string; snapshot?: unknown }[] = [];
  const submit = makeManagedReviewSubmit(
    () => async (raw) => {
      const wire = JSON.parse(raw) as { op: string; request_id: string; snapshot?: unknown };
      if (wire.op === 'capabilities') return JSON.stringify(caps);
      expect(wire.op).toBe('submit');
      wires.push(wire);
      return JSON.stringify({
        v: 1,
        action: 'observed',
        state: 'failed',
        next_action: 'resubmit',
        reason: 'provider unavailable',
      });
    },
    async () => 'owner/repo',
  );
  let retryReason = '';
  for (const target of ['main', 'merge-queue']) {
    const result = await submit({ cwd: repo.root, target, base, head });
    if (result.status === 'refused') retryReason = result.reason;
    expect(result).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('--repeat --requestId=') as unknown,
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining(`--head=${head} --reachable --repeat`) as unknown,
    });
  }
  expect(wires).toHaveLength(2);
  expect(wires[0]?.snapshot).toBeUndefined();
  expect(wires[0]?.request_id).not.toBe(wires[1]?.request_id);
  // Execute the printed selectors after the checkout advances. Recovery still
  // submits the failed reviewed commit and needs no snapshot scanner.
  await repo.write('later.txt', 'later commit');
  const later = repo.commitAll('advance after failure');
  expect(later).not.toBe(head);
  const flags = Object.fromEntries<string>(
    [...retryReason.matchAll(/--(\w+)=(\S+)/g)].map((match) => [match[1]!, match[2]!] as const),
  );
  let retried: unknown;
  const recovery = await makeSubmit(async (raw) => {
    const wire = JSON.parse(raw) as { op: string };
    if (wire.op === 'capabilities') return JSON.stringify(caps);
    retried = wire;
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  })({
    cwd: repo.root,
    repo: flags['repo']!,
    target: flags['target']!,
    base: flags['base']!,
    head: flags['head']!,
    requestId: flags['requestId']!,
    repeat: true,
    reachable: retryReason.includes(' --reachable'),
  });
  expect(recovery.status).toBe('ok');
  expect(retried).toMatchObject({ repeat: true, inputs: { head_commit: head } });
  expect(retried).not.toHaveProperty('snapshot');
});

test('empty committed diff reports no changes without fetching an unknown result', async () => {
  const head = repo.git('rev-parse', 'HEAD').trim();
  const submit = makeManagedReviewSubmit(
    () => async () => {
      throw new Error('must not contact server');
    },
    async () => 'owner/repo',
  );
  expect(
    await submit({ cwd: repo.root, target: 'main', base: head, head, reachable: true }),
  ).toEqual({ status: 'refused', reason: 'the queue saw no committed changes to review' });
});

test('published uncommitted base missing at the runner reports fetch guidance without claiming coverage', async () => {
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
  const head = repo.git('rev-parse', 'HEAD').trim();
  await repo.write('src/a.ts', 'export const a = 3;\n');
  const result = await makeManagedReviewSubmit(
    () => async (raw) => {
      const wire = JSON.parse(raw) as { op: string };
      if (wire.op === 'capabilities') return JSON.stringify(caps);
      return JSON.stringify({
        v: 1,
        error: { code: 'refused', message: 'snapshot Git operation refused', retryable: false },
      });
    },
    async () => 'owner/repo',
  )({
    cwd: repo.root,
    target: 'merge-queue',
    base: head,
    head,
    workingTree: 'uncommitted',
    scanner: '/bin/true',
  });
  expect(result).toMatchObject({
    status: 'refused',
    reason: expect.stringContaining(`runner has fetched published HEAD ${head}`) as unknown,
  });
});

test.each(['full', 'uncommitted'] as const)(
  'synthetic %s recovery preserves head, projection and quoted scanner after checkout advances',
  async (scope) => {
    const actualHead = repo.git('rev-parse', 'HEAD').trim();
    if (scope === 'uncommitted') repo.git('push', '-q', 'origin', 'HEAD:refs/heads/feature/x');
    await repo.write('src/a.ts', 'export const a = 3;\n');
    await mkdir(join(repo.root, '.cq'), { recursive: true });
    const scanner = join(repo.root, '.cq', "scanner's fixture");
    await writeFile(scanner, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
    let original: unknown;
    const result = await makeManagedReviewSubmit(
      () => async (raw) => {
        const wire = JSON.parse(raw) as { op: string };
        if (wire.op === 'capabilities') return JSON.stringify(caps);
        original = wire;
        return JSON.stringify({
          v: 1,
          action: 'observed',
          state: 'failed',
          next_action: 'resubmit',
          reason: 'offline failure',
        });
      },
      async () => 'owner/repo',
    )({
      cwd: repo.root,
      target: 'main',
      base: scope === 'full' ? repo.git('rev-parse', 'origin/merge-queue').trim() : actualHead,
      head: actualHead,
      workingTree: scope,
      scanner,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected recovery command');
    expect(result.reason).toContain('cq review.submit ');
    const command = result.reason.slice(result.reason.indexOf('cq review.submit '));
    const tokens = JSON.parse(
      execFileSync(
        'python3',
        ['-c', 'import json, shlex, sys; print(json.dumps(shlex.split(sys.stdin.read())))'],
        { input: command, encoding: 'utf8' },
      ),
    ) as string[];
    const flags = Object.fromEntries(
      tokens
        .filter((token) => token.startsWith('--') && token.includes('='))
        .map((token) => {
          const split = token.indexOf('=');
          return [token.slice(2, split), token.slice(split + 1)];
        }),
    );
    const projection = scope === 'full' ? 'working-tree-full-v1' : 'working-tree-uncommitted-v1';
    expect(flags['projection']).toBe(projection);
    expect(flags['scanner']).toBe(scanner);
    expect(tokens).toContain('--repeat');
    expect(tokens).not.toContain('--reachable');
    expect(original).toMatchObject({ inputs: { head_commit: flags['head'], projection } });
    expect(flags['head']).toMatch(/^[0-9a-f]{40}$/);
    expect(flags['head']).not.toBe(actualHead);
    repo.git('commit', '--allow-empty', '-qm', 'advance after failed snapshot');
    expect(repo.git('rev-parse', 'HEAD').trim()).not.toBe(actualHead);
    let retried: unknown;
    const recovery = await makeSubmit(async (raw) => {
      const wire = JSON.parse(raw) as { op: string };
      if (wire.op === 'capabilities') return JSON.stringify(caps);
      retried = wire;
      return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
    })({
      cwd: repo.root,
      repo: flags['repo']!,
      target: flags['target']!,
      base: flags['base']!,
      head: flags['head']!,
      projection,
      scanner: flags['scanner']!,
      requestId: flags['requestId']!,
      repeat: true,
    });
    expect(recovery.status).toBe('ok');
    expect(retried).toMatchObject({
      repeat: true,
      inputs: { head_commit: flags['head'], projection },
      snapshot: expect.any(Object) as unknown,
    });
  },
);
