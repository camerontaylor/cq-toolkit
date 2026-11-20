import { describe, expect, test } from 'vitest';
import { decodeGitHeaderPath } from '../../../src/adapters/crq/gitPath.js';

describe('decodeGitHeaderPath', () => {
  test('strips the a/ or b/ prefix from a plain path', () => {
    expect(decodeGitHeaderPath('b/src/x.ts')).toBe('src/x.ts');
    expect(decodeGitHeaderPath('a/src/x.ts\t')).toBe('src/x.ts');
  });

  test('decodes C-style escapes and octal UTF-8 bytes', () => {
    expect(decodeGitHeaderPath('"b/src/a\\tb.ts"')).toBe('src/a\tb.ts');
    expect(decodeGitHeaderPath('"a/secr\\303\\251t.env"')).toBe('secrét.env');
  });

  test('refuses malformed quoting', () => {
    expect(decodeGitHeaderPath('"b/x\\q"')).toBeNull();
    expect(decodeGitHeaderPath('"b/x')).toBeNull();
  });
});
