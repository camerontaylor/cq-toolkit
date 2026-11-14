import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  parseJsonValue,
  type JsonValue,
} from './jsonValue.js';
import { pythonStr } from './prReviewFindings.js';
import { pythonStrip } from './repairBinding.js';

const types = new Set([
  'finding',
  'complete',
  'error',
  'action_required',
  'status',
  'heartbeat',
  'review_context',
]);
const blocking = new Set(['critical', 'major']);
const safeCode = /^[A-Za-z0-9_-]{1,80}$(?![\s\S])/;
const noFresh = /no fresh (detailed )?(file )?review|review (was )?skipped|skipped (this )?review/i;
const int = (n: number | bigint) => JsonNumber.int(n);
const object = (entries: [string, JsonValue][]) => new JsonObject(entries);

// Python's regex \\d and int() accept Unicode decimal digits. Adjacent Nd
// blocks may form runs longer than ten (mathematical digits), hence modulo 10.
function decimalInteger(digits: string): bigint {
  let result = 0n;
  for (const digit of digits) {
    const code = digit.codePointAt(0)!;
    let first = code;
    while (first > 0 && /\p{Decimal_Number}/u.test(String.fromCodePoint(first - 1))) first--;
    result = result * 10n + BigInt((code - first) % 10);
  }
  return result;
}

