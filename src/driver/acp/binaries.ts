// Endpoint registry for the acp driver — T1.8 (strategy §3).
//
// DISCOVERY ONLY — never bundled, never a dependency: stricter than the
// claude-agent lane's optional peer, the harness binary is an EXTERNAL
// program the operator installs, full stop. The registry below is plain
// serializable CONFIG (the same posture as every lane's routing table):
// per endpoint, the DEFAULT launch argv, the install hint the
// absent-binary throw names, and human notes. No vendor code, no SDK
// import, nothing vendored — v1's second vendor is a different default
// argv, which is the point of the lane.
//
// RESOLUTION ORDER (strategy §3): explicit constructor argv FIRST, then
// the endpoint table's default argv; the chosen argv's first element is
// then resolved like `which` — an absolute binary is used as-is, a
// RELATIVE path-carrying one is resolved against the CALLER's cwd (the
// spawn later runs with cwd = the workspace), and a bare name is searched
// on PATH. An UNRESOLVABLE binary is
// a PRE-DISPATCH THROW naming the binary, the install hint, and the
// searched PATH — the same posture as the claude-agent lane's absent
// optional peer: fail loudly before any session exists, never a crash
// mid-run. Once spawned, run() never throws past the seam.
//
// SECRETS: entries carry env var guidance in `notes` as NAMES only —
// never values. The driver injects the child env at run() time (see
// index.ts); nothing here reads a key.
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// The endpoint table — plain data, schema-validated (invalid tables throw loudly)
// ---------------------------------------------------------------------------

export const AcpEndpointSchema = z.object({
  /** The DEFAULT launch argv for this endpoint (explicit constructor argv wins). */
  command: z.array(z.string().min(1)).min(1),
  /** The install hint the absent-binary pre-dispatch throw names. */
  installHint: z.string().min(1),
  /** Human notes: what the harness reads from the environment (NAMES only, never values). */
  notes: z.string().min(1),
}).strict();

export const AcpEndpointTableSchema = z.object({
  endpoints: z.record(z.string(), AcpEndpointSchema),
}).strict();

export type AcpEndpointEntry = z.infer<typeof AcpEndpointSchema>;
export type AcpEndpointTable = z.infer<typeof AcpEndpointTableSchema>;

/** The endpoint used when the constructor names none (strategy §3's default argv). */
export const DEFAULT_ACP_ENDPOINT = 'zcode-acp-server';

/**
 * The documented default endpoint table — CONFIG as-of 2026-09 (registry
 * metadata + the live probe, strategy §3's recorded evidence). Treat as
 * immutable: `resolveAcpCommand` re-validates whatever table it is handed,
 * but callers should not mutate the exported value. A deployment overrides
 * it wholesale via the driver's `endpointTable` option.
 */
