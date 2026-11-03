import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeRepoDiffScanner, type DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address closure source provenance', () => {
  test.each(['clean', 'parent', 'candidate', 'patch'] as const)(
    'configured path policy scans exact closure sources: %s',
    async (mode) => {
      const original = mode === 'parent' ? ' PRIVATE\n' : ' PUBLIC\n';
      const candidate = mode === 'candidate' || mode === 'patch' ? ' PRIVATE\n' : ' GOOD\n';
      const scans: Array<Array<{ text: string; path?: string }>> = [];
      let configured: DiffSecretScanner;
      let closures = 0;
      const f = await fixture(
        async (input) => {
          if (input.outputSchema?.name === 'review.address.closure/v1') {
            closures++;
            return { closed: true, reason: 'verified' };
          }
          if (!input.prompt.startsWith('related-check feedback'))
            await writeFile(join(input.workspace!.path, 'src/a.ts'), candidate);
          return { disposition: 'fixed', reason: 'fixed', evidence: [] };
        },
        '',
        {
          providerRequest: true,
          configure: (config) => {
            config.review!.denylistPatternsFile = 'patterns.yml';
          },
          scanner: async (components) => {
            if (
              components.some((part) => part.text.includes('Verify assigned-finding closure')) ||
              components.filter((part) => part.path === 'src/a.ts').length >= 3
            )
              scans.push([...components]);
            return configured(components);
          },
        },
      );
      try {
        await f.repo.write('src/a.ts', original);
        await f.repo.write(
          'patterns.yml',
          `rules:\n  - id: closure-leaf\n    description: closure source\n    regex: '${mode === 'patch' ? '^\\+ PRIVATE' : '^ PRIVATE'}'\n    path: '^src/a\\.ts$'\n    sample: '${mode === 'patch' ? '+ PRIVATE' : ' PRIVATE'}'\nclean_probes:\n  - ' PUBLIC'\n`,
        );
        f.repo.commitAll('closure policy and original leaf');
        configured = makeRepoDiffScanner(f.repo.root, 'patterns.yml');
        const result = await f.engine.fix(finding(), 1);
        expect(result.finding.status, result.reason).toBe(mode === 'clean' ? 'fixed' : 'deferred');
        expect(closures).toBe(mode === 'clean' ? 1 : 0);
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          const sources = scan.filter((part) => part.path === 'src/a.ts').slice(-3);
          expect(sources.map((part) => part.text).slice(-2)).toEqual([original, candidate]);
          expect(sources[0]!.text).toMatch(/^diff --git \S+\/src\/a\.ts \S+\/src\/a\.ts\n/);
        }
        if (mode === 'clean') expect(scans).toHaveLength(2);
        else expect(result.reason).toMatch(/upload/);
      } finally {
        await f.cleanup();
      }
    },
  );
});
