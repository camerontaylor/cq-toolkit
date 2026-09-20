// T4.2 — metric SOURCES (src/ops/ratchet/sources.ts): lane C's CheckRunner is
// the injected seam that turns a plain-JSON {@link MetricSourceSpec} into the
// `(ws) => Promise<unknown | null>` MetricSource the ratchet adapters read.
//
// Pinned here (I5 throughout — every absent/unusable source is NULL, never a
// fabricated pass):
//   - `raw` returns the carried value verbatim.
//   - `command` text/json parse the captured bytes; a null exit (signal,
//     timeout, spawn fault) is non-passing evidence for both.
//   - `command` tsc-text applies the evidence classification: a clean exit 0
//     over an EMPTY capture is the authoritative `{count: 0}`; a clean exit 0
//     over non-empty output is a configuration/banner fault (null); exits 1/2
//     hand over the raw text; every other outcome is null.
//   - `file` reads workspace-relative or absolute paths; a missing/unreadable
//     file and an unparsable JSON body are null.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeMetricSource } from '../../../src/ops/ratchet/sources.js';

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-ratchet-sources-'));
  tmpDirs.push(dir);
  return dir;
}

const runnerOf =
  (out: RawCheckOutput): RunCheck =>
  async () =>
    out;

describe('makeMetricSource', () => {
  test('raw returns the carried value verbatim', async () => {
    const raw = { count: 4 };
    const source = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'raw',
      raw,
    });
    await expect(source('/ws')).resolves.toBe(raw);
  });

  test('command text returns the combined stdout+stderr', async () => {
    const source = makeMetricSource(
      runnerOf({ stdout: 'src/a.ts(1,7): error TS2322: boom\n', stderr: 'tail', exitCode: 1 }),
      { kind: 'command', command: 'tsc', args: [], parse: 'text' },
    );
    await expect(source('/ws')).resolves.toBe('src/a.ts(1,7): error TS2322: boom\ntail');
  });

  test('command json parses stdout; an unparsable body is null (I5)', async () => {
    const ok = makeMetricSource(runnerOf({ stdout: '{"count":3}', stderr: '', exitCode: 0 }), {
      kind: 'command',
      command: 'x',
      args: [],
      parse: 'json',
    });
    await expect(ok('/ws')).resolves.toEqual({ count: 3 });
    const bad = makeMetricSource(runnerOf({ stdout: 'not json', stderr: '', exitCode: 0 }), {
      kind: 'command',
      command: 'x',
      args: [],
      parse: 'json',
    });
    await expect(bad('/ws')).resolves.toBeNull();
  });

  test('command with a null exit (timeout/signal/spawn fault) is null for text/json', async () => {
    for (const parse of ['text', 'json'] as const) {
      const source = makeMetricSource(runnerOf({ stdout: 'partial', stderr: '', exitCode: null }), {
        kind: 'command',
        command: 'x',
        args: [],
        parse,
      });
      await expect(source('/ws')).resolves.toBeNull();
    }
  });

  test('command tsc-text: clean exit 0 + empty capture is the authoritative zero', async () => {
    const source = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'command',
      command: 'tsc',
      args: [],
      parse: 'tsc-text',
    });
    await expect(source('/ws')).resolves.toEqual({ count: 0 });
  });

  test('command tsc-text: exit 0 with output, and abnormal exits, are null (I5)', async () => {
    const noisySuccess = makeMetricSource(
      runnerOf({ stdout: 'unexpected banner', stderr: '', exitCode: 0 }),
      { kind: 'command', command: 'tsc', args: [], parse: 'tsc-text' },
    );
    await expect(noisySuccess('/ws')).resolves.toBeNull();
    const abnormal = makeMetricSource(runnerOf({ stdout: 'x', stderr: '', exitCode: 3 }), {
      kind: 'command',
      command: 'tsc',
      args: [],
      parse: 'tsc-text',
    });
    await expect(abnormal('/ws')).resolves.toBeNull();
    const nullExit = makeMetricSource(runnerOf({ stdout: 'x', stderr: '', exitCode: null }), {
      kind: 'command',
      command: 'tsc',
      args: [],
      parse: 'tsc-text',
    });
    await expect(nullExit('/ws')).resolves.toBeNull();
  });

  test('command tsc-text: exits 1/2 hand over the raw diagnostic text', async () => {
    const text = 'src/a.ts(1,7): error TS2322: boom\n';
    const source = makeMetricSource(runnerOf({ stdout: text, stderr: '', exitCode: 1 }), {
      kind: 'command',
      command: 'tsc',
      args: [],
      parse: 'tsc-text',
    });
    await expect(source('/ws')).resolves.toBe(text);
  });

  test('command tsc-text: compiler configuration/project-loading failures are non-passing (null)', async () => {
    // The legacy classifier refused to count `error TSxxxx:` heads and
    // `<file>.json(line,col): error TSxxxx:` heads as ordinary diagnostics
    // (I5): a broken tsconfig must never masquerade as N real errors once a
    // baseline is non-zero. Restored here for the JSON op boundary.
    for (const text of [
      "error TS18003: No inputs were found in configuration file 'tsconfig.json'.",
      "tsconfig.json(1,2): error TS5023: Unknown compiler option 'x'.",
      "error TS5083: Cannot read file 'tsconfig.json'.",
    ]) {
      for (const exitCode of [1, 2]) {
        const source = makeMetricSource(runnerOf({ stdout: text, stderr: '', exitCode }), {
          kind: 'command',
          command: 'tsc',
          args: [],
          parse: 'tsc-text',
        });
        await expect(source('/ws')).resolves.toBeNull();
      }
    }
    // A genuine diagnostic on the same exit still hands the text over — the
    // guard is scoped to the configuration/project-loading shapes, not to
    // every `error TS` prefix.
    const real = 'src/a.ts(1,7): error TS2322: Type string is not assignable.\n';
    const normal = makeMetricSource(runnerOf({ stdout: real, stderr: '', exitCode: 1 }), {
      kind: 'command',
      command: 'tsc',
      args: [],
      parse: 'tsc-text',
    });
    await expect(normal('/ws')).resolves.toBe(real);
  });

  test('file reads a workspace-relative path and parses json; missing/unparsable are null', async () => {
    const ws = await makeTmpDir();
    await writeFile(join(ws, 'coverage-summary.json'), '{"total":{"lines":{"pct":87}}}', 'utf8');
    const source = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'file',
      path: 'coverage-summary.json',
      parse: 'json',
    });
    await expect(source(ws)).resolves.toEqual({ total: { lines: { pct: 87 } } });
    const missing = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'file',
      path: 'nope.json',
      parse: 'json',
    });
    await expect(missing(ws)).resolves.toBeNull();
    await writeFile(join(ws, 'bad.json'), 'not json', 'utf8');
    const unparsable = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'file',
      path: 'bad.json',
      parse: 'json',
    });
    await expect(unparsable(ws)).resolves.toBeNull();
  });

  test('file coverage-json rounds total.lines.pct to integer percent (shared granularity law)', async () => {
    const ws = await makeTmpDir();
    await writeFile(join(ws, 'coverage-summary.json'), '{"total":{"lines":{"pct":93.46}}}', 'utf8');
    const source = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'file',
      path: 'coverage-summary.json',
      parse: 'coverage-json',
    });
    await expect(source(ws)).resolves.toEqual({ total: { lines: { pct: 93 } } });
    // A hostile/missing shape passes through untouched — the adapter rules it
    // unusable (I5), never a fabricated reading.
    await writeFile(join(ws, 'weird.json'), '"not an object"', 'utf8');
    const weird = makeMetricSource(runnerOf({ stdout: '', stderr: '', exitCode: 0 }), {
      kind: 'file',
      path: 'weird.json',
      parse: 'coverage-json',
    });
    await expect(weird(ws)).resolves.toBe('not an object');
  });
});
