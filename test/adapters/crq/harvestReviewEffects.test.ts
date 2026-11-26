/**
 * Replays `apps/crq-python/fixtures/crq-harvest-review-effects/cases.json`, emitted by
 * `harvest_review_effects_vectors.py` from the PRODUCTION `crq.findings_md`,
 * `crq.current_document` + `review_receipt.write_receipt` and `crq._request_pr_review`,
 * against `fileHarvestReviewEffects`. Run directories are real temporary directories.
 * Where Python lets an exception escape, the port throws the same class.
 */
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileHarvestReviewEffects,
  removeReviewWorktree,
} from '../../../src/adapters/crq/harvestReviewEffects.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
} from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';

interface Spec {
  name: string;
  op: 'findings' | 'document' | 'request';
  item: unknown;
  meta: unknown;
  cls: unknown;
  files: Record<string, string>;
  dirs: string[];
  outcome: string;
  pre: string | null;
}
interface Expected {
  error: string | null;
  key?: string;
  canonical?: string;
  receipt_id?: string;
  findings_md?: string | null;
  receipts?: string[];
  item?: unknown;
  item_keys?: string[];
}
const fixtureText = await readFile(
  new URL(
    '../../../apps/crq-python/fixtures/crq-harvest-review-effects/cases.json',
    import.meta.url,
  ),
  'utf8',
);
/** The plain parse, for fields where a float's lexeme does not matter. */
const cases = (
  JSON.parse(fixtureText) as { cases: { name: string; scenario: Spec; expected: Expected }[] }
).cases;
/** The lossless parse, so `1.0` stays a float in the inputs and in the expected item. */
const lossless = (parseJsonValue(fixtureText) as JsonObject).get('cases') as JsonObject[];
const field = (
  index: number,
  section: 'scenario' | 'expected',
  key: string,
): Record<string, unknown> =>
  toPlainJsonRetainingNumbers(
    (lossless[index]!.get(section) as JsonObject).get(key) as never,
  ) as Record<string, unknown>;
const text = (value: unknown): string =>
  pythonJsonText(fromPlainJson(value), {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });

function className(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  if (error instanceof Error && /receipt identity collision/.test(error.message))
    return 'ValueError';
  return `unmapped:${error instanceof Error ? error.message : String(error)}`;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harvest-effects-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const effects = () =>
  fileHarvestReviewEffects({
    stateRoot: root,
    pool: new GitPool(),
    worktreePrefix: 'crq-wt-',
    primaryClone: root,
  });

async function readBytes(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).isDirectory()) return '<dir>';
    return (await readFile(path)).toString('hex');
  } catch {
    return null;
  }
}

describe('harvest_review file effects against the Python oracle', () => {
  it('replays every case', () => expect(cases.length).toBeGreaterThan(50));
  for (const [index, { name, scenario: spec, expected }] of cases.entries()) {
    it(name, async () => {
      const rdir = join(root, 'runs', 'r-1');
      await mkdir(rdir, { recursive: true });
      for (const [file, hex] of Object.entries(spec.files))
        await writeFile(
          join(rdir, file === '@scan' ? 'secret-scan.json' : file),
          Buffer.from(hex, 'hex'),
        );
      for (const dir of spec.dirs) await mkdir(join(rdir, dir));
      const item = field(index, 'scenario', 'item');
      const meta = field(index, 'scenario', 'meta');
      const cls = field(index, 'scenario', 'cls') as never;
      const fx = effects();
      const receipts = join(root, 'receipts');
      let error: string | null = null;
      let key: string | undefined;
      let receiptId: string | undefined;
      try {
        if (spec.op === 'findings') await fx.writeFindings('r-1', meta, cls);
        else if (spec.op === 'request') await fx.requestPrReview(item, 'r-1', meta, cls);
        else {
          if (spec.pre === 'tamper') {
            // The oracle plants the file under the digest of the document it is about to write.
            await mkdir(receipts, { recursive: true });
            await writeFile(
              join(receipts, `${expected.receipt_id ?? (await tamperId(spec))}.json`),
              'tampered',
            );
          }
          receiptId = await fx.writeReceipt(item, spec.outcome, meta, cls, 'r-1');
          if (spec.pre === 'receipt')
            expect(await fx.writeReceipt(item, spec.outcome, meta, cls, 'r-1')).toBe(receiptId);
        }
      } catch (caught) {
        error = className(caught);
        if (caught instanceof PyError && caught.kind === 'KeyError')
          key = caught.message.replace(/^'|'$/g, '');
      }
      expect(error).toBe(expected.error);
      if (expected.key !== undefined) expect(key).toBe(expected.key);
      if (spec.op === 'findings')
        expect(await readBytes(join(rdir, 'findings.md'))).toBe(expected.findings_md);
      if (spec.op === 'document') {
        if (expected.error === null) expect(receiptId).toBe(expected.receipt_id);
        const names = await readdir(receipts).catch(() => [] as string[]);
        const seen = await Promise.all(
          names.map(async (n) => `${n}:${await readBytes(join(receipts, n))}`),
        );
        expect(seen.sort()).toEqual(expected.receipts?.map((r) => r.replace(/ /g, '')));
      }
      if (spec.op === 'request') {
        expect(Object.keys(item)).toEqual(expected.item_keys);
        expect(text(item).split(root).join('/T')).toBe(text(field(index, 'expected', 'item')));
      }
    });
  }
});

