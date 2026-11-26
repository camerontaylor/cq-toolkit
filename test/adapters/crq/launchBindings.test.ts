/**
 * Replays `apps/crq-python/fixtures/crq-launch-bindings/cases.json`, emitted by
 * `launch_bindings_vectors.py` from the PRODUCTION `author_lease.check_queue` /
 * `grant_queue`, `review_transport.clone_for`, `crq.secret_scan` /
 * `secret_scan_diff`, the backfill context scan and `crq.save_queue`, against
 * `fileLaunchBindings`. Scans run in real throwaway git repositories (tags `base`
 * and `head`, the denylist at `origin/main`); gitleaks is absent on both sides.
 * Where Python lets an exception escape, the binding throws the same class.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchReviewRegexBatch } from '../../../dist/adapters/crq/reviewRegexMatcher.js';
import { fileLaunchBindings } from '../../../src/adapters/crq/launchBindings.js';
import { parseJsonValue, toPlainJsonRetainingNumbers } from '../../../src/policy/crq/jsonValue.js';
import type { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import { StartAuthorRefused } from '../../../src/queue-runner/startOne.js';

type Files = Record<string, string>;
interface Spec {
  name: string;
  op: string;
  item?: unknown;
  at?: unknown;
  repo?: unknown;
  repos?: { repo: string; clone: string }[];
  queue?: unknown;
  base?: Files;
  head?: Files;
  patterns?: string;
  classes?: string[] | null;
  spec?: string;
}
interface Expected {
  error: string | null;
  message?: string | null;
  item?: unknown;
  value?: string;
  queue?: string;
  siblings?: string[];
  ok?: boolean;
  scan?: Record<string, unknown>;
  artifact?: string;
}
const fixtureText = await readFile(
  new URL('../../../apps/crq-python/fixtures/crq-launch-bindings/cases.json', import.meta.url),
  'utf8',
);
const cases = (
  JSON.parse(fixtureText) as { cases: { name: string; scenario: Spec; expected: Expected }[] }
).cases;
const lossless = (parseJsonValue(fixtureText) as JsonObject).get('cases') as JsonObject[];
const field = (index: number, section: 'scenario' | 'expected', key: string): unknown => {
  const holder = lossless[index]!.get(section) as JsonObject;
  return holder.has(key) ? toPlainJsonRetainingNumbers(holder.get(key) as never) : undefined;
};

const CORPUS = await readFile(
  new URL('../../../policy/denylist/patterns.yml', import.meta.url),
  'utf8',
);

function className(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  if (error instanceof StartAuthorRefused) return 'AuthorRefused';
  return `unmapped:${error instanceof Error ? error.message : String(error)}`;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
};
async function commit(repo: string, files: Files, message: string, previous: Files): Promise<void> {
  for (const name of Object.keys(previous))
    if (!(name in files) && existsSync(join(repo, name))) await unlink(join(repo, name));
  for (const [name, hex] of Object.entries(files)) {
    await mkdir(dirname(join(repo, name)), { recursive: true });
    await writeFile(join(repo, name), Buffer.from(hex, 'hex'));
  }
  git(repo, 'add', '-A', '-f');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
}
async function makeRepo(root: string, spec: Spec): Promise<string> {
  const repo = join(root, 'clone');
  await mkdir(join(repo, 'policy', 'denylist'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(
    join(repo, 'policy', 'denylist', 'patterns.yml'),
    spec.patterns === undefined ? CORPUS : Buffer.from(spec.patterns, 'hex'),
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'patterns');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await commit(repo, spec.base ?? {}, 'base', {});
  git(repo, 'tag', 'base');
  await commit(repo, spec.head ?? {}, 'head', spec.base ?? {});
  git(repo, 'tag', 'head');
  return repo;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launch-bindings-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const text = (value: unknown): string =>
  pythonJsonText(fromPlainJson(value), {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });

describe('launch bindings against the Python oracle', () => {
  it('replays every case', () => expect(cases.length).toBeGreaterThan(80));
  for (const [index, { name, scenario: spec, expected }] of cases.entries()) {
    it(name, async () => {
      let error: string | null = null;
      let message: string | null = null;
      const out: Partial<Expected> = {};
      try {
        if (spec.op === 'author-check' || spec.op === 'author-grant') {
          const fx = fileLaunchBindings(bindings(null));
          const item = field(index, 'scenario', 'item') as never;
          (spec.op === 'author-check' ? fx.checkAuthor : fx.grantAuthor)(item, spec.at as never);
          out.item = item;
        } else if (spec.op === 'clone') {
          const repos = (spec.repos ?? []).map((r) => ({
            repo: r.repo,
            clone: r.clone.replace('/T', root),
          }));
          const fx = fileLaunchBindings({ ...bindings(null), repos });
          out.value = await fx.onDemandClone(spec.repo as never);
        } else if (spec.op === 'save') {
          const queue = field(index, 'scenario', 'queue') as never;
          const fx = fileLaunchBindings({ ...bindings(null), queue: () => queue });
          await fx.saveQueue();
          out.queue = (await readFile(join(root, 'queue.json'))).toString('hex');
          out.siblings = (await readdir(root)).sort();
        } else if (spec.op === 'revparse') {
          const repo = await makeRepo(root, {} as Spec);
          out.value = await fileLaunchBindings(bindings(repo)).revParse(spec.spec!, null);
        } else {
          const repo = await makeRepo(root, spec);
          const rdir = join(root, 'run');
          await mkdir(rdir);
          const fx = fileLaunchBindings(bindings(repo));
          const decision =
            spec.op === 'scan'
              ? await fx.scan({
                  mode: 'range',
                  item: {},
                  base: 'base',
                  head: 'head',
                  exemptionBase: null,
                  clone: repo,
                  classes: spec.classes ?? null,
                  rdir,
                })
              : await fx.scanBackfillContext({
                  item: field(index, 'scenario', 'item') as never,
                  base: 'base',
                  head: 'head',
                  rdir,
                } as never);
          out.ok = decision.ok;
          const file = spec.op === 'scan' ? 'secret-scan.json' : 'context-secret-scan.json';
          const bytes = await readFile(join(rdir, file));
          out.artifact = bytes.toString('hex');
          out.scan = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        }
      } catch (caught) {
        error = className(caught);
        message = caught instanceof Error ? caught.message : String(caught);
      }
      // Non-UTF-8 git output is a ValueError here, its subclass UnicodeDecodeError in Python.
      const expectedClass =
        expected.error === 'UnicodeDecodeError' && error === 'ValueError'
          ? 'ValueError'
          : expected.error;
      expect(error, String(message)).toBe(expectedClass);
      if (expected.error !== null) {
        if (expected.message && expected.error !== 'UnicodeDecodeError')
          expect(message).toBe(expected.message);
        return;
      }
      if (spec.op === 'scan' || spec.op === 'context') {
        expect(out.ok).toBe(expected.ok);
        const want = { ...expected.scan };
        const got = { ...out.scan };
        if (typeof want.exemption_error === 'string') {
          // The TOML parser's own wording differs from tomllib's; the prefix and the fail-closed result do not.
          expect(String(got.exemption_error)).toMatch(/^\.crq\/scan-exemptions\.toml: ./);
          delete want.exemption_error;
          delete got.exemption_error;
        } else expect(out.artifact).toBe(expected.artifact);
        expect(got).toEqual(want);
        return;
      }
      if (out.item !== undefined)
        expect(text(out.item)).toBe(text(field(index, 'expected', 'item')));
      if (spec.op === 'clone' || spec.op === 'revparse')
        expect(out.value?.split(root).join('/T')).toBe(expected.value);
      if (spec.op === 'save') {
        expect(out.queue).toBe(expected.queue);
        expect(out.siblings).toEqual(expected.siblings);
      }
    });
  }
});

function bindings(repo: string | null) {
  return {
    stateRoot: join(root, 'state'),
    queuePath: join(root, 'queue.json'),
    queue: () => ({}),
    primaryClone: repo ?? join(root, 'primary'),
    primaryRepo: 'org/primary',
    repos: [] as { repo: string; clone: string }[],
    gitleaks: async () => ({ kind: 'not-run' as const }),
    match: matchReviewRegexBatch,
  };
}

describe('projection scans (no Python callable: `launch` inlines them)', () => {
  const honoured = cases.findIndex(
    (c) => c.name === 'scan: an exemption on the base honours a hit',
  );
  const run = async (exemptionBase: string | null): Promise<boolean> => {
    const spec = cases[honoured]!.scenario;
    const repo = await makeRepo(root, spec);
    const rdir = join(root, 'run');
    await mkdir(rdir);
    const decision = await fileLaunchBindings(bindings(repo)).scan({
      mode: 'projection',
      item: {},
      base: 'base',
      head: 'head',
      exemptionBase,
      clone: repo,
      classes: null,
      rdir,
    });
    return decision.ok;
  };
  it('honours an exemption read from the resolved exemption base', async () => {
    expect(honoured).toBeGreaterThanOrEqual(0);
    expect(await run('base')).toBe(true);
  });
  it('honours none without an exemption base', async () => {
    expect(await run(null)).toBe(false);
  });
});
