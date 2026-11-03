// Split provenance: test/ops/pr/assemblePrs.test.ts was split by subject;
// this file holds the PR publication payload scanning tests (the denylist
// gate before every create and tracker update). Shared fixtures live in
// assemblePrs.helpers.ts.
import { afterAll, describe, expect, test } from 'vitest';
import { makeAssemblePrs as makeAssemblePrsWithScanner } from '../../../src/ops/pr/assemblePrs.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import {
  PKG_CORE,
  TRACKER_BRANCH,
  cleanupRepoRoot,
  failedAt,
  fakeGh,
  inputOf,
  makeAssemblePrs,
  okReport,
} from './assemblePrs.helpers.js';

afterAll(cleanupRepoRoot);

describe('PR publication payload scanning', () => {
  test('missing scanner refuses before any publication', async () => {
    const fake = fakeGh();

    const error = await failedAt(makeAssemblePrsWithScanner(fake.gh), inputOf());
    expect(error).toContain('no PR payload denylist scanner');
    expect(fake.creates).toEqual([]);
    expect(fake.edits.size).toBe(0);
  });

  test('scans the exact outgoing titles and bodies before each create and tracker update', async () => {
    const fake = fakeGh();
    const seen: string[] = [];
    const scanner: DiffSecretScanner = (components) => {
      seen.push(...components.map(({ text }) => text));
      return components.map(({ component }) => ({ component, hits: [] }));
    };

    await okReport(makeAssemblePrs(fake.gh, scanner), inputOf());

    for (const request of fake.creates) {
      expect(seen).toContain(request.title);
      if (request.body !== undefined) expect(seen).toContain(request.body);
    }
    const edited = fake.edits.get(101);
    expect(edited).toBeDefined();
    expect(seen).toContain(edited);
  });

  test('a tracker payload hit prevents tracker creation', async () => {
    const fake = fakeGh();
    const scanner: DiffSecretScanner = (components) =>
      components.map(({ component, text }) => ({
        component,
        hits: text.includes('DO_NOT_UPLOAD synthetic')
          ? [{ ruleId: 'fixture-secret', lines: [1] }]
          : [],
      }));
    const input = inputOf({
      tracker: { title: 'DO_NOT_UPLOAD synthetic', branch: TRACKER_BRANCH },
    });

    const error = await failedAt(makeAssemblePrs(fake.gh, scanner), input);
    expect(error).toContain('fixture-secret');
    expect(fake.creates).toEqual([]);
    expect(fake.edits.size).toBe(0);
  });

  test('a create diagnostic hit in the composed tracker body prevents body update', async () => {
    const fake = fakeGh({ createFaultOnHead: PKG_CORE });
    fake.gh.createPr = async (request) => {
      fake.calls.push(`create:${request.head}`);
      fake.creates.push(request);
      if (request.head === PKG_CORE) throw new Error('DO_NOT_UPLOAD synthetic');
      const number = fake.nextNumber++;
      return { number };
    };
    const scanner: DiffSecretScanner = (components) =>
      components.map(({ component, text }) => ({
        component,
        hits: text.includes('DO_NOT_UPLOAD synthetic')
          ? [{ ruleId: 'fixture-secret', lines: [1] }]
          : [],
      }));

    const error = await failedAt(makeAssemblePrs(fake.gh, scanner), inputOf());
    expect(error).toContain('fixture-secret');
    expect(fake.creates.some((request) => request.head === TRACKER_BRANCH)).toBe(true);
    expect(fake.edits.size).toBe(0);
  });

  test('a scanner fault prevents the first create', async () => {
    const fake = fakeGh();
    const scanner: DiffSecretScanner = () => {
      throw new Error('synthetic scanner fault');
    };

    const error = await failedAt(makeAssemblePrs(fake.gh, scanner), inputOf());
    expect(error).toContain('denylist scan failed');
    expect(fake.creates).toEqual([]);
    expect(fake.edits.size).toBe(0);
  });

  test.each(['missing', 'duplicate', 'wrong-component', 'missing-hits'] as const)(
    'an incomplete %s scan result prevents publication at both tracker boundaries',
    async (fault) => {
      for (const boundary of ['create', 'update'] as const) {
        const fake = fakeGh();
        const scanner: DiffSecretScanner = (components) => {
          const clean = components.map(({ component }) => ({ component, hits: [] }));
          const isUpdate = components.length === 1 && components[0]?.component === 'pr-body';
          if ((boundary === 'update') !== isUpdate) return clean;
          if (fault === 'missing') return [];
          if (fault === 'duplicate')
            return components.map(() => ({ component: 'pr-title', hits: [] }));
          if (fault === 'wrong-component')
            return components.map(() => ({ component: 'unrelated', hits: [] }));
          return components.map(({ component }) => ({
            component,
          })) as ReturnType<DiffSecretScanner>;
        };

        const error = await failedAt(makeAssemblePrs(fake.gh, scanner), inputOf());
        expect(error).toContain('denylist scanner returned an incomplete result');
        expect(fake.creates).toHaveLength(boundary === 'create' ? 0 : 3);
        expect(fake.edits.size).toBe(0);
      }
    },
  );

  test('a scanner fault on the composed tracker update prevents body upload', async () => {
    const fake = fakeGh();
    const scanner: DiffSecretScanner = (components) => {
      if (components.some(({ text }) => text.includes('`core` — #102'))) {
        throw new Error('synthetic scanner fault');
      }
      return components.map(({ component }) => ({ component, hits: [] }));
    };

    const error = await failedAt(makeAssemblePrs(fake.gh, scanner), inputOf());
    expect(error).toContain('denylist scan failed');
    expect(fake.creates).toHaveLength(3);
    expect(fake.edits.size).toBe(0);
  });
});
