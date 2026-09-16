// Central op registry — lazy family aggregation over src/ops.
//
// FAMILY CONVENTION (defined by this lane): every op family exports
// `src/ops/<family>/registry.ts` containing
//
//   export const registry: OpRegistryEntry[];
//
// where each entry is `{ name, inputSchema, importer }`:
//   - `name`       — the globally unique op name (unique across ALL families).
//   - `inputSchema`— a zod schema validating the JSON-serializable op input
//                    before dispatch.
//   - `importer`   — `() => Promise<Op>`; canonical form
//                    `async () => (await import('./<name>.js')).default` —
//                    the op module `src/ops/<family>/<name>.ts` DEFAULT-exports
//                    the op function, and the importer unwraps the module
//                    namespace to it (lazy: the module loads only on dispatch).
//
// Aggregation here NEVER imports an op module or a family registry module at
// construction: importing this module does no fs work and no dynamic imports.
// Discovery happens lazily on the first list()/get() call — a runtime
// directory scan of the ops root (one level: family directories), then a lazy
// dynamic import of each family's `registry.js`, then (only when an op is
// actually dispatched) the entry's own `importer()` pulls the op module in.
// ABSENT vs BROKEN vs NONCONFORMING (the tolerance is narrow, and has three
// classes):
//   - ABSENT — expected (families land in later phases): only a not-found
//     rejection whose resolution target IS the requested family `registry.js`
//     itself is treated as absent (classifier mirrors the SDK presence idiom:
//     code ERR_MODULE_NOT_FOUND + `Cannot find module '<path>'`, or the
//     module runner's `Could not resolve "<path>"`). The family contributes
//     no entries and is surfaced in `skippedFamilies`.
//   - BROKEN — a PRESENT-but-broken registry: a syntax error, an evaluation
//     throw, a not-found for a TRANSITIVE dependency of the registry module,
//     any other rejection — throws loudly, naming the family, the requested
//     path, and the original message (attached as `cause`).
//   - NONCONFORMING — a registry module that LOADS cleanly but exports no
//     `registry` array (or a non-array) is NOT a broken family: it
//     contributes no entries and is skipped + surfaced in `skippedFamilies`
//     instead of throwing. Rationale: at integration a family's registry.ts
//     may carry its own interim internal registries — e.g. lane-H ratchet's
//     metric-adapter registry — until the family conforms; op-registry
//     recognition is by EXPORT SHAPE, and a module without the shape is
//     simply not an op registry yet. Full convention closure is phase-4 T4.2.
// `listWithDiagnostics()` returns `{ entries, skippedFamilies }` — the family
// dir names that contributed no entries without erroring (absent or
// nonconforming) — so an integration-time skip stays visible to callers and
// tests instead of being silently swallowed; `list()` delegates to it and
// returns `.entries`, keeping the existing seam (and the `listOps` barrel
// alias) unchanged.
//
// Defects that still surface loudly: a malformed entry, a duplicate op name
// across families, or a shape-bearing object input schema that is not
// `.strict()` (unknown-key rejection is load-bearing — see the scan loop
// below) — all throw immediately — including a NAME that collides with the
// CLI dispatcher: 'run-plan' (handled by main.ts before the registry is ever
// consulted) and any name starting with '-' (reads as a flag spelling).
// Such an entry validates but can never be invoked, and the deduped global
// help would hide it — a dead op — so registration rejects it.
//
// Results are cached per resolved ops root (as a promise), so repeated
// list()/listWithDiagnostics()/get() calls do not rescan or re-import.
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpRegistryEntry } from '../kernel/types.js';

const listCache = new Map<
  string,
  Promise<{ entries: OpRegistryEntry[]; skippedFamilies: string[] }>
>();

/**
 * Default ops root: `src/ops` under vitest (source layout), `dist/ops` in the
 * built package — resolved relative to this module's compiled location.
 */
export function defaultOpsRoot(): string {
  return fileURLToPath(new URL('../ops', import.meta.url));
}

/**
 * Aggregate every landed op family's registry entries together with the
 * families that contributed none without erroring: `skippedFamilies` holds
 * the family dir names whose `registry.js` is absent (lands in a later
 * phase) or loads cleanly without exporting a `registry` array
 * (nonconforming interim registry — see the header). Scans `opsRoot`
 * (default {@link defaultOpsRoot}) for directories only; a root that does
 * not exist means no family has landed yet and yields
 * `{ entries: [], skippedFamilies: [] }`.
 */
