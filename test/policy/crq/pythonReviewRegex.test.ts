import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDenylistPatterns } from '../../../src/ops/dev/denylist.js';
import { translatePythonReviewPattern } from '../../../src/policy/crq/pythonReviewRegex.js';

const oracle = spawnSync(
  'python3.14',
  ['-c', 'import unicodedata; print(unicodedata.unidata_version)'],
  { encoding: 'utf8' },
);
describe('Python review regex subset', () => {
  it('rejects unsupported constructs and malformed expressions', () => {
    for (const pattern of [
      '(?i)x',
      '(?=x)',
      '(a)\\1',
      '\\d',
      '[a-\\s]',
      'a**',
      'a{2,1}',
      `a{1,${'9'.repeat(400)}}`,
      'a{',
      '(',
      'a|',
      '[]',
      '\\b+',
      '(^)+',
      '(\\b)*',
    ]) {
      expect(() => translatePythonReviewPattern(pattern)).toThrow('unsupported review regex');
    }
  });
  it.skipIf((oracle.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')(
    'matches Python 3.14 on policy expressions and edge vectors',
    () => {
      expect(oracle.status).toBe(0);
      expect(oracle.stdout.trim()).toBe('16.0.0');
      const policy = parseDenylistPatterns(
        readFileSync(new URL('../../../policy/denylist/patterns.yml', import.meta.url), 'utf8'),
        'fixture',
      );
      const patterns = policy.rules.flatMap((rule) =>
        rule.path ? [rule.regex, rule.path] : [rule.regex],
      );
      patterns.push(
        '\\bMARK0',
        '\\s',
        '[^\\s]+',
        '.',
        '^x$',
        'x$',
        'a{2,}',
        '(?:a|b)+',
        '^$',
        '^\\s*$',
        '^x*$',
        '^[^a]*$',
      );
      const texts = [
        'λMARK0',
        ' MARK0',
        '𐀀MARK0',
        '\ud800MARK0',
        '😀MARK0',
        '\u001c',
        '\u0085',
        '\ufeff',
        '\n',
        '\r',
        '\u2028',
        'x\n',
        'x\r',
        'aaaa',
        'ba',
        ['pk', 'abcdefghijklmno', ''].join('-'),
        ['export GITHUB_', 'TOKEN=', 'gh', 'p_', '0123456789abcdef'].join(''),
        '.env',
        '.claude/settings.local.json',
      ];
      const script =
        'import json,re,sys,unicodedata; assert unicodedata.unidata_version == "16.0.0"; p,t=json.load(sys.stdin); print(json.dumps([[bool(re.search(x,s)) for s in t] for x in p]))';
      const result = spawnSync('python3.14', ['-c', script], {
        input: JSON.stringify([patterns, texts]),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      expect(result.status).toBe(0);
      const expected: unknown = JSON.parse(result.stdout);
      const actual = patterns.map((pattern) => {
        const re = new RegExp(translatePythonReviewPattern(pattern), 'u');
        return texts.map((text) => re.test(text));
      });
      expect(actual).toEqual(expected);
    },
  );
});
