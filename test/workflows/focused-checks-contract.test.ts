import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('focused-checks policy guidance (#243)', () => {
  // The independent oracle is the canonical contract §1: workers must run
  // format:check at local checkpoints and test:narrow locally; only full
  // candidate validation belongs exclusively to CI. The template assertion
  // tracks the contract's current merge-bar wording (static and denylist
  // required on the exact PR head).
  it('keeps the file-scoped fix guidance consistent with required local format checkpoints', () => {
    const contract = read('docs/focused-checks-contract.md');
    const fixGuidance = contract.split('## 3. `pnpm fix` is file-scoped')[1]?.split('## 4.')[0];

    expect(fixGuidance).toBeDefined();
    expect(fixGuidance).toMatch(/format:check` remains.*required local checkpoint-level check/);
    expect(fixGuidance).toContain('not per-turn feedback');
    expect(fixGuidance).not.toContain('candidate-level check');
  });

  it('requires focused local tests while keeping the optional CI job distinct from repository CI', () => {
    const template = read('policy/templates/affected-tests.md');
    const introduction = template.split('## The idea')[0];

    expect(introduction).toContain('required locally through `pnpm test:narrow`');
    expect(introduction).toContain('../../docs/focused-checks-contract.md');
    expect(introduction).toContain('Full-suite checks run only in CI');
    expect(introduction).toContain(
      'green required CI (`static` and `denylist`) on the exact PR head',
    );
    expect(introduction).toContain('optional CI job');
    expect(template).not.toMatch(/selection remains a proposal|advisory developer optimization/);
    expect(template).not.toContain('Reduced selection is a per-PR convenience');
  });

  // Review r1 P3 (pr1536, 4bf05d8e): the merge-bar assertion above did not
  // guard the event/skip claims — a falsified event list stayed green
  // (mutation B). This test derives the expectation from the canonical CI
  // semantics (the static job's own selection in ci.yml, read live) and
  // pins the template's exact wording to it, so either side drifting
  // fails. Block extraction follows cq-state-skip.test.ts: a job's block
  // runs from its id line to the next two-space job id.
  it('binds the template CI-scope sentence to ci.yml static-job semantics', () => {
    // Raw read: the file-level `read` helper collapses whitespace, which
    // would destroy the line structure the job-block extraction needs.
    const lines = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ).split('\n');
    const staticLine = lines.findIndex((line) => line === '  static:');
    expect(staticLine, 'ci.yml declares a static job').toBeGreaterThan(-1);
    const nextJob = lines.findIndex(
      (line, i) => i > staticLine && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line),
    );
    const block = lines.slice(staticLine, nextJob === -1 ? lines.length : nextJob);
    const jobIf = block.find((line) => line.startsWith('    if:'));
    // The static job must select exactly the four event classes the
    // template sentence paraphrases below.
    expect(jobIf).toContain("github.event_name == 'pull_request'");
    expect(jobIf).toContain("github.event_name == 'schedule'");
    expect(jobIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(jobIf).toContain(
      "github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    // The prose/Python-only skip is enforced by the two complementary step
    // guards inside the job, not by the job selection itself.
    expect(
      block.find((line) => line.includes("needs.changes.outputs.typescript == 'false'")),
      'format-only step guard',
    ).toBeDefined();
    expect(
      block.find((line) => line.includes("needs.changes.outputs.typescript != 'false'")),
      'full static-gate step guard',
    ).toBeDefined();
    // The template introduction must state this exact selection and skip.
    // The file-level `read` helper collapses whitespace (prose-oriented),
    // so the phrases below are written single-spaced; ci.yml above is read
    // raw to preserve line structure for block extraction.
    const template = read('policy/templates/affected-tests.md');
    const introduction = template.split('## The idea')[0];
    expect(introduction).toContain(
      'on every PR head, nightly and manual dispatches, and default-branch pushes',
    );
    expect(introduction).toContain(
      'recognized prose/Python-only PRs run formatting without the TS gates',
    );
  });
});
