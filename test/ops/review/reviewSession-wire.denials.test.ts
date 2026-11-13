// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// recoverable denial and truncation suite.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
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
  it('records a recoverable denial and truncation without poisoning coverage', async () => {
    const root = await scratch();
    await writeFile(join(root, 'src/big.txt'), 'x'.repeat(210_000), 'utf8');
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        generated += 1;
        if (generated === 1) return toolCallResult('read', { path: '../outside.txt' });
        if (generated === 2) return toolCallResult('read', { path: 'src/big.txt' });
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(3);
    expect(calls.map((call) => call.kind)).toEqual([
      'model-request',
      'tool-output', // denied call's retained assistant diagnostic
      'model-request',
      'tool-output', // successful read result upload scan
      'tool-output', // successful call's retained assistant diagnostic
      'model-request',
    ]);
    expect(JSON.parse(calls[1]!.text)).toMatchObject({
      toolCalls: [{ toolName: 'read', input: { file_path: '../outside.txt' } }],
    });
    expect(JSON.parse(calls[4]!.text)).toMatchObject({
      toolCalls: [{ toolName: 'read', input: { file_path: 'src/big.txt' } }],
    });
    expect(scanCalls).toHaveLength(6);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(1);
    expect(evidence.requests).toHaveLength(3);
    expect(evidence.deliveries).toHaveLength(1);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
    const transcript = await readFile(
      // The session binding file lives outside the repo root (Annex A,
      // issue #1197): the wire factory's sessions sibling, not root/sessions.
      join(`${root}-sessions`, `${evidence.driverSessionId}.jsonl`),
      'utf8',
    );
    expect(transcript).toContain('"toolName":"read"');
    expect(transcript).toContain('\\"ok\\":false');
    expect(transcript).toContain('\\"truncated\\":true');
  });
});