/** The receipt id of a spec's document, read from the oracle's own canonical bytes. */
async function tamperId(spec: Spec): Promise<string> {
  const { createHash } = await import('node:crypto');
  const hit = cases.find((c) => c.scenario.name === spec.name)!;
  return createHash('sha256')
    .update(Buffer.from(hit.expected.canonical!.replace(/ /g, ''), 'hex'))
    .digest('hex');
}

describe('removeReviewWorktree', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  async function repo() {
    const clone = join(root, 'clone');
    await mkdir(clone);
    git(clone, 'init', '-q', '-b', 'main');
    git(
      clone,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    return clone;
  }
  it('removes the worktree, prunes and deletes the branch', async () => {
    const clone = await repo();
    const path = join(root, 'crq-wt-r1');
    git(clone, 'worktree', 'add', '-q', '-b', 'crq/r1', path);
    const remove = removeReviewWorktree({
      pool: new GitPool(),
      worktreePrefix: 'crq-wt-',
      primaryClone: root,
    });
    await remove(path, 'crq/r1', clone);
    expect(await readBytes(path)).toBeNull();
    expect(git(clone, 'branch', '--list', 'crq/r1')).toBe('');
    expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain('crq-wt-r1');
  });
  it('sweeps a surviving prefixed directory but leaves an unprefixed one', async () => {
    const clone = await repo();
    const remove = removeReviewWorktree({
      pool: new GitPool(),
      worktreePrefix: 'crq-wt-',
      primaryClone: root,
    });
    const prefixed = join(root, 'crq-wt-stray');
    const other = join(root, 'other-stray');
    await mkdir(prefixed);
    await mkdir(other);
    await remove(prefixed, null, clone);
    await remove(other, null, clone);
    expect(await readBytes(prefixed)).toBeNull();
    expect(await readBytes(other)).toBe('<dir>');
  });
  it('leaves a prefixed symlink and its target, as shutil.rmtree does', async () => {
    const clone = await repo();
    const remove = removeReviewWorktree({
      pool: new GitPool(),
      worktreePrefix: 'crq-wt-',
      primaryClone: root,
    });
    const victim = join(root, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'f'), 'x');
    const link = join(root, 'crq-wt-link');
    await symlink(victim, link);
    await remove(link, null, clone);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readBytes(join(victim, 'f'))).not.toBeNull();
  });
  it('leaves a prefixed regular file, as shutil.rmtree does', async () => {
    const clone = await repo();
    const remove = removeReviewWorktree({
      pool: new GitPool(),
      worktreePrefix: 'crq-wt-',
      primaryClone: root,
    });
    const file = join(root, 'crq-wt-file');
    await writeFile(file, 'x');
    await remove(file, null, clone);
    expect(await readBytes(file)).not.toBeNull();
  });
  it('never raises for a missing path or branch', async () => {
    const clone = await repo();
    const remove = removeReviewWorktree({
      pool: new GitPool(),
      worktreePrefix: 'crq-wt-',
      primaryClone: root,
    });
    await expect(remove(join(root, 'absent'), 'no/such', clone)).resolves.toBeUndefined();
  });
  it('rejects a non-string worktree as TypeError', () => {
    expect(() => effects().removeWorktree(5, 'b', null)).toThrow(PyError);
  });
});
