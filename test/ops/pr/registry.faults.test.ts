// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the execFile fault taxonomy (mapGhFault) and the inert-construction pin.
import { describe, expect, test } from 'vitest';
import {
  makeSubprocessPrEffects,
  mapGhFault,
} from '../../../src/adapters/forge-github/ghEffects.js';

describe('mapGhFault (the execFile fault taxonomy)', () => {
  const ARGS = ['pr', 'view', '7'];

  test('a maxBuffer overflow is named a size limit, not a timeout', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'stdout maxBuffer length exceeded', killed: true },
      '',
      600_000,
    );
    expect(fault.message).toContain('exceeded the output limit');
    expect(fault.message).toContain('maxBuffer');
    expect(fault.message).not.toContain('timed out');
  });

  test('a SIGKILLed call is named a timeout that never produced evidence', () => {
    const fault = mapGhFault(ARGS, { message: 'command failed', killed: true }, '', 600_000);
    expect(fault.message).toContain('timed out after 600000ms');
    expect(fault.message).toContain('never produced evidence');
  });

  test('a plain nonzero exit carries the exit code and the captured stderr', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'command failed', killed: false, code: 4 },
      'GraphQL: Could not resolve to a PullRequest',
      600_000,
    );
    expect(fault.message).toContain('gh pr view (exit 4) failed');
    expect(fault.message).toContain('Could not resolve to a PullRequest');
  });

  test('a spawn failure without stderr falls back to the error message', () => {
    const fault = mapGhFault(
      ARGS,
      { message: 'spawn gh ENOENT', killed: false, code: 127 },
      '  ',
      600_000,
    );
    expect(fault.message).toContain('spawn gh ENOENT');
  });
});

describe('makeSubprocessPrEffects construction is inert', () => {
  test('the adapter is a closure set — no gh spawn at construction time', () => {
    // Construction must not touch env/network/filesystem (the importer
    // resolves it); the effects spawn only when CALLED.
    const effects = makeSubprocessPrEffects('/repo');
    expect(typeof effects.searchPrByHead).toBe('function');
    expect(typeof effects.createPr).toBe('function');
  });
});
