// RS-14 profile data and admission helpers — pure data, no network, no clock
// dependency (every helper takes its instant explicitly), no model calls.
//
// These pin the three rules the W2.6 admission work will lean on, and the
// fail-closed ceiling that keeps an unknown provider ADVISORY:
//
// - a structured signal (provider error code, then HTTP status) outranks text;
// - the Claude unified-quota header set is checked BEFORE `retry-after`, because
//   the captured 429 carried both and calling an exhausted plan a throttle
//   busy-retries it for an hour;
// - a `quota` verdict carries the observed reset time when one exists, and has no
//   retry time when none does — an unresettable quota is a human decision.
import { describe, expect, test } from 'vitest';
import { PROVIDER_PROFILES, providerProfile } from '../../src/driver/pricing/provider-profiles.js';
import {
  admissionVerdict,
  classifyProviderSignal,
  creditsForUsage,
  peakMultiplier,
} from '../../src/driver/pricing/admission.js';

const ZAI = providerProfile('zai-glm-coding');
const CLAUDE_SUB = providerProfile('claude-subscription');
const THURSDAY_UTC_MIDNIGHT = Date.parse('2026-10-01T00:00:00Z');
const DEEPSEEK = providerProfile('deepseek');

/** 2026-10-01T00:00:00Z — a Thursday. */

/** The unified-quota 429 RS-14 captured (research evidence cc_out3.json). */
const CLAUDE_EXHAUSTED_429 = {
  httpStatus: 429,
  retryAfterMs: 3_741_000,
  headers: {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-5h-status': 'rejected',
    'anthropic-ratelimit-unified-5h-utilization': '1.0',
    'anthropic-ratelimit-unified-5h-reset': '1790269200',
    'anthropic-ratelimit-unified-7d-utilization': '0.7',
    'anthropic-ratelimit-unified-7d-reset': '1790341200',
  },
};

describe('profile data', () => {
  test('every profile carries provenance and a lane list — no bare assertions', () => {
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      expect(profile.lanes.length).toBeGreaterThan(0);
      expect(profile.cap.provenance.source).not.toBe('');
      expect(profile.observability.provenance.source).not.toBe('');
      for (const fact of profile.errorSignals) expect(fact.provenance.source).not.toBe('');
      for (const window of profile.quota?.windows ?? []) {
        expect(window.provenance.source).not.toBe('');
      }
    }
  });

  test('RS-14 covers all six providers plus the two subscription lanes', () => {
    expect(Object.keys(PROVIDER_PROFILES).sort()).toEqual([
      'anthropic-api',
      'claude-subscription',
      'codex-chatgpt',
      'deepseek',
      'openai-api',
      'opencode-go',
      'zai-glm-coding',
    ]);
  });

  test('subscription lanes are quota-accounted and API lanes are modelled-USD', () => {
    expect(providerProfile('claude-subscription')?.accounting).toBe('quota');
    expect(providerProfile('zai-glm-coding')?.accounting).toBe('quota');
    expect(providerProfile('codex-chatgpt')?.accounting).toBe('quota');
    expect(providerProfile('opencode-go')?.accounting).toBe('quota');
    expect(providerProfile('anthropic-api')?.accounting).toBe('modeled-usd');
    expect(providerProfile('deepseek')?.accounting).toBe('modeled-usd');
    expect(providerProfile('openai-api')?.accounting).toBe('modeled-usd');
  });

  test('an unknown profile id resolves to undefined, never a default profile', () => {
    expect(providerProfile('acme-cloud')).toBeUndefined();
    expect(providerProfile(undefined)).toBeUndefined();
  });

  test('the GLM-5.3-Flash model limit omits the output cap this lane could not verify', () => {
    const limits = providerProfile('zai-glm-coding')?.modelLimits?.['glm-5.3-flash'];
    expect(limits?.maxInputTokens).toBe(1_000_000);
    // Absent, not guessed: an unknown published limit keeps the lane ADVISORY.
    expect(limits?.maxOutputTokens).toBeUndefined();
  });
});

