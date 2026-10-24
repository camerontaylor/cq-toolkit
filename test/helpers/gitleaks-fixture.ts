import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Process-backed clean/fault gitleaks contract fixture, never a production scanner override. */
export async function makeGitleaksFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cq-gitleaks-fixture-'));
  const log = join(root, 'calls.jsonl');
  await writeFile(
    join(root, 'gitleaks'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const report = args[args.indexOf('--report-path') + 1];
if (!args.includes('detect') || !args.includes('--no-git') || !report) process.exit(2);
fs.writeFileSync(report, '[]');
const failOn = process.env.CQ_TEST_GITLEAKS_FAIL_ON;
const matched = failOn && fs.readdirSync(args[args.indexOf('--source') + 1])
  .filter(name => name.startsWith('component-'))
  .some(name => fs.readFileSync(require('node:path').join(args[args.indexOf('--source') + 1], name), 'utf8').includes(failOn));
process.exitCode = matched ? 2 : Number(process.env.CQ_TEST_GITLEAKS_EXIT ?? 0);
`,
  );
  await chmod(join(root, 'gitleaks'), 0o755);
  return {
    root,
    path: root + ':' + (process.env.PATH ?? ''),
    calls: async (): Promise<string[][]> =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
  };
}
