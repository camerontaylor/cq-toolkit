import { describe, expect, it } from 'vitest';
import { readCqEnv, type CqEnv } from '../../../src/config/env.js';
import { runWithCqEnv } from '../../../src/config/run-env.js';
import { snapshotHead } from '../../../src/ops/dev/internal/snapshot.js';
import { registry } from '../../../src/ops/dev/registry.js';
import {
  AUTHOR_TRANSPORT_HINT,
  envAuthorAdmission,
  makeAuthorAdmission,
  resolveAuthorEnv,
  type AuthorTransport,
} from '../../../src/ops/dev/review-transport.js';
import { admissionBinding, admissionInput, waitingDecision } from './reviewTestKit.js';

const treeOid = 'b'.repeat(40);

/**
 * A transport that answers with the request's own binding (a tree enroll's
 * synthetic head is computed locally, so a fixed decision cannot match it).
 */
function echoRecorder() {
  const sent: string[] = [];
  return {
    sent,
    transport: (async (request: string) => {
      sent.push(request);
      const envelope = JSON.parse(request) as {
        binding: typeof admissionBinding;
      };
      return JSON.stringify({
        ...waitingDecision,
        request_id: envelope.binding.request_id,
        binding: envelope.binding,
      });
    }) as AuthorTransport,
  };
}

/** The admission input without `head`, for tree enrollments (exactly one of head/tree). */
function treeInput(tree: string) {
  const { head: _dropped, ...rest } = admissionInput;
  return { ...rest, tree };
}

// ---------------------------------------------------------------------------
// The entry-snapshot contract (#1185): the author-side environment resolves
// from the dispatch wiring's snapshot, never ambient at call time; capture
// stays an explicit override; foreign vendor env is never read.
// ---------------------------------------------------------------------------

