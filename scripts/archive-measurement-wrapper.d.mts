// Types for scripts/archive-measurement-wrapper.mjs (measurement slice M8b).
export interface MeasurementArchiveResult {
  state: 'archived' | 'local' | 'failed';
  runId: string | null;
  target: string | null;
  host: string;
  destination?: string;
  localBundle: string | null;
  reason?: string;
  archive: { state: 'present' | 'unavailable' | 'unknown'; reason?: string };
}

export declare function runMeasurementArchive(input?: {
  bundleDir?: string;
  target?: string;
  host?: string;
  run?: (
    command: string,
    args: string[],
  ) => Promise<{ code: number | string; stdout?: string; stderr?: string }>;
}): Promise<MeasurementArchiveResult>;
