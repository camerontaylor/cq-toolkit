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
});
