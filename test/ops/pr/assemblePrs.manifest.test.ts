// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the tracker-write composition tests (the manifest upsert
// preserves other sections and escapes markdown). Shared fixtures live in
// assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import {
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_END_MARKER,
  READINESS_SECTION_MARKER,
} from '../../../src/ops/pr/assemblePrs.js';
import {
  PKG_CORE,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

// ---------------------------------------------------------------------------
// The section compose protocol + markdown safety (PR-165 r2#4, r2#7)
// ---------------------------------------------------------------------------

describe('the tracker write composes, never clobbers', () => {
  test('the manifest upsert preserves an existing readiness section verbatim', async () => {
    const fake = fakeGh({
      prsByHead: new Map([[TRACKER_BRANCH, { number: 7 }]]),
    });
    const readinessBody = [
      READINESS_SECTION_MARKER,
      '<!-- cq-toolkit fleet-run report: runPrefix cq/09-16a (generated; merge-readiness, never auto-merges) -->',
      '# Fleet run `cq/09-16a` — merge readiness',
      '',
      '- `core` — #11 — checks: pass; review: approved — READY',
      READINESS_SECTION_END_MARKER,
      '',
      'User prose below the section survives.',
      '',
    ].join('\n');
    fake.gh.getPrBody = async () => readinessBody;
    await okReport(makeAssemblePrs(fake.gh), inputOf());
    const written = fake.edits.get(7);
    expect(written).toContain(MANIFEST_SECTION_MARKER);
    expect(written).toContain(READINESS_SECTION_MARKER);
    expect(written).toContain('`core` — #101'); // the fresh manifest content landed
    // The readiness section survived BYTE-FOR-BYTE, prose included.
    expect(written).toContain(readinessBody.trimEnd());
  });

  test('markdown metacharacters in a package name cannot break the manifest bullets', async () => {
    const fake = fakeGh();
    await okReport(
      makeAssemblePrs(fake.gh),
      inputOf({ packages: [{ name: 'co`re<b>', branch: PKG_CORE, title: 'x' }] }),
    );
    const written = fake.edits.get(101);
    // Backticks are REPLACED with U+2019 (final jN7cZ — CommonMark does not
    // process backslash escapes inside code spans), angles stripped: the
    // generated code span can never be closed by the name.
    expect(written).toContain('`co’reb`');
    expect(written).not.toContain('co`');
    expect(written).not.toContain('\\`');
    expect(written).not.toContain('<b>');
  });

  test('a MULTILINE markdown body is accepted and transported verbatim (r3 codex jMJpG)', async () => {
    // The body rides stdin (--body-file -) straight to the PR and is never
    // interpolated into the tracker manifest — control characters and
    // newlines are its business, so the old Cc refusal is gone.
    const fake = fakeGh();
    const multilineBody = '## Notes\n\n- one\n- two\n\n```sh\nnpm test\n```';
    const result = await okReport(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [{ name: 'core', branch: PKG_CORE, title: 'core fixes', body: multilineBody }],
      }),
    );
    expect(result.packages[0]).toMatchObject({ name: 'core', created: true });
    // creates[0] is the TRACKER (tracker-first); the package create is second.
    expect(fake.creates[1]?.head).toBe(PKG_CORE);
    expect(fake.creates[1]?.body).toBe(multilineBody);
  });

  test('a non-string body is still refused naming the field', async () => {
    const fake = fakeGh();
    const error = await failedAt(
      makeAssemblePrs(fake.gh),
      inputOf({
        packages: [{ name: 'core', branch: PKG_CORE, title: 'x', body: 42 as unknown as string }],
      }),
    );
    expect(error).toContain('packages[0].body must be a string');
    expect(fake.calls).toEqual([]);
  });
});
