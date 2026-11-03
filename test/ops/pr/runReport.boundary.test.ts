// Split provenance: moved verbatim from test/ops/pr/runReport.test.ts (shared
// fixtures in runReport.helpers.ts, which carries the suite header).
import { describe, expect, test } from 'vitest';
import { makeRunReport, type RunReportInput } from '../../../src/ops/pr/runReport.js';
import { makeReportHarness } from './runReport.helpers.js';

const { fakeGh, inputOf } = makeReportHarness();

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field
// ---------------------------------------------------------------------------

describe('boundary validation refuses bad inputs before any gh call', () => {
  test('a hostile or unsanitary runPrefix is refused at the boundary (r3 boundary parity)', async () => {
    // SEGMENT_RE parity means a backtick-bearing prefix is REFUSED too —
    // the reviewer's "escaped in the body" case is unreachable through the
    // op boundary; the reportSection mdSafe on runPrefix stays as
    // defense-in-depth for direct library callers (its siblings are pinned
    // by the markdown-metacharacter tests).
    for (const bad of ['cq/x--></textarea', 'cq/x>', 'cq/..', 'cq/a.lock', 'cq/`x`']) {
      const fake = fakeGh();
      const result = await makeRunReport(fake.gh)(inputOf({ runPrefix: bad }));
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toContain('runPrefix');
      expect(fake.edits.size).toBe(0);
    }
  });
  test('a zero, negative, or non-integer PR number is refused naming the field', async () => {
    const op = makeRunReport(fakeGh().gh);
    for (const bad of [0, -3, 1.5]) {
      const result = await op(inputOf({ packages: [{ name: 'core', number: bad }] }));
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toContain('packages[0].number');
    }
    const trackerResult = await op(inputOf({ tracker: { number: 0 } }));
    expect(trackerResult.status).toBe('failed');
    expect(trackerResult.status === 'failed' && trackerResult.error).toContain('tracker.number');
  });

  test('a non-object input and a non-array packages are refused', async () => {
    const op = makeRunReport(fakeGh().gh);
    expect((await op(null as unknown as RunReportInput)).status).toBe('failed');
    expect(
      (await op(inputOf({ packages: 'core' as unknown as RunReportInput['packages'] }))).status,
    ).toBe('failed');
  });

  test('a control character in a package NAME is refused (it feeds the tracker body)', async () => {
    const fake = fakeGh();
    const op = makeRunReport(fake.gh);
    const result = await op(inputOf({ packages: [{ name: 'util\u0000', number: 12 }] }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('packages[0].name');
    expect(fake.edits.size).toBe(0);
  });

  test('a non-object input never reaches the effects (zero calls)', async () => {
    const fake = fakeGh();
    await makeRunReport(fake.gh)(null as unknown as RunReportInput);
    expect(fake.edits.size).toBe(0);
  });
});
