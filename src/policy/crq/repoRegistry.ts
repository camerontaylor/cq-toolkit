/**
 * Port of `repo_registry.parse` (apps/crq-python/repo_registry.py): the per-repo
 * review configuration under `repos`. The primary repository stays top-level in
 * config. Parsing is fail-closed: any unknown key, bad slug, bad timestamp or
 * out-of-range rank refuses the whole config, so one typo cannot silently drop
 * a repository from discovery. Pure; the caller supplies the decoded config.
 *
 * Deliberate differences, both stricter and never looser: Python's `\d` also
 * matches non-ASCII decimal digits in a `floor` timestamp (this port accepts ASCII
 * digits only), and Python accepts an arbitrary-precision `quiet_minutes` integer
 * where this port refuses one beyond +/-2^53 (it could not be a usable window).
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import { isJsonInt, jsonIntValue } from './queueDoc.js';

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

export const DEFAULT_RANK = 3;
export const MIN_RANK = 2;
export const MAX_RANK = 4;
export const DEFAULT_FINDINGS = 'issue';
const FINDINGS_MODES = ['issue', 'none'] as const;
export type FindingsMode = (typeof FINDINGS_MODES)[number];

const ALLOWED = new Set([
  'repo',
  'clone',
  'default_branch',
  'discovery',
  'floor',
  'quiet_minutes',
  'include',
  'exclude',
  'rank_tier',
  'findings',
  'scan_extra_classes',
]);

/** A refused `repos` configuration (Python `ValueError`). */
export class RepoRegistryError extends Error {
  override readonly name = 'RepoRegistryError';
}

/** One parsed `repos` entry (a non-primary repository). */
export interface RegistryRepo {
  readonly repo: string;
  readonly name: string;
  readonly clone: string;
  readonly defaultBranch: string;
  readonly defaultRef: string;
  readonly push: boolean;
  readonly pr: boolean;
  readonly floor: string | null;
  /** Positive integer, or null when the entry leaves the global window to apply. */
  readonly quietMinutes: number | null;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly rankTier: number;
  readonly findings: FindingsMode;
  readonly scanExtraClasses: readonly string[];
}

/** GitHub owner/name is case-insensitive; compare identities, never raw spellings. */
export function repoIdentity(slug: unknown): string {
  return typeof slug === 'string' ? slug.toLowerCase() : '';
}

/** `repo_registry.same_repo`: non-empty identities that agree. */
export function sameRepoIdentity(left: unknown, right: unknown): boolean {
  const a = repoIdentity(left);
  return a !== '' && a === repoIdentity(right);
}

function refuse(entry: JsonValue, why: string): never {
  const slug = entry instanceof JsonObject ? entry.get('repo') : undefined;
  throw new RepoRegistryError(`repos entry ${typeof slug === 'string' ? slug : '?'}: ${why}`);
}

/** Python `dict.get(key, default)`: a present `null` is a value, not the default. */
function lookup(entry: JsonObject, key: string): JsonValue | undefined {
  return entry.has(key) ? entry.get(key) : undefined;
}

function badGlob(value: JsonValue): boolean {
  return (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('\0')
  );
}

function stringList(
  entry: JsonObject,
  key: 'include' | 'exclude',
  fallback: readonly string[],
): string[] {
  const raw = lookup(entry, key);
  const value: JsonValue = raw === undefined ? [...fallback] : raw;
  if (!Array.isArray(value) || (value.length === 0 && key === 'include')) {
    refuse(
      entry,
      key === 'include'
        ? `${key} must be a non-empty list of globs`
        : `${key} must be a list of globs`,
    );
  }
  if (value.some(badGlob)) refuse(entry, `${key} contains an invalid glob`);
  return value as string[];
}

const daysIn = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/** `strptime('%Y-%m-%dT%H:%M:%SZ')` succeeds: a real calendar instant, year >= 1, no leap second. */
function realTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function smallInt(value: JsonValue | undefined): number | null {
  if (!isJsonInt(value)) return null;
  const n = jsonIntValue(value);
  return n >= -(2n ** 53n) && n <= 2n ** 53n ? Number(n) : null;
}

