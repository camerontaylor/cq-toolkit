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
});
