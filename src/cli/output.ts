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
