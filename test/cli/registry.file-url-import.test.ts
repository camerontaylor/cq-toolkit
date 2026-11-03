// Split provenance: test/cli/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures and helpers
// live in registry.helpers.ts, which carries the full I1 contract header.
// This file carries the file-URL (win32 specifier form) registry import pin.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { list } from '../../src/registry/index.js';
import { makeTmpOpsRoot, registerRegistryTmpCleanup, registrySource } from './registry.helpers.js';

registerRegistryTmpCleanup();

// 4530779 pin: the family scan imports each registry through a PLAIN fs path
// on POSIX and a FILE URL on win32 (pathToFileURL — a constructed fs path is
// not importable there). Both halves of that seam stay pinned: the scan
// resolves a tmp family through list(), and the URL form — the specifier the
// win32 branch imports through — imports and exposes `registry` directly.
describe('file-URL registry import (the win32 specifier form)', () => {
  test('list() resolves a tmp family; registry.js also imports through a FILE URL exposing registry', async () => {
    const tmp = await makeTmpOpsRoot('cq-registry-fileurl-');
    await mkdir(join(tmp, 'urlfam'), { recursive: true });
    const registryPath = join(tmp, 'urlfam', 'registry.js');
    await writeFile(registryPath, registrySource('urlop'));
    expect((await list({ opsRoot: tmp })).map((entry) => entry.name)).toEqual(['urlop']);
    // The generated registry uses an INLINE importer on purpose: under the
    // vitest module runner a file-URL module id breaks NESTED relative
    // importers (the './op.js' caveat documented in 4530779 — node itself is
    // unaffected); the inline form keeps this probe about the specifier.
    const mod: unknown = await import(pathToFileURL(registryPath).href);
    const registry = (mod as { registry?: unknown }).registry;
    expect(Array.isArray(registry)).toBe(true);
    expect((registry as Array<{ name?: unknown }>)[0]?.name).toBe('urlop');
  });
});
