// Independent review regression probe; synthetic content, no live provider.
import { expect, test } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { makeRepoDiffScanner } from '../../../src/ops/dev/denylist.js';
import { makeTestRepo, repoEffects } from './repo.js';

for (const malformed of [false, true]) {
  test(`pre-upload rule ${malformed ? 'malformed quote must refuse' : 'valid rule blocks sentinel'}`, async () => {
    const repo = await makeTestRepo();
    try {
      const scalar = malformed ? "'review334_forbidden_probe' # typo'" : "'review334_forbidden_probe'";
      await repo.write('policy/denylist/patterns.yml', [
        'rules:', '  - id: class:review334', '    description: synthetic publication guard',
        `    regex: ${scalar}`, '    sample: review334_forbidden_probe', '',
      ].join('\n'));
      await repo.write('src/a.ts', '// review334_forbidden_probe\n');
      repo.commitAll('synthetic pre-upload regression fixture');
      let uploads = 0;
      const effects = repoEffects(repo, (command) => {
        if (command !== 'coderabbit') return undefined;
        uploads += 1;
        return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
      });
      const result = await makeDevReview({ effects, scanSecrets: makeRepoDiffScanner(repo.root) })({ repoRoot: repo.root });
      console.log(JSON.stringify({ malformed, status: result.status, uploads }));
      expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
    } finally { await repo.cleanup(); }
  });
}