export function defaultAcpEndpointTable(): AcpEndpointTable {
  return AcpEndpointTableSchema.parse({
    endpoints: {
      'zcode-acp-server': {
        command: ['zcode-acp-server'],
        installHint: 'npm install -g zcode-acp-server',
        notes:
          'Z.AI — bridges headless ZCode over ACP (bins zcode-acp + zcode-acp-server, probed live ' +
          'at 0.37.3; engines node >=22). Auth is agent-side (authMethod zcode-credentials, the app\'s ' +
          'own credentials — no client key). When the zcode CLI is not on PATH, the ZCODE_BIN env var ' +
          'names the desktop-app CLI (e.g. /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs).',
      },
      'dsh-acp': {
        command: ['dsh-acp'],
        installHint: 'npm install -g @openma/deepseek-harness-acp',
        notes:
          'DeepSeek — the @openma/deepseek-harness-acp bin (registry metadata 2026-09: bin dsh-acp → ' +
          'dist/bin.js). FAST-FOLLOW endpoint: the same driver, a different default argv — nothing in ' +
          'the lane is zcode-specific (strategy §7).',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Resolution — explicit argv first, PATH fallback, absent = pre-dispatch throw
// ---------------------------------------------------------------------------

/** One resolved launch command (plain data, secret-free). */
export interface ResolvedAcpCommand {
  /** The endpoint name resolved ('explicit' when constructor argv won). */
  endpoint: string;
  /** The launch argv (first element is the resolved `binary`). */
  command: readonly string[];
  /** The resolved binary path (absolute: PATH-joined for a bare name, caller-cwd-resolved for a relative path-carrying value, verbatim when already absolute). */
  binary: string;
  /** Which source won. */
  source: 'explicit' | 'endpoint';
}

/** Executable-probe seam (tests inject a no-fs probe; default: fs access X_OK). */
export type ExecutableProbe = (candidate: string) => Promise<boolean>;

async function probeExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the launch argv for one run. THROWS BEFORE ANY SPAWN on an
 * unknown endpoint (naming the known ones) or an absent binary (naming
 * the binary, the install hint, and the searched PATH) — the strategy §3
 * pre-dispatch posture.
 *
 * `explicitCommand` (the constructor's argv) wins over the endpoint
 * table; the table's default argv applies otherwise. The first argv
 * element resolves like `which`: absolute values are probed as-is;
 * relative path-carrying values resolve against the caller's cwd (the
 * spawn later runs with cwd = the workspace); bare names are searched
 * across every PATH entry — each entry resolved to ABSOLUTE before
 * probing (review-debt #46: a relative entry's result would break the
 * later cwd switch to the workspace), and, on win32, across the
 * entry's PATHEXT-suffixed candidates as well (review-debt #40; the
 * candidate list comes from pathCandidates, keyed on the HOST platform).
 *
 * `env` is the environment the PATH lookup reads (defaults to
 * `process.env`; tests inject a literal record). A set-but-EMPTY PATH
 * counts as no PATH.
 */
export async function resolveAcpCommand(
  explicitCommand: readonly string[] | undefined,
  endpointName: string,
  table: AcpEndpointTable = defaultAcpEndpointTable(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  probe: ExecutableProbe = probeExecutable,
): Promise<ResolvedAcpCommand> {
  const parsed: AcpEndpointTable = AcpEndpointTableSchema.parse(table);
  let command: readonly string[];
  let endpoint: string;
  let installHint: string;
  if (explicitCommand !== undefined) {
    if (explicitCommand.length === 0) {
      throw new Error('acp driver: the command option must carry at least the binary (non-empty argv)');
    }
    command = [...explicitCommand];
    endpoint = 'explicit';
    installHint = installHintFor(command[0] as string, parsed);
  } else {
    // Own-property guard (same posture as the claude-agent routing table):
    // the parsed record inherits Object.prototype, so an endpoint handle
    // like 'constructor' must not dodge the unknown-endpoint throw.
    const entry = Object.prototype.hasOwnProperty.call(parsed.endpoints, endpointName)
      ? parsed.endpoints[endpointName]
      : undefined;
    if (entry === undefined) {
      throw new Error(
        `acp driver: unknown endpoint '${endpointName}' (known endpoints: ${Object.keys(parsed.endpoints).join(', ')})`,
      );
    }
    command = [...entry.command];
    endpoint = endpointName;
    installHint = entry.installHint;
  }

  const binary = command[0] as string;
  const resolved = await resolveBinary(binary, env, probe);
  if (resolved !== undefined) {
    return { endpoint, command: [resolved, ...command.slice(1)], binary: resolved, source: explicitCommand === undefined ? 'endpoint' : 'explicit' };
  }
  const pathValue = env['PATH'] ?? '';
  throw new Error(
    `acp driver: the harness binary '${binary}' was not found (not absolute/resolvable and not on PATH) — ` +
      `install it first (${installHint}) or pass an explicit command via the driver's \`command\` option; ` +
      `refusing pre-dispatch, before any session exists. PATH searched: ${pathValue === '' ? '(empty)' : pathValue}`,
  );
}

/** Install hint for an EXPLICIT argv's binary: the registry entry when the basename names one, else generic guidance. */
function installHintFor(binary: string, table: AcpEndpointTable): string {
  const entry = Object.values(table.endpoints).find((candidate) => basenameOf(candidate.command[0] ?? '') === basenameOf(binary));
  return entry?.installHint ?? 'install the harness binary and ensure it is on PATH (see docs/acp-driver.md)';
}

/**
 * A path-carrying command candidate — EITHER separator counts (Codex P2).
 * `sep` is '\\' on Windows, but Node also accepts '/' there: the
 * documented './bin/acp-server' form would miss a sep-only test, fall
 * through to the PATH walk, and get joined to every PATH dir. Exported
 * for the resolution tests; the suite runs on ubuntu/macOS (where sep IS
 * '/'), so the backslash half of the check is inert on this host — it is
 * correctness for the documented Windows case, not locally observable
 * behavior.
 */
export function carriesPathSeparator(candidate: string): boolean {
  return candidate.includes('/') || candidate.includes(sep);
}

function basenameOf(pathValue: string): string {
  // The same either-separator rule as carriesPathSeparator: a Windows
  // form like './bin/acp-server' must yield 'acp-server' for the
  // install-hint basename match (hint quality only — but the same bug).
  const index = Math.max(pathValue.lastIndexOf('/'), pathValue.lastIndexOf(sep));
  return index === -1 ? pathValue : pathValue.slice(index + 1);
}

/** which-like resolution: absolute/path-carrying values resolve to an ABSOLUTE path (a relative one against the CALLER's cwd — the spawn later runs with cwd = the workspace); bare names are searched across PATH. Undefined = absent. */
async function resolveBinary(
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
  probe: ExecutableProbe,
): Promise<string | undefined> {
  if (isAbsolute(binary) || carriesPathSeparator(binary)) {
    // A RELATIVE path-carrying binary ('./bin/acp-server') must be resolved
    // against the caller's cwd NOW: the spawn later runs with
    // cwd = the invocation's workspace, and node resolves a relative spawn
    // command against THAT cwd — probed verbatim, the probe would bless a
    // file the child can never find (and vice versa). Bare names stay
    // PATH-resolved (the child's cwd is irrelevant to a PATH hit). The
    // path-carrying test accepts EITHER separator (Codex P2 — see
    // carriesPathSeparator).
    const candidate = isAbsolute(binary) ? binary : resolve(binary);
    return (await probe(candidate)) ? candidate : undefined;
  }
  const pathValue = env['PATH'] ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue;
    // A RELATIVE PATH ENTRY ('./bin') resolves against the caller's cwd
    // NOW (review-debt #46): joined raw, the candidate is probed relative
    // to the caller's cwd and returned as a relative path that breaks the
    // moment the spawn later runs with cwd = the workspace. resolve() on
    // an absolute entry is a no-op.
    for (const candidate of pathCandidates(resolve(dir), binary, env)) {
      if (await probe(candidate)) return candidate;
    }
  }
  return undefined;
}

// Windows default PATHEXT (documented shell behavior) — used when the env
// carries no PATHEXT of its own.
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

/**
 * The candidates ONE PATH dir offers for a bare command name (in probe
 * order): the name verbatim first, then — win32 ONLY — the name with each
 * PATHEXT extension appended (issue #40): npm-installed bare commands are
 * exposed as `.cmd` shims on Windows, so an extensionless-only probe finds
 * nothing and a present harness reads as absent. On every other platform
 * the verbatim name is the whole candidate list. Keyed on the HOST platform
 * (like `sep` in carriesPathSeparator): correct for the documented Windows
 * case, not locally observable on the ubuntu/macOS suite.
 */
function pathCandidates(
  dir: string,
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (process.platform !== 'win32') return [join(dir, binary)];
  const exts = (env['PATHEXT'] ?? '')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');
  return [
    join(dir, binary),
    ...exts.map((ext) => join(dir, binary + ext)),
    ...(exts.length === 0 ? DEFAULT_PATHEXT.map((ext) => join(dir, binary + ext)) : []),
  ];
}
