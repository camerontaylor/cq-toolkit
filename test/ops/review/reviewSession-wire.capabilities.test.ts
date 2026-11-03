// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// read-only reference surface and rg capability suite.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { RG_MINIMUM_VERSION } from '../../../src/driver/ai-sdk/index.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import {
  evidenceFor,
  planFor,
  recordingScanner,
  runInput,
  scratch,
  textResult,
  toolCallResult,
  useScratchRoots,
  wireFactory,
  type WireCall,
} from './reviewSession-wire.helpers.js';

useScratchRoots();

describe('review session wire hook', () => {
  it('offers the fixed read-only reference surface and records the rg capability when search is allowed', async () => {
    const root = await scratch();
    await writeFile(join(root, 'src/dep.ts'), 'export const dep = 1;\n', 'utf8');
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        generated += 1;
        if (generated === 1) return toolCallResult('read', { path: 'src/dep.ts' });
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      searchTools: true,
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(2);
    expect(evidence.status).toBe('complete');
    expect(evidence.deliveries).toHaveLength(1);
    // The injected probe's outcome rides the session evidence: search tools
    // were offered and the capability was observed.
    expect(evidence.capabilities).toEqual({
      rg: {
        available: true,
        version: RG_MINIMUM_VERSION,
        minimum: RG_MINIMUM_VERSION,
        probe: 'ok',
      },
    });
  });

  it('keeps a read-only file-only surface and no capability record when searchTools is false', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => textResult(JSON.stringify({ findings: [] })),
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      searchTools: false,
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(evidence.status).toBe('complete');
    // A session without any search tool never probes: no capability record.
    expect(evidence.capabilities).toBeUndefined();
  });
});
