// Independent synthetic probes. No provider or network calls.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { makeRepoDiffScanner } from '../../../src/ops/dev/denylist.js';
import { makeTestRepo, repoEffects } from './repo.js';

const sentinel = 'review334_forbidden_probe';
const valid = [
  'rules:', '  - id: class:review334', '    description: synthetic guard',
  `    regex: '${sentinel}'`, `    sample: '${sentinel}'`,
  'clean_probes:', "  - 'ordinary sentence'", '',
].join('\n');
const cases: [string, string | Buffer | null][] = [
  ['valid positive control', valid],
  ['original malformed quote with complete policy', valid.replace(`regex: '${sentinel}'`, `regex: '${sentinel}' # typo'`)],
  ['empty file', ''],
  ['zero rules', 'rules:\nclean_probes:\n  - ordinary\n'],
  ['empty clean probes', valid.replace("  - 'ordinary sentence'\n", '')],
  ['missing file', null],
  ['invalid regex', valid.replace(`regex: '${sentinel}'`, "regex: '[broken'")],
  ['invalid path regex', valid.replace('clean_probes:', "    path: '[broken'\nclean_probes:")],
  ['duplicate section', valid + 'rules:\n'],
  ['duplicate rule key', valid.replace('clean_probes:', "    regex: 'weaker'\nclean_probes:")],
  ['empty scalar', valid.replace(`regex: '${sentinel}'`, "regex: ''")],
  ['bad indentation', valid.replace('    regex:', '   regex:')],
  ['tab', valid.replace('    regex:', '\tregex:')],
  ['UTF-16 policy', Buffer.from(valid, 'utf16le')],
  ['invalid UTF-8 in regex', Buffer.concat([
    Buffer.from(valid.slice(0, valid.indexOf(sentinel) + sentinel.length)),
    Buffer.from([0xff]),
    Buffer.from(valid.slice(valid.indexOf(sentinel) + sentinel.length)),
  ])],
];

test.each(cases)('%s must refuse before reviewer upload', async (label, contents) => {
  const repo = await makeTestRepo();
  try {
    if (contents !== null) {
      await repo.write('policy/denylist/patterns.yml', 'placeholder');
      await writeFile(join(repo.root, 'policy/denylist/patterns.yml'), contents);
    }
    await repo.write('src/a.ts', `// ${sentinel}\n`);
    repo.commitAll('synthetic probe');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
    });
    const result = await makeDevReview({ effects, scanSecrets: makeRepoDiffScanner(repo.root) })({ repoRoot: repo.root });
    console.log(JSON.stringify({ label, status: result.status, uploads, records: effects.openLedger('feature/x').load().records.length, reason: result.status === 'needs-human' ? result.reason : undefined }));
    expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
    if (label === 'valid positive control') expect(JSON.stringify(result)).toContain('class:review334');
    if (label === 'original malformed quote with complete policy') expect(JSON.stringify(result)).toContain('unterminated single-quoted value');
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  } finally {
    await repo.cleanup();
  }
});

test('a policy read error must refuse before reviewer upload', async () => {
  const repo = await makeTestRepo();
  try {
    await mkdir(join(repo.root, 'policy/denylist/patterns.yml'), { recursive: true });
    await repo.write('src/a.ts', `// ${sentinel}\n`);
    repo.commitAll('read-error probe');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
    });
    const result = await makeDevReview({ effects, scanSecrets: makeRepoDiffScanner(repo.root) })({ repoRoot: repo.root });
    console.log(JSON.stringify({ label: 'EISDIR', status: result.status, uploads }));
    expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
  } finally {
    await repo.cleanup();
  }
});
