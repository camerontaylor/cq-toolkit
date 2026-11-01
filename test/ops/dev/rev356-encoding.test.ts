// Independent head-bound probes. Real git, synthetic policy, no provider calls.
import { chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { decodePolicyUtf8 } from '../../../src/ops/dev/denylist.js';
import { makeRepoDiffScanner } from '../../../src/ops/dev/denylist.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { makeTestRepo, repoEffects } from './repo.js';

const sentinel = 'review334_forbidden_probe';
const valid = [
  'rules:', '  - id: class:review334', '    description: synthetic guard',
  `    regex: '${sentinel}'`, `    sample: '${sentinel}'`,
  'clean_probes:', "  - 'ordinary sentence'", '',
].join('\n');
const malformed = (bytes: number[], source = valid): Buffer => {
  const at = source.indexOf(sentinel) + sentinel.length;
  return Buffer.concat([Buffer.from(source.slice(0, at)), Buffer.from(bytes), Buffer.from(source.slice(at))]);
};
const cases: [string, string | Buffer, string][] = [
  ['CRLF complete policy', valid.replaceAll('\n', '\r\n'), 'class:review334 in committed:src/a.ts'],
  ['BOM before rules', `\uFEFF${valid}`, 'content before the first section'],
  ['BOM before comment', `\uFEFF# policy\n${valid}`, 'class:review334 in committed:src/a.ts'],
  ['CRLF malformed quote', valid.replace(`regex: '${sentinel}'`, `regex: '${sentinel}' # typo'`).replaceAll('\n', '\r\n'), 'unterminated single-quoted value'],
  ['overlong encoding', malformed([0xc0, 0xaf]), 'not valid UTF-8'],
  ['encoded surrogate', malformed([0xed, 0xa0, 0x80]), 'not valid UTF-8'],
  ['out of Unicode range', malformed([0xf4, 0x90, 0x80, 0x80]), 'not valid UTF-8'],
  ['truncated four-byte sequence', malformed([0xf0, 0x9f, 0x92]), 'not valid UTF-8'],
  ['stray continuation', malformed([0x80]), 'not valid UTF-8'],
  ['invalid byte in comment', Buffer.concat([Buffer.from('# comment '), Buffer.from([0xff]), Buffer.from(`\n${valid}`)]), 'not valid UTF-8'],
  ['UTF-16BE BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(valid)]), 'not valid UTF-8'],
];

test.each(cases)('%s refuses for the intended scan reason', async (label, policy, reason) => {
  const repo = await makeTestRepo();
  try {
    await repo.write('policy/denylist/patterns.yml', policy);
    await repo.write('src/a.ts', `// ${sentinel}\n`);
    repo.commitAll('encoding probe');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
    });
    const result = await makeDevReview({ effects, scanSecrets: makeRepoDiffScanner(repo.root) })({ repoRoot: repo.root });
    expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
    expect(result.status === 'needs-human' && result.reason).toContain(reason);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
    console.log(JSON.stringify({ label, status: result.status, uploads, records: 0 }));
  } finally { await repo.cleanup(); }
});

test('well-formed literal U+FFFD and multibyte text are decoded without substitution', () => {
  const text = 'literal replacement \uFFFD, café, 🧪';
  expect(decodePolicyUtf8(Buffer.from(text), 'probe')).toBe(text);
});

test.each(['EACCES', 'ELOOP'])('%s read error refuses before upload', async (fault) => {
  const repo = await makeTestRepo();
  const policy = join(repo.root, 'policy/denylist/patterns.yml');
  try {
    if (fault === 'EACCES') {
      await repo.write('policy/denylist/patterns.yml', valid);
      repo.commitAll('read error');
    } else {
      await repo.write('policy/denylist/placeholder', 'placeholder');
      await symlink('patterns.yml', policy);
      repo.commitAll('read error');
    }
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
    });
    const scan = makeRepoDiffScanner(repo.root);
    const result = await makeDevReview({ effects, scanSecrets: async (components) => {
      // Apply permissions at the scan seam so git's earlier state read cannot mask the factory error.
      if (fault === 'EACCES') await chmod(policy, 0);
      return scan(components);
    } })({ repoRoot: repo.root });
    expect({ status: result.status, uploads }).toEqual({ status: 'needs-human', uploads: 0 });
    expect(result.status === 'needs-human' && result.reason).toContain(fault);
    expect(effects.openLedger('feature/x').load().records).toEqual([]);
  } finally {
    if (fault === 'EACCES') await chmod(policy, 0o600);
    await repo.cleanup();
  }
});

test('clean complete policy permits the scripted reviewer and records a terminal cycle', async () => {
  const repo = await makeTestRepo();
  try {
    await repo.write('policy/denylist/patterns.yml', valid);
    repo.commitAll('clean control');
    let uploads = 0;
    const effects = repoEffects(repo, (command) => {
      if (command !== 'coderabbit') return undefined;
      uploads += 1;
      return JSON.stringify({ type: 'complete', status: 'review_completed' }) + '\n';
    });
    const result = await makeDevReview({ effects, scanSecrets: makeRepoDiffScanner(repo.root) })({ repoRoot: repo.root });
    expect({ status: result.status, uploads }).toEqual({ status: 'ok', uploads: 1 });
    expect(effects.openLedger('feature/x').load().records).toHaveLength(1);
  } finally { await repo.cleanup(); }
});
