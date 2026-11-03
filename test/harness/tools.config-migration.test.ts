// Split provenance: test/harness/tools.test.ts was split by subject into the
// tools.*.test.ts siblings in this directory (shared fixtures live in
// tools.helpers.ts). This file keeps the F1 config-migration cases.
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig, HarnessConfigSchema } from '../../src/harness/config.js';

describe('F1 config migration', () => {
  test('the legacy tools.run key normalises to tools.bash; both keys are refused', () => {
    const parsed = HarnessConfigSchema.parse({
      tools: {
        read: defaultHarnessConfig.tools.read,
        edit: defaultHarnessConfig.tools.edit,
        run: { enabled: true, commandPatterns: ['echo'] },
      },
      promptBudget: defaultHarnessConfig.promptBudget,
    });
    expect(parsed.tools.bash.commandPatterns).toEqual(['echo']);
    expect(parsed.tools.write.enabled).toBe(true);

    expect(() =>
      HarnessConfigSchema.parse({
        tools: {
          read: defaultHarnessConfig.tools.read,
          edit: defaultHarnessConfig.tools.edit,
          bash: { enabled: true, commandPatterns: ['echo'] },
          run: { enabled: true, commandPatterns: ['echo'] },
        },
        promptBudget: defaultHarnessConfig.promptBudget,
      }),
    ).toThrow(/mutually exclusive/);
  });
});
