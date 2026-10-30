// Script only the fixer; CLI dispatch, packet assembly and git reads are production.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewAddressInputSchema } from '../../../../dist/ops/review/registry.js';
import { makeReviewAddress } from '../../../../dist/ops/review/address.js';
import { createEscalationState } from '../../../../dist/ops/fix/escalation.js';
export const registry = [
  {
    name: 'review.address',
    inputSchema: ReviewAddressInputSchema,
    importer: async () => async (input) => {
      const git = (...args) => execFileSync('git', args, { cwd: input.repoRoot, encoding: 'utf8' }).trim();
      const role = { provider: 'mock', model: 'mock' };
      const finding = {
        id: 'demo',
        source: 'agent',
        file: 'a.ts',
        severity: 'major',
        text: 'Replace `BAD` in a.ts',
        status: 'open',
      };
      return makeReviewAddress({
        config: {
          schemaVersion: 2,
          roles: { worker: role, reviewer: role },
          checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
          budgets: { run: { maxTokens: 1000 } },
          review: { reviewers: ['agent'] },
        },
        initialRecord: {
          schemaVersion: 1,
          branch: git('branch', '--show-current'),
          head: git('rev-parse', 'HEAD'),
          sources: [{ kind: 'agent', status: 'terminal' }],
          findings: [finding],
        },
        disposition: async () => {
          throw new Error('uncertain closure must not persist disposition');
        },
        workerFactory: () => ({
          escalation: createEscalationState,
          fix: async (item) => {
            const observedHead = git('rev-parse', 'HEAD');
            await writeFile(join(input.repoRoot, 'a.ts'), 'export const value = "GOOD";\n');
            git('add', 'a.ts');
            git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', 'commit', '-qm', 'fix');
            return {
              finding: { ...item, status: 'fixed' },
              observedHead,
              commit: git('rev-parse', 'HEAD'),
              reason: 'fixed',
              validation: [],
            };
          },
        }),
      })(input);
    },
  },
];
