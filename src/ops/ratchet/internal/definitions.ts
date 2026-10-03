// Ratchet definition manifest — `baselines/ratchets.json` (W1.7, ADR-0004
// D-C.4/D-C.6).
//
// The manifest names every ratchet the verifier enforces (target, metric,
// direction, unit, and whether the evidence is the head's `measurement` or a
// trusted `recompute`) plus the DEFINITION SET: anchored regex sources over
// repo-relative POSIX paths whose change redefines what a ratchet measures
// (workflows, runner/compiler config, lockfiles, the manifest itself). A
// subject that touches a definition-set path is never judged by numbers — the
// verifier routes it to needs-human.
//
// TRUST: the manifest is read ONLY from the trust ref via `git cat-file blob`
// ({@link loadTrustedManifest}); never from the working tree and never from
// the subject, so a PR cannot redefine the ratchet that judges it.
//
// parseRatchetManifest is STRICT like parseBaseline: unknown keys fail, the
// ratchet list is non-empty with unique (target, metric) pairs, and every
// definition-set entry must compile AND be anchored (`^` or `(?:^|/)`) — an
// unanchored source would match a substring anywhere in a path and silently
// widen or narrow the set in ways a reviewer would not read off the text.
import { posix } from 'node:path';
import { z } from 'zod';
import type { Direction } from '../format.js';
import { assertRepoRelPath, gitReadBlob, gitRevParse } from '../git.js';

/** Repo-relative path of the manifest (read at the trust ref). */
export const RATCHETS_MANIFEST_PATH = 'baselines/ratchets.json';

/** One enforced ratchet. */
export interface RatchetDefinition {
  target: string;
  metric: string;
  direction: Direction;
  unit?: string;
  /** `measurement`: the head's credential-free artifact; `recompute`: the trusted verifier recomputes it. */
  evidence: 'measurement' | 'recompute';
}

/** The parsed manifest. */
export interface RatchetManifest {
  schemaVersion: 1;
  ratchets: RatchetDefinition[];
  /** Anchored JS RegExp sources over repo-relative POSIX paths. */
  definitionSet: string[];
}

/** True when `source` compiles as a JS RegExp. */
function compiles(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

const RatchetDefinitionSchema: z.ZodType<RatchetDefinition> = z
  .object({
    target: z.string().min(1),
    metric: z.string().min(1),
    direction: z.enum(['lower-is-better', 'higher-is-better']),
    unit: z.string().exactOptional(),
    evidence: z.enum(['measurement', 'recompute']),
  })
  .strict();

const DefinitionPatternSchema = z
  .string()
  .refine((source) => source.startsWith('^') || source.startsWith('(?:^|/)'), {
    message: 'definitionSet entry must be anchored (start with ^ or (?:^|/))',
  })
  .refine(compiles, { message: 'definitionSet entry must compile as a RegExp' });

const RatchetManifestSchema: z.ZodType<RatchetManifest> = z
  .object({
    schemaVersion: z.literal(1),
    ratchets: z
      .array(RatchetDefinitionSchema)
      .min(1)
      .superRefine((ratchets, ctx) => {
        const seen = new Set<string>();
        for (const [index, ratchet] of ratchets.entries()) {
          // JSON of the pair: an injective key (format.ts's pathDigest idiom).
          const key = JSON.stringify([ratchet.target, ratchet.metric]);
          if (seen.has(key)) {
            ctx.addIssue({
              code: 'custom',
              path: [index],
              message: `duplicate ratchet (${ratchet.target}, ${ratchet.metric})`,
            });
          }
          seen.add(key);
        }
      }),
    definitionSet: z.array(DefinitionPatternSchema).min(1),
  })
  .strict();

/** Parse and validate manifest text; throws a plain Error on any violation. */
export function parseRatchetManifest(text: string): RatchetManifest {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`ratchet manifest: not valid JSON — ${(err as Error).message}`, {
      cause: err,
    });
  }
  const parsed = RatchetManifestSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`ratchet manifest: schema violation — ${issues}`);
  }
  return parsed.data;
}

/**
 * The manifest as committed at `trustRef` — read with `git cat-file blob`, so
 * neither the working tree nor the subject can substitute it. Absent → throw
 * (no manifest means no trusted definition; the caller fails closed).
 */
export async function loadTrustedManifest(
  repo: string,
  trustRef: string,
): Promise<RatchetManifest> {
  const text = await gitReadBlob(repo, trustRef, RATCHETS_MANIFEST_PATH);
  if (text === null) {
    throw new Error(`ratchet manifest: ${RATCHETS_MANIFEST_PATH} is absent at ${trustRef}`);
  }
  return parseRatchetManifest(text);
}

/** Compiled definition sets, keyed by manifest identity (a manifest is immutable once parsed). */
const compiledSets = new WeakMap<RatchetManifest, RegExp[]>();

