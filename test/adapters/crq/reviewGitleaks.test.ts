import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileReviewGitleaks } from '../../../src/adapters/crq/reviewGitleaks.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(script?: string) {
  const root = await mkdtemp(join(tmpdir(), 'crq-gitleaks-test-'));
  roots.push(root);
  if (script !== undefined) {
    await writeFile(join(root, 'gitleaks'), `#!/bin/sh\n${script}\n`);
    await chmod(join(root, 'gitleaks'), 0o700);
  }
  return { root, scan: fileReviewGitleaks({ path: root, scratchRoot: root, timeoutMs: 1000 }) };
}
const reportPath = 'while [ "$1" != "--report-path" ]; do shift; done; shift; report="$1"';
describe('inactive gitleaks binding', () => {
  it('distinguishes absent binary from a process failure', async () => {
    const absent = await fixture();
    expect(await absent.scan('diff')).toEqual({ kind: 'not-run' });
    const fail = await fixture('exit 2');
    expect(await fail.scan('')).toEqual({ kind: 'exit', code: 2, hits: null });
    expect(await readdir(fail.root)).toEqual(['gitleaks']);
  });
  it('passes stdin and redacted arguments and only exposes rule and line', async () => {
    const f = await fixture(
      `[ "$1 $2 $3 $4 $5 $6 $7 $8" = 'stdin --no-banner --redact --log-level error --report-format json --report-path' ] || exit 4\n[ "\${10} \${11}" = '--exit-code 0' ] || exit 4\n[ -z "$GITLEAKS_CONFIG" ] || exit 5\n${reportPath}\nIFS= read -r value\n[ "$value" = "SECRET" ] || exit 3\nprintf '%s' '[{"RuleID":"fixture","StartLine":4,"Secret":"SECRET"}]' > "$report"`,
    );
    expect(await f.scan('SECRET\n')).toEqual({
      kind: 'exit',
      code: 0,
      hits: [{ rule: 'fixture', diffLine: 4 }],
    });
    expect(await readdir(f.root)).toEqual(['gitleaks']);
  });
  it('refuses missing or malformed reports and never leaks report content', async () => {
    const missing = await fixture('exit 0');
    await expect(missing.scan('')).rejects.toThrow('gitleaks execution or report failed');
    const malformed = await fixture(`${reportPath}\nprintf '%s' 'SECRET' > "$report"`);
    await expect(malformed.scan('')).rejects.toThrow('gitleaks execution or report failed');
    expect(await readdir(malformed.root)).toEqual(['gitleaks']);
  });
  it('resolves relative PATH and scratch paths before changing the child cwd', async () => {
    const f = await fixture(`${reportPath}\nIFS= read -r value || :\nhelper > "$report"`);
    const helper = join(f.root, 'helper');
    await writeFile(helper, "#!/bin/sh\nprintf '[]'\n");
    await chmod(helper, 0o700);
    const path = relative(process.cwd(), f.root);
    const scan = fileReviewGitleaks({ path, scratchRoot: path });
    expect(await scan('')).toEqual({ kind: 'exit', code: 0, hits: [] });
  });
  it('kills a timed-out fake child and cleans its scratch directory', async () => {
    const f = await fixture('printf "%s" "$$" > ../child.pid\nexec /bin/sleep 10');
    const scan = fileReviewGitleaks({ path: f.root, scratchRoot: f.root, timeoutMs: 50 });
    await expect(scan('')).rejects.toThrow('gitleaks execution or report failed');
    const pid = Number(await readFile(join(f.root, 'child.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await readdir(f.root)).sort()).toEqual(['child.pid', 'gitleaks']);
  });
});
