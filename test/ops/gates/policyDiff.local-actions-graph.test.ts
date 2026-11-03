import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { scanWorkflow } from '../../../src/ops/gates/workflowScan.js';
import {
  HOOK_MS,
  SLOW,
  CI_PATH,
  localActionFixtures,
  setupFixtures,
  teardownFixtures,
} from './policyDiff.helpers.js';

beforeAll(setupFixtures, HOOK_MS);
afterAll(teardownFixtures);

describe('policyDiff: local actions of required-check producers', SLOW, () => {
  const la = localActionFixtures();
  const { actionOnly, changed, GATE, GATE_ACTION, INNER_SCRIPT, LA_FILES } = la;
  beforeAll(() => la.setup(), HOOK_MS);

  test.each(['root', 'nested'])(
    'self-repository action-only edits are traced (%s)',
    async (side) => {
      const out = await actionOnly(
        `self-${side}`,
        side === 'root'
          ? { [CI_PATH]: LA_FILES[CI_PATH]!.replace('uses: ./', 'uses: $/') }
          : { [GATE]: GATE_ACTION.replace('uses: ./', 'uses: $/') },
      );
      expect(out.findings).toContainEqual(changed(INNER_SCRIPT, '.github/actions/inner'));
      expect(out.verdict).toBe('needs-human');
    },
  );

  test('a broad action graph fails closed before reading its unbounded frontier', async () => {
    const out = await actionOnly('broad-graph', {
      [GATE]: `runs:\n  using: composite\n  steps:\n${Array.from(
        { length: 129 },
        (_, i) => `    - uses: ./wide/${i}\n`,
      ).join('')}`,
    });
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'required-check',
        reason: expect.stringContaining('exceeds 128 targets') as unknown,
      }),
    );
    // None of the deliberately absent children should have been read.
    expect(out.findings.some((f) => f.path.startsWith('./wide/'))).toBe(false);
    expect(out.verdict).toBe('needs-human');
  });

  test('repeated edges also exhaust the graph reference budget', async () => {
    const out = await actionOnly('repeated-graph', {
      [GATE]: `runs:\n  using: composite\n  steps:\n${'    - uses: ./.github/actions/inner\n'.repeat(1025)}`,
    });
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'required-check',
        reason: expect.stringContaining('exceeds 1024 references') as unknown,
      }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('an unchanged unparseable producer cannot hide an action-only edit', async () => {
    // GitHub-valid YAML outside the conservative scanner's supported subset.
    const workflow = LA_FILES[CI_PATH]!.replace('permissions:', '"permissions":');
    expect(scanWorkflow(workflow).ok).toBe(false);
    const out = await actionOnly('unparseable-producer', { [CI_PATH]: workflow });
    expect(out.findings).toContainEqual(
      expect.objectContaining({
        kind: 'required-check',
        path: INNER_SCRIPT,
        reason: expect.stringContaining(`${CI_PATH} unparseable`) as unknown,
      }),
    );
    expect(out.verdict).toBe('needs-human');
  });

  test('metadata lookahead does not copy the remaining rows for every uses line', async () => {
    const original = Array.prototype.slice;
    let copiedRows = 0;
    const spy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
      this: unknown[],
      start?: number,
      end?: number,
    ) {
      if (this[0] === 'name: suffix-copy-regression') copiedRows += this.length - (start ?? 0);
      return original.call(this, start, end) as unknown[];
    });
    try {
      const out = await actionOnly('metadata-lookahead', {
        [GATE]: `name: suffix-copy-regression\nruns:\n  using: composite\n  steps:\n${'    - uses: actions/checkout@v5\n\n    # gap\n'.repeat(512)}    - uses: ./.github/actions/inner\n`,
      });
      expect(out.findings).toContainEqual(changed(INNER_SCRIPT, '.github/actions/inner'));
      // A linear copy is allowed; quadratic suffix copies are not.
      expect(copiedRows).toBeLessThan(4 * 1542);
    } finally {
      spy.mockRestore();
    }
  });
});
