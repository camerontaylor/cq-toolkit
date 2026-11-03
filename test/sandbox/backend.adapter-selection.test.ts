// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts (this
// file), backend.seatbelt-execute.test.ts, backend.availability.test.ts and
// backend.launcher-hardening.test.ts, with shared helpers in
// backend.helpers.ts.
import { describe, expect, test } from 'vitest';

import { containerAdapter, landlockAdapter } from '../../src/sandbox/backend.js';
import {
  adaptersForPlatform,
  bwrapAdapter,
  seatbeltAdapter,
} from '../../experimental/sandbox-host/backend.js';

describe('adapter selection per platform', () => {
  test('darwin auto order is seatbelt then container; linux adds landlock/bwrap', () => {
    expect(adaptersForPlatform('darwin').map((a) => a.backend)).toEqual(['seatbelt', 'container']);
    expect(adaptersForPlatform('linux').map((a) => a.backend)).toEqual([
      'landlock',
      'bwrap',
      'container',
    ]);
    expect(adaptersForPlatform('win32')).toEqual([]);
  });

  test('only seatbelt declares loopback-proxy composition for model-only', () => {
    expect(seatbeltAdapter().supportsProxyModelOnly).toBe(true);
    expect(bwrapAdapter().supportsProxyModelOnly).toBeUndefined();
    expect(
      containerAdapter({ image: 'x', allowUnpinnedImage: true }).supportsProxyModelOnly,
    ).toBeUndefined();
    expect(landlockAdapter().supportsProxyModelOnly).toBeUndefined();
  });
});