describe('classifyProviderSignal', () => {
  test('a Claude unified-quota 429 is QUOTA even though it carries retry-after', () => {
    const verdict = classifyProviderSignal('claude-subscription', CLAUDE_EXHAUSTED_429);
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.rule).toMatch(/marker-header|structured/);
    // The unified -reset epoch is the defer-until time.
    expect(verdict.deferUntilMs).toBe(1_790_269_200_000);
  });

  test('a plain 429 with no unified headers is a throttle, deferring on retry-after', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      retryAfterMs: 2_000,
      message: 'Server is temporarily limiting requests',
    });
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.rule).toBe('retry-after');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('a 429 with neither unified headers nor retry-after falls back to the status rule', () => {
    const verdict = classifyProviderSignal('claude-subscription', { httpStatus: 429 });
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.rule).toBe('structured');
  });

  test('a provider error code outranks the HTTP status and the message text', () => {
    const verdict = classifyProviderSignal('anthropic-api', {
      httpStatus: 429,
      providerCode: 'enforced_spend_limit_reached',
      retryAfterMs: 60_000,
      message: 'rate_limit_error',
    });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.rule).toBe('structured');
  });

  test('an OpenAI credit-balance 429 is quota with no retry time', () => {
    const verdict = classifyProviderSignal('openai-api', {
      httpStatus: 429,
      providerCode: 'credit_balance_exhausted',
    });
    expect(verdict.errorClass).toBe('quota');
    // No reset was observable: a human/top-up decision, not a retry.
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('a DeepSeek 402 is quota; a 429 is the concurrency throttle', () => {
    expect(classifyProviderSignal('deepseek', { httpStatus: 402 }).errorClass).toBe('quota');
    expect(classifyProviderSignal('deepseek', { httpStatus: 429 }).errorClass).toBe('rate-limit');
  });

  test('a Z.AI coding-wire 429 is quota-shaped: no retry-after means wait for the window', () => {
    const verdict = classifyProviderSignal('zai-glm-coding', { httpStatus: 429 });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('an observed resetsAt attaches the defer-until time to the matched status rule', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 402 },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.rule).toBe('structured');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-09-28T00:00:00Z'));
  });

  test('an observed resetsAt with NO status match is still quota, defer-until-reset', () => {
    const verdict = classifyProviderSignal(
      'anthropic-api',
      { message: 'gateway said no' },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.rule).toBe('quota-resets-at');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-09-28T00:00:00Z'));
  });

  test('an unclassifiable failure is provider-error, never a silent zero or retry', () => {
    const verdict = classifyProviderSignal('deepseek', { message: 'socket hang up' });
    expect(verdict.errorClass).toBe('provider-error');
    expect(verdict.rule).toBe('unclassified');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('an unknown profile is ADVISORY provider-error with the reason attached', () => {
    const verdict = classifyProviderSignal('acme-cloud', { httpStatus: 429, retryAfterMs: 1_000 });
    expect(verdict.errorClass).toBe('provider-error');
    expect(verdict.rule).toBe('unknown-profile');
    expect(verdict.advisoryReason).toMatch(/ADVISORY/);
  });
});

describe('peakMultiplier', () => {
  test('Mon-Fri 14:00-18:00 Singapore time is the documented peak at 1x', () => {
    // 2026-10-01 is a Thursday; 15:00 +08 is 07:00 UTC.
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-01T07:00:00Z'))).toBe(1);
  });

  test('the same UTC hour outside the window is the 0.5x off-peak rate', () => {
    // 20:00 +08 is 12:00 UTC.
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-01T12:00:00Z'))).toBe(0.5);
    // 09:00 +08 is 01:00 UTC.
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-01T01:00:00Z'))).toBe(0.5);
  });

  test('the weekend is off-peak at every hour', () => {
    // 2026-10-03 is a Saturday; 07:00 UTC is 15:00 +08 — inside the weekday
    // window, but Saturday is not a peak day.
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-03T07:00:00Z'))).toBe(0.5);
  });

  test('the window is half-open: 18:00 +08 is already off-peak', () => {
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-01T10:00:00Z'))).toBe(0.5);
    expect(peakMultiplier(ZAI!, Date.parse('2026-10-01T09:59:00Z'))).toBe(1);
  });

  test('a profile with no documented peak window is never discounted', () => {
    expect(peakMultiplier(DEEPSEEK!, THURSDAY_UTC_MIDNIGHT)).toBe(1);
  });
});

describe('creditsForUsage', () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };

  test('the published GLM-5.3-Flash formula, with cache read at the CACHED rate', () => {
    // (1e6*2.3 + 1e6*0.56 + 1e6*8) / 1e6 / 10000 credits, at peak (1x).
    expect(creditsForUsage(ZAI!, usage, Date.parse('2026-10-01T07:00:00Z'))).toBeCloseTo(
      (2.3 + 0.56 + 8) / 10_000,
      12,
    );
  });

  test('off-peak credits are half the peak burn', () => {
    const peak = creditsForUsage(ZAI!, usage, Date.parse('2026-10-01T07:00:00Z'))!;
    const offPeak = creditsForUsage(ZAI!, usage, Date.parse('2026-10-01T12:00:00Z'))!;
    expect(offPeak).toBeCloseTo(peak * 0.5, 12);
  });

  test('a profile with no published burn model yields no local burn figure', () => {
    expect(creditsForUsage(CLAUDE_SUB!, usage, THURSDAY_UTC_MIDNIGHT)).toBeUndefined();
  });
});

describe('admissionVerdict', () => {
  test('a lane with a documented cap, observable headers and known limits is HARD-eligible', () => {
    expect(admissionVerdict('anthropic-api')).toEqual({ verdict: 'hard', reasons: [] });
    expect(admissionVerdict('claude-subscription')).toEqual({ verdict: 'hard', reasons: [] });
  });

  test('the console-only Z.AI lane is ADVISORY: its allowance cannot be observed', () => {
    expect(admissionVerdict('zai-glm-coding')).toEqual({
      verdict: 'advisory',
      reasons: ['limits-unknown', 'unobservable-allowance'],
    });
  });

  test('the interactive-TUI codex lane is ADVISORY for quota-aware admission', () => {
    const verdict = admissionVerdict('codex-chatgpt');
    expect(verdict.verdict).toBe('advisory');
    expect(verdict.reasons).toContain('unobservable-allowance');
  });

  test('the OpenCode Go lane has an observable endpoint, so it is HARD-eligible', () => {
    expect(admissionVerdict('opencode-go')).toEqual({ verdict: 'hard', reasons: [] });
  });

  test('an unknown provider is ADVISORY, never treated as unmetered', () => {
    expect(admissionVerdict('acme-cloud')).toEqual({
      verdict: 'advisory',
      reasons: ['unknown-profile'],
    });
    expect(admissionVerdict(undefined)).toEqual({
      verdict: 'advisory',
      reasons: ['unknown-profile'],
    });
  });
});
