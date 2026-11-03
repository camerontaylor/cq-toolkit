// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts (this file),
// backend.adapter-selection.test.ts, backend.seatbelt-execute.test.ts,
// backend.availability.test.ts and backend.launcher-hardening.test.ts, with
// shared helpers in backend.helpers.ts. The suite-local `stubScript` closure
// became the shared helper factory `stubScript(stubDir, name, marker)`; its
// body is unchanged.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  containerAdapter,
  DEFAULT_SANDBOX_IMAGE,
  landlockAdapter,
  type ContainerAdapterOptions,
  type LandlockAdapterOptions,
} from '../../src/sandbox/backend.js';
import { stubScript } from './backend.helpers.js';

describe('adapter options are snapshotted at construction (Sol final-head review)', () => {
  let stubDir: string;
  let wsDir: string;

  beforeEach(async () => {
    stubDir = await mkdtemp(join(tmpdir(), 'cq-sbx-stub-'));
    // Launchers must live OUTSIDE the workspace the adapter confines.
    wsDir = await mkdtemp(join(tmpdir(), 'cq-sbx-ws-'));
  });
  afterEach(async () => {
    if (stubDir !== undefined) await rm(stubDir, { recursive: true, force: true });
    if (wsDir !== undefined) await rm(wsDir, { recursive: true, force: true });
  });

  test('mutating container options after construction cannot change the boundary', async () => {
    const stubA = join(stubDir, 'docker-a');
    await writeFile(
      stubA,
      `#!/bin/sh
case "$1" in
  create) echo "$*" > '${stubDir}/created'; printf '%064d\n' 1 ;;
  start) echo STUB-A; cat '${stubDir}/created' ;;
  inspect) echo 'false 0' ;;
  rm) exit 0 ;;
esac
`,
      { mode: 0o700 },
    );
    const stubB = await stubScript(stubDir, 'docker-b', 'STUB-B');
    const options: ContainerAdapterOptions = {
      image: 'orig:latest',
      allowUnpinnedImage: true,
      command: stubA,
      user: '1000:1000',
    };
    const adapter = containerAdapter(options);
    // The caller mutates the SAME options object after construction — the
    // launch must still be exactly the boundary that was constructed.
    options.command = stubB;
    options.image = 'evil:latest';
    options.user = '0:0';
    const result = await adapter.launch({
      workspace: wsDir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('STUB-A');
    expect(result.stdout).not.toContain('STUB-B');
    expect(result.stdout).toContain('--user 1000:1000');
    expect(result.stdout).toContain('orig:latest');
    expect(result.stdout).not.toContain('evil:latest');
    expect(result.stdout).not.toContain('0:0');
    // Bounded per-test margin, measured (final head, concurrent authorized
    // testing): process spawn latency on the shared host reached ~9s per
    // spawn at load ~104/6 cores; this test chains four sequential CLI
    // stub spawns.  The 60s bound is test scheduling margin only — product
    // launch timeouts are untouched.
  }, 60_000);

  test('an adapter built without an image freezes the digest-pinned default into the launch', async () => {
    const stub = join(stubDir, 'docker-default-image');
    await writeFile(
      stub,
      `#!/bin/sh
case "$1" in
  create) echo "$*" > '${stubDir}/created'; printf '%064d\n' 1 ;;
  start) cat '${stubDir}/created' ;;
  inspect) echo 'false 0' ;;
  rm) exit 0 ;;
esac
`,
      { mode: 0o700 },
    );
    // No image option: construction resolves DEFAULT_SANDBOX_IMAGE, and a
    // later mutation of the caller's object cannot inject a different one.
    const options: ContainerAdapterOptions = { command: stub };
    const adapter = containerAdapter(options);
    options.image = 'evil:latest';
    const result = await adapter.launch({
      workspace: wsDir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(result.stdout).not.toContain('evil:latest');
    // Same measured-margin rationale as the container snapshot test above.
  }, 60_000);

  test('mutating landlock helperPath after construction cannot swap the helper', async () => {
    const stubA = await stubScript(stubDir, 'landlock-a', 'STUB-A');
    const stubB = await stubScript(stubDir, 'landlock-b', 'STUB-B');
    const options: LandlockAdapterOptions = { helperPath: stubA };
    const adapter = landlockAdapter(options);
    options.helperPath = stubB;
    const result = await adapter.launch({
      workspace: wsDir,
      argv: ['/usr/bin/true'],
      network: 'model-only',
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('STUB-A');
    expect(result.stdout).not.toContain('STUB-B');
    // Availability reads the same snapshot: still the constructed helper.
    const availability = await adapter.available();
    expect(availability.available).toBe(true);
    // Same measured-margin rationale as the container snapshot test above.
  }, 60_000);
});
