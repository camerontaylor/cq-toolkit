// Issue #1185 slice: the queue family reads CQ_QUEUE_SSH_ALIAS from the
// entry/run CqEnv snapshot, never from the live ambient environment. A
// snapshot the entry captured (or passed through the registry wiring) is the
// authority: mutating `process.env` afterwards cannot alter queue
// configuration, and a registry importer binds the host's snapshot when one
// rides the wiring.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readCqEnv } from '../../../src/config/env.js';
import { runWithCqEnv } from '../../../src/config/run-env.js';
import * as queueClient from '../../../src/ops/review/internal/queueClient.js';
import { makeConfiguredQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import { QueueConfigurationError } from '../../../src/ops/review/queue.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { registry } from '../../../src/ops/review/registry.js';
import { pendingStatus, ref } from './queue.helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Stub dispatch: record the alias each transport was built with and answer
 * the pending-status wire without touching ssh (the local dispatch seam, the
 * alias test's spy technique). */
function captureTransportAliases(): string[] {
  const aliases: string[] = [];
  vi.spyOn(queueClient, 'sshQueueTransport').mockImplementation((alias: string) => {
    aliases.push(alias);
    return async () =>
      JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: pendingStatus,
      });
  });
  return aliases;
}

describe('queue alias reads the CqEnv snapshot, not the ambient env', () => {
  test('ops built outside a run keep the construction snapshot after ambient env changes', async () => {
    const snapshot = readCqEnv({ CQ_QUEUE_SSH_ALIAS: 'fixture' });
    const ops = makeQueueOps(undefined, snapshot);
    const aliases = captureTransportAliases();
    // Ambient drift after the snapshot cannot alter queue configuration: the
    // malformed post-entry alias is ignored and dispatch still rides 'fixture'.
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
    await expect(ops.queueStatus(ref)).resolves.toMatchObject({
      status: 'ok',
      value: pendingStatus,
    });
    // Unset ambient after entry: the snapshot alias still drives dispatch
    // (a call-time read would report needs-human here).
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    await expect(ops.queueStatus(ref)).resolves.toMatchObject({
      status: 'ok',
      value: pendingStatus,
    });
    expect(aliases).toEqual(['fixture', 'fixture']);
  });

  test('makeQueueOps inside runWithCqEnv reads the run snapshot, not the ambient env', async () =>
    runWithCqEnv(readCqEnv({ CQ_QUEUE_SSH_ALIAS: 'fixture' }), async () => {
      const aliases = captureTransportAliases();
      const ops = makeQueueOps();
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
      await expect(ops.queueStatus(ref)).resolves.toMatchObject({
        status: 'ok',
        value: pendingStatus,
      });
      expect(aliases).toEqual(['fixture']);
    }));

  test('ambient-only alias still yields needs-human (library default outside a run)', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    const result = await runWithCqEnv(readCqEnv(), () => makeQueueOps().queueStatus(ref));
    expect(result).toMatchObject({ status: 'needs-human' });
    if (result.status === 'needs-human') expect(result.reason).toContain('CQ_QUEUE_SSH_ALIAS');
  });

  test('makeConfiguredQueueClient reads the given snapshot, not the ambient env', () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'fixture');
    // Unset in the snapshot: construction must refuse even though the ambient
    // environment carries a usable alias (the snapshot is the authority).
    expect(() => makeConfiguredQueueClient(readCqEnv({}))).toThrow(QueueConfigurationError);
    // Present in the snapshot: construction binds the valid transport alias.
    const client = makeConfiguredQueueClient(readCqEnv({ CQ_QUEUE_SSH_ALIAS: 'fixture' }));
    expect(client.status).toBeTypeOf('function');
  });

  test('registry importer binds the wiring snapshot; ambient drift is inert', async () => {
    const snapshot = readCqEnv({ CQ_QUEUE_SSH_ALIAS: 'hostid' });
    const op = await registry
      .find((entry) => entry.name === 'review.queueStatus')!
      .importer({ cqEnv: snapshot });
    const aliases = captureTransportAliases();
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
    await expect(op(ref)).resolves.toMatchObject({ status: 'ok', value: pendingStatus });
    expect(aliases).toEqual(['hostid']);
  });

  test('registry importer without wiring keeps library behavior (fresh snapshot)', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'fixture');
    const aliases = captureTransportAliases();
    const op = await registry.find((entry) => entry.name === 'review.queueStatus')!.importer();
    await expect(op(ref)).resolves.toMatchObject({ status: 'ok', value: pendingStatus });
    expect(aliases).toEqual(['fixture']);
  });

  test('whitespace in the snapshot matches the old ambient read verbatim', async () => {
    // The old call-time read took process.env verbatim; the snapshot's text
    // parser also passes values verbatim, so a whitespace-padded alias is NOT
    // trimmed or silently repaired. Wrap the real factory (the alias test's
    // technique): it records the alias it received and then refuses the padded
    // value before any spawn, proving both verbatim flow and the refusal.
    const padded = makeQueueOps(undefined, readCqEnv({ CQ_QUEUE_SSH_ALIAS: ' fixture ' }));
    const seen: string[] = [];
    const real = queueClient.sshQueueTransport;
    vi.spyOn(queueClient, 'sshQueueTransport').mockImplementation((alias: string) => {
      seen.push(alias);
      return real(alias);
    });
    await expect(padded.queueStatus(ref)).resolves.toMatchObject({
      status: 'failed',
      error: 'invalid queue SSH alias',
    });
    expect(seen).toEqual([' fixture ']);
    // Whitespace-only is blank, and blank means unset (contract C2): the
    // snapshot resolves it to needs-human, never a dispatch with a whitespace
    // alias. This intentionally DIFFERS from the old call-time guard: `!alias`
    // on the raw ambient string treated '   ' as PRESENT (non-empty strings
    // are truthy in JavaScript), so the old path reached sshQueueTransport and
    // failed closed at the alias regex ({status:'failed'}). Both refuse; the
    // new declared needs-human is the honest classification.
    // Pin the OLD observable too, by replaying the old guard's logic against
    // the same blank input: it builds the transport and the alias regex
    // refuses, exactly the old failure shape this slice deliberately reclassifies.
    const oldGuardTransport = (() => {
      try {
        return queueClient.sshQueueTransport('   ');
      } catch (error) {
        return error;
      }
    })();
    expect(oldGuardTransport).toBeInstanceOf(Error);
    expect((oldGuardTransport as Error).message).toBe('invalid queue SSH alias');
    const blank = makeQueueOps(undefined, readCqEnv({ CQ_QUEUE_SSH_ALIAS: '   ' }));
    await expect(blank.queueStatus(ref)).resolves.toMatchObject({ status: 'needs-human' });
    // ' fixture ' came from the padded op dispatch; '   ' is ONLY the old-guard
    // replay above (a rejected construction, never a built transport or
    // dispatch): the blank op itself built nothing and dispatched nothing.
    expect(seen).toEqual([' fixture ', '   ']);
  });
});
