// The RS-13 backend adapters (B14): boundary construction is data (assertable
// on any host), while boundary ENFORCEMENT is only claimed where it can
// actually execute (the darwin seatbelt legs skip elsewhere — certification
// evidence comes from probe.ts, never from these builders alone). The
// seatbelt-live suite also exercises network, clipboard and process-group
// canaries on macOS without broadening the profile's file permissions.
// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts (this file), backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts, backend.availability.test.ts and
// backend.launcher-hardening.test.ts, with shared helpers in
// backend.helpers.ts. This file keeps the original suite header above.
import { describe, expect, test } from 'vitest';

import { seatbeltProfile } from '../../experimental/sandbox-host/backend.js';

describe('seatbelt boundary construction', () => {
  test('the profile is deny-default with the bsd.sb startup closure', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(import "bsd.sb")');
  });

  test('reads use a narrow runtime allowlist — never a whole-volume grant', () => {
    const profile = seatbeltProfile('model-only');
    // The audit-rejected broad allow must be gone: no (subpath "/").
    expect(profile).not.toMatch(/\(subpath "\/"\)/);
    for (const runtime of [
      '"/bin"',
      '"/sbin"',
      '"/usr/bin"',
      '"/usr/lib"',
      '"/System"',
      '"/private/var/db/dyld"',
    ]) {
      expect(profile).toContain(`(subpath ${runtime})`);
    }
    // The delta review's local-prefix and /etc surfaces are NOT readable:
    // /usr/local/* and /private/etc are absent from the allowlist entirely.
    expect(profile).not.toContain('/usr/local');
    expect(profile).not.toContain('/private/etc');
    expect(profile).not.toContain('"/Users"');
    expect(profile).not.toContain('"/Volumes"');
    expect(profile).not.toContain('"/private/var/folders"');
  });

  test('process execution is narrowed to the accepted P7 trial trees', () => {
    const profile = seatbeltProfile('model-only');
    // The accepted P7 shape — no unrestricted exec, no /usr/local/bin (e.g.
    // /usr/local/bin/docker stays denied); the probe's local-prefix-exec
    // canary attacks exactly this surface live.
    expect(profile).toContain(
      '(allow process-exec* (subpath "/usr/bin") (subpath "/bin") (subpath "/sbin") (subpath "/usr/libexec"))',
    );
    expect(profile).not.toMatch(/\(allow process-exec\*\)/);
    expect(profile).not.toContain('/usr/local');
  });

  test('no blanket Mach service grant reaches the child', () => {
    // crq delta review: `(allow mach-lookup)` opened every global Mach
    // service — a confined /usr/bin/pbpaste read the host clipboard under it
    // (observed on darwin 24.6.0).  bsd.sb carries the startup services.
    for (const network of ['model-only', 'allow'] as const) {
      const profile = seatbeltProfile(network);
      expect(profile).not.toMatch(/\(allow mach-lookup\)/);
      expect(profile).not.toMatch(/\(allow mach-lookup\s*\(global-name-regex/);
    }
  });

  test('the workspace arrives as the WS parameter, never as profile text', () => {
    const profile = seatbeltProfile('model-only');
    expect(profile).toContain('(allow file-read* file-write* (subpath (param "WS")))');
    // A hostile workspace path cannot rewrite the profile: no caller-supplied
    // path is interpolated into profile text at all.
    expect(profile).not.toMatch(/\/private\/var\/tmp|cq-ws/);
  });

  test('model-only is deny-all by default; allow grants network', () => {
    expect(seatbeltProfile('model-only')).not.toContain('network-outbound');
    expect(seatbeltProfile('model-only')).not.toContain('(allow network*)');
    expect(seatbeltProfile('allow')).toContain('(allow network*)');
  });

  test('a proxy-composed model-only permits exactly the proxy loopback port', () => {
    const profile = seatbeltProfile('model-only', 9053);
    // `localhost`, not a numeric address: SBPL rejects the latter ("host must
    // be * or localhost in network address" — first live execution, final head).
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:9053"))');
    // No other egress rule may appear: one port, nothing else.
    expect(profile.match(/network-outbound/g)).toHaveLength(1);
    expect(profile).not.toContain('(allow network*)');
    // And without a proxy there is no port rule at all.
    expect(seatbeltProfile('model-only')).not.toContain('network-outbound');
  });

  test('a runtime proxyPort outside an integer 1-65535 is refused before any policy is built', () => {
    // TypeScript's `number` is not a runtime guard (Sol exact-head audit):
    // a string through an untyped boundary must not reach the SBPL text.
    for (const bad of [
      '45454',
      '45454)) (allow network*',
      0,
      -1,
      70000,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => seatbeltProfile('model-only', bad as unknown as number)).toThrow(
        /proxyPort must be an integer/,
      );
    }
  });
});
