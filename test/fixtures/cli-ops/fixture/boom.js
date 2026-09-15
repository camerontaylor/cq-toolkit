// Pure-op fixture: boom — a deliberate, deterministic failure verdict. The
// error text deliberately spans TWO lines: narration is line-based (one
// `cq:`-prefixed stderr line per call), so this pins the embedded-newline
// flattening end-to-end.
export default async function boom() {
  return {
    status: 'failed',
    error: 'boom: deliberate fixture failure\nsecond line of the failure',
  };
}
