// The ONE cq.json read helper: only ENOENT reads as "no config"; every other
// fault (EACCES, EISDIR, EIO, an errno-less throw) comes back as `fault`
// carrying the original error, so no op can confuse a broken checkout with
// an unconfigured one (#1190).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { cqConfigFaultText, errnoOf, readCqConfigText } from '../../src/shared/readCqConfigText.js';

const dirs: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-read-config-'));
  dirs.push(dir);
  return dir;
};

describe('readCqConfigText', () => {
  test('a present cq.json returns its text', async () => {
    const root = await scratch();
    await writeFile(join(root, 'cq.json'), '{"schemaVersion":2}', 'utf8');
    expect(await readCqConfigText(root)).toEqual({
      outcome: 'text',
      text: '{"schemaVersion":2}',
    });
  });

  test('an absent cq.json (ENOENT) reads as no config', async () => {
    const root = await scratch();
    expect(await readCqConfigText(root)).toEqual({ outcome: 'absent' });
  });

  test('a directory in place of cq.json (EISDIR) is a fault carrying the error', async () => {
    const root = await scratch();
    await mkdir(join(root, 'cq.json'));
    const read = await readCqConfigText(root);
    expect(read.outcome).toBe('fault');
    if (read.outcome === 'fault') expect(errnoOf(read.error)).toBe('EISDIR');
  });

  test('an errno-less throw is a fault, never a silent "no config"', async () => {
    // The retired pattern matched on the MESSAGE ('ENOENT'); the helper pins
    // the errno `code` as the only absence signal.
    const read = await readCqConfigText('/repo', async () => {
      throw new Error('ENOENT');
    });
    expect(read.outcome).toBe('fault');
  });

  test('a non-ENOENT errno from the injected reader is a fault with that errno', async () => {
    const read = await readCqConfigText('/repo', async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    expect(read.outcome).toBe('fault');
    if (read.outcome === 'fault') expect(errnoOf(read.error)).toBe('EACCES');
  });

  test('the injected reader receives the joined cq.json path', async () => {
    const seen: string[] = [];
    await readCqConfigText('/repo', async (path) => {
      seen.push(path);
      return '{}';
    });
    expect(seen).toEqual([join('/repo', 'cq.json')]);
  });
});

describe('cqConfigFaultText', () => {
  test('names cq.json, the errno and the original message', () => {
    expect(cqConfigFaultText(Object.assign(new Error('boom'), { code: 'EIO' }))).toBe(
      'cq.json could not be read (EIO) — boom',
    );
  });

  test('an errno-less fault still names cq.json', () => {
    expect(cqConfigFaultText(new Error('boom'))).toBe('cq.json could not be read — boom');
  });
});
