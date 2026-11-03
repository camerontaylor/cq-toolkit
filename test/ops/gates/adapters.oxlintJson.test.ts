// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the oxlint-json gate cases.
import { describe, expect, test } from 'vitest';
import { adapterByName, parseCheckOutput } from '../../../src/ops/gates/index.js';

describe('oxlint-json gate', () => {
  const parse = (stdout: string, exitCode: number | null = 0) =>
    parseCheckOutput(adapterByName('oxlint-json'), { stdout, stderr: '', exitCode });
  const diagnostic = {
    message: 'Unexpected await of a non-Promise',
    code: 'typescript(await-thenable)',
    severity: 'error',
    filename: 'test/a.test.ts',
    labels: [{ span: { line: 12, column: 3 } }],
  };
  test('clean and attributed typed lint failure', () => {
    expect(parse(JSON.stringify({ diagnostics: [], number_of_files: 1 }))).toMatchObject({
      verdict: 'parsed',
      set: { failures: [] },
    });
    expect(
      parse(JSON.stringify({ diagnostics: [diagnostic], number_of_files: 1 }), 1),
    ).toMatchObject({
      verdict: 'parsed',
      set: {
        failures: [{ file: 'test/a.test.ts', line: 12, ruleId: 'typescript(await-thenable)' }],
      },
    });
  });
  test.each(['', '{}', '{"diagnostics":[]}', '{"diagnostics":[{}],"number_of_files":1}'])(
    'ambiguous %s',
    (output) => expect(parse(output).verdict).toBe('indeterminate'),
  );
  test.each([1, 2, null])('unexpected exit %s never certifies clean', (exit) => {
    expect(parse('{"diagnostics":[],"number_of_files":1}', exit).verdict).toBe('indeterminate');
    if (exit !== 1)
      expect(
        parse(JSON.stringify({ diagnostics: [diagnostic], number_of_files: 1 }), exit).verdict,
      ).toBe('indeterminate');
  });
});
