// Coarse PR ownership only. Every uncertain range/path selects the full gate.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classifyPaths(paths) {
  if (paths.length === 0) return { typescript: true, python: true };
  let typescript = false;
  let python = false;
  for (const path of paths) {
    if (path.startsWith('apps/crq-python/')) {
      python = true;
    } else if (
      /^(?:docs|plans)\/.+\.md$/.test(path) &&
      !path.startsWith('docs/ops/') &&
      path !== 'docs/config.md'
    ) {
      // Hand-written prose. Generated docs and operational .cq are excluded.
    } else if (/^(?:README|CHANGELOG|CONTRIBUTING|AGENTS)\.md$/.test(path)) {
      // Root prose allowlist.
    } else if (/^(?:src|test)\/.+\.(?:ts|tsx|js|mjs|json)$/.test(path)) {
      typescript = true;
      if (
        /^(?:src|test)\/(?:policy|ops)\/crq\//.test(path) ||
        path === 'src/ops/dev/coderabbit.ts' ||
        path === 'test/ops/dev/coderabbit.test.ts'
      )
        python = true;
    } else {
      return { typescript: true, python: true };
    }
  }
  return { typescript, python };
}

export function selectChecks({ event, base, head, cwd = process.cwd() }) {
  if (event !== 'pull_request') return { typescript: true, python: true };
  try {
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? '')))
      throw new Error('missing SHA');
    const git = (args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const ancestor = git(['merge-base', base, head]).trim();
    // No renames: both old and new paths must be classified (including deletions).
    const paths = git(['diff', '--no-renames', '--name-only', '-z', ancestor, head, '--'])
      .split('\0')
      .filter(Boolean);
    return classifyPaths(paths);
  } catch {
    console.warn('Change detection unavailable; running all checks.');
    return { typescript: true, python: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selected = selectChecks({
    event: process.env.GITHUB_EVENT_NAME,
    base: process.env.CHANGE_BASE,
    head: process.env.CHANGE_HEAD,
  });
  for (const [key, value] of Object.entries(selected)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