/** True when `path` (repo-relative POSIX) is in the manifest's definition set. */
export function isDefinitionPath(manifest: RatchetManifest, path: string): boolean {
  let patterns = compiledSets.get(manifest);
  if (patterns === undefined) {
    patterns = manifest.definitionSet.map((source) => new RegExp(source));
    compiledSets.set(manifest, patterns);
  }
  return patterns.some((pattern) => pattern.test(path));
}

// ---------------------------------------------------------------------------
// tsconfig graph — the dynamic part of the definition set
// ---------------------------------------------------------------------------

/**
 * Cap on files in one tsconfig graph. A graph that exceeds it THROWS rather
 * than truncating: a silently dropped tail would leave definition paths
 * unprotected, so the caller fails closed.
 */
const MAX_TSCONFIG_FILES = 64;

/**
 * Strip JSONC to JSON: `//` and `/* *\/` comments are removed and trailing
 * commas before `}`/`]` dropped, all outside string literals (escapes are
 * honoured, so `"a//b"` and `"\"/*"` survive). Throws on an unterminated
 * block comment or string.
 */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new Error('unterminated string');
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      out += ' ';
      i = end + 2;
    } else if (ch === ',') {
      // A comma followed (past whitespace and comments) by a closer is trailing.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j] ?? '')) j += 1;
        if (text.startsWith('//', j)) {
          while (j < text.length && text[j] !== '\n') j += 1;
        } else if (text.startsWith('/*', j)) {
          const end = text.indexOf('*/', j + 2);
          if (end === -1) throw new Error('unterminated block comment');
          j = end + 2;
        } else break;
      }
      if (text[j] !== '}' && text[j] !== ']') out += ',';
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Resolve a tsconfig-relative reference to a repo-relative path, or null when
 * it is not a repo file this graph follows (a package-name `extends` such as
 * `@tsconfig/node20` is node_modules content; an absolute path or one that
 * escapes the repository root is outside it).
 */
function resolveRelative(fromFile: string, ref: string): string | null {
  if (ref.startsWith('/')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), ref));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  try {
    assertRepoRelPath(joined);
  } catch {
    return null;
  }
  return joined;
}

/**
 * `extends` targets (string or array): TS tries a relative reference as
 * written before appending `.json`. Both paths are definitions, even when
 * the first is absent at the trust ref: the head could add it and change
 * which config tsc resolves.
 */
function extendsTargets(file: string, config: Record<string, unknown>): string[] {
  const raw = config['extends'];
  const refs = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== 'string') continue;
    // TS resolves only `./`/`../` extends relatively; anything else is a package.
    if (!ref.startsWith('./') && !ref.startsWith('../')) continue;
    const candidates = ref.endsWith('.json') ? [ref] : [ref, `${ref}.json`];
    for (const candidate of candidates) {
      const resolved = resolveRelative(file, candidate);
      if (resolved !== null) out.push(resolved);
    }
  }
  return out;
}

/** `references[].path` targets: a `.json` path is the file, anything else is `<dir>/tsconfig.json`. */
function referenceTargets(file: string, config: Record<string, unknown>): string[] {
  const raw = config['references'];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const path = (item as { path?: unknown } | null)?.path;
    if (typeof path !== 'string') continue;
    const target = path.endsWith('.json') ? path : posix.join(path, 'tsconfig.json');
    // A reference path is always relative to the referencing file's directory.
    const resolved = resolveRelative(file, target);
    if (resolved !== null) out.push(resolved);
  }
  return out;
}

/**
 * Every repo-relative tsconfig path reachable at `rev` from `roots` through
 * relative `extends` (string or array) and `references[].path`, read from git
 * (never the working tree) and parsed as lenient JSONC. Cycle-safe. Every
 * reached path is included — also one that is absent at `rev` or does not
 * parse (it is still a definition path; it just is not followed further).
 * Package-name `extends` are node_modules content and are not followed.
 * Returned sorted. Throws when the graph exceeds {@link MAX_TSCONFIG_FILES}.
 */
export async function tsconfigGraphPaths(
  repo: string,
  rev: string,
  roots: readonly string[] = ['tsconfig.json'],
): Promise<string[]> {
  // Resolve once: a bad revision throws here instead of reading as "absent".
  const commit = await gitRevParse(repo, rev);
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (path: string): void => {
    if (seen.has(path)) return;
    if (seen.size >= MAX_TSCONFIG_FILES) {
      throw new Error(
        `ratchet definitions: tsconfig graph at ${rev} exceeds ${MAX_TSCONFIG_FILES} files`,
      );
    }
    seen.add(path);
    queue.push(path);
  };
  for (const root of roots) {
    assertRepoRelPath(root, 'tsconfig root');
    enqueue(posix.normalize(root));
  }
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const text = await gitReadBlob(repo, commit, path);
    if (text === null) continue;
    let config: unknown;
    try {
      config = JSON.parse(stripJsonc(text));
    } catch {
      continue; // unparsable: the path counts, its edges cannot be read
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue;
    const record = config as Record<string, unknown>;
    for (const next of [...extendsTargets(path, record), ...referenceTargets(path, record)]) {
      enqueue(next);
    }
  }
  return [...seen].sort();
}
