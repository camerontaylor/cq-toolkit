// Fixture injection only; all fix planning, validation, git and CLI behavior is production.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FixRunInputSchema } from '../../../../dist/ops/fix/registry.js';
import { makeFixRun } from '../../../../dist/ops/fix/runFix.js';
const drivers = {
  resolve: ({ modelSpec }) => ({
    modelSpec,
    lane: 'ai-sdk',
    driver: {
      run: async (invocation) => {
        const line = invocation.prompt.split('\n').find((text) => text.startsWith('Task: '));
        const task = JSON.parse(line?.slice(6) ?? '{}');
        const edits =
          modelSpec.model === 'worker-regression' ||
          modelSpec.model === 'scripted' ||
          modelSpec.model === 'rescue-fixes' ||
          (modelSpec.model === 'worker-fixes-b' &&
            task.files.every((file) => file.includes('b.test')));
        for (const file of edits ? task.files : []) {
          const path = join(invocation.workspace.path, file);
          if (file.endsWith('.ts')) {
            const text = await readFile(path, 'utf8');
            const rule = task.failures[0]?.ruleId;
            await writeFile(
              path,
              rule === 'TS2322'
                ? text.replace('= 123', "= 'fixed'")
                : text.replace('.missing', '.length'),
            );
          } else {
            await writeFile(path, 'module.exports = { actual: 1, expected: 1 };\n');
          }
        }
        if (modelSpec.model === 'worker-regression')
          await writeFile(
            join(invocation.workspace.path, 'cases/b.test.cjs'),
            'module.exports = { actual: 1, expected: 3 };\n',
          );
        if (modelSpec.model === 'worker-fails' || modelSpec.model === 'worker-tainted') {
          for (const file of task.files)
            if (file.endsWith('.test.cjs'))
              await writeFile(
                join(invocation.workspace.path, file),
                'module.exports = { actual: 1, expected: 3 };\n',
              );
          if (modelSpec.model === 'worker-tainted')
            await writeFile(join(invocation.workspace.path, 'public-note.txt'), 'DO_NOT_UPLOAD\n');
        }
        if (modelSpec.model === 'rescue-fixes') {
          if (!invocation.prompt.includes('Prior failed-attempt patch'))
            throw new Error('rescue prompt omitted prior failed-attempt patch feedback');
          if (!invocation.prompt.includes('expected: 3'))
            throw new Error('rescue prompt omitted prior failed-attempt source patch');
        }
        return {
          stopReason: 'complete',
          denials: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          structuredOutput: {
            outcome: task.files.some((file) => file.endsWith('.ts')) ? 'code-bug' : 'broken-test',
            summary: 'correct fixture expectation',
            confidence: 0.8,
          },
        };
      },
    },
  }),
};
export const registry = [
  {
    name: 'fix.run',
    inputSchema: FixRunInputSchema,
    importer: async () => makeFixRun({ drivers }),
  },
];
