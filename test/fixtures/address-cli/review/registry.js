// Only the provider is scripted: CLI, scanners, git, ledger, gates and re-review are production.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewAddressInputSchema } from '../../../../dist/ops/review/registry.js';
import { makeReviewAddress } from '../../../../dist/ops/review/address.js';
const drivers = {
  resolve: ({ modelSpec }) => ({
    lane: 'ai-sdk',
    modelSpec,
    driver: {
      run: async (input) => {
        const path = join(input.workspace.path, 'src/a.ts');
        const text = await readFile(path, 'utf8');
        let structuredOutput;
        if (input.outputSchema.name === 'review.agent/v2') {
          structuredOutput = {
            receipt: /receipt: ([a-f0-9]{64})/.exec(input.prompt)?.[1],
            findings: text.includes('BAD')
              ? [{ file: 'src/a.ts', line: 1, severity: 'high', text: 'Replace BAD with GOOD' }]
              : [],
          };
        } else if (input.outputSchema.name === 'review.address.closure/v1') {
          structuredOutput = { closed: text.includes('GOOD'), reason: 'candidate contains GOOD' };
        } else if (modelSpec.model === 'defer') {
          structuredOutput = {
            disposition: 'deferred',
            reason: 'owner decision needed',
            evidence: [{ path: 'src/a.ts', line: 1 }],
          };
        } else {
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(path, text.replace('BAD', 'GOOD'));
          structuredOutput = {
            disposition: 'fixed',
            reason: 'correct fixture value',
            evidence: [],
          };
        }
        return {
          stopReason: 'complete',
          structuredOutput,
          denials: [],
          usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        };
      },
    },
  }),
};
export const registry = [
  {
    name: 'review.address',
    inputSchema: ReviewAddressInputSchema,
    importer: async () => makeReviewAddress({ drivers }),
  },
];
