/**
 * `crq_review_identity.authenticated_gh` and `pr_review_findings.select_receipt_identity`.
 *
 * The App token comes from `cq-review-post`'s token-only interface, captured privately
 * and never logged. Once an identity is selected a POST never switches to another one.
 * The helper process, the clock and the environment are injected; the real `spawnSync`
 * seam belongs to the binding layer. Inactive: nothing imports this yet.
 */
import { JsonObject, parseJsonValue, type JsonValue } from './jsonValue.js';
import {
  PrReviewRuntimeError,
  PrReviewValueError,
  authenticatedLogin,
  ghString,
  type GhPort,
  type GhResult,
} from './prReviewFindings.js';
import { pythonIsSpace, pythonStrip, pythonTruthy } from './repairBinding.js';

/** Safe reason code only: never carry helper output or exception detail. */
export class IdentityUnavailable extends Error {
  override readonly name: string = 'IdentityUnavailable';
  readonly pythonError = 'IdentityUnavailable';
}

/** Why a process could not run: `FileNotFoundError` is `missing`, any other OSError/SubprocessError `other`. */
export class ProcessLaunchError extends Error {
  override readonly name: string = 'ProcessLaunchError';
  readonly kind: 'missing' | 'other';

  constructor(kind: 'missing' | 'other', detail = '') {
    super(detail);
    this.kind = kind;
  }
}

export interface IdentityRun {
  readonly inputText: string | null;
  readonly timeoutSec: number;
  /** null: inherit the ambient environment. */
  readonly env: Readonly<Record<string, string>> | null;
}

export interface IdentityDeps {
  /** `subprocess.run(argv, capture_output=True, text=True, ...)`; a launch failure is a `ProcessLaunchError`. */
  run(argv: readonly string[], options: IdentityRun): GhResult;
  /** `time.time()`. */
  now(): number;
  /** `os.environ`. */
  env: Readonly<Record<string, string>>;
}

const HELPER_TIMEOUT = 60;
const SKEW = 10;
const STRIPPED = ['GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

function helper(deps: IdentityDeps, args: readonly string[]): GhResult {
  try {
    return deps.run(['cq-review-post', ...args], {
      inputText: null,
      timeoutSec: HELPER_TIMEOUT,
      env: null,
    });
  } catch (error) {
    if (error instanceof ProcessLaunchError)
      throw new IdentityUnavailable(
        error.kind === 'missing' ? 'helper-missing' : 'helper-unavailable',
      );
    throw error;
  }
}

const isReturncodeZero = (result: GhResult): boolean => !pythonTruthy(result.returncode ?? null);

/** `datetime.fromisoformat` for the offset-bearing forms the helper emits; microseconds since the epoch, or null. */
export function parseAwareIso(text: string): bigint | null {
  const match =
    /^(\d{4})-?(\d{2})-?(\d{2})(.)(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d{1,6})?)?)?)$/u.exec(
      text,
    );
  if (match === null) return null;
  const [, y, mo, d, , h, mi = '0', s = '0', frac = '', zone = ''] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < 1 || month < 1 || month > 12 || hour > 24 || minute > 59 || second > 59) return null;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const micros = BigInt((frac + '000000').slice(0, 6));
  // `24:00[:00[.0]]` is midnight of the next day; any other minute/second is rejected.
  const rollover = hour === 24;
  if (rollover && (minute !== 0 || second !== 0 || micros !== 0n)) return null;
  if (rollover && year === 9999 && month === 12 && day === 31) return null;
  let offsetSeconds = 0n;
  if (zone !== 'Z') {
    const parts = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?(?:\.(\d{1,6}))?$/u.exec(zone);
    if (parts === null) return null;
    const [, sign, oh, om = '0', os = '0'] = parts;
    if (Number(oh) > 23 || Number(om) > 59 || Number(os) > 59) return null;
    offsetSeconds = BigInt(Number(oh) * 3600 + Number(om) * 60 + Number(os));
    if (sign === '-') offsetSeconds = -offsetSeconds;
  }
  const days = BigInt(probe.getTime() / 86_400_000);
  const local = days * 86_400n + BigInt(hour * 3600 + minute * 60 + second);
  return (local - offsetSeconds) * 1_000_000n + micros;
}

