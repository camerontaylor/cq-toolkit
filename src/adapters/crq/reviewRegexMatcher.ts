import { Worker } from 'node:worker_threads';

export interface ReviewRegexBatch {
  rules: readonly { regex: string; path: string | null }[];
  lines: readonly { path: string; text: string }[];
}
/** Inactive worker-backed subset matcher. Python is never used at runtime. */
export async function matchReviewRegexBatch(
  input: ReviewRegexBatch,
  timeoutMs = 10000,
): Promise<readonly (readonly [number, number])[]> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    input.rules.length > 100 ||
    input.lines.length > 100000 ||
    input.rules.length * input.lines.length > 1000000 ||
    input.rules.some(
      (rule) => rule.regex.length > 8192 || (rule.path !== null && rule.path.length > 8192),
    ) ||
    Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024
  )
    throw new Error('review matcher input exceeds limits');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./reviewRegexWorker.js', import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    });
    let finished = false;
    const finish = (hits?: readonly (readonly [number, number])[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().then(
        () => {
          if (hits === undefined) reject(new Error('review matcher unavailable'));
          else resolve(hits);
        },
        () => reject(new Error('review matcher unavailable')),
      );
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    worker.once('error', () => finish());
    worker.once('exit', () => finish());
    worker.once('message', (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('ok' in message) ||
        message.ok !== true ||
        !('hits' in message) ||
        !Array.isArray(message.hits) ||
        message.hits.length > 100000
      )
        return finish();
      const result: [number, number][] = [];
      let previous = -1;
      for (const entry of message.hits as unknown[]) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'number' ||
          typeof entry[1] !== 'number' ||
          !Number.isSafeInteger(entry[0]) ||
          !Number.isSafeInteger(entry[1]) ||
          entry[0] < 0 ||
          entry[0] >= input.lines.length ||
          entry[1] < 0 ||
          entry[1] >= input.rules.length
        )
          return finish();
        const order = entry[0] * input.rules.length + entry[1];
        if (order <= previous) return finish();
        previous = order;
        result.push([entry[0], entry[1]]);
      }
      finish(result);
    });
  });
}
