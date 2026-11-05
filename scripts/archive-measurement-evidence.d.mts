// Types for scripts/archive-measurement-evidence.mjs (measurement slice M8a).
export declare function sanitizeEvidenceText(text: string): string;
export declare function buildMeasurementBundle(input: unknown): Promise<unknown>;
export declare function restoreMeasurementBundle(bundleDir: string): Promise<unknown>;
