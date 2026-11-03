// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the plain-JSON report tests (the ok value and a faulted
// row both survive a JSON round trip unchanged). Shared fixtures live in
// assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import {
  PKG_CORE,
  PKG_UTIL,
  cleanupRepoRoot,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// Plain-JSON report
// ---------------------------------------------------------------------------

describe('the report is plain JSON', () => {
  test('the ok value survives a JSON round trip unchanged', async () => {
    const fake = fakeGh({
      prsByHead: new Map([
        [PKG_CORE, { number: 55, url: 'https://github.test/owner/repo/pull/55' }],
      ]),
    });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test('a faulted row survives a JSON round trip unchanged', async () => {
    const fake = fakeGh({ createFaultOnHead: PKG_UTIL });
    const result = await okReport(makeAssemblePrs(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
