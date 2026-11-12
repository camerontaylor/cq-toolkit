// #1198 — the expectation-change observer: a test file hunk that removes and
// re-adds a line inside an assertion call yields one
// `{file, line, before, after}` entry; source-only fixes, non-assertion test
// edits, one-sided edits and non-test files yield none.
import { expect, test } from 'vitest';
import { expectationChangesOf } from '../../../src/ops/gates/expectationChanges.js';

const diffOf = (path: string, body: string): string =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

test('a rewritten assertion value in a test file is one entry with the before/after pair', () => {
  const diff = diffOf(
    'test/a.test.ts',
    [
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-expect(x).toBe(1);',
      '+expect(x).toBe(2);',
      ' debug();',
      '',
    ].join('\n'),
  );
  expect(expectationChangesOf(diff)).toEqual([
    { file: 'test/a.test.ts', line: 2, before: 'expect(x).toBe(1);', after: 'expect(x).toBe(2);' },
  ]);
});

test('the same rewrite in a source file is not an expectation dispute', () => {
  const diff = diffOf(
    'src/a.ts',
    ['@@ -1,3 +1,3 @@', ' const x = 1;', '-expect(x).toBe(1);', '+expect(x).toBe(2);', ''].join(
      '\n',
    ),
  );
  expect(expectationChangesOf(diff)).toEqual([]);
});

test('a non-assertion line change inside a test file yields no entry', () => {
  const diff = diffOf(
    'test/a.test.ts',
    [
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = compute(1);',
      '+const y = compute(2);',
      ' expect(y).toBe(4);',
      '',
    ].join('\n'),
  );
  expect(expectationChangesOf(diff)).toEqual([]);
});

test('added-only or removed-only assertion lines yield no entry', () => {
  const added = diffOf(
    'test/a.test.ts',
    ['@@ -1 +1,2 @@', ' const x = 1;', '+expect(x).toBe(2);', ''].join('\n'),
  );
  const removed = diffOf(
    'test/a.test.ts',
    ['@@ -1,2 +1 @@', ' const x = 1;', '-expect(x).toBe(1);', ''].join('\n'),
  );
  expect(expectationChangesOf(added)).toEqual([]);
  expect(expectationChangesOf(removed)).toEqual([]);
});

test('an assertion re-added verbatim is a reformat, not a value dispute', () => {
  const diff = diffOf(
    'test/a.test.ts',
    ['@@ -1,3 +1,3 @@', '-  expect(x).toBe(1);', '+expect(x).toBe(1);', ''].join('\n'),
  );
  expect(expectationChangesOf(diff)).toEqual([]);
});

test('line numbers follow the new file across hunks', () => {
  const diff = diffOf(
    'test/a.test.ts',
    [
      '@@ -2,3 +2,3 @@',
      ' keep();',
      '-expect(a).toEqual(1);',
      '+expect(a).toEqual(2);',
      ' keep();',
      '@@ -10,3 +10,3 @@',
      ' keep();',
      '-assert b == 1',
      '+assert b == 2',
      ' keep();',
      '',
    ].join('\n'),
  );
  expect(expectationChangesOf(diff)).toEqual([
    {
      file: 'test/a.test.ts',
      line: 3,
      before: 'expect(a).toEqual(1);',
      after: 'expect(a).toEqual(2);',
    },
    { file: 'test/a.test.ts', line: 11, before: 'assert b == 1', after: 'assert b == 2' },
  ]);
});

test('one edit block pairs removals with re-additions in order; a context line ends the block', () => {
  const diff = diffOf(
    'tests/b.test.ts',
    [
      '@@ -1,4 +1,4 @@',
      '-expect(a).toBe(1);',
      '-expect(b).toBe(1);',
      '+expect(a).toBe(2);',
      '+expect(b).toBe(3);',
      ' context();',
      '-expect(c).toBe(1);',
      '+expect(c).toBe(4);',
      '',
    ].join('\n'),
  );
  expect(expectationChangesOf(diff)).toEqual([
    { file: 'tests/b.test.ts', line: 1, before: 'expect(a).toBe(1);', after: 'expect(a).toBe(2);' },
    { file: 'tests/b.test.ts', line: 2, before: 'expect(b).toBe(1);', after: 'expect(b).toBe(3);' },
    { file: 'tests/b.test.ts', line: 4, before: 'expect(c).toBe(1);', after: 'expect(c).toBe(4);' },
  ]);
});

test('a malformed non-diff text yields no entry and never throws', () => {
  expect(expectationChangesOf('hello\nworld\n')).toEqual([]);
  expect(expectationChangesOf('')).toEqual([]);
});
