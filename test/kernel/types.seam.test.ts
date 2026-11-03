// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the seam v2 invocation fields and the seam-compatibility/version pin.
// Sibling subjects: types.roundtrip.test.ts, types.encoded-couplings.test.ts,
// types.mirror-tightenings.test.ts, types.worker-result-wire.test.ts,
// types.dispatch-errors.test.ts; shared fixtures live in types.helpers.ts.
import { describe, expect, test } from 'vitest';
import { SEAM_VERSION } from '../../src/driver/types.js';
import type { OpInvocation } from '../../src/driver/types.js';
import * as kernelSchema from '../../src/kernel/schema.js';
import { failsParse, roundTripsThrough } from './types.helpers.js';

describe('OpInvocation.outputSchema/workspace — seam v2 invocation fields', () => {
  const base: OpInvocation = {
    prompt: 'resolve the conflict',
    modelSpec: { model: 'glm-4.7', provider: 'zai' },
    toolPolicy: { allow: ['read'] },
    sandboxPolicy: { level: 'workspace-write' },
    budget: {},
  };

  test('outputSchema parses and round-trips', () => {
    roundTripsThrough(kernelSchema.OpInvocationSchema, {
      ...base,
      outputSchema: { name: 'review.fixItem/v1', schema: { type: 'object' } },
    });
  });

  test('workspace parses and round-trips', () => {
    roundTripsThrough(kernelSchema.OpInvocationSchema, {
      ...base,
      workspace: { path: '/tmp/workspaces/ws-a' },
    });
  });

  test('an invocation with NEITHER new field still parses (v1 shape)', () => {
    roundTripsThrough(kernelSchema.OpInvocationSchema, { ...base });
  });

  test('extra keys inside outputSchema/workspace are rejected (strict mirror)', () => {
    failsParse(
      kernelSchema.OpInvocationSchema,
      {
        ...base,
        outputSchema: { name: 'x/v1', schema: {}, journalled: true },
      },
      'unknown key inside outputSchema',
    );
    failsParse(
      kernelSchema.OpInvocationSchema,
      { ...base, workspace: { path: '/tmp/ws', realpath: '/private/tmp/ws' } },
      'unknown key inside workspace',
    );
  });
});

describe('seam compatibility + version pin (ADR-0002 §2.8)', () => {
  test('a v1-shaped WorkerResult WITHOUT the new fields still parses', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete',
    });
  });

  test('SEAM_VERSION is 3', () => {
    expect(SEAM_VERSION).toBe(3);
  });
});
