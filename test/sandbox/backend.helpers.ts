// Split provenance: test/sandbox/backend.test.ts was split by subject into
// backend.seatbelt-profile.test.ts, backend.linux-container.test.ts,
// backend.adapter-snapshot.test.ts, backend.adapter-selection.test.ts,
// backend.seatbelt-execute.test.ts, backend.availability.test.ts and
// backend.launcher-hardening.test.ts. This module holds the helpers those
// files share; it defines no tests and no suites.
import { accessSync, constants } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

// Writes an executable stub CLI into `dir` and returns its path. Moved
// verbatim from the original suite's local `stubScript` closure: the closure
// captured `stubDir`, so the directory is now an explicit parameter.
export const stubScript = async (dir: string, name: string, marker: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\necho "${marker} $@"\n`, { mode: 0o755 });
  return path;
};

// The landlock stand-in helper execs the argv on the HOST, so resolve perl
// the way a shell would rather than assuming FHS /usr/bin (NixOS has no
// /usr/bin/perl). Inside a real boundary the FHS path is the point; here it
// is not. Relative PATH entries are skipped like probe.ts's hostTool: the
// adapter launches with cwd set to its workspace, so a relative candidate
// would not resolve there — the returned path is always absolute.
export const hostPerl = (): string => {
  const executable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (executable('/usr/bin/perl')) return '/usr/bin/perl';
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    if (executable(join(dir, 'perl'))) return join(dir, 'perl');
  }
  return '/usr/bin/perl';
};