/** Classify an optional UTF-8 review stream without consulting the filesystem or provider. */
export function classify(bytes: Uint8Array | null, exitCode: number | null): JsonObject {
  const events: JsonObject[] = [];
  let bad = 0;
  if (bytes !== null) {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    // Python str.splitlines recognises these C0 separators too.
    // eslint-disable-next-line no-control-regex
    for (const raw of text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
      const line = pythonStrip(raw);
      if (!line) continue;
      try {
        const event = parseJsonValue(line, {
          duplicates: 'last',
          parseConstant: (s) =>
            JsonNumber.float(s === 'NaN' ? NaN : s === 'Infinity' ? Infinity : -Infinity),
        });
        if (
          !(event instanceof JsonObject) ||
          typeof event.get('type') !== 'string' ||
          !types.has(event.get('type') as string)
        ) {
          bad++;
          continue;
        }
        if (
          event.get('type') === 'finding' &&
          (typeof event.get('severity') !== 'string' || !event.get('severity'))
        )
          bad++;
        events.push(event);
      } catch (error) {
        if (!(error instanceof JsonParseError)) throw error;
        bad++;
      }
    }
  }
  const errors = events.filter((e) => e.get('type') === 'error');
  const actions = events.filter(
    (e) => e.get('type') === 'action_required' || e.get('status') === 'awaiting_confirmation',
  );
  const findings = events.filter((e) => e.get('type') === 'finding');
  const complete = events.filter((e) => e.get('type') === 'complete');
  const last = events.at(-1);
  const counts = new Map<string, number>(
    ['critical', 'major', 'minor', 'trivial', 'info', 'none'].map((s) => [s, 0]),
  );
  for (const f of findings) {
    const severity = f.get('severity');
    const key = typeof severity === 'string' ? severity : 'none';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const causes: JsonValue[] = [];
  let proof = bytes !== null && bad === 0 && Number.isInteger(exitCode);
  const hard = (code: string) =>
    causes.push(
      object([
        ['source', 'queue'],
        ['category', 'unknown'],
        ['code', code],
      ]),
    );
  for (let i = 0; i < bad; i++) hard('malformed-stream');
  for (const e of events) {
    const type = e.get('type');
    if (type === 'error') {
      const code = e.get('errorType');
      if (code === 'rate_limit' && e.get('recoverable') === true)
        causes.push(
          object([
            ['source', 'vendor'],
            ['category', 'vendor-rate-limited'],
            ['code', 'rate_limit'],
          ]),
        );
      else hard(typeof code === 'string' && safeCode.test(code) ? code : 'unknown-error');
    }
    if (type === 'action_required' || e.get('status') === 'awaiting_confirmation')
      hard('action-required');
    const severity = e.get('severity');
    if (type === 'finding' && typeof severity === 'string' && blocking.has(severity))
      hard('blocking-finding');
    if (type !== 'complete' && e.has('status')) {
      const status = e.get('status');
      const progress =
        (type === 'status' &&
          typeof status === 'string' &&
          ['scanning', 'reviewing', 'writing'].includes(status)) ||
        (type === 'heartbeat' && status === 'reviewing');
      if (!progress) {
        hard(typeof status === 'string' && safeCode.test(status) ? status : 'unrecognized-status');
        proof = false;
      }
    }
  }
  if (errors.length && complete.length) hard('conflicting-terminal');
  const vendorOnly =
    causes.length > 0 &&
    causes.every((c) => c instanceof JsonObject && c.get('source') === 'vendor');
  if (!Number.isInteger(exitCode)) hard('missing-exit');
  else if (exitCode !== 0 && !(exitCode === 1 && vendorOnly)) hard('unexpected-exit');
  let outcome: string;
  let message: string | undefined;
  let reviewed: JsonValue | undefined;
  let wait: JsonValue | undefined;
  if (actions.length) {
    outcome = 'action_required';
    message = 'structured action required';
  } else if (errors.some((e) => e.get('errorType') === 'auth')) {
    outcome = 'auth';
    message = 'structured authentication failure; owner action needed';
  } else if (errors.length) {
    if (vendorOnly && proof && (exitCode === 0 || exitCode === 1)) {
      outcome = 'rate_limited';
      const waits: bigint[] = [];
      for (const e of errors) {
        const metadata = e.get('metadata');
        const value = metadata instanceof JsonObject ? metadata.get('waitTime') : undefined;
        // Python regex whitespace includes C0 separators and excludes the BOM.
        // eslint-disable-next-line no-control-regex
        const waitPattern =
          /^(\p{Decimal_Number}+)([\s\x1c-\x1f]*)(second|minute|hour)s?$(?![\s\S])/u;
        const m = typeof value === 'string' ? waitPattern.exec(value) : null;
        if (m && !m[2]!.includes('\ufeff'))
          waits.push(
            decimalInteger(m[1]!) * BigInt(m[3] === 'second' ? 1 : m[3] === 'minute' ? 60 : 3600),
          );
      }
      wait = waits.length ? int(waits.reduce((a, b) => (a > b ? a : b))) : null;
    } else {
      outcome = 'error';
      message = 'structured failure; see failure provenance';
    }
  } else if (exitCode === null) {
    outcome = 'interrupted';
    message = 'no exit status recorded';
  } else if (exitCode !== 0) {
    outcome = 'error';
    message = `CLI exit ${exitCode}`;
  } else if (bad) {
    outcome = 'malformed';
    message = 'stream contains malformed or unrecognized events';
  } else if (complete.length && noFresh.test(pythonStr(complete[0]!.get('message') ?? ''))) {
    outcome = 'skipped';
    message = 'affirmative no-fresh/skipped completion';
  } else if (complete.length !== 1 || last?.get('type') !== 'complete') {
    outcome = 'interrupted';
    message = 'stream did not end with a terminal complete event';
  } else if (last.get('status') !== 'review_completed') {
    outcome = 'skipped';
    message = `complete.status=${pythonStr(last.get('status') ?? null)}`;
  } else {
    outcome = 'completed';
    const files = last.get('reviewedFiles');
    reviewed = Array.isArray(files)
      ? int(files.length)
      : files instanceof JsonNumber && files.kind === 'int' && files.integer! >= 0n
        ? files
        : int(0);
  }
  if (!errors.length && !actions.length && outcome !== 'completed') hard('nonterminal-review');
  if (!proof && outcome === 'completed') {
    outcome = 'malformed';
    message = 'stream contains an unrecognized status';
  }
  const entries: [string, JsonValue][] = [
    ['exit', exitCode === null ? null : int(exitCode)],
    ['events', int(events.length)],
    ['bad_lines', int(bad)],
    ['findings', int(findings.length)],
    ['severity_counts', object([...counts].map(([k, v]) => [k, int(v)]))],
    ['outcome', outcome],
  ];
  if (message !== undefined) entries.push(['message', message]);
  if (reviewed !== undefined) entries.push(['reviewed_files', reviewed]);
  if (wait !== undefined) entries.push(['wait_seconds', wait]);
  entries.push(
    [
      'failure_provenance',
      object([
        ['version', int(1)],
        ['complete', proof],
        ['causes', causes],
      ]),
    ],
    ['counted', outcome === 'completed'],
  );
  const cleanFailure =
    proof &&
    !bad &&
    !actions.length &&
    !complete.length &&
    !findings.some(
      (f) => typeof f.get('severity') === 'string' && blocking.has(f.get('severity') as string),
    );
  let transient: string | undefined;
  if (cleanFailure && outcome !== 'completed') {
    if (
      errors.length &&
      errors.every((e) => e.get('errorType') === 'rate_limit' && e.get('recoverable') === true) &&
      (exitCode === 0 || exitCode === 1)
    )
      transient = 'vendor-rate-limited';
    else if (
      errors.length &&
      errors.every(
        (e) =>
          (e.get('errorType') === 'network_error' || e.get('errorType') === 'transport_error') &&
          e.get('recoverable') === true,
      ) &&
      (exitCode === 0 || exitCode === 1)
    )
      transient = 'transport';
    else if (!errors.length && exitCode === 124) transient = 'timeout';
    else if (!errors.length && exitCode !== null && [-2, -9, -15, 130, 137, 143].includes(exitCode))
      transient = 'interrupted';
  }
  if (transient)
    entries.push([
      'retry_transient',
      object([
        ['version', int(1)],
        ['category', transient],
      ]),
    ]);
  return object(entries);
}

/** D2 scheduling override, separate from the receipt-compatible classification. */
export function noFreshScheduling(classification: JsonObject): {
  state: 'blocked';
  reason: 'skipped:no-fresh';
  retriable: true;
} | null {
  return classification.get('outcome') === 'skipped' &&
    classification.get('message') === 'affirmative no-fresh/skipped completion'
    ? { state: 'blocked', reason: 'skipped:no-fresh', retriable: true }
    : null;
}
