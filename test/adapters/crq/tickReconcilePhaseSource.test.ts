import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileReconcilePhaseEffects } from '../../../src/adapters/crq/tickReconcilePhaseSource.js';
import { ForgeBudget } from '../../../src/policy/crq/forgeBudget.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { runReconcilePhase } from '../../../src/queue-runner/tickDiscoveryPhase.js';

const NEVER = (): never => {
  throw new Error('not expected');
};
let root: string;
const events: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tick-reconcile-'));
  events.length = 0;
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const doc = (text: string) => parseJsonValue(text) as JsonObject;
const run = async (text: string, state: string | null) => {
  await writeFile(join(root, 'queue.json'), text);
  const effects = fileReconcilePhaseEffects({
    stateRoot: root,
    clone: '/fake/clone',
    repo: 'o/r',
    now: () => new Date('2026-11-15T01:02:03.999Z'),
    gh: async () =>
      state === null
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: `{"number":7,"state":"${state}"}`, stderr: '' },
    runGit: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
    fixRun: {
      proveMerge: NEVER,
      recheckRevalidation: NEVER,
      markFixedOutcome: NEVER,
      publishSource: NEVER,
    },
    event: async (kind) => {
      events.push(kind);
    },
  });
  const log = await runReconcilePhase(doc(text), effects, undefined);
  return { log, saved: await readFile(join(root, 'queue.json'), 'utf8') };
};
const FIX =
  '{"items":[{"id":"i1","kind":"promotion","repair_runs":{"r1":{"fix_pr":{"number":7}}}}],"unknown":1.5}\n';

describe('fileReconcilePhaseEffects', () => {
  it('persists an abandoned fix PR with the tick-clock stamp and lossless numbers', async () => {
    const { log, saved } = await run(FIX, 'CLOSED');
    expect(log).toEqual(['reconcile: 1 examined, 0 projected, 0 starved, 0 deferred']);
    const item = (doc(saved).get('items') as JsonObject[])[0] as JsonObject;
    const record = (item.get('repair_runs') as JsonObject).get('r1') as JsonObject;
    expect(record.get('fix_closed')).toBe('2026-11-15T01:02:03Z');
    expect((record.get('fix_pr') as JsonObject).get('state')).toBe('CLOSED');
    expect(saved).toContain('1.5');
    expect(events).toEqual([]);
  });

  it('counts a forge failure as deferred, records the event, and leaves the queue as it was', async () => {
    const { log, saved } = await run(FIX, null);
    expect(log).toEqual(['reconcile: 1 examined, 0 projected, 0 starved, 1 deferred']);
    expect(saved).toBe(FIX);
    expect(events).toEqual(['reconcile_incomplete']);
  });

  it('records the observed state of an open fix PR but does not close it', async () => {
    const { log, saved } = await run(FIX, 'OPEN');
    expect(log).toEqual(['reconcile: 1 examined, 0 projected, 0 starved, 0 deferred']);
    expect(saved).not.toBe(FIX);
    const record = ((doc(saved).get('items') as JsonObject[])[0] as JsonObject).get('repair_runs');
    expect(((record as JsonObject).get('r1') as JsonObject).has('fix_closed')).toBe(false);
  });

  it('runs the receipt lane: distrusts remediation and installs the item', async () => {
    const text =
      '{"items":[{"id":"r2","kind":"merged-current","remediation_state":"fixed","remediation":{"a":1}}]}\n';
    const { log, saved } = await run(text, 'OPEN');
    expect(log).toEqual(['reconcile: 1 examined, 0 projected, 0 starved, 0 deferred']);
    const item = (doc(saved).get('items') as JsonObject[])[0] as JsonObject;
    expect(item.get('remediation_state')).toBe('pending-merged-evidence');
    expect(item.has('remediation')).toBe(false);
  });

  it('uses the budget it is given for the forge read', async () => {
    const budget = new ForgeBudget({ requests: 1, seconds: 60 });
    const effects = fileReconcilePhaseEffects({
      stateRoot: root,
      clone: '/fake/clone',
      repo: 'o/r',
      gh: async () => ({ code: 0, stdout: '{"number":7,"state":"OPEN"}', stderr: '' }),
      runGit: async (args) => ({ args, code: 0, stdout: new Uint8Array(), stderr: '' }),
      fixRun: {
        proveMerge: NEVER,
        recheckRevalidation: NEVER,
        markFixedOutcome: NEVER,
        publishSource: NEVER,
      },
      event: async () => {},
    });
    await writeFile(join(root, 'queue.json'), FIX);
    expect(budget.available()).toBe(true);
    await effects.reconcile(doc(FIX), budget);
    expect(budget.available()).toBe(false);
  });
});
