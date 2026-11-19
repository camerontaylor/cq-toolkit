// Subject: buildChildEnv override precedence is case-insensitive on Windows
// (env names there are case-insensitive: an override `Path` replaces `PATH`).
import { afterEach, describe, expect, test } from 'vitest';
import { buildChildEnv } from '../../src/shared/proc.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  if (realPlatform !== undefined) Object.defineProperty(process, 'platform', realPlatform);
});

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('buildChildEnv override case folding', () => {
  test('win32: an override with different case replaces the inherited key', () => {
    setPlatform('win32');
    const env = buildChildEnv({ PATH: '/inherited' }, { Path: '/override' });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(env['Path']).toBe('/override');
  });

  test('linux: names stay case-sensitive', () => {
    setPlatform('linux');
    const env = buildChildEnv({ PATH: '/inherited' }, { Path: '/override' });
    expect(env['PATH']).toBe('/inherited');
    expect(env['Path']).toBe('/override');
  });
});
