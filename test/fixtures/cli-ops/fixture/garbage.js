// Pure-op fixture: garbage — a verdict OUTSIDE the frozen five-status
// taxonomy ({status:'nope'}). The CX1 gate probe: ops load from RUNTIME
// registries where TypeScript's return type is no runtime guarantee, so the
// CLI must validate every op result against the kernel's OpResultSchema
// BEFORE writing the stdout artifact — dispatching this op must yield exit 1
// with stdout EMPTY and an 'invalid result' narration, never an artifact.
export default async function garbage() {
  return { status: 'nope', detail: 'not a real status' };
}