/** `crq_review_identity.authenticated_gh`: a gh port bound to a repo-scoped installation token. */
export function authenticatedGh(deps: IdentityDeps, repo: string): GhPort {
  const probe = helper(deps, ['--capabilities']);
  let supported = false;
  try {
    const parsed = parseJsonValue(ghString(probe.stdout), { duplicates: 'last' });
    supported =
      parsed instanceof JsonObject && parsed.get('installation_token') === 'repo-scoped-v1';
  } catch {
    supported = false;
  }
  if (!isReturncodeZero(probe) || !supported)
    throw new IdentityUnavailable('helper-capability-missing');
  const result = helper(deps, ['--installation-token', '--repo', repo]);
  if (!isReturncodeZero(result)) throw new IdentityUnavailable('app-credentials-unavailable');
  const token = pythonStrip(ghString(result.stdout));
  const invalid = new IdentityUnavailable('invalid-credential-response');
  let expiry: number;
  try {
    const document = parseJsonValue(ghString(result.stderr), { duplicates: 'last' });
    const raw = document instanceof JsonObject ? document.get('expires_at') : undefined;
    if (typeof raw !== 'string') throw invalid;
    const micros = parseAwareIso(raw.replace('Z', '+00:00'));
    if (micros === null) throw invalid;
    expiry = Number(micros) / 1e6;
    if (expiry <= deps.now() + SKEW) throw invalid;
    if (token === '' || [...token].some((c) => pythonIsSpace(c.codePointAt(0) as number)))
      throw invalid;
  } catch {
    throw invalid;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(deps.env))
    if (!STRIPPED.includes(key)) env[key] = value;
  env.GH_TOKEN = token;
  return (argv, options) => {
    if (deps.now() + SKEW >= expiry)
      throw new PrReviewRuntimeError('App credentials expired; retry with the same identity');
    const out = deps.run(argv, { inputText: options.inputText, timeoutSec: HELPER_TIMEOUT, env });
    const redact = (value: JsonValue | undefined): string =>
      (typeof value === 'string' ? value : '').split(token).join('[redacted]');
    return {
      returncode: out.returncode ?? null,
      stdout: redact(out.stdout),
      stderr: redact(out.stderr),
    };
  };
}

export interface IdentitySelection {
  readonly gh: GhPort;
  readonly login: string;
  readonly meta: JsonObject;
}

const setKey = (meta: JsonObject, key: string, value: JsonValue): JsonObject => {
  const entries = meta.entries.map(([k, v]) =>
    k === key ? ([k, value] as const) : ([k, v] as const),
  );
  return new JsonObject(meta.has(key) ? entries : [...entries, [key, value]]);
};

export interface SelectInput {
  readonly repo: string;
  readonly meta: JsonObject;
  readonly gh: GhPort;
  readonly login: string | null | undefined;
  /** The caller supplied its own gh, so no App credential setup is attempted. */
  readonly injected: boolean;
  readonly authenticate: (repo: string) => GhPort;
  /** `meta["identity_checkpoint"]`, a callable Python keeps inside the meta dict. */
  readonly checkpoint?: ((login: string, reason: JsonValue) => void) | null;
}

/** `select_receipt_identity`: App identity first, an explicit unattested host fallback only before any POST. */
export function selectReceiptIdentity(input: SelectInput): IdentitySelection {
  let { gh, meta } = input;
  let login = input.login ?? null;
  const selected = meta.get('posting_identity') ?? null;
  const isApp = selected === 'cq-review[bot]';
  if (!input.injected) {
    if (pythonTruthy(selected) && !isApp) {
      const actual = authenticatedLogin(gh);
      if (actual !== selected) throw new PrReviewValueError('changed CRQ posting identity');
      login = actual;
      meta = setKey(meta, 'unattested', true);
    } else {
      try {
        gh = input.authenticate(input.repo);
        login = 'cq-review[bot]';
      } catch (error) {
        if (!(error instanceof IdentityUnavailable)) throw error;
        if (isApp)
          throw new PrReviewRuntimeError(
            'App identity selected; credential setup unavailable, retry as App',
          );
        meta = setKey(setKey(meta, 'unattested', true), 'identity_reason', error.message);
      }
    }
  }
  const resolved = login !== null && login !== '' ? login : authenticatedLogin(gh);
  if (pythonTruthy(selected) && selected !== resolved)
    throw new PrReviewValueError('changed CRQ posting identity');
  input.checkpoint?.(resolved, meta.get('identity_reason') ?? null);
  return { gh, login: resolved, meta };
}
