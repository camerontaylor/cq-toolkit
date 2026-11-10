// The denylist required check must scan with the DEFAULT BRANCH's scanner
// policy, never the scanned revision's. A pull request controls its own
// `.gitleaks.toml`; reading the policy from the head would let it allowlist
// its own findings in a required check. The head is scanned as data only.
// Pinned over the template and its instantiation: they are rendered, but the
// trust direction is the point of the workflow, so it is asserted directly.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PATHS = ['policy/templates/denylist.yml', '.github/workflows/denylist.yml'] as const;

/** Every gitleaks command line in the file. */
function gitleaksLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\bgitleaks\s+(?:git|dir|stdin)\b/.test(line));
}

/** The job-level `env:` value assigned to `name`, if any. */
function jobEnv(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\s{4}env:\s*$/.test(line));
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s{6}\S/.test(line)) break;
    const match = new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

describe.each(PATHS)('%s scans with a trusted scanner policy', (path) => {
  const text = readFileSync(join(ROOT, path), 'utf8');

  it('runs every gitleaks invocation with $GITLEAKS_CONFIG', () => {
    const invocations = gitleaksLines(text);
    // Vacuity guard: a refactor that removed the scans must fail here.
    expect(invocations.length).toBeGreaterThanOrEqual(3);
    for (const line of invocations) {
      expect(line, line).toContain('--config "$GITLEAKS_CONFIG"');
      expect(line, line).not.toContain('--config .gitleaks.toml');
    }
  });

  it('keeps the trusted policy available when both scans run', () => {
    // Check executable step order, excluding comments that describe old order.
    const steps = text.split(/^ {6}- name: /m).slice(1);
    const names = steps.map((step) => step.split('\n')[0]);
    const root = names.indexOf('Check out the repo');
    const policy = names.indexOf('Check out the trusted scanner policy (default branch)');
    const commits = names.indexOf('Scan added commits');
    const messages = names.indexOf('Scan commit messages');
    expect(root).toBeGreaterThanOrEqual(0);
    expect(policy).toBeGreaterThan(root);
    expect(commits).toBeGreaterThan(policy);
    expect(messages).toBeGreaterThan(policy);
    // A later checkout could clean away trust/; it must be the final checkout.
    const checkouts = steps.flatMap((step, index) =>
      /uses: actions\/checkout@/.test(step) ? [index] : [],
    );
    expect(checkouts).toEqual([root, policy]);
    expect(steps[root]).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(steps[policy]).toContain('path: trust');
    expect(steps[policy]).toContain('ref: ${{ github.event.repository.default_branch }}');
  });

  it('points $GITLEAKS_CONFIG at the default-branch checkout', () => {
    expect(jobEnv(text, 'GITLEAKS_CONFIG')).toBe('${{ github.workspace }}/trust/.gitleaks.toml');
    expect(text).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(text).toContain('path: trust');
    expect(text).toContain('sparse-checkout: .gitleaks.toml');
  });
});
