/**
 * Pure read-gate policy tests against the Python oracle fixture.
 *
 * The fixture is generated from the PRODUCTION Python `canonical_rounds`,
 * `require_canonical_delivery`, `Inbox.handoff` and the exact scan-patch
 * builders. No process, filesystem or network participates here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  canonicalDeliveryRefusal,
  canonicalHandoffRefusal,
  deriveRoundCount,
  fixInstructionsScanPatch,
  fullSourceScanPatch,
  pythonSplitlines,
} from '../../../src/policy/crq/repairGates.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import type { RepairRefusal } from '../../../src/policy/crq/repairBinding.js';

const CANONICAL = 'f'.repeat(64);
const OLD = 'crq-historical-F1';
const PREPARED = 'crq-prepared-F1';

const fixture = asObject(
  parseJsonValue(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/repair-prepare/cases.json', import.meta.url),
      'utf8',
    ),
  ),
);

function asObject(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected a JSON object');
  return value;
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array');
  return value;
}

function asString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected a JSON string');
  return value;
}

function asBoolean(value: JsonValue | undefined): boolean {
  if (typeof value !== 'boolean') throw new Error('expected a JSON boolean');
  return value;
}

function asNumber(value: JsonValue | undefined): number {
  if (!(value instanceof JsonNumber)) throw new Error('expected a JSON number');
  if (value.kind === 'int') {
    if (value.integer === null) throw new Error('integer value missing');
    return Number(value.integer);
  }
  if (value.float === null) throw new Error('float value missing');
  return value.float;
}

function inboxJobs(row: JsonObject): JsonObject {
  return asObject(row.get('inbox_jobs'));
}

function readInbox(
  jobs: JsonObject,
  calls: string[],
): (jobId: string) => Promise<string | undefined> {
  return async (jobId) => {
    calls.push(jobId);
    const text = jobs.get(jobId);
    return typeof text === 'string' ? text : undefined;
  };
}

describe('scan-patch construction', () => {
  const patches = asObject(fixture.get('patch_cases'));

  for (const [index, row] of asArray(patches.get('source')).map(asObject).entries()) {
    test(`full source patch ${String(index)}`, () => {
      expect(fullSourceScanPatch(asString(row.get('path')), asString(row.get('text')))).toBe(
        asString(row.get('patch')),
      );
    });
  }

  for (const [index, row] of asArray(patches.get('instructions')).map(asObject).entries()) {
    test(`instructions patch ${String(index)}`, () => {
      expect(fixInstructionsScanPatch(asString(row.get('text')))).toBe(asString(row.get('patch')));
    });
  }

  test('pythonSplitlines matches Python boundaries', () => {
    expect(pythonSplitlines('a\r\nb\rc\nd\ve\ff\x1cg\x85h\u2028i\u2029j')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
    ]);
    expect(pythonSplitlines('')).toEqual([]);
    expect(pythonSplitlines('a\n')).toEqual(['a']);
    expect(pythonSplitlines('\n\n')).toEqual(['', '']);
  });
});

describe('round derivation against the Python oracle', () => {
  for (const row of asArray(fixture.get('round_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, async () => {
      const queue = asObject(parseJsonValue(asString(row.get('queue_json'))));
      const canonicalValue = row.get('canonical');
      const canonical = typeof canonicalValue === 'string' ? canonicalValue : undefined;
      const calls: string[] = [];
      const result = await deriveRoundCount({
        queue,
        ...(canonical === undefined ? {} : { canonicalFindingId: canonical }),
        pin: asString(row.get('pin')),
        item: asObject(asArray(queue.get('items'))[0]),
        readInboxJob: readInbox(inboxJobs(row), calls),
      });
      expect(calls).toEqual(asArray(row.get('inbox_reads')).map(asString));
      if (asBoolean(row.get('ok'))) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.basis).toBe(asString(row.get('basis')));
        expect(result.value.count).toBe(asNumber(row.get('count')));
        return;
      }
      expect(result).toEqual({ ok: false, refusal: 'round-history-unreadable' });
    });
  }

  test('PR-pin equality compares int and float exactly', async () => {
    const pin = 'a'.repeat(40);
    const queue = new JsonObject([
      [
        'items',
        [
          new JsonObject([
            ['id', 'item'],
            ['pr', JsonNumber.int('9007199254740993')],
            ['repair_runs', new JsonObject([['a', new JsonObject([['pin', pin]])]])],
          ]),
        ],
      ],
    ]);
    const result = await deriveRoundCount({
      queue,
      pin,
      item: new JsonObject([
        ['id', 'item'],
        ['pr', JsonNumber.float(9007199254740992)],
      ]),
      readInboxJob: async () => undefined,
    });
    expect(result).toEqual({ ok: true, value: { basis: 'pr-pin', count: 0 } });

    const missingQueue = new JsonObject([
      [
        'items',
        [
          new JsonObject([
            ['id', 'item'],
            ['repair_runs', new JsonObject([['a', new JsonObject([['pin', pin]])]])],
          ]),
        ],
      ],
    ]);
    const missingResult = await deriveRoundCount({
      queue: missingQueue,
      pin,
      item: new JsonObject([
        ['id', 'item'],
        ['pr', null],
      ]),
      readInboxJob: async () => undefined,
    });
    expect(missingResult).toEqual({ ok: true, value: { basis: 'pr-pin', count: 1 } });
  });
});

describe('canonical delivery validator against the Python oracle', () => {
  for (const row of asArray(fixture.get('delivery_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, () => {
      const job = asObject(parseJsonValue(asString(row.get('job_json'))));
      const rowJson = row.get('row_json');
      const rowText = typeof rowJson === 'string' ? rowJson : undefined;
      const result = canonicalDeliveryRefusal({ rowText, job });
      if (asBoolean(row.get('ok'))) {
        expect(result).toBeUndefined();
        return;
      }
      const message = asString(row.get('message'));
      const expected: RepairRefusal =
        message === 'invalid canonical finding identity'
          ? 'canonical-delivery-invalid'
          : message === 'canonical delivery state unavailable'
            ? 'canonical-delivery-unavailable'
            : 'canonical-delivery-mismatch';
      expect(result).toBe(expected);
    });
  }
});

describe('canonical handoff precondition against the Python oracle', () => {
  for (const row of asArray(fixture.get('handoff_cases')).map(asObject)) {
    const name = asString(row.get('name'));
    test(name, () => {
      const job = asObject(parseJsonValue(asString(row.get('job_json'))));
      const rowJson = row.get('row_json');
      const rowText = typeof rowJson === 'string' ? rowJson : undefined;
      const result = canonicalHandoffRefusal({
        rowText,
        job,
        findingId: CANONICAL,
        previousTask: OLD,
        preparedJobId: PREPARED,
      });
      if (asBoolean(row.get('ok'))) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.alreadyHandedOff).toBe(asBoolean(row.get('already_handed_off')));
        return;
      }
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const message = asString(row.get('message'));
      const expected: RepairRefusal =
        message === 'prepared retry no longer owns canonical finding' ||
        message === 'prepared retry source identity mismatch'
          ? 'canonical-handoff-mismatch'
          : 'canonical-handoff-unavailable';
      expect(result.refusal).toBe(expected);
    });
  }
});