export function listWithDiagnostics(opts?: {
  opsRoot?: string;
}): Promise<{ entries: OpRegistryEntry[]; skippedFamilies: string[] }> {
  const root = path.resolve(opts?.opsRoot ?? defaultOpsRoot());
  let cached = listCache.get(root);
  if (cached === undefined) {
    cached = scanOps(root);
    listCache.set(root, cached);
  }
  return cached;
}

/**
 * Aggregate every landed op family's registry entries. Delegates to
 * {@link listWithDiagnostics} and returns `.entries` — the pre-existing seam
 * (and the `listOps` barrel alias) is unchanged by the diagnostics.
 */
export function list(opts?: { opsRoot?: string }): Promise<OpRegistryEntry[]> {
  return listWithDiagnostics(opts).then((aggregated) => aggregated.entries);
}

/**
 * Look up one op registry entry by name across all families, or `undefined`
 * when no family registers that name.
 */
export async function get(
  name: string,
  opts?: { opsRoot?: string },
): Promise<OpRegistryEntry | undefined> {
  return (await list(opts)).find((entry) => entry.name === name);
}

/**
 * Classify ONE family-registry import rejection: 'absent' ONLY for the known
 * resolution-error shapes naming the REQUESTED registry path itself as the
 * quoted resolution target — node's `ERR_MODULE_NOT_FOUND` +
 * `Cannot find module '<path>'` (or the module runner's
 * `Could not resolve "<path>"`). `target` is the specifier the registry was
 * imported through — a plain fs path on POSIX, a FILE URL on win32 (see the
 * import site below); when it is a file URL the two runtimes quote different
 * spellings of that ONE requested module (node's native loader prints the
 * decoded path, the vitest module runner prints the URL as given), so both
 * spellings are matched — they name the REQUESTED registry itself, never a
 * transitive dependency, and the tolerance stays exactly this narrow.
 * Everything else — a not-found for a TRANSITIVE dependency of the registry
 * module (the requested path appears only as the IMPORTING module, never as
 * the quoted target), a syntax error, an evaluation throw, junk — is
 * 'broken'.
 */
function isAbsentFamilyRegistry(err: unknown, target: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  // The file-URL spelling's other face: its decoded path. For a plain-path
  // target fileURLToPath throws (not a URL) and the list stays single-entry.
  let decodedPath: string | undefined;
  try {
    decodedPath = fileURLToPath(target);
  } catch {
    decodedPath = undefined;
  }
  const targets = decodedPath === undefined ? [target] : [target, decodedPath];
  return targets.some(
    (candidate) =>
      (code === 'ERR_MODULE_NOT_FOUND' && message.includes(`Cannot find module '${candidate}'`)) ||
      message.includes(`Could not resolve "${candidate}"`),
  );
}

/**
 * Walk wrapper schemas down to the object they hide (review-debt #82):
 * optional/nullable/default/prefault/catch/readonly carry `innerType` on
 * the def, pipes carry their IN side as `in`. Bounded (a pathological
 * self-referential def cannot loop forever); stops at the first schema
 * without an inner — an object, or a shape-less schema the gate leaves
 * unjudged.
 */
