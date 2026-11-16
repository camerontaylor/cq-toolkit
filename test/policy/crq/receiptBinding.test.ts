/**
 * Differential test of `checkpointReviewIdentity` against live `crq._checkpoint_review_identity`
 * (`oracle/checkpoint_oracle.py`), plus the hook binder and the real `spawnSync` seam.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { nodeIdentityDeps } from '../../../src/adapters/crq/identityProcess.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
} from '../../../src/policy/crq/jsonValue.js';
import {
  bindReceiptHooks,
  checkpointReviewIdentity,
} from '../../../src/policy/crq/receiptBinding.js';
import { ProcessLaunchError } from '../../../src/policy/crq/reviewIdentity.js';

const ORACLE = fileURLToPath(new URL('./oracle/checkpoint_oracle.py', import.meta.url));
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;
const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;

interface Scenario {
  name: string;
  request: Record<string, unknown>;
  login: string;
  reason?: string | null;
}
const BASE = { run_id: 'r', pr: 7 };
const SCENARIOS: Scenario[] = [
  {
    name: 'unset records identity and reason',
    request: BASE,
    login: 'cq-review[bot]',
    reason: null,
  },
  { name: 'unset with reason', request: BASE, login: 'owner', reason: 'helper-missing' },
  {
    name: 'explicit null is unset',
    request: { ...BASE, posting_identity: null },
    login: 'a',
    reason: 'r',
  },
  {
    name: 'null keeps key order',
    request: { posting_identity: null, z: 1, identity_reason: null },
    login: 'a',
    reason: 'r',
  },
  {
    name: 'same identity is a no-op',
    request: { ...BASE, posting_identity: 'a' },
    login: 'a',
    reason: 'r',
  },
  {
    name: 'different identity throws',
    request: { ...BASE, posting_identity: 'a' },
    login: 'b',
    reason: 'r',
  },
  {
    name: 'empty string is neither',
    request: { ...BASE, posting_identity: '' },
    login: 'b',
    reason: 'r',
  },
  {
    name: 'identity_reason alone',
    request: { ...BASE, identity_reason: 'x' },
    login: 'b',
    reason: 'r',
  },
];

function viaTs(sc: Scenario): { ok?: unknown; err?: string; msg?: string; saved: number } {
  try {
    const next = checkpointReviewIdentity(doc(sc.request), sc.login, sc.reason ?? null);
    return {
      ok: { request: toPlainJson(next ?? doc(sc.request)), saved: next === null ? 0 : 1 },
      saved: next === null ? 0 : 1,
    };
  } catch (error) {
    const e = error as { pythonError?: string; name: string; message: string };
    return { err: e.pythonError ?? e.name, msg: e.message, saved: 0 };
  }
}

describe.skipIf(!HAVE_PYTHON)('checkpointReviewIdentity vs Python', () => {
  const run = spawnSync('python3', ['-I', ORACLE], {
    input: JSON.stringify(SCENARIOS),
    encoding: 'utf8',
  });
  const oracle = run.status === 0 ? (JSON.parse(run.stdout) as Array<Record<string, unknown>>) : [];
  test('oracle ran', () => {
    expect(run.status).toBe(0);
    expect(oracle).toHaveLength(SCENARIOS.length);
  });
  SCENARIOS.forEach((sc, index) => {
    test(sc.name, () => {
      const py = oracle[index] as {
        ok?: { request: unknown; saved: number };
        err?: string;
        msg?: string;
      };
      const ts = viaTs(sc);
      if (py.ok) expect(ts.ok).toEqual(py.ok);
      else expect({ err: ts.err, msg: ts.msg }).toEqual({ err: py.err, msg: py.msg });
    });
  });
});

describe('bindReceiptHooks', () => {
  test('select_receipt_identity closes over injected and forwards the checkpoint', () => {
    const seen: Array<[string, unknown]> = [];
    const hooks = bindReceiptHooks({
      injected: true,
      authenticate: () => {
        throw new Error('not called');
      },
      checkpoint: (login, reason) => seen.push([login, reason]),
      files: { readBytes: () => null },
      ndjson: '/x/review.ndjson',
    });
    const gh = () => ({ returncode: JsonNumber.int(0n), stdout: 'cq-review[bot]\n', stderr: '' });
    const out = hooks.selectIdentity(gh, 'o/r', doc({ run_id: 'r' }), 'owner');
    expect(out.login).toBe('owner');
    expect(seen).toEqual([['owner', null]]);
  });
});

describe('nodeIdentityDeps', () => {
  const deps = nodeIdentityDeps();
  test('captures stdout, stderr and the exit code and feeds stdin', () => {
    const r = deps.run(['sh', '-c', 'cat; echo err >&2; exit 3'], {
      inputText: 'hi',
      timeoutSec: 5,
      env: null,
    });
    expect(toPlainJson(r.returncode as never)).toBe(3);
    expect([r.stdout, r.stderr]).toEqual(['hi', 'err\n']);
  });
  test('uses the given env instead of the ambient one', () => {
    const r = deps.run(['sh', '-c', 'printf %s "$ONLY"'], {
      inputText: null,
      timeoutSec: 5,
      env: { ONLY: 'v', PATH: process.env.PATH ?? '' },
    });
    expect(r.stdout).toBe('v');
  });
  test('a missing command is `missing`; a timeout is `other`', () => {
    const missing = () =>
      deps.run(['definitely-not-a-command-xyz'], { inputText: null, timeoutSec: 5, env: null });
    expect(missing).toThrow(ProcessLaunchError);
    try {
      missing();
    } catch (error) {
      expect((error as ProcessLaunchError).kind).toBe('missing');
    }
    try {
      deps.run(['sleep', '5'], { inputText: null, timeoutSec: 0.1, env: null });
      throw new Error('expected a launch error');
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessLaunchError);
      expect((error as ProcessLaunchError).kind).toBe('other');
    }
  });
});
