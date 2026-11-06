// dev.check op tests over a REAL git repo (repo.ts): pnpm and node are
// scripted, git and tar run for real. Pinned: the gate set and its order,
// red → failed with the record still persisted, the resolved base handed to
// test:narrow, the range rules, the path-class knip rule, the denylist scan
// over the archived tree WITH the working patch applied, and the three
// diff-checks.
//
// Split provenance: check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
// This module holds the fixture surface those files share.
import { repoEffects, type CommandHandler, type TestRepo } from './repo.js';

/** pnpm and node answer green unless `override` says otherwise. */
export const tools =
  (override: CommandHandler = () => undefined): CommandHandler =>
  async (command, args) => {
    const scripted = await override(command, args);
    if (scripted !== undefined) return scripted;
    if (command === 'pnpm' || command === 'node' || command === 'gitleaks') return 'ok\n';
    return undefined;
  };

export const devEffectsFor = (repo: TestRepo, override?: CommandHandler) =>
  repoEffects(repo, tools(override), {}, ['tar']);

export const gateNames = ['check:static', 'format:check', 'test:narrow', 'knip', 'denylist-scan'];

export const pnpmArgs = (effects: ReturnType<typeof devEffectsFor>) =>
  effects.calls.filter((call) => call.command === 'pnpm').map((call) => call.args);
