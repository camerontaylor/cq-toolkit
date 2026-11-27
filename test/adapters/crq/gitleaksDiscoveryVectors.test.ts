/**
 * Replays `apps/crq-python/fixtures/crq-gitleaks-discovery/cases.json`, emitted by
 * `gitleaks_discovery_vectors.py` from the PRODUCTION `shutil.which("gitleaks", path=...)` of
 * Python 3.14, against `findGitleaksOnPath`, and re-runs the same scenarios against a LIVE
 * Python 3.14 (so root, where the committed fixture does not apply, is still compared).
 * Fake executables only; nothing here runs a gitleaks.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_PATH,
  findGitleaksOnPath,
} from '../../../src/adapters/crq/gitleaksDiscovery.js';
import { oraclePython } from '../../helpers/oraclePython.js';

type Op =
  | ['file', string, number]
  | ['dir', string]
  | ['symlink', string, string]
  | ['fifo', string, number]
  | ['chmod', string, number];
interface Scenario {
  name: string;
  path: string[];
  ops: Op[];
  cwd: string;
}
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/crq-gitleaks-discovery/cases.json', import.meta.url),
    'utf8',
  ),
) as {
  unset: {
    confstr_consulted: boolean;
    confstr_search_found: string;
    empty_string: null;
    cs_path: string;
  };
  cases: { name: string; scenario: Scenario; expected: string | null }[];
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Undo the permission scenarios so the tree can be removed.
    spawnSync('chmod', ['-R', 'u+rwx', root]);
    rmSync(root, { recursive: true, force: true });
  }
});

function materialize(scenario: Scenario): { tmp: string; path: string; cwd: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'gl-disc-ts-'));
  roots.push(tmp);
  const sub = (s: string): string => s.replaceAll('/T', tmp);
  mkdirSync(sub(scenario.cwd), { recursive: true });
  for (const op of scenario.ops) {
    if (op[0] === 'file') {
      mkdirSync(join(sub(op[1]), '..'), { recursive: true });
      writeFileSync(sub(op[1]), '#!/bin/sh\n');
      chmodSync(sub(op[1]), op[2]);
    } else if (op[0] === 'dir') mkdirSync(sub(op[1]), { recursive: true });
    else if (op[0] === 'symlink') {
      mkdirSync(join(sub(op[1]), '..'), { recursive: true });
      symlinkSync(sub(op[2]), sub(op[1]));
    } else if (op[0] === 'fifo') {
      mkdirSync(join(sub(op[1]), '..'), { recursive: true });
      spawnSync('mkfifo', ['-m', op[2].toString(8), sub(op[1])]);
    } else chmodSync(sub(op[1]), op[2]);
  }
  return { tmp, path: scenario.path.map(sub).join(':'), cwd: sub(scenario.cwd) };
}

/** The cwd prefixed to Python's relative answer, with no lexical normalisation. */
const joinUnnormalised = (cwd: string, answer: string): string =>
  answer.startsWith('/') ? answer : `${cwd}/${answer}`;

const isRoot = process.geteuid?.() === 0;

describe('gitleaks discovery differential (shutil.which, Python 3.14)', () => {
  it('has the committed scenarios', () => {
    expect(fixture.cases.length).toBeGreaterThan(40);
  });

  describe.skipIf(isRoot)('fixture replay (non-root)', () => {
    for (const c of fixture.cases) {
      it(c.name, () => {
        const { tmp, path, cwd } = materialize(c.scenario);
        const found = findGitleaksOnPath(path, { cwd });
        // Python returns the joined string, relative for a relative entry; ours is the cwd prefix of it, never normalised.
        const expected =
          c.expected === null ? null : joinUnnormalised(cwd, c.expected.replace('/T', tmp));
        expect(found).toBe(expected);
      });
    }
  });

  describe('live Python 3.14 (any uid, including root)', () => {
    const python = oraclePython();
    for (const c of fixture.cases) {
      it(c.name, () => {
        const { path, cwd } = materialize(c.scenario);
        // Arguments cannot carry a NUL byte, so the scenario goes in on stdin as JSON.
        const live = spawnSync(
          python,
          [
            '-I',
            '-c',
            'import json,os,shutil,sys\nd=json.load(sys.stdin)\nos.chdir(d["cwd"])\nr=shutil.which("gitleaks",path=d["path"])\nprint("" if r is None else "R"+r)',
          ],
          { encoding: 'utf8', input: JSON.stringify({ path, cwd }) },
        );
        expect(live.status).toBe(0);
        const out = live.stdout.replace(/\n$/, '');
        const pyFound = out === '' ? null : joinUnnormalised(cwd, out.slice(1));
        expect(findGitleaksOnPath(path, { cwd })).toBe(pyFound);
      });
    }
  });

  describe('unset and empty PATH', () => {
    it('pins the unset search path to the CS_PATH Python consults', () => {
      expect(fixture.unset.confstr_consulted).toBe(true);
      expect(fixture.unset.empty_string).toBeNull();
      expect(DEFAULT_SEARCH_PATH).toBe(fixture.unset.cs_path);
      expect(findGitleaksOnPath('')).toBeNull();
    });
    it('searches the default path for an unset PATH (the confstr value, not a literal order swap)', () => {
      const live = spawnSync(
        oraclePython(),
        ['-I', '-c', 'import os;print(os.confstr("CS_PATH"))'],
        { encoding: 'utf8' },
      );
      expect(live.stdout.trim()).toBe(DEFAULT_SEARCH_PATH);
    });
  });

  describe('named deviations from Python', () => {
    it("emptyEntries:'skip' ignores an empty entry that Python reads as the cwd", () => {
      const c = fixture.cases.find((x) => x.name === 'empty entry means the cwd');
      if (c === undefined) throw new Error('missing scenario');
      const { tmp, path, cwd } = materialize(c.scenario);
      expect(findGitleaksOnPath(path, { cwd })).toBe(`${cwd}/gitleaks`);
      expect(findGitleaksOnPath(path, { cwd, emptyEntries: 'skip' })).toBe(
        join(tmp, 'b', 'gitleaks'),
      );
    });
    it('returns an absolute path where Python returns the relative join', () => {
      const c = fixture.cases.find((x) => x.name === 'relative entry');
      if (c === undefined) throw new Error('missing scenario');
      const { cwd, path } = materialize(c.scenario);
      expect(c.expected).toBe('rel/gitleaks');
      expect(findGitleaksOnPath(path, { cwd })).toBe(`${cwd}/rel/gitleaks`);
    });
  });
});
