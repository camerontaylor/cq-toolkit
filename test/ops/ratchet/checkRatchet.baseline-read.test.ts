// Split provenance: test/ops/ratchet/checkRatchet.test.ts was split into
// checkRatchet.helpers.ts (shared fixtures) and six subject files; this file
// carries the baseline-read subject — missing/corrupt baselines and the
// non-regular leaf refusal (lstat before any read).
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { match } from '../../helpers/matchers.js';
import { describe, expect, test } from 'vitest';
import { renderBaseline } from '../../../src/ops/ratchet/format.js';
import {
  CAPTURED_AT,
  check,
  checkInput,
  METRIC,
  raws,
  REL,
  TARGET,
  ws,
} from './checkRatchet.helpers.js';

describe('checkRatchet', () => {
  test('a missing baseline file fails as non-passing evidence (no dir, and dir present but empty)', async () => {
    raws[METRIC] = { count: 2 };
    // No baselines dir at all.
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(
          new RegExp(
            `baseline '${REL}' not found — metric 'typecheck-count' baseline not found \\(non-passing evidence\\)`,
          ),
        ),
      },
    });
    // Baselines dir exists, file does not.
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(new RegExp(`baseline '${REL}' not found`)),
      },
    });
  });

  test('a corrupt baseline fails naming the path', async () => {
    raws[METRIC] = { count: 2 };
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, REL), '{"schemaVersion": 999}\n', 'utf8');
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        reason: match.stringMatching(new RegExp(`baseline '${REL}' is corrupt`)),
      },
    });
  });

  test('a symlinked baseline leaf (byte-valid content outside ws) fails the leaf check, never read as evidence', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'cq-check-outside-'));
    try {
      await mkdir(join(ws, 'baselines'), { recursive: true });
      const outsideFile = join(outside, 'elsewhere.json');
      await writeFile(
        outsideFile,
        renderBaseline({
          schemaVersion: 1,
          target: TARGET,
          metric: METRIC,
          direction: 'lower-is-better',
          value: 3,
          unit: 'errors',
          capturedAt: CAPTURED_AT,
        }),
        'utf8',
      );
      await symlink(outsideFile, join(ws, REL));
      raws[METRIC] = { count: 2 };
      // lstat sees the link itself — even byte-VALID evidence behind a
      // symlink is refused, mirroring captureBaseline's write-path leaf
      // check and prune's scan guard.
      await expect(check(checkInput())).resolves.toEqual({
        status: 'ok',
        value: {
          path: REL,
          verdict: 'fail',
          baselineValue: null,
          currentValue: null,
          reason: match.stringMatching(/is not a regular file — refusing to read as evidence/),
        },
      });
      // The link was never followed — the outside bytes are untouched.
      expect(await readFile(outsideFile, 'utf8')).toContain('"value": 3');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a directory squatting at the baseline path fails the leaf check — wording distinct from not-found', async () => {
    raws[METRIC] = { count: 2 };
    await mkdir(join(ws, REL), { recursive: true });
    await expect(check(checkInput())).resolves.toEqual({
      status: 'ok',
      value: {
        path: REL,
        verdict: 'fail',
        baselineValue: null,
        currentValue: null,
        // The non-ENOENT refusal — negative lookahead pins that it is NOT
        // the missing-baseline 'not found' wording.
        reason: match.stringMatching(
          /^(?!.*not found).*is not a regular file — refusing to read as evidence/,
        ),
      },
    });
  });
});
