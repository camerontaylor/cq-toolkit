// Split provenance: test/ops/pr/registry.test.ts was split into the
// registry.*.test.ts subject files plus registry.helpers.ts; this file keeps
// the tracker-body compose protocol (composeSection and its markers).
import { describe, expect, test } from 'vitest';
import {
  composeSection,
  MANIFEST_SECTION_END_MARKER,
  MANIFEST_SECTION_MARKER,
  READINESS_SECTION_END_MARKER,
  READINESS_SECTION_MARKER,
} from '../../../src/ops/pr/assemblePrs.js';

describe('composeSection (the tracker-body compose protocol, END markers per final jMrm3)', () => {
  const manifestSection = [
    MANIFEST_SECTION_MARKER,
    '# Fleet run',
    '- `core` — #11',
    MANIFEST_SECTION_END_MARKER,
  ].join('\n');
  const readinessSection = [
    READINESS_SECTION_MARKER,
    '# Merge readiness',
    '- `core` — READY',
    READINESS_SECTION_END_MARKER,
  ].join('\n');

  test('no existing body → the section alone', () => {
    expect(composeSection(undefined, manifestSection)).toBe(`${manifestSection}\n`);
    expect(composeSection('', readinessSection)).toBe(`${readinessSection}\n`);
  });

  test('a body without the marker → the section appended, existing content preserved', () => {
    expect(composeSection('Some prose.\n', manifestSection)).toBe(
      `Some prose.\n\n${manifestSection}\n`,
    );
  });

  test('an existing span → ONLY the span between START and ITS END is replaced', () => {
    const existing = [
      'Prose header.',
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      '',
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain('Prose header.');
    expect(composed).toContain(manifestSection); // the fresh span landed
    expect(composed).not.toContain('STALE manifest line');
    expect(composed).toContain('READINESS line'); // the sibling is untouched
  });

  test('USER PROSE BELOW the section survives a span replacement (final jMrm3)', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      '',
      'User prose below the section.',
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain(manifestSection);
    expect(composed).not.toContain('STALE manifest line');
    expect(composed).toContain('User prose below the section.');
  });

  test('USER PROSE BETWEEN the sections survives either writer', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
      'Prose between the sections.',
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const viaManifest = composeSection(existing, manifestSection);
    expect(viaManifest).toContain('Prose between the sections.');
    expect(viaManifest).not.toContain('STALE manifest line');
    const viaReadiness = composeSection(existing, readinessSection);
    expect(viaReadiness).toContain('Prose between the sections.');
    expect(viaReadiness).toContain(readinessSection);
  });

  test('a descriptive `<!-- cq-toolkit …` comment is CONTENT, never a terminator (r3)', () => {
    const existing = [
      MANIFEST_SECTION_MARKER,
      '<!-- cq-toolkit fleet-run manifest: runPrefix cq/09-16a (generated; updated in place, never duplicated) -->',
      'STALE manifest bullet',
      MANIFEST_SECTION_END_MARKER,
      '',
      READINESS_SECTION_MARKER,
      '<!-- cq-toolkit fleet-run report: runPrefix cq/09-16a (generated; merge-readiness, never auto-merges) -->',
      'READINESS line',
      READINESS_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain(manifestSection); // the span was replaced up to ITS end marker
    expect(composed).not.toContain('STALE manifest bullet');
    expect(composed).toContain(READINESS_SECTION_MARKER);
    expect(composed).toContain('READINESS line');
  });

  test('LEGACY bodies without END markers: the span owns the tail (migration path)', () => {
    const existing = [MANIFEST_SECTION_MARKER, 'STALE manifest line'].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toBe(`${manifestSection}\n`);
  });

  test('replacement works regardless of section order (readiness first, manifest last)', () => {
    const existing = [
      READINESS_SECTION_MARKER,
      'READINESS line',
      READINESS_SECTION_END_MARKER,
      '',
      MANIFEST_SECTION_MARKER,
      'STALE manifest line',
      MANIFEST_SECTION_END_MARKER,
    ].join('\n');
    const composed = composeSection(existing, manifestSection);
    expect(composed).toContain('READINESS line');
    expect(composed).toContain(manifestSection);
    expect(composed).not.toContain('STALE manifest line');
  });
});
