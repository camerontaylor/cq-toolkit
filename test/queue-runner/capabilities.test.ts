import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SCHEMA_VERSION,
  LIVE_UNIT_COMMANDS,
} from '../../src/queue-runner/capabilities.js';

const KNOWN = ['tick', 'slot', 'repair', 'publish', 'backfill inventory', 'watchdog'];

describe('queue-runner artifact capability declaration', () => {
  it('declares only known, unique live unit commands', () => {
    expect(new Set(LIVE_UNIT_COMMANDS).size).toBe(LIVE_UNIT_COMMANDS.length);
    for (const command of LIVE_UNIT_COMMANDS) expect(KNOWN).toContain(command);
  });

  it('is emitted into the built artifact exactly as declared', async () => {
    const raw = await readFile(
      new URL('../../dist/queue-runner/capabilities.json', import.meta.url),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual({
      schema_version: CAPABILITY_SCHEMA_VERSION,
      commands: [...LIVE_UNIT_COMMANDS].sort(),
    });
    expect(raw.endsWith('\n')).toBe(true);
  });
});
