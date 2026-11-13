// Types for scripts/archive-measurement-wrapper.mjs (measurement slice M8b).
export interface MeasurementArchiveResult {
  state: 'archived' | 'local' | 'failed';
  runId: string | null;
  target: string | null;
  host: string;
  destination?: string;
  localBundle: string | null;
  /** Set when a required or invalid CLI input failed validation (exit 2, I1). */
  usage?: true;
  reason?: string;
  archive: { state: 'present' | 'unavailable' | 'unknown'; reason?: string };
}

/** Map an execFile failure onto the rclone runner's result shape. */
export declare function mapRcloneFailure(
  error: unknown,
  args: string[],
): { code: number | string; stdout: string; stderr: string };

export declare function runMeasurementArchive(input?: {
  bundleDir?: string;
  target?: string;
  host?: string;
  run?: (
    command: string,
    args: string[],
  ) => Promise<{ code: number | string; stdout?: string; stderr?: string }>;
}): Promise<MeasurementArchiveResult>;
