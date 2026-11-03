// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts, backend.availability.test.ts (this file)
// and backend.launcher-hardening.test.ts, with shared helpers in
// backend.helpers.ts.
import { describe, expect, test } from 'vitest';

import { bwrapAdapter } from '../../experimental/sandbox-host/backend.js';

describe('a bubblewrap adapter can at least name its own availability', () => {
  test('availability returns a verdict, with a blocker when absent', async () => {
    const availability = await bwrapAdapter().available();
    expect(typeof availability.available).toBe('boolean');
    if (!availability.available) expect(availability.blocker).toMatch(/bwrap|bubblewrap/);
  });
});