function unwrapToObjectSchema(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 10; depth++) {
    const def = (current as { def?: { innerType?: unknown; in?: unknown } } | undefined)?.def;
    if (def === undefined) return current;
    const inner = def.innerType ?? def.in;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/**
 * True when the walk to the object passes through a `.catch()` wrapper
 * (PR #112 review, Codex P2): zod's catch replaces ANY inner parse
 * failure — including the `unrecognized_keys` failure a typo'd CLI flag
 * produces against a strict object — with its fallback, so unknown keys
 * would reach the op as fallback data instead of the required exit 2.
 * A catch wrapper is incompatible with the unknown-key-rejection
 * convention, whatever the inner object's own strictness marker says.
 */
function hasCatchWrapper(schema: unknown): boolean {
  let current = schema;
  for (let depth = 0; depth < 10; depth++) {
    const def = (
      current as { def?: { type?: unknown; innerType?: unknown; in?: unknown } } | undefined
    )?.def;
    if (def === undefined) return false;
    if (def.type === 'catch') return true;
    const inner = def.innerType ?? def.in;
    if (inner === undefined) return false;
    current = inner;
  }
  return false;
}

/** One directory scan + lazy family-registry imports, per resolved root. */
async function scanOps(
  root: string,
): Promise<{ entries: OpRegistryEntry[]; skippedFamilies: string[] }> {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { entries: [], skippedFamilies: [] }; // no family has landed yet
    }
    throw err;
  }
  const entries: OpRegistryEntry[] = [];
  const skippedFamilies: string[] = [];
  const familyOf = new Map<string, string>(); // op name -> family (integrity)
  const families = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();
  for (const family of families) {
    // Discovered-path import, URL-safe. Node parses import specifiers with
    // URL semantics, so the conversion has three cases:
    //   - win32: a plain fs path cannot be imported (`import('C:\\...')`
    //     parses `c:` as a URL scheme — ERR_UNSUPPORTED_ESM_URL_SCHEME) →
    //     convert to a FILE URL (pathToFileURL).
    //   - a POSIX path containing `#`, `?`, or `%`: the raw path would
    //     truncate (`#` starts a fragment, `?` a query) or misparse (`%`
    //     starts an invalid escape) → convert too (pathToFileURL
    //     percent-escapes them, e.g. `/tmp/cq#work/ops` →
    //     `file:///tmp/cq%23work/ops`). (A backslash is NOT this case —
    //     it is unaddressable either way and refused above, review-debt
    //     #85.)
    //   - every other POSIX path: keep the plain path — it is already a
    //     valid specifier, and the vitest module runner resolves the NESTED
    //     relative dynamic imports inside a family registry (the
    //     convention's canonical `import('./<name>.js')` importer) against
    //     the file-URL module id AS AN FS PATH — importing registries via
    //     file URLs breaks every family's lazy importers under vitest. The
    //     caveat stays true exactly for these normal POSIX paths.
    // TypeScript must NOT statically resolve this specifier — families are
    // discovered at runtime.
    const registryPath = path.join(root, family, 'registry.js');
    // A POSIX path containing a backslash is UNADDRESSABLE as an ESM
    // module (review-debt #85), and neither escape form can rescue it —
    // verified against Node: the raw specifier re-resolves with the
    // backslash as a path separator (a silent WRONG path → cannot-find),
    // and a percent-encoded file URL is rejected outright ("Invalid
    // module … must not include encoded '/' or '\\' characters"). Refuse
    // loudly with the reason instead of a confusing not-found or a silent
    // family skip; win32 is exempt (backslash IS its separator, and the
    // file-URL conversion below handles it).
    if (process.platform !== 'win32' && registryPath.includes('\\')) {
      throw new Error(
        `ops scan: the family registry path '${registryPath}' contains a backslash — Node's ESM import addressing treats '\\' as a path separator on every platform, so the registry module cannot be imported; rename the directory`,
      );
    }
    const registrySpecifier =
      process.platform === 'win32' || /[#?%]/.test(registryPath)
        ? pathToFileURL(registryPath).href
        : registryPath;
    let mod: unknown;
    try {
      mod = await import(registrySpecifier);
    } catch (err) {
      if (isAbsentFamilyRegistry(err, registrySpecifier)) {
        // Absent family registry — the family lands in a later phase. It
        // contributes no entries and is surfaced in skippedFamilies rather
        // than silently dropped.
        skippedFamilies.push(family);
        continue;
      }
      throw new Error(
        `op family '${family}': registry module ${registrySpecifier} failed to load ` +
          `(broken registry): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const registry = (mod as { registry?: unknown }).registry;
    if (!Array.isArray(registry)) {
      // Loads cleanly but exports no `registry` array: NONCONFORMING, not
      // broken — by export shape the module is not an op registry yet (an
      // interim internal registry, e.g. lane-H ratchet's metric adapters).
      // It contributes no entries and is skipped + surfaced, never thrown
      // (full convention closure is phase-4 T4.2).
      skippedFamilies.push(family);
      continue;
    }
    for (const entry of registry) {
      const e = entry as Partial<OpRegistryEntry> | null | undefined;
      if (typeof e?.name !== 'string' || e.name === '') {
        throw new Error(
          `op family '${family}': registry entry must have a non-empty string 'name'`,
        );
      }
      // Dispatcher-colliding names are a malformed entry: 'run-plan' is the
      // one non-op subcommand (main.ts dispatches it before the registry) and
      // a leading '-' makes the name read as a flag token — neither can ever
      // reach get()/dispatch, so accepting them would ship a dead op.
      if (e.name === 'run-plan' || e.name.startsWith('-')) {
        throw new Error(
          `op family '${family}': op name '${e.name}' is reserved by the CLI dispatcher ` +
            `('run-plan' is the built-in subcommand; names starting with '-' parse as flags)`,
        );
      }
      if (typeof e?.inputSchema?.parse !== 'function') {
        throw new Error(
          `op family '${family}': op '${e?.name}' registry entry must have an 'inputSchema' ` +
            `with a .parse function (zod schema)`,
        );
      }
      if (typeof e?.importer !== 'function') {
        throw new Error(
          `op family '${family}': op '${e?.name}' registry entry must have an 'importer' ` +
            `function (() => Promise<Op>)`,
        );
      }
      // Reserved CLI keys can never be op input fields (src/ops/README.md):
      // `json`/`help`/`h` are reserved on EVERY subcommand (narration mode /
      // help surface) and are stripped before the schema ever sees the input,
      // so a schema declaring one — a REQUIRED reserved field especially —
      // could never receive it through its subcommand. Enforced at
      // registration time for schemas that expose a structural `.shape`
      // (same idiom as the CLI's help rendering); dynamic zod compositions
      // without a usable shape are unaffected. The schema is UNWRAPPED
      // first (review-debt #82): the common wrappers — .optional()/
      // .nullable()/nullish, .default()/.prefault(), .catch(), .readonly(),
      // and a pipe's IN side — all carry their inner schema on the def
      // (innerType, or `in` for pipes), so a bounded def-walk exposes the
      // object a wrapper hides. Without it, `z.object({...}).optional()`
      // bypassed the strictness enforcement entirely (unknown flags
      // silently stripped for such entries) — exactly the loss the
      // convention exists to prevent. A pipe THROUGH a transform (string
      // in, object out) cannot be statically judged and stays unjudged,
      // like every other shape-less schema.
      const unwrapped = unwrapToObjectSchema(e.inputSchema);
      // A catch wrapper on the way to the object would swallow the
      // unknown-key rejection the convention is about (PR #112 review) —
      // reject before the strictness marker is even consulted.
      if (hasCatchWrapper(e.inputSchema)) {
        throw new Error(
          `op family '${family}': op '${e.name}' input schema wraps its object in .catch() — ` +
            "the fallback would swallow the unknown-key rejection the .strict() convention exists to enforce (a typo'd flag must exit 2, not reach the op as fallback data)",
        );
      }
      const shape = (unwrapped as { shape?: unknown }).shape;
      if (typeof shape === 'object' && shape !== null && !Array.isArray(shape)) {
        for (const key of Object.keys(shape)) {
          if (key === 'json' || key === 'help' || key === 'h') {
            throw new Error(
              `op family '${family}': op '${e.name}' input schema declares the reserved CLI key ` +
                `'${key}' (op input schemas must not declare reserved keys: json, help, h)`,
            );
          }
        }
        // Strictness enforcement (the convention makes `.strict()`
        // load-bearing): unknown keys must FAIL parsing (the CLI maps the
        // zod issue to exit 2), so a family that forgets `.strict()` and
        // ships a default `z.object({...})` silently STRIPS typo'd keys —
        // the exact loss the convention exists to prevent. Probed live
        // against zod 4 (4.6.4): strictness is visible on the object def's
        // `catchall` — `.strict()`/`z.strictObject()` set it to a `never`
        // schema, default (strip-mode) objects leave it undefined, and
        // `.loose()`/`.passthrough()` set `unknown` (unknown keys pass, so
        // non-strict too). Refinements (`.refine`/`.superRefine`) mutate the
        // SAME ZodObject def, so the marker stays visible through them —
        // and through WRAPPERS too, since the check runs on the unwrapped
        // schema (review-debt #82). Still unjudged, deliberately: pipes
        // through transforms (the object sits on a pipe's OUT side) and
        // non-object schemas (string, array, record, union) expose no
        // `shape` — there is nothing to judge.
        const def = (
          unwrapped as { def?: { type?: unknown; catchall?: { def?: { type?: unknown } } } }
        ).def;
        if (def?.type === 'object') {
          const catchallType = def.catchall?.def?.type;
          if (catchallType !== 'never') {
            throw new Error(
              `op family '${family}': op '${e.name}' input schema must be .strict() — ` +
                'the convention makes unknown-key rejection load-bearing (src/ops/README.md)',
            );
          }
        }
      }
      const previous = familyOf.get(e.name);
      if (previous !== undefined) {
        throw new Error(
          `duplicate op name '${e.name}' registered by both family '${previous}' and family '${family}'`,
        );
      }
      familyOf.set(e.name, family);
      entries.push(e as OpRegistryEntry);
    }
  }
  return { entries, skippedFamilies };
}
