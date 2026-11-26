// Stand-in worker entry for the process-mechanism tests. The coordinator passes
// the payload as argv[2]; its `configText` is a JSON map of item -> scenario.
// The stub does only what the scenario says on fd 3, then exits. It imports no
// repair code. Scenario: {publish?: string[], exit?: n, signal?: 'SIGKILL',
// fdsTo?: path, holdUntil?: path, afterRelease?: string[], reportTo?: path}
import { existsSync, readdirSync, readlinkSync, writeFileSync, writeSync } from 'node:fs';

const payload = JSON.parse(process.argv[2]);
const scenario = JSON.parse(payload.configText)[payload.item] ?? {};
for (const byte of scenario.publish ?? []) {
  try {
    writeSync(3, byte);
  } catch {
    // swallowed, like the real child
  }
}
if (scenario.fdsTo) {
  const fds = readdirSync('/proc/self/fd')
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((fd) => {
      try {
        return [{ fd, target: readlinkSync(`/proc/self/fd/${fd}`) }];
      } catch {
        return []; // the descriptor readdir itself used
      }
    });
  writeFileSync(scenario.fdsTo, JSON.stringify(fds));
}
if (scenario.holdUntil) {
  // Bounded wait for the test to create the release file (never open-ended).
  for (let i = 0; i < 600 && !existsSync(scenario.holdUntil); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// Bytes written only after the release file appeared (to publish while the test's loop is blocked).
for (const byte of scenario.afterRelease ?? []) writeSync(3, byte);
if (scenario.reportTo) {
  writeFileSync(
    scenario.reportTo,
    JSON.stringify({ cwd: process.cwd(), stateRoot: payload.stateRoot, clone: payload.clone }),
  );
}
if (scenario.signal) process.kill(process.pid, scenario.signal);
process.exit(scenario.exit ?? 0);
