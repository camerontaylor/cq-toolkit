// Type declarations for scripts/measurement-session-index.mjs so the
// typechecked test suite can import the plain-JS offline tool.
import type { ZodTypeAny, z } from 'zod';

export interface AvailabilityEntry {
  state: 'known-zero' | 'not-collected' | 'unavailable' | 'partial' | 'n-a' | 'known';
  reason: string;
  source: string | null;
}

export interface KnownTotal {
  knownSubtotal: number | null;
  complete: boolean;
}

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
  tokens: KnownTotal | null;
  wallMs: KnownTotal | null;
  stopReasons: Array<{
    stopCode: string;
    class: 'retriable' | 'terminal' | 'infrastructure' | 'budget' | 'human';
  }>;
  availability: Record<string, AvailabilityEntry>;
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
