// Type declarations for scripts/measurement-session-index.mjs so the
// typechecked test suite can import the plain-JS offline tool. Availability
// vocabulary comes from the kernel (single source of truth — no drift).
import type { z } from 'zod';
import type { AvailabilityRecord, AvailabilityState } from '../src/kernel/types.js';

export type { AvailabilityRecord, AvailabilityState };

export interface SessionIndexRow {
  /** Archive-safe opaque remote digest; null when no remote exists. */
  repo: string | null;
  sessionId: string | null;
  workId: string;
  parentWorkId: string | null;
  branch: string;
  commitSha: string | null;
  runId: string;
  agentId: string | null;
  model: { model: string; provider: string } | null;
  attempts: number;
  tokens: number | null;
  wallMs: number | null;
  stopReasons: Array<{
    stopCode: string;
    class: 'retriable' | 'terminal' | 'infrastructure' | 'budget' | 'human';
  }>;
  availability: Record<string, AvailabilityRecord>;
}

export interface SessionIndex {
  indexVersion: 1;
  sessions: SessionIndexRow[];
}

export interface BuildSessionIndexInput {
  correlation: unknown;
  stream: unknown;
}

export type CorrelationIndexError =
  | { state: 'invalid'; reason: string }
  | { state: 'missing'; reason: string };

export declare const SessionIndexRowSchema: z.ZodTypeAny;
export declare const SessionIndexSchema: z.ZodTypeAny;

export declare function buildSessionIndex(input: BuildSessionIndexInput): SessionIndex;

export declare function parseCorrelationForIndex(
  correlation: unknown,
): { ok: true; record: Record<string, unknown> } | { ok: false; error: CorrelationIndexError };

export declare function stopReasonsOf(
  attempts: Array<{
    payload: { stopCode: string; class: SessionIndexRow['stopReasons'][number]['class'] };
  }>,
): SessionIndexRow['stopReasons'];

export declare function commitBranchIsAmbiguous(rows: SessionIndexRow[]): boolean;
