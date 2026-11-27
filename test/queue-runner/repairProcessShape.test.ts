/**
 * The glue's refusal of a result that is not an object. `runRepairProcess`
 * itself raises before returning one (a non-dict prior fails at `prior.get`),
 * so the branch is a defensive guard; the machine is stubbed to reach it.
 */
import { describe, expect, test, vi } from 'vitest';

import { RepairItemShapeError } from '../../src/ops/crq/internal/repairItemLoop.js';
import { JsonObject } from '../../src/policy/crq/jsonValue.js';
import { bindRepairProcess } from '../../src/queue-runner/repairProcess.js';
import type { RepairRungEffects } from '../../src/queue-runner/repairRungMachine.js';

vi.mock('../../src/queue-runner/repairRungMachine.js', () => ({
  runRepairProcess: vi.fn(async () => [1]),
}));

describe('bindRepairProcess shape guard', () => {
  test('a non-object result is a RepairItemShapeError with the Python text', async () => {
    const run = bindRepairProcess({
      config: {},
      root: '/T/root',
      effects: {} as RepairRungEffects,
    });
    const job = new JsonObject([['job', 'j']]);
    await expect(run(job, '/T/wt')).rejects.toBeInstanceOf(RepairItemShapeError);
    await expect(run(job, '/T/wt')).rejects.toThrow(
      "AttributeError: 'list' object has no attribute 'get'",
    );
  });
});
