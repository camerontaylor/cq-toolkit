// I1 CLI output contract — INJECTABLE streams (I1 slice B).
//
// src/kernel/output.ts owns the same contract against process.stdout/stderr
// DIRECTLY; the CLI needs injectable streams (tests capture output,
// embedders redirect it), so this module re-states the contract over the
// CliIo seam. Nothing here touches process streams except processIo.
//
// THE I1 CONTRACT: stdout carries exactly ONE machine-readable artifact per
// invocation (writeResultJson is the ONLY stdout writer in normal operation;
// the plain-text --help surfaces are the one sanctioned exception). Human
// narration goes to stderr with the `cq:` prefix — narration NEVER touches
// stdout, so `cq … | jq .` is always safe.
//
// NarrationMode:
//   - 'human' (the default) — failures-only narration on stderr; ok rows are
//     silent (the nx/turbo pattern).
//   - 'json' — machine mode: stderr stays EMPTY, stdout carries the artifact.
import { renderHuman } from '../kernel/output.js';
import type { OpResult, RunReport } from '../kernel/types.js';

/** The injectable stream seam: every CLI write goes through one of these. */
export interface CliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

/** Production streams: process.stdout / process.stderr. */
export const processIo: CliIo = {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
};

/**
 * Narration mode: 'human' (failures-only stderr narration — the default) or
 * 'json' (machine mode — stderr stays EMPTY; stdout always carries the
 * artifact in both modes).
 */
export type NarrationMode = 'human' | 'json';

/**
 * Write THE one stdout artifact of an invocation: pretty JSON plus a
 * trailing newline. Exactly one artifact per invocation; nothing else ever
 * writes stdout (except the plain-text --help surfaces).
 */
export function writeResultJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * JSON-LOSSLESSNESS check for op results — the CLI's exact mirror of the
 * kernel runner's walk (src/kernel/runner.ts, `assertJsonLossless`). The
 * stdout artifact is a JSON.stringify of the result; stringify-throwing
 * values (BigInt, circular) are caught by the caller's stringify probe,
 * while this walk catches the SILENTLY lossy ones — Map/Set/Date/RegExp/
 * class instances stringify as `{}` or strings, function members, symbol-keyed or non-enumerable (hidden) members
 * vanish, undefined array elements become null — where the emitted artifact
 * would disagree with the value the run produced. One normalization is
 * accepted, matching JSON semantics: an undefined-valued member of a nested
 * object IS absent data ({a: undefined} and {} are the same JSON record) —
 * required-field positions (the ok variant's `value`) are guarded by the
 * caller. Plain objects: prototype null or Object.prototype only.
 * Requires cycle-freedom — call only after the stringify probe passed.
 */
export function assertJsonLossless(value: unknown): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`non-finite number ${String(value)}`);
      return;
    case 'object': {
      if (value === null) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const element = value[i];
          if (element === undefined) throw new Error(`undefined array element at [${i}]`);
          assertJsonLossless(element);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as object).constructor?.name ?? 'unknown';
        throw new Error(`non-plain object of type '${name}'`);
      }
      // ALL own keys, not just the enumerable string-keyed ones (PR #31
      // review, Codex P1 + review-debt #76): a SYMBOL-keyed member is
      // dropped by JSON.stringify, so the emitted artifact would carry
      // less than the walk accepted; a NON-ENUMERABLE own member is the
      // worse divergence when it is a hidden `toJSON` hook — Object.values
      // skips it while stringify INVOKES it, so the artifact would carry
      // the hook's output instead of the walked shape (and any
      // non-enumerable member is data invisible to the serialization
      // either way). An ENUMERABLE own toJSON needs no special case: the
      // member walk below reaches it as a function value and throws.
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new Error(`symbol-keyed own member '${key.toString()}' — JSON.stringify drops it`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && !descriptor.enumerable) {
          throw new Error(
            key === 'toJSON'
              ? "non-enumerable own 'toJSON' — JSON.stringify invokes the hidden hook, so the artifact would carry its output instead of the walked shape"
              : `non-enumerable own member '${key}' — invisible to JSON.stringify`,
          );
        }
      }
      for (const memberValue of Object.values(value)) {
        if (memberValue === undefined) continue; // absent-key semantics
        assertJsonLossless(memberValue);
      }
      return;
    }
    default:
      throw new Error(`non-JSON value of type '${typeof value}'`);
  }
}

/**
 * One narration line to stderr with the `cq:` prefix. Never stdout (I1).
 *
 * One narrate() call is EXACTLY ONE `cq: `-prefixed stderr line: the OpResult
 * contract permits arbitrary multi-line error/reason/detail strings, and an
 * embedded newline would emit an unprefixed continuation line that breaks the
 * line-based narration contract — so embedded newlines (CR, LF, CRLF) are
 * flattened to the literal two-character `\n` escape before writing.
 * (narrateRunReport pre-splits renderHuman output and narrates line by line;
 * this guard covers every other caller and any detail text.)
 */
export function narrate(io: CliIo, message: string): void {
  const oneLine = message.replace(/\r\n?|\n/g, '\\n');
  io.stderr(`cq: ${oneLine}\n`);
}

/**
 * Human-readable detail of an op result — the same vocabulary as the
 * kernel's rowDetail: 'failed' → error, 'needs-human' → reason,
 * 'budget-exhausted' → 'budget bound hit', 'indeterminate' → detail, 'ok' →
 * bare (values can be arbitrarily large).
 */
function resultDetail(result: OpResult<unknown>): string {
  switch (result.status) {
    case 'ok':
      return '';
    case 'failed':
      return result.error;
    case 'needs-human':
      return result.reason;
    case 'budget-exhausted':
      return 'budget bound hit';
    case 'indeterminate':
      return result.detail;
  }
}

/**
 * Narrate one op result. Mode 'json' → nothing (stderr stays EMPTY). Mode
 * 'human' → failures-only: ok rows are SILENT; a non-ok result gets one
 * line, `cq: <name>: <status> — <error|reason|detail>`.
 */
export function narrateOpResult(
  io: CliIo,
  name: string,
  result: OpResult<unknown>,
  mode: NarrationMode,
): void {
  if (mode === 'json') return; // machine mode: stderr stays empty
  if (result.status === 'ok') return; // failures-only narration
  const detail = resultDetail(result);
  narrate(io, detail === '' ? `${name}: ${result.status}` : `${name}: ${result.status} — ${detail}`);
}

/**
 * Narrate a run report. Mode 'json' → nothing (stderr stays EMPTY). Mode
 * 'human' → the kernel's PURE renderHuman(report) (failures-only default:
 * one line per non-ok row plus the counts summary), split on '\n' into
 * separate `cq:` narration lines.
 */
export function narrateRunReport(io: CliIo, report: RunReport, mode: NarrationMode): void {
  if (mode === 'json') return; // machine mode: stderr stays empty
  for (const line of renderHuman(report).split('\n')) {
    narrate(io, line);
  }
}
