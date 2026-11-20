import { describe, expect, test } from 'vitest';
import { buildChildEnv } from '../../src/shared/proc.js';

describe('buildChildEnv override precedence by platform', () => {
  const parent = { PATH: '/inherited/bin' };

  test('win32: an override spelled Path replaces the inherited PATH', () => {
    const env = buildChildEnv(parent, { Path: 'C:\\override' }, [], 'win32');
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
    expect(env['Path']).toBe('C:\\override');
  });

  test('linux: names stay case-sensitive', () => {
    const env = buildChildEnv(parent, { Path: '/other' }, [], 'linux');
    expect(env['PATH']).toBe('/inherited/bin');
    expect(env['Path']).toBe('/other');
  });

  test('win32: an override spelled cq_parent_work_id is not shadowed by a derived link', () => {
    const env = buildChildEnv(
      { PATH: '/p', PASEO_AGENT_ID: 'agent-1' },
      { cq_parent_work_id: 'explicit' },
      [],
      'win32',
    );
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CQ_PARENT_WORK_ID')).toEqual([
      'cq_parent_work_id',
    ]);
    expect(env['cq_parent_work_id']).toBe('explicit');
  });
});
