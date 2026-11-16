import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { fileRepairDispatchEffects } from '../../../src/adapters/crq/repairDispatchSource.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dispatch-source-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const enc = (s: string | Uint8Array): Uint8Array =>
  typeof s === 'string' ? new TextEncoder().encode(s) : s;
function fake(reply: (args: readonly string[]) => { code: number; out: string | Uint8Array }) {
  const calls: (readonly string[])[] = [];
  const runGit: RunGit = async (args): Promise<GitCall> => {
    calls.push(args);
    const r = reply(args);
    return { args, code: r.code, stdout: enc(r.out), stderr: '' };
  };
  return { calls, effects: fileRepairDispatchEffects({ stateRoot: root, clone: '/c', runGit }) };
}

describe('fileRepairDispatchEffects', () => {
  it('reads the tip and blob oids as trimmed text', async () => {
    const { calls, effects } = fake(() => ({ code: 0, out: 'abc\n' }));
    expect(await effects.git.currentTip()).toBe('abc');
    expect(await effects.git.blobOid('s'.repeat(40), 'a/b.ts')).toBe('abc');
    expect(calls).toEqual([
      ['rev-parse', 'origin/main'],
      ['rev-parse', `${'s'.repeat(40)}:a/b.ts`],
    ]);
  });

  it('shows a file with Python universal newlines', async () => {
    const { calls, effects } = fake(() => ({ code: 0, out: 'a\r\nb\rc\n' }));
    expect(await effects.git.showFile('s:p')).toBe('a\nb\nc\n');
    expect(calls).toEqual([['show', 's:p']]);
  });

  it('fails closed on a git error or undecodable output', async () => {
    const bad = fake(() => ({ code: 128, out: 'fatal: secret path' }));
    await expect(bad.effects.git.currentTip()).rejects.toThrow('git read failed');
    const binary = fake(() => ({ code: 0, out: new Uint8Array([0xff, 0xfe]) }));
    await expect(binary.effects.git.showFile('s:p')).rejects.toThrow();
  });

  it('reads the exact prepared job text and rejects unsafe ids', async () => {
    const { effects } = fake(() => ({ code: 0, out: '' }));
    await mkdir(join(root, 'repair', 'inbox'), { recursive: true });
    await writeFile(join(root, 'repair', 'inbox', 'crq-job1.json'), '{"a": 1}\r\n');
    expect(await effects.readPreparedJob('crq-job1')).toBe('{"a": 1}\r\n');
    await expect(effects.readPreparedJob('../x')).rejects.toThrow('invalid repair job id');
    await expect(effects.readPreparedJob('crq-absent')).rejects.toThrow();
  });
});