describe('dev.review author-env snapshot (#1185)', () => {
  it('resolves the author repo and scanner from the entry snapshot', () => {
    const snapshot = readCqEnv({
      CQ_AUTHOR_REPO: '/author/repo',
      CQ_AUTHOR_SNAPSHOT_SCANNER: '/bin/scan',
    });
    expect(resolveAuthorEnv(snapshot)).toEqual({ repo: '/author/repo', scanner: '/bin/scan' });
  });

  it('prefers the entry snapshot over a hostile ambient environment', async () => {
    const previousRepo = process.env['CQ_AUTHOR_REPO'];
    const previousScanner = process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'];
    process.env['CQ_AUTHOR_REPO'] = '/hostile/repo';
    process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'] = '/hostile/scanner';
    try {
      // The resolver reads the PASSED env only: the snapshot wins even
      // though the ambient keys point at hostile paths.
      expect(resolveAuthorEnv(readCqEnv({ CQ_AUTHOR_REPO: '/snapshot/repo' }))).toEqual({
        repo: '/snapshot/repo',
        scanner: undefined,
      });
      const wire = echoRecorder();
      const result = await makeAuthorAdmission(
        wire.transport,
        async (captureBase, captureTree) => ({
          head: snapshotHead(captureBase, captureTree),
          snapshot: { captureBase, captureTree },
        }),
        readCqEnv({ CQ_AUTHOR_REPO: '/snapshot/repo' }),
      )(treeInput(treeOid));
      expect(result.status).toBe('ok');
      expect(wire.sent).toHaveLength(1);
    } finally {
      if (previousRepo === undefined) delete process.env['CQ_AUTHOR_REPO'];
      else process.env['CQ_AUTHOR_REPO'] = previousRepo;
      if (previousScanner === undefined) delete process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'];
      else process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'] = previousScanner;
    }
  });

  it('uses the snapshot scanner — not the hostile ambient one — in the default capture', async () => {
    const wire = echoRecorder();
    // A relative scanner fails the absolute-path gate before any git or
    // transport touch; the hostile ambient absolute path must never be read.
    const snapshot = readCqEnv({ CQ_AUTHOR_SNAPSHOT_SCANNER: 'snapshot-relative-scanner' });
    const previousScanner = process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'];
    process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'] = '/hostile/scanner';
    try {
      const result = await makeAuthorAdmission(
        wire.transport,
        undefined,
        snapshot,
      )(treeInput(treeOid));
      expect(result).toMatchObject({
        status: 'needs-human',
        reason: 'Configure CQ_AUTHOR_SNAPSHOT_SCANNER as an absolute operator scanner path.',
      });
      expect(wire.sent).toEqual([]);
    } finally {
      if (previousScanner === undefined) delete process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'];
      else process.env['CQ_AUTHOR_SNAPSHOT_SCANNER'] = previousScanner;
    }
  });

  it('keeps the explicit capture override winning over the snapshot', async () => {
    const wire = echoRecorder();
    const result = await makeAuthorAdmission(
      wire.transport,
      async () => ({
        head: snapshotHead(admissionInput.base, treeOid),
        snapshot: { override: true },
      }),
      readCqEnv({ CQ_AUTHOR_REPO: '/snapshot/repo' }),
    )(treeInput(treeOid));
    expect(result).toMatchObject({ status: 'ok' });
    const envelope = JSON.parse(wire.sent[0] ?? '{}') as { snapshot?: { override?: unknown } };
    expect(envelope.snapshot).toEqual({ override: true });
  });

  it('keeps raw-record injection as a first-class seam', () => {
    expect(
      resolveAuthorEnv({ CQ_AUTHOR_REPO: '/raw/repo', CQ_AUTHOR_SNAPSHOT_SCANNER: '/raw/scan' }),
    ).toEqual({ repo: '/raw/repo', scanner: '/raw/scan' });
    expect(resolveAuthorEnv({})).toEqual({ repo: undefined, scanner: undefined });
    expect(resolveAuthorEnv({ CQ_AUTHOR_REPO: '' })).toEqual({
      repo: undefined,
      scanner: undefined,
    });
  });

  it('treats a whitespace-only snapshot value as unset while an explicit raw record keeps it verbatim', () => {
    // The registry's isBlank trims, so the snapshot path (the default and
    // the wired dispatch) can never mistake a whitespace-only value for a
    // repo path or scanner. An explicitly injected raw record keeps its
    // historical ''-only rule: whitespace-only is a live (if useless) value,
    // and no non-blank configured value changes meaning on either path.
    expect(resolveAuthorEnv(readCqEnv({ CQ_AUTHOR_REPO: '   ' }))).toEqual({
      repo: undefined,
      scanner: undefined,
    });
    expect(resolveAuthorEnv({ CQ_AUTHOR_REPO: '   ' })).toEqual({
      repo: '   ',
      scanner: undefined,
    });
  });

  it('refuses an errored snapshot by name before falling back to the default', () => {
    // The AUTHOR keys use the identity parser, so no raw value can fail it;
    // the guard still names the key first if the snapshot ever carries one
    // (a denied name, or a future validating parser).
    const errored = {
      ...readCqEnv({}),
      errors: [{ name: 'CQ_AUTHOR_SNAPSHOT_SCANNER', message: 'CQ_AUTHOR_SNAPSHOT_SCANNER: boom' }],
    } as unknown as Parameters<typeof resolveAuthorEnv>[0];
    expect(() => resolveAuthorEnv(errored)).toThrow(/CQ_AUTHOR_SNAPSHOT_SCANNER/);
  });

  it('binds the snapshot alias through envAuthorAdmission without ambient reads', async () => {
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await envAuthorAdmission(admissionInput, {
        CQ_AUTHOR_SSH_ALIAS: 'snapshot-alias',
      });
      expect(result).toMatchObject({ status: 'indeterminate' });
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('reports the configuration gap from a snapshot without an alias', async () => {
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await envAuthorAdmission(admissionInput, readCqEnv({}));
      expect(result).toMatchObject({ status: 'needs-human' });
      if (result !== null && typeof result === 'object' && 'reason' in result) {
        expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
      }
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('threads the dispatch wiring snapshot through the registry admission', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer({ cqEnv: readCqEnv({}) });
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      const result = await op?.(admissionInput);
      expect(result).toMatchObject({ status: 'needs-human' });
      if (result !== null && typeof result === 'object' && 'reason' in result) {
        expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
      }
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('the wired registry snapshot wins over an enclosing run snapshot', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer({ cqEnv: readCqEnv({}) });
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      // The wired (empty) snapshot is passed explicitly, so the default —
      // and with it the enclosing run snapshot's alias — is never consulted:
      // the admission reports the configuration gap instead of dispatching.
      await runWithCqEnv(readCqEnv({ CQ_AUTHOR_SSH_ALIAS: 'run-snapshot-alias' }), async () => {
        const result = await op?.(admissionInput);
        expect(result).toMatchObject({ status: 'needs-human' });
        if (result !== null && typeof result === 'object' && 'reason' in result) {
          expect(String(result.reason)).toContain('CQ_AUTHOR_SSH_ALIAS');
        }
      });
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('without wiring, the admission resolves the enclosing run snapshot through the default', async () => {
    const entry = registry.find((item) => item.name === 'dev.review');
    const op = await entry?.importer({});
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    delete process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      // No wiring: the `env` default (`currentCqEnv()`) evaluates at call
      // time inside the run scope and reaches the enclosing run snapshot, so
      // its alias binds and the transport is attempted (it fails locally →
      // indeterminate — never the alias configuration gap).
      await runWithCqEnv(readCqEnv({ CQ_AUTHOR_SSH_ALIAS: 'run-snapshot-alias' }), async () => {
        const result = await op?.(admissionInput);
        expect(result).toMatchObject({ status: 'indeterminate' });
      });
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('the standalone default is one fresh validated snapshot, not the ambient raw record', async () => {
    const previous = process.env['CQ_AUTHOR_SSH_ALIAS'];
    try {
      // A whitespace-only ambient alias is blank to the registry: the fresh
      // snapshot default reports the configuration gap, where the old raw
      // default mistook it for a live alias and failed transport
      // construction with the other message.
      process.env['CQ_AUTHOR_SSH_ALIAS'] = '   ';
      const blank = await envAuthorAdmission(admissionInput);
      expect(blank).toMatchObject({ status: 'needs-human', reason: AUTHOR_TRANSPORT_HINT });
      // A fresh read per call: a non-blank ambient alias set after the
      // snapshot above was taken is honored by the NEXT default read.
      process.env['CQ_AUTHOR_SSH_ALIAS'] = 'ambient-default-alias';
      const set = await envAuthorAdmission(admissionInput);
      expect(set).toMatchObject({ status: 'indeterminate' });
    } finally {
      if (previous !== undefined) process.env['CQ_AUTHOR_SSH_ALIAS'] = previous;
    }
  });

  it('the default re-checks a fabricated errored snapshot on every call (nothing cached)', () => {
    // The AUTHOR keys use the identity parser, so readCqEnv cannot produce
    // an error for them; only a fabricated (or denied, in future) snapshot
    // reaches the name guard. The default evaluates PER CALL, so both calls
    // inside the run scope re-check the enclosing snapshot and throw —
    // nothing about the first resolution is cached.
    const errored = {
      ...readCqEnv({}),
      errors: [{ name: 'CQ_AUTHOR_SSH_ALIAS', message: 'CQ_AUTHOR_SSH_ALIAS: boom' }],
    } as unknown as CqEnv;
    runWithCqEnv(errored, () => {
      expect(() => envAuthorAdmission(admissionInput)).toThrow(/CQ_AUTHOR_SSH_ALIAS/);
      expect(() => envAuthorAdmission(admissionInput)).toThrow(/CQ_AUTHOR_SSH_ALIAS/);
    });
  });

  it('ignores foreign vendor env when resolving the author side', () => {
    const resolved = resolveAuthorEnv({
      CQ_AUTHOR_REPO: '/author/repo',
      ZAI_API_KEY: 'foreign-secret',
      GH_TOKEN: 'foreign-secret',
    });
    expect(resolved).toEqual({ repo: '/author/repo', scanner: undefined });
  });

  it('refuses an invalid explicit alias before any byte is sent', async () => {
    // sshAuthorTransport throws on construction, so no transport exists to send with.
    const result = await envAuthorAdmission(
      { ...admissionInput, requestId: 'bad-alias-probe' },
      { CQ_AUTHOR_SSH_ALIAS: '-oProxyCommand=bad' },
    );
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'Invalid author transport configuration.',
    });
  });
});
