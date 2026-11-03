// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the cancellation and timeout snapshot decisions.
import { expect, it } from 'vitest';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, clean, fakeDrivers } from './agentReviewer-partitions.helpers.js';

it('rechecks cancellation after upload scanning and before recording delivery', async () => {
  const controller = new AbortController();
  const scanner: DiffSecretScanner = (components) => {
    if (components.some(({ component }) => component === 'request')) controller.abort();
    return clean(components);
  };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ scanSecrets: scanner, signal: controller.signal }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBe(1);
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'aborted', deliveries: [] });
});

it('does not let a late scanner callback mutate the timed-out coverage snapshot', async () => {
  let releaseScan!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const scanner: DiffSecretScanner = async (components) => {
    if (components.some(({ component }) => component === 'request')) {
      markEntered();
      await scanGate;
    }
    return clean(components);
  };
  const fake = fakeDrivers();
  const pending = runAgentReviewer(fake.drivers, baseInput({ scanSecrets: scanner, wallMs: 40 }));
  await entered;
  const outcome = await pending;
  expect(outcome.status).toBe('needs-human');
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'aborted', deliveries: [] });
  const snapshot = JSON.stringify(outcome.report?.coverage);
  releaseScan();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(JSON.stringify(outcome.report?.coverage)).toBe(snapshot);
  expect(fake.sends()).toBe(0);
});
