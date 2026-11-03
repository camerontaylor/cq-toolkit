// Split provenance: test/harness/surface.test.ts was split into the
// surface.*.test.ts subject files plus surface.helpers.ts; this file keeps
// the queued-cancellation pin.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createHarnessSurface, isHarnessDenial } from '../../src/harness/surface.js';
import { manifest, scratch } from './surface.helpers.js';

describe('queued cancellation (improvement pass)', () => {
  test('a call cancelled while queued never executes: an edit behind a running run does not write', async () => {
    const workspace = scratch();
    await writeFile(join(workspace, 'note.txt'), 'before\n');
    const surface = createHarnessSurface(manifest(workspace));
    const cancel = new AbortController();
    const running = surface.call('bash', { command: 'sleep 1' });
    const queued = surface.call(
      'edit',
      { path: 'note.txt', oldText: 'before', newText: 'after' },
      { signal: cancel.signal },
    );
    cancel.abort();
    await running;
    const { result, outcome } = await queued;
    expect(outcome).toEqual({
      ok: false,
      denial: {
        tool: 'edit',
        reason: 'CANCELLED: cancelled: the call was cancelled before it ran',
      },
    });
    expect(result.isError).toBe(true);
    expect(isHarnessDenial('CANCELLED: cancelled: the call was cancelled before it ran')).toBe(
      true,
    );
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('before\n');
  }, 20_000);
});
