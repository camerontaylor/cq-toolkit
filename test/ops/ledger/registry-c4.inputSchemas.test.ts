// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the strict input schemas (the
// full input, and only it).
import { describe, expect, test } from 'vitest';
import {
  LedgerQueryInputSchema,
  LedgerRecordInputSchema,
} from '../../../src/ops/ledger/registry.js';

describe('LedgerRecordInputSchema / LedgerQueryInputSchema (full input, and only it)', () => {
  test('accepts the plain JSON a dispatcher sends (root + storePath, optional fields included)', () => {
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'ws/ledger.json',
        signature: 'sig-a',
      }).success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'ws/ledger.json',
        signature: 'sig-a',
        component: 'c',
        note: 'n',
      }).success,
    ).toBe(true);
    expect(
      LedgerQueryInputSchema.safeParse({ root: 'ws', storePath: 'ws/ledger.json' }).success,
    ).toBe(true);
  });

  test('rejects smuggled unknown keys at every level (strict)', () => {
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        memoize: true,
      }).success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        thresholds: { suppressAt: 1, escalateAt: 2, cache: true },
      }).success,
    ).toBe(false);
    expect(
      LedgerQueryInputSchema.safeParse({ root: 'ws', storePath: 'l.json', store: {} }).success,
    ).toBe(false);
  });

  test('rejects missing/empty root and storePath and out-of-bounds signatures', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's' }).success).toBe(
      false,
    );
    expect(
      LedgerRecordInputSchema.safeParse({ root: '', storePath: 'l.json', signature: 's' }).success,
    ).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ root: 'ws', signature: 's' }).success).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: '', signature: 's' }).success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({ root: 'ws', storePath: 'l.json', signature: '' }).success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's'.repeat(501),
      }).success,
    ).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({}).success).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({ storePath: 'l.json' }).success).toBe(false);
  });

  test('bounds component at 200 and note at 500 chars, mirroring the op-level validation', () => {
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        component: 'c'.repeat(200),
      }).success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        component: 'c'.repeat(201),
      }).success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        note: 'n'.repeat(500),
      }).success,
    ).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        note: 'n'.repeat(501),
      }).success,
    ).toBe(false);
  });

  test('rejects an EMPTY component or note (an empty backfill would pin hollow metadata permanently)', () => {
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        component: '',
      }).success,
    ).toBe(false);
    expect(
      LedgerRecordInputSchema.safeParse({
        root: 'ws',
        storePath: 'l.json',
        signature: 's',
        note: '',
      }).success,
    ).toBe(false);
  });
});
