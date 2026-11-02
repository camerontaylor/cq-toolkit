import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('focused-checks policy guidance (#243)', () => {
  // The independent oracle is the canonical contract §1: workers must run
  // format:check at local checkpoints and test:narrow locally; only full
  // candidate validation belongs exclusively to CI. No existing oracle changes.
  it('keeps the file-scoped fix guidance consistent with required local format checkpoints', () => {
    const contract = read('docs/focused-checks-contract.md');
    const fixGuidance = contract.split('## 3. `pnpm fix` is file-scoped')[1]?.split('## 4.')[0];

    expect(fixGuidance).toBeDefined();
    expect(fixGuidance).toMatch(/format:check` remains.*required local checkpoint-level check/);
    expect(fixGuidance).toContain('not per-turn feedback');
    expect(fixGuidance).not.toContain('candidate-level check');
  });

  it('requires focused local tests while keeping the optional CI job distinct from candidate CI', () => {
    const template = read('policy/templates/affected-tests.md');
    const introduction = template.split('## The idea')[0];

    expect(introduction).toContain('required locally through `pnpm test:narrow`');
    expect(introduction).toContain('../../docs/focused-checks-contract.md');
    expect(introduction).toContain('Full-suite checks run only in CI');
    expect(introduction).toContain('green required CI on the exact candidate SHA');
    expect(introduction).toContain('optional CI job');
    expect(template).not.toMatch(/selection remains a proposal|advisory developer optimization/);
    expect(template).not.toContain('Reduced selection is a per-PR convenience');
  });
});
