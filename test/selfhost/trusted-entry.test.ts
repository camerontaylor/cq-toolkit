// Residual R1 — the carrier contract the trusted selfhost entry points share
// (src/selfhost/trusted-entry.ts): strict `--name=value` argv, ONE JSON
// line on stdout, and the I1 exit codes (policy/DOCTRINE.md).
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { OpResult } from '../../src/kernel/types.js';
import {
  decimalFlag,
  EntryUsageError,
  exitCodeFor,
  parseEntryArgs,
  runEntry,
} from '../../src/selfhost/trusted-entry.js';

const Schema = z
  .object({
    name: z.string().min(1),
    count: decimalFlag(z.number().int().positive()).exactOptional(),
  })
  .strict();

describe('parseEntryArgs', () => {
  test('parses --name=value flags through the schema', () => {
    expect(parseEntryArgs(['--name=a=b', '--count=12'], Schema)).toEqual({
      name: 'a=b',
      count: 12,
    });
  });

  test.each([
    [['name=a'], 'unknown argument'],
    [['--name'], 'unknown argument'],
    [['--name=a', '--name=b'], 'given more than once'],
    [['--name='], 'needs a value'],
    [['--name=a', '--other=1'], 'other'],
    [['--count=1'], '--name'],
  ])('%j is a usage error (%s)', (argv, message) => {
    expect(() => parseEntryArgs(argv, Schema)).toThrow(EntryUsageError);
    expect(() => parseEntryArgs(argv, Schema)).toThrow(message);
  });

  test.each(['0', '-1', '+1', '1e3', '0x10', '012', ' 1', '1.0', '9007199254740993'])(
    'a numeric flag refuses %j',
    (value) => {
      expect(() => parseEntryArgs(['--name=a', `--count=${value}`], Schema)).toThrow(
        EntryUsageError,
      );
    },
  );
});

describe('exitCodeFor (I1)', () => {
  test.each([
    ['ok', 0],
    ['failed', 1],
    ['indeterminate', 1],
    ['needs-human', 3],
    ['budget-exhausted', 3],
    ['something-new', 1],
  ])('%s → %i', (status, code) => {
    expect(exitCodeFor({ status } as unknown as OpResult<unknown>)).toBe(code);
  });
});

describe('runEntry', () => {
  const run = async (compute: () => Promise<OpResult<unknown>>) => {
    const lines: string[] = [];
    const code = await runEntry(compute, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(lines[0]?.slice(0, -1)).not.toContain('\n');
    return { code, result: JSON.parse(lines[0] ?? '') as OpResult<unknown> };
  };

  test('an ok result is written as one line, exit 0', async () => {
    expect(await run(() => Promise.resolve({ status: 'ok', value: { n: 1 } }))).toEqual({
      code: 0,
      result: { status: 'ok', value: { n: 1 } },
    });
  });

  test('a usage error is a failed result, exit 2', async () => {
    const out = await run(() => {
      throw new EntryUsageError('--x: bad');
    });
    expect(out).toEqual({ code: 2, result: { status: 'failed', error: '--x: bad' } });
  });

  test('any other throw is a failed result, exit 1', async () => {
    const out = await run(() => Promise.reject(new Error('boom')));
    expect(out).toEqual({ code: 1, result: { status: 'failed', error: 'boom' } });
  });
});
