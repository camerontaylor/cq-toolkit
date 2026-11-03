// Shared fixtures for the split of test/ops/review/queue.test.ts (round-2
// pure-move split): the review-queue cases now live in the `queue.*.test.ts`
// subject files beside this module.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { sha256 } from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  QueueReference,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';

const dirs: string[] = [];

export async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'cq-queue-'));
  dirs.push(dir);
  return dir;
}

export async function cleanupQueueDirs(): Promise<void> {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}

export const ref: QueueReference = {
  requestId: 'request-1',
  binding: {
    kind: 'merged-current',
    repo: 'owner/repo',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    targetSelector: 'promoted-main',
  },
};

export const pendingStatus = {
  state: 'pending',
  pr: null,
  mergeSha: null,
  itemId: null,
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
};

export function fixture(clean = false, fixed = false, unicode = false) {
  const paths = [
    {
      source_path: unicode ? 'src/é😀.ts' : 'src/a.ts',
      path: unicode ? 'src/é😀.ts' : 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
    },
  ];
  // Sorted keys match Python canonical(paths); ASCII fixture here; the Unicode receipt test pins Python escaping.
  const canonicalPaths = JSON.stringify([
    {
      disposition: 'included',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      source_path: 'src/a.ts',
    },
  ]);
  const itemId =
    'current-' +
    sha256(
      Buffer.from(
        JSON.stringify({
          merge_sha: 'b'.repeat(40),
          policy: 'affected-current-additions-v1',
          pr: 12,
          repo: 'owner/repo',
          target_selector: 'promoted-main',
        }),
      ),
    ).slice(0, 32);
  const document = {
    version: 1,
    item_id: itemId,
    request_id: ref.requestId,
    source: {
      repo: 'owner/repo',
      pr: 12,
      merge_sha: 'b'.repeat(40),
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      target: 'c'.repeat(40),
      tree: 'd'.repeat(40),
      paths,
      scope_digest: unicode
        ? 'b82aca57fb7b2cbd6034b6794e07367dca72ba8b17f4de681d6be7d1d4e1bd22'
        : sha256(Buffer.from(canonicalPaths)),
      equivalence: 'e'.repeat(64),
      policy: 'affected-current-additions-v1',
      projection: 'current-affected-files/full-file-addition-projection',
      reviewer: 'coderabbit-review-agent-committed-v1',
      reviewer_version: 'fixture',
      captured_at: '2026-10-28T00:00:00Z',
    },
    classification: { outcome: 'completed', counted: true },
    outcome: clean ? 'terminal-clean' : 'terminal-with-findings',
    counted: true,
    findings: clean ? [] : [{ text: 'large finding '.repeat(3000) }],
    run_id: 'run-1',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = sha256(bytes);
  let ack = 0;
  let calls = 0;
  const status = {
    state: document.outcome,
    pr: 12,
    mergeSha: 'b'.repeat(40),
    itemId,
    receiptId,
    consumed: false,
    reviewed: true,
    fixed,
    ...(fixed
      ? {
          remediation: {
            receiptId,
            captureDigest: 'd'.repeat(64),
            fixPr: 99,
            mergeSha: 'e'.repeat(40),
            headSha: 'f'.repeat(40),
            targetSha: 'a'.repeat(40),
          },
        }
      : {}),
  };
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks: Math.ceil(bytes.length / 3072),
    encoding: 'base64-utf8-json',
  };
  const transport: QueueTransport = async (wire) => {
    calls++;
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(8192);
    const req = JSON.parse(wire) as { op: string; cursor?: string | null };
    let result: unknown = status;
    if (req.op === 'report') {
      if (req.cursor === null)
        result = { page: { ...common, kind: 'manifest', cursor: receiptId + ':0' } };
      else {
        const index = Number(req.cursor?.split(':')[1]);
        const chunk = bytes.subarray(index * 3072, (index + 1) * 3072);
        result = {
          page: {
            ...common,
            kind: 'chunk',
            index,
            chunk_sha256: sha256(chunk),
            data: chunk.toString('base64'),
            next_cursor: index + 1 < common.chunks ? receiptId + ':' + (index + 1) : null,
          },
        };
      }
    }
    if (req.op === 'ack') {
      ack++;
      result = { ...status, consumed: true };
    }
    const raw =
      JSON.stringify({ v: 1, requestId: ref.requestId, binding: ref.binding, result }) + '\n';
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(8192);
    return raw;
  };
  return {
    transport,
    document,
    receiptId,
    bytes,
    common,
    acknowledgements: () => ack,
    calls: () => calls,
  };
}
