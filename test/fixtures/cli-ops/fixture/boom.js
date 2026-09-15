// Pure-op fixture: boom — a deliberate, deterministic failure verdict.
export default async function boom() {
  return { status: 'failed', error: 'boom: deliberate fixture failure' };
}
