/** Type boundary for the standalone JavaScript test-narrow policy. */
export const MAX_FILES: number;
export const NICE_INCREMENT: number;
export const MAX_WAIT_CEILING_S: number;
export const RUN_TIMEOUT_MS: number;
export const DEFAULT_BASE: string;
export const GATED_CLASSES: readonly string[];
export const USAGE: string;
export interface NarrowOptions {
  files: string[];
  base: string | null;
  range: string | null;
  dryRun: boolean;
  include: string[];
  testNamePattern: string | null;
  maxWaitS: number;
}
export function parseArgs(
  argv: readonly string[],
): { ok: true; options: NarrowOptions } | { ok: false; help?: true; reason?: string };
export function classOf(file: string, manifest: Readonly<Record<string, string>>): string;
export interface PlannedFile {
  file: string;
  project: string;
}
export function planRun(input: {
  selection: { files: readonly string[]; fallback: boolean; reason: string };
  manifest: Readonly<Record<string, string>>;
  include: readonly string[];
}): { ok: true; run: PlannedFile[] } | { ok: false; reason: string; candidates: string[] };
export function missingManifestEntries(
  manifest: Readonly<Record<string, string>>,
  exists: (file: string) => boolean,
): string[];
export function projectsOf(run: readonly PlannedFile[]): string[];
export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}
export interface Summary {
  result: string;
  exit: number;
  files?: readonly string[];
  projects?: readonly string[];
  tests?: TestCounts;
  waitMs?: number;
  durationMs?: number;
  nice?: number;
  load?: string;
  uptimeS?: number;
  source?: string;
  ran?: readonly string[];
  reason?: string;
}
export function summaryLine(summary: Summary): string;
export function readReport(
  report: unknown,
  toRelative: (path: string) => string,
): { tests: TestCounts; ran: string[] } | null;
export function runVerdict(input: {
  exit: number;
  report: { tests: TestCounts; ran: string[] } | null;
  files: readonly string[];
  timedOut: boolean;
  interruptedBy: string | null;
}): { result: string; exit: number; reason?: string };
