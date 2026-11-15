import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileEnrolledEvent } from '../../../src/adapters/crq/enrolledEvent.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fresh = async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'enrolled-')), 'state');
  roots.push(join(root, '..'));
  return root;
};
const now = () => new Date('2026-11-15T01:02:03.987Z');

describe('fileEnrolledEvent', () => {
  it('appends the Python json.dumps line, creating the state directory', async () => {
    const root = await fresh();
    const event = fileEnrolledEvent({ stateRoot: root, now });
    await event('o-pr7', '2026-11-15T01:02:03Z auto-enrolled: open PR not yet enrolled');
    expect(await readFile(join(root, 'events.jsonl'), 'utf8')).toBe(
      '{"at": "2026-11-15T01:02:03Z", "event": "enrolled", "item": "o-pr7", ' +
        '"reason": "2026-11-15T01:02:03Z auto-enrolled: open PR not yet enrolled"}\n',
    );
  });

  it('appends rather than truncates, and escapes non-ASCII like ensure_ascii', async () => {
    const root = await fresh();
    const event = fileEnrolledEvent({ stateRoot: root, now });
    await event('a', 'one');
    await event('b', 'é"\\');
    const lines = (await readFile(join(root, 'events.jsonl'), 'utf8')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"item": "a"');
    expect(lines[1]).toContain('"reason": "\\u00e9\\"\\\\"');
  });
});