/** `repo_registry.parse_entry`. */
export function parseRepoEntry(entry: JsonValue): RegistryRepo {
  if (!(entry instanceof JsonObject) || entry.entries.some(([key]) => !ALLOWED.has(key))) {
    refuse(entry, 'must be an object with only known keys (see docs/multi-repo.md)');
  }
  const object = entry as JsonObject;
  const repo = lookup(object, 'repo');
  if (typeof repo !== 'string' || !SLUG.test(repo)) refuse(entry, 'repo must be owner/name');
  const slug = repo as string;
  const rawClone = lookup(object, 'clone');
  if (typeof rawClone !== 'string' || rawClone.trim() === '') {
    refuse(entry, 'clone path is required (host overlay supplies it)');
  }
  const clone = (rawClone as string).trim();
  const rawBranch = lookup(object, 'default_branch');
  const branch = rawBranch === undefined ? 'main' : rawBranch;
  if (
    typeof branch !== 'string' ||
    !BRANCH.test(branch) ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('.lock')
  ) {
    refuse(entry, 'invalid default_branch');
  }
  const rawDiscovery = lookup(object, 'discovery');
  const discovery = rawDiscovery === undefined ? new JsonObject([]) : rawDiscovery;
  if (
    !(discovery instanceof JsonObject) ||
    discovery.entries.some(([key]) => key !== 'push' && key !== 'pr')
  ) {
    refuse(entry, 'discovery may only contain push/pr booleans');
  }
  const flags = discovery as JsonObject;
  const rawPush = lookup(flags, 'push');
  const rawPr = lookup(flags, 'pr');
  const push = rawPush === undefined ? true : rawPush;
  const pr = rawPr === undefined ? false : rawPr;
  if (typeof push !== 'boolean' || typeof pr !== 'boolean') {
    refuse(entry, 'discovery push/pr must be booleans');
  }
  const floor = lookup(object, 'floor') ?? null;
  if (floor !== null) {
    if (typeof floor !== 'string' || !TIMESTAMP.test(floor)) {
      refuse(entry, 'floor must be an ISO Z timestamp (set at deploy time)');
    }
    if (!realTimestamp(floor as string)) refuse(entry, 'floor is not a real UTC timestamp');
  }
  const rawQuiet = lookup(object, 'quiet_minutes') ?? null;
  let quiet: number | null = null;
  if (rawQuiet !== null) {
    quiet = smallInt(rawQuiet);
    if (quiet === null || quiet <= 0) refuse(entry, 'quiet_minutes must be a positive integer');
  }
  const rawRank = lookup(object, 'rank_tier');
  const rank = rawRank === undefined ? DEFAULT_RANK : smallInt(rawRank);
  if (rank === null || rank < MIN_RANK || rank > MAX_RANK) {
    refuse(entry, `rank_tier must be an integer in [${String(MIN_RANK)}, ${String(MAX_RANK)}]`);
  }
  const rawFindings = lookup(object, 'findings');
  const findings = rawFindings === undefined ? DEFAULT_FINDINGS : rawFindings;
  if (findings !== 'issue' && findings !== 'none') {
    refuse(entry, `findings must be one of (${FINDINGS_MODES.map((m) => `'${m}'`).join(', ')})`);
  }
  const rawScan = lookup(object, 'scan_extra_classes');
  const scan = rawScan === undefined ? [] : rawScan;
  if (!Array.isArray(scan) || scan.some(badGlob)) {
    refuse(entry, 'scan_extra_classes must be a list of denylist class ids');
  }
  return {
    repo: slug,
    name: slug.split('/')[1] as string,
    clone,
    defaultBranch: branch as string,
    defaultRef: `origin/${branch as string}`,
    push,
    pr,
    floor: floor as string | null,
    quietMinutes: quiet,
    include: stringList(object, 'include', ['**']),
    exclude: stringList(object, 'exclude', []),
    rankTier: rank as number,
    findings: findings as FindingsMode,
    scanExtraClasses: [...(scan as string[])],
  };
}

/** `repo_registry.parse(config)`: the whole `repos` list, duplicates and primary repeats refused. */
export function parseRepos(config: JsonObject): RegistryRepo[] {
  // `config.get("repos", [])`: a present null is not the default and is refused below.
  const entries = lookup(config, 'repos') === undefined ? [] : lookup(config, 'repos');
  if (!Array.isArray(entries))
    throw new RepoRegistryError('repos must be a list of per-repo objects');
  const repos: RegistryRepo[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const entry of entries) {
    const parsed = parseRepoEntry(entry);
    if (seen.has(repoIdentity(parsed.repo)))
      throw new RepoRegistryError(`repos entry duplicated: ${parsed.repo}`);
    if (names.has(repoIdentity(parsed.name)))
      throw new RepoRegistryError(`repos entry name collides with another repo: ${parsed.name}`);
    if (repoIdentity(parsed.repo) === repoIdentity(lookup(config, 'repo')))
      throw new RepoRegistryError(
        'repos must not repeat the primary repo (top-level config owns it)',
      );
    seen.add(repoIdentity(parsed.repo));
    names.add(repoIdentity(parsed.name));
    repos.push(parsed);
  }
  return repos;
}
