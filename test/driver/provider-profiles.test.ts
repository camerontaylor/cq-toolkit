// RS-14 profile data and admission helpers — pure data, no network, no clock
// dependency (every helper takes its instant explicitly), no model calls.
//
// These pin the rules the W2.6 admission work leans on, and the fail-closed
// ceiling that keeps an unknown provider ADVISORY:
//
// - rules are consulted by discriminator specificity — provider error code, then
//   required message shape, then endpoint identity, then MARKER HEADER, then bare
//   HTTP status — and a rule matches only when EVERY discriminator it declares
//   matches. A provider's own header set outranks its status code;
// - the Claude unified-quota header set is checked BEFORE `retry-after`, because
//   the captured 429 carried both and calling an exhausted plan a throttle
//   busy-retries it for an hour;
// - a `quota` verdict carries the observed reset time when one exists, and has no
//   retry time when none does — an unresettable quota is a human decision.
import { describe, expect, test } from 'vitest';
import { PROVIDER_PROFILES, providerProfile } from '../../src/driver/pricing/provider-profiles.js';
import type { ProviderSignal } from '../../src/driver/pricing/admission.js';
import {
  admissionVerdict,
  classifyProviderSignal,
  creditsAreLowerBound,
  creditsForUsage,
  peakMultiplier,
} from '../../src/driver/pricing/admission.js';

const ZAI = providerProfile('zai-glm-coding');
const CLAUDE_SUB = providerProfile('claude-subscription');
const THURSDAY_UTC_MIDNIGHT = Date.parse('2026-10-01T00:00:00Z');
const DEEPSEEK = providerProfile('deepseek');

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
    // The unified -reset epoch of the BLOCKING window is the defer-until time.
    expect(verdict.deferUntilMs).toBe(1_790_269_200_000);
  });

  test('when the WEEKLY window is the blocked one, defer past the 7-day reset', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      ...CLAUDE_EXHAUSTED_429,
      headers: {
        ...CLAUDE_EXHAUSTED_429.headers,
        // 5-hour window has room again; the weekly window is spent.
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
      },
    });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(1_790_341_200_000);
  });

  test('with neither window reporting blocked, defer past the LATER reset', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      ...CLAUDE_EXHAUSTED_429,
      headers: {
        ...CLAUDE_EXHAUSTED_429.headers,
        // BOTH statuses must be cleared, not just the utilizations: the shared
        // fixture reports `5h-status: rejected`, which alone keeps the 5-hour
        // window blocking. Overriding utilization only would leave the fixture
        // describing a blocked window while the assertion expected a free one.
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-utilization': '0.7',
      },
    });
    // Choosing the earlier reset here could retry against a wall that has not moved.
    expect(verdict.deferUntilMs).toBe(1_790_341_200_000);
  });

  test('a 5-hour-only exhaustion defers to the 5-hour reset', () => {
    const headers = { 'anthropic-ratelimit-unified-status': 'rejected' };
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      headers: {
        ...headers,
        'anthropic-ratelimit-unified-5h-reset': '1790269200',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
      },
    });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(1_790_269_200_000);
  });

  // Fail-closed: a BLOCKING window whose own reset is missing or malformed makes
  // every candidate defer time unsound. Falling back to the other, UNBLOCKED
  // window's reset would schedule a retry against a wall that has not moved.
  test('a rejected WEEKLY window with no usable 7d reset yields NO defer time', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-reset': '1790269200',
        'anthropic-ratelimit-unified-7d-status': 'rejected',
        // the 7d reset header is simply ABSENT
      },
    });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
    expect(verdict.advisoryReason).toMatch(/needs-human/);
  });

  test('a MALFORMED 7d reset is treated as no reset, not as a time', () => {
    for (const malformed of ['', '   ', 'soon', '0', '-1', 'NaN', '1790341200ms']) {
      const verdict = classifyProviderSignal('claude-subscription', {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-reset': '1790269200',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'anthropic-ratelimit-unified-7d-utilization': '1.0',
          'anthropic-ratelimit-unified-7d-reset': malformed,
        },
      });
      expect({ reset: malformed, deferUntilMs: verdict.deferUntilMs }).toEqual({
        reset: malformed,
        deferUntilMs: undefined,
      });
    }
  });

  test('the mirror case: a rejected 5h window with no usable 5h reset yields NO defer time', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        // the 5h reset header is ABSENT; the unblocked weekly window has one.
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': '1790341200',
      },
    });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('BOTH windows blocking with only one usable reset still yields no defer time', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1.0',
        'anthropic-ratelimit-unified-5h-reset': '1790269200',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        // the 7d reset header is ABSENT
      },
    });
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('a unified-status header that is not `rejected` is not quota evidence', () => {
    // The headers ride ordinary responses (`allowed`); a transient failure that
    // carries them must not be parked until a routine window reset.
    for (const value of ['allowed', 'allowed_warning', '']) {
      const verdict = classifyProviderSignal('claude-subscription', {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': value,
          'anthropic-ratelimit-unified-5h-reset': '1790269200',
        },
      });
      expect(verdict.errorClass, `status '${value}'`).toBe('rate-limit');
      expect(verdict.deferUntilMs).toBeUndefined();
    }
    const rejected = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      headers: { 'anthropic-ratelimit-unified-status': ' Rejected ' },
    });
    expect(rejected.errorClass).toBe('quota');
  });

  test('a TARGETED endpoint observation that reports headroom does NOT fill a blocking window', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          // no 5h reset header: only the endpoint could supply it
        },
      },
      // A routine window boundary, not a release time (`exhausted: false`).
      { window: '5h', resetsAt: '2026-09-28T05:00:00Z', exhausted: false },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
    expect(verdict.advisoryReason).toBeDefined();
    // The same observation, explicitly exhausted, IS the release time.
    const exhausted = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
        },
      },
      { window: '5h', resetsAt: '2026-09-28T05:00:00Z', exhausted: true },
    );
    expect(exhausted.deferUntilMs).toBe(Date.parse('2026-09-28T05:00:00Z'));
  });

  // The cross-window trap: an endpoint `resetsAt` carries a time but NOT a window
  // identity, so it cannot stand in for a blocking window's own missing reset.
  test('an UNTARGETED endpoint resetsAt does NOT fill a blocking window with no reset', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          // 5h window is fine and announces an EARLY reset...
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-reset': '1790269200',
          // ...while the 7d window is the one blocking, with no reset of its own.
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        },
      },
      // A generic endpoint observation, earlier than the 5h reset: using it (or
      // the 5h reset) would retry straight into the exhausted weekly window.
      { resetsAt: '2026-09-26T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
    expect(verdict.advisoryReason).toMatch(/needs-human/);
  });

  test('an endpoint resetsAt is admitted only when it NAMES the blocking window', () => {
    const tied = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-reset': '1790269200',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        },
      },
      { resetsAt: '2026-10-05T00:00:00Z', window: 'weekly' },
    );
    // 'weekly' names the blocking 7d window, so the value is tied to it.
    expect(tied.errorClass).toBe('quota');
    expect(tied.deferUntilMs).toBe(Date.parse('2026-10-05T00:00:00Z'));
  });

  test('an endpoint observation naming the UNBLOCKED window is refused', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-reset': '1790269200',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        },
      },
      // Right time, wrong window: this is the 5-hour window's release, not the
      // weekly wall's.
      { resetsAt: '2026-09-26T00:00:00Z', window: '5h' },
    );
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('with NO blocking window, an endpoint resetsAt is still usable', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-7d-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.4',
        },
      },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-09-28T00:00:00Z'));
  });

  // Two blocking windows: BOTH must clear, so every blocking window needs a known
  // release time and the defer is the MAX across them. An endpoint value that
  // resolves ONE of them does not make the other resolved.
  // (2) Anthropic answers every 400 as invalid_request_error; only the documented
  // message family means the workspace spend limit was reached.
  test('the self-set spend-limit 400 is quota ONLY with its documented message', () => {
    const verdict = classifyProviderSignal('anthropic-api', {
      httpStatus: 400,
      providerCode: 'invalid_request_error',
      message: 'You have reached your specified API usage limits for this workspace',
    });
    expect(verdict.errorClass).toBe('quota');
  });

  test('an ORDINARY Anthropic 400 is not quota', () => {
    for (const message of [
      'invalid request: unexpected content type',
      'max_tokens: must be <= 64000',
      'model: unknown model claude-nope',
    ]) {
      const verdict = classifyProviderSignal('anthropic-api', {
        httpStatus: 400,
        providerCode: 'invalid_request_error',
        message,
      });
      expect({ message, errorClass: verdict.errorClass }).toEqual({
        message,
        errorClass: 'provider-error',
      });
      expect(verdict.deferUntilMs).toBeUndefined();
    }
  });

  test('a bare 400 with no code and no message is not quota either', () => {
    expect(classifyProviderSignal('anthropic-api', { httpStatus: 400 }).errorClass).toBe(
      'provider-error',
    );
  });

  // (3) Go 402 is endpoint-scoped: the Zen wire answers 402 for a different
  // reason, and an observation with no endpoint identity must not resolve
  // against the Go allowance.
  test('a Go-wire 402 is quota only when the endpoint IS the Go wire', () => {
    const verdict = classifyProviderSignal('opencode-go', {
      httpStatus: 402,
      endpoint: 'https://opencode.ai/zen/go/v1',
    });
    expect(verdict.errorClass).toBe('quota');
  });

  test('a ZEN-wire 402 does NOT charge the Go allowance', () => {
    const verdict = classifyProviderSignal('opencode-go', {
      httpStatus: 402,
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      message: 'Upstream request failed: Insufficient account funds',
    });
    // Fail closed: an empty Zen balance is a different condition, and resolving
    // it against the Go allowance would defer/charge the wrong plan.
    expect(verdict.errorClass).toBe('provider-error');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('a Go-wire 402 on a real request path beneath the Go origin is quota', () => {
    // The observation carries the request it made, not the wire's base; strict
    // equality against the origin never matched a real chat-completions call.
    const verdict = classifyProviderSignal('opencode-go', {
      httpStatus: 402,
      endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
    });
    expect(verdict.errorClass).toBe('quota');
  });

  test('a sibling path that merely shares the Go origin as a string prefix is not the Go wire', () => {
    const verdict = classifyProviderSignal('opencode-go', {
      httpStatus: 402,
      endpoint: 'https://opencode.ai/zen/go/v1beta/chat/completions',
    });
    expect(verdict.errorClass).toBe('provider-error');
  });

  test('a 402 with NO endpoint identity fails closed on the Go profile', () => {
    const verdict = classifyProviderSignal('opencode-go', { httpStatus: 402 });
    expect(verdict.errorClass).toBe('provider-error');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('the Go rule names the SAME origin as the usage endpoint it resets from', () => {
    const profile = providerProfile('opencode-go');
    const rule = profile?.errorSignals[0];
    expect(rule?.endpointMatch).toBe(
      profile?.observability.usageEndpoint?.url.replace('/usage', ''),
    );
  });

  test('two blocked windows: 7d from a targeted endpoint, 5h from its header -> MAX of both', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          // 5h blocked, with a LATE header reset...
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.0',
          'anthropic-ratelimit-unified-5h-reset': '1790341200',
          // ...7d blocked with NO header reset of its own.
          'anthropic-ratelimit-unified-7d-status': 'rejected',
        },
      },
      // Targeted at 7d, but EARLIER than the 5h header reset, so the correct
      // answer is the 5h header time and the endpoint value alone is wrong.
      { resetsAt: '2026-09-24T00:00:00Z', window: 'weekly' },
    );
    expect(verdict.errorClass).toBe('quota');
    // The max, NOT the endpoint value alone: deferring to the 7d endpoint reset
    // would retry while the 5h wall is still up.
    expect(verdict.deferUntilMs).toBe(1_790_341_200_000);
    expect(verdict.deferUntilMs).not.toBe(Date.parse('2026-09-24T00:00:00Z'));
  });

  test('two blocked windows, both headers missing, endpoint names only one -> NO defer', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      {
        httpStatus: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.0',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'anthropic-ratelimit-unified-7d-utilization': '1.0',
        },
      },
      // Resolves the 7d wall only; the 5h wall has no known release time.
      { resetsAt: '2026-09-28T00:00:00Z', window: 'weekly' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
    expect(verdict.advisoryReason).toMatch(/needs-human/);
  });

  test('an OpenAI spend or usage-limit 429 is QUOTA, never a retryable throttle', () => {
    // Codes verified against the vendor spend-limits page, fetched 2026-10-01.
    for (const code of [
      'organization_spend_limit_exceeded',
      'project_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
      'insufficient_quota',
    ]) {
      const verdict = classifyProviderSignal('openai-api', { httpStatus: 429, providerCode: code });
      expect(verdict.errorClass).toBe('quota');
      expect(verdict.deferUntilMs).toBeUndefined();
    }
  });

  test('an OpenAI 429 with no body code and no Retry-After is NOT called a throttle', () => {
    const verdict = classifyProviderSignal('openai-api', { httpStatus: 429 });
    expect(verdict.errorClass).not.toBe('rate-limit');
  });

  test('an OpenAI transient 429 WITH Retry-After is a throttle', () => {
    const verdict = classifyProviderSignal('openai-api', {
      httpStatus: 429,
      retryAfterMs: 2_000,
    });
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.rule).toBe('retry-after');
  });

  test('a plain 429 with no unified headers is a throttle', () => {
    const verdict = classifyProviderSignal('claude-subscription', {
      httpStatus: 429,
      retryAfterMs: 2_000,
      message: 'Server is temporarily limiting requests',
    });
    // The CLASS is what governs behaviour, and it is rate-limit. The RULE label is
    // `structured` rather than `retry-after` because the profile carries a
    // documented status-only 429 rule ("Server is temporarily limiting requests"
    // is a 429 WITHOUT unified quota headers), and specific rules resolve before
    // the generic retry-after branch. A generic profile with no 429 rule still
    // reports `retry-after` — see the OpenAI transient case below.
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  // ORDERING: a marker header outranks a bare status. Without this, the Claude
  // subscription profile's status-only 429 (rate-limit) shadows its marker rule
  // (quota), and every unified-quota 429 — the one that also carries retry-after,
  // precisely the case the marker rule exists for — busy-retries an exhausted
  // plan window instead of deferring to it.
  test('a marker header wins over a status-only rule that would also match', () => {
    const verdict = classifyProviderSignal('claude-subscription', CLAUDE_EXHAUSTED_429);
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.rule).toBe('marker-header:anthropic-ratelimit-unified-status');
    expect(verdict.deferUntilMs).toBe(1_790_269_200_000);
  });

  test('structurally: no marker rule is ever shadowed by a status-only sibling', () => {
    // Walks every profile: wherever a marker rule and a status-only rule both
    // match the SAME observation, the marker's class must be the one returned.
    let shadowed = 0;
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      const markerRules = profile.errorSignals.filter((fact) => fact.markerHeader !== undefined);
      const statusOnlyRules = profile.errorSignals.filter(
        (fact) =>
          fact.httpStatus !== undefined &&
          fact.providerCode === undefined &&
          fact.messagePrefix === undefined &&
          fact.endpointMatch === undefined &&
          fact.markerHeader === undefined,
      );
      for (const marker of markerRules) {
        for (const statusOnly of statusOnlyRules) {
          // statusOnlyRules only ever holds rules that DECLARE an httpStatus.
          const status: number = statusOnly.httpStatus as number;
          const signal: ProviderSignal = {
            httpStatus: status,
            headers: { [marker.markerHeader as string]: 'rejected' },
          };
          const verdict = classifyProviderSignal(profile.id, signal);
          expect({
            profile: profile.id,
            marker: marker.markerHeader,
            status,
            got: verdict.errorClass,
            want: marker.errorClass,
          }).toEqual({
            profile: profile.id,
            marker: marker.markerHeader,
            status,
            got: marker.errorClass,
            want: marker.errorClass,
          });
          shadowed += 1;
        }
      }
    }
    // Non-vacuous: at least one such shadowing pair must exist, or this test
    // would pass with nothing to check.
    expect(shadowed).toBeGreaterThan(0);
  });

  test('the status-only path still works when NO marker header is present', () => {
    // The counterpart to the ordering test: removing the marker must fall
    // through to the status rule, so the ordering change did not simply disable
    // status matching on this profile.
    expect(classifyProviderSignal('claude-subscription', { httpStatus: 429 }).errorClass).toBe(
      'rate-limit',
    );
    expect(classifyProviderSignal('deepseek', { httpStatus: 429 }).errorClass).toBe('rate-limit');
    expect(classifyProviderSignal('deepseek', { httpStatus: 402 }).errorClass).toBe('quota');
    expect(classifyProviderSignal('zai-glm-coding', { httpStatus: 429 }).errorClass).toBe('quota');
  });

  test('an undocumented 429 splits by profile, and never by guesswork', () => {
    // Claude subscription: the vendor documents that a 429 WITHOUT unified
    // quota headers is the plain "Server is temporarily limiting requests"
    // throttle, so it stays rate-limit.
    expect(classifyProviderSignal('claude-subscription', { httpStatus: 429 }).errorClass).toBe(
      'rate-limit',
    );
    // Anthropic API: with NO code and NO retry-after there is nothing to
    // attribute the 429 to, so it settles as provider-error — honestly
    // unattributed, and fail-closed (no defer time, no retry).
    expect(classifyProviderSignal('anthropic-api', { httpStatus: 429 }).errorClass).toBe(
      'provider-error',
    );
    // The documented discriminator still works in the other direction: a
    // retry-after means the vendor says the condition clears on its own.
    expect(
      classifyProviderSignal('anthropic-api', { httpStatus: 429, retryAfterMs: 1_000 }).errorClass,
    ).toBe('rate-limit');
    // ...and the documented spend-cap code resolves to quota.
    expect(
      classifyProviderSignal('anthropic-api', {
        httpStatus: 429,
        providerCode: 'enforced_spend_limit_reached',
      }).errorClass,
    ).toBe('quota');
    // OpenAI: every documented 429 code there is a quota code, so a code-less
    // 429 must not become a throttle.
    expect(classifyProviderSignal('openai-api', { httpStatus: 429 }).errorClass).not.toBe(
      'rate-limit',
    );
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

  // Structural guard against the bypass that survived the first fix: a lookup
  // keyed on HTTP status alone would re-admit every rule that declares a status
  // PLUS another discriminator. For any such rule, a bare status-only
  // observation must NOT resolve to that rule's class.
  test('no rule matches on its status alone when it declares another discriminator', () => {
    for (const profile of Object.values(PROVIDER_PROFILES)) {
      for (const fact of profile.errorSignals) {
        if (fact.httpStatus === undefined) continue;
        if (
          fact.providerCode === undefined &&
          fact.messagePrefix === undefined &&
          fact.endpointMatch === undefined &&
          fact.markerHeader === undefined
        ) {
          continue; // genuinely status-only: matching on the status is correct
        }
        const verdict = classifyProviderSignal(profile.id, { httpStatus: fact.httpStatus });
        expect({
          profile: profile.id,
          status: fact.httpStatus,
          ruleClass: fact.errorClass,
          got: verdict.errorClass,
        }).toEqual({
          profile: profile.id,
          status: fact.httpStatus,
          ruleClass: fact.errorClass,
          got: 'provider-error',
        });
      }
    }
  });

  test('a genuinely status-only rule DOES match on its status', () => {
    // DeepSeek's concurrency 429 and Z.AI's plan-window 429 are documented status
    // conditions, so this is the path that must keep working.
    expect(classifyProviderSignal('deepseek', { httpStatus: 429 }).errorClass).toBe('rate-limit');
    expect(classifyProviderSignal('zai-glm-coding', { httpStatus: 429 }).errorClass).toBe('quota');
  });

  test('a Z.AI coding-wire 429 is quota-shaped: no retry-after means wait for the window', () => {
    const verdict = classifyProviderSignal('zai-glm-coding', { httpStatus: 429 });
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('an observed resetsAt attaches the defer-until time to the matched status rule', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      // Endpoint identity is REQUIRED by this rule (finding: a Zen 402 is a
      // different condition), so the observation carries the Go wire.
      { httpStatus: 402, endpoint: 'https://opencode.ai/zen/go/v1' },
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

  test('several exhausted windows defer to the LATEST reset, not whichever was passed first', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 402, endpoint: 'https://opencode.ai/zen/go/v1' },
      [
        { window: '5h', resetsAt: '2026-09-28T05:00:00Z', exhausted: true },
        { window: 'monthly', resetsAt: '2026-10-01T00:00:00Z', exhausted: true },
        // Headroom: a routine boundary, not a release time, even though later.
        { window: 'weekly', resetsAt: '2026-10-05T00:00:00Z', exhausted: false },
      ],
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  test('an exhausted window with no readable reset leaves the quota verdict needs-human', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 402, endpoint: 'https://opencode.ai/zen/go/v1' },
      [
        { window: '5h', resetsAt: '2026-09-28T05:00:00Z', exhausted: true },
        { window: 'monthly', exhausted: true },
      ],
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
    expect(verdict.advisoryReason).toBeDefined();
  });

  test('an explicit exhausted flag with no reset is quota/needs-human, not provider-error', () => {
    for (const profile of ['deepseek', 'opencode-go']) {
      const verdict = classifyProviderSignal(profile, { httpStatus: 500 }, { exhausted: true });
      expect(verdict.errorClass).toBe('quota');
      expect(verdict.deferUntilMs).toBeUndefined();
      expect(verdict.advisoryReason).toBeDefined();
    }
  });

  test('a NON-exhausted observation does not defer a matched quota rule either', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 402, endpoint: 'https://opencode.ai/zen/go/v1' },
      { resetsAt: '2026-09-28T00:00:00Z', exhausted: false },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('a resetsAt from a NON-exhausted endpoint observation is not quota evidence', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 500 },
      { resetsAt: '2026-09-28T00:00:00Z', exhausted: false },
    );
    expect(verdict.errorClass).toBe('provider-error');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('opencode-go documents no throttle, so a bare Retry-After is not a rate-limit', () => {
    expect(providerProfile('opencode-go')?.rateLimitHeaders).toEqual([]);
    const verdict = classifyProviderSignal('opencode-go', { retryAfterMs: 1_000 });
    expect(verdict.errorClass).not.toBe('rate-limit');
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
  const PEAK = Date.parse('2026-10-01T07:00:00Z'); // Thursday 15:00 +08
  const OFF_PEAK = Date.parse('2026-10-01T12:00:00Z'); // Thursday 20:00 +08

  /**
   * The vendor's own cross-check, fetched 2026-10-01:
   * https://docs.z.ai/devpack/overview.md, "Estimated Token Allowance" table.
   * At the published multipliers a Lite weekly allowance of 10,000 credits buys a
   * weekly token count inside the documented band; a 1e6 scaling error misses it
   * by six orders of magnitude, and using one model's coefficients for the other
   * misses it entirely.
   */
  const LITE_WEEKLY_CREDITS = 10_000;
  const ALLOWANCE_BAND_M_TOKENS_WEEK = {
    'glm-5.3': { min: 48, max: 97 },
    'glm-5.3-flash': { min: 146, max: 292 },
  } as const;

  function weeklyTokensAtCachedRate(model: string, credits: number, instantMs: number): number {
    const burn = creditsForUsage(
      ZAI!,
      model,
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      instantMs,
    )!;
    return (credits / burn) * 1_000_000;
  }

  test('the published formula, with cache read at the CACHED-INPUT multiplier', () => {
    // (1e6 x 2.3 + 1e6 x 0.56 + 1e6 x 8) / 10,000 credits at peak (1x).
    expect(creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK)).toBeCloseTo(
      (2.3 + 0.56 + 8) * 100,
      6,
    );
  });

  test('reasoning tokens are billed at the OUTPUT multiplier', () => {
    const base = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK)!;
    const withReasoning = creditsForUsage(
      ZAI!,
      'glm-5.3-flash',
      { ...usage, reasoning: 1_000_000 },
      PEAK,
    )!;
    // 1e6 reasoning tokens x 8 output multiplier / 10,000 divisor.
    expect(withReasoning - base).toBeCloseTo(8 * 100, 6);
  });

  test('the scale reconciles with the vendor token-allowance table (Lite weekly)', () => {
    for (const [model, band] of Object.entries(ALLOWANCE_BAND_M_TOKENS_WEEK)) {
      const bestCasePeak = weeklyTokensAtCachedRate(model, LITE_WEEKLY_CREDITS, PEAK) / 1e6;
      const bestCaseOffPeak = weeklyTokensAtCachedRate(model, LITE_WEEKLY_CREDITS, OFF_PEAK) / 1e6;
      // All-cached is the cheapest possible mix, so it must land INSIDE the
      // documented band at peak, and reach or exceed the band maximum off-peak
      // (the documented range is exactly the 0.5x off-peak discount).
      expect(bestCasePeak).toBeGreaterThanOrEqual(band.min);
      expect(bestCasePeak).toBeLessThanOrEqual(band.max);
      expect(bestCaseOffPeak).toBeGreaterThanOrEqual(band.max);
    }
  });

  test('GLM-5.3 uses its OWN coefficients, roughly 3x the Flash ones', () => {
    const flash = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK)!;
    const full = creditsForUsage(ZAI!, 'glm-5.3', usage, PEAK)!;
    // 6.9/2.3 = 1.7/0.56 = 24/8 = 3 exactly per direction, so the blended total
    // is 3 to within a rounding hair; a profile-wide coefficient set lands ~3x
    // off this for one of the two models.
    expect(full / flash).toBeCloseTo(3, 1);
  });

  test('a model with no recorded burn formula yields no local burn figure', () => {
    expect(creditsForUsage(ZAI!, 'glm-4.7', usage, PEAK)).toBeUndefined();
    expect(creditsForUsage(CLAUDE_SUB!, 'claude-haiku-4-5', usage, PEAK)).toBeUndefined();
  });

  test('the published MCP term is applied when the caller supplies the count', () => {
    const withoutMcp = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK)!;
    const withMcp = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK, 10)!;
    // 10 calls x the GLM-5.3-Flash output multiplier (8), a separate charge NOT scaled by the 10,000 divisor.
    expect(withMcp - withoutMcp).toBeCloseTo(10 * 8, 9);
  });

  test('a figure is a LOWER BOUND exactly when the MCP term was not supplied', () => {
    expect(creditsAreLowerBound(ZAI!, 'glm-5.3-flash')).toBe(true);
    expect(creditsAreLowerBound(ZAI!, 'glm-5.3-flash', 0)).toBe(false);
    // A model with no published MCP term is never a lower bound.
    expect(creditsAreLowerBound(ZAI!, 'glm-4.7')).toBe(false);
    expect(creditsAreLowerBound(CLAUDE_SUB!, 'claude-haiku-4-5')).toBe(false);
  });

  test('off-peak credits are half the peak burn', () => {
    const peak = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, PEAK)!;
    const offPeak = creditsForUsage(ZAI!, 'glm-5.3-flash', usage, OFF_PEAK)!;
    expect(offPeak).toBeCloseTo(peak * 0.5, 9);
  });
});

describe('admissionVerdict', () => {
  // HARD is not broadened by this lane: it now needs the claim's MODEL to carry
  // both published token limits, and a quota lane needs an OBSERVED remaining
  // allowance. "Can be observed" is not "was observed".
  const HAIKU = { model: 'claude-haiku-4-5', observedRemaining: 1_000 };

  test('a modelled lane with published model limits and an observed balance is HARD-eligible', () => {
    expect(admissionVerdict('anthropic-api', HAIKU)).toEqual({ verdict: 'hard', reasons: [] });
  });

  test('a modelled lane WITHOUT a model claim is ADVISORY', () => {
    expect(admissionVerdict('anthropic-api')).toEqual({
      verdict: 'advisory',
      reasons: ['model-limits-unverified'],
    });
  });

  test('a model whose output cap was never verified cannot claim HARD', () => {
    expect(admissionVerdict('zai-glm-coding', { model: 'glm-5.3-flash' }).reasons).toContain(
      'model-limits-unverified',
    );
  });

  test('the console-only Z.AI lane is ADVISORY: its allowance cannot be observed', () => {
    const verdict = admissionVerdict('zai-glm-coding', { model: 'glm-5.3-flash' });
    expect(verdict.verdict).toBe('advisory');
    expect(verdict.reasons).toContain('limits-unknown');
    expect(verdict.reasons).toContain('unobservable-allowance');
  });

  test('a quota lane with a modeled balance but no OBSERVED one stays ADVISORY', () => {
    expect(admissionVerdict('opencode-go', { model: 'glm-5.3-flash' }).reasons).toContain(
      'no-observed-balance',
    );
    expect(
      admissionVerdict('opencode-go', { model: 'glm-5.3-flash', observedRemaining: 0 }).reasons,
    ).toContain('no-observed-balance');
    // An observed positive balance clears that reason but NOT the missing model
    // limits: OpenCode Go has no published per-model token limits here.
    expect(
      admissionVerdict('opencode-go', { model: 'glm-5.3-flash', observedRemaining: 5 }),
    ).toEqual({
      verdict: 'advisory',
      reasons: ['model-limits-unverified'],
    });
  });

  test('openai-api and deepseek cannot claim HARD for any model without published limits', () => {
    expect(
      admissionVerdict('openai-api', { model: 'gpt-5', observedRemaining: 5 }).reasons,
    ).toContain('model-limits-unverified');
    expect(
      admissionVerdict('deepseek', { model: 'deepseek-flash', observedRemaining: 5 }).reasons,
    ).toContain('model-limits-unverified');
  });

  test('the interactive-TUI codex lane is ADVISORY for quota-aware admission', () => {
    const verdict = admissionVerdict('codex-chatgpt', { model: 'gpt-6-sol' });
    expect(verdict.verdict).toBe('advisory');
    expect(verdict.reasons).toContain('unobservable-allowance');
  });

  // F1: the codex lane's documented default is produced by the seam's
  // classifyFailure, not here. Its profile declares no throttle signal, so a
  // stray Retry-After must not manufacture a retryable verdict.
  test('codex: a stray Retry-After does not become a transient throttle', () => {
    const verdict = classifyProviderSignal('codex-chatgpt', {
      httpStatus: 429,
      retryAfterMs: 30_000,
    });
    expect(verdict.errorClass).not.toBe('rate-limit');
    expect(verdict.errorClass).toBe('provider-error');
  });

  test('codex: a bare failure with no signal is still the unattributed default', () => {
    expect(classifyProviderSignal('codex-chatgpt', { message: 'exit 1' }).errorClass).toBe(
      'provider-error',
    );
  });

  test('codex: the profile declares no throttle headers and no rule', () => {
    const codex = providerProfile('codex-chatgpt');
    expect(codex?.rateLimitHeaders).toEqual([]);
    expect(codex?.errorSignals).toEqual([]);
  });

  // F2: an endpoint-channel lane's own wall-clock reset outranks a generic retry
  // hint; header-channel lanes keep `retry-after` precedence.
  test('deepseek: an endpoint resetsAt outranks Retry-After on the balance lane', () => {
    const verdict = classifyProviderSignal(
      'deepseek',
      { httpStatus: 500, retryAfterMs: 1_000 },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-09-28T00:00:00Z'));
  });

  test('opencode-go: same precedence on the usage-endpoint lane', () => {
    const verdict = classifyProviderSignal(
      'opencode-go',
      { httpStatus: 500, retryAfterMs: 1_000 },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('quota');
    expect(verdict.deferUntilMs).toBe(Date.parse('2026-09-28T00:00:00Z'));
  });

  test('an endpoint lane with no resetsAt still classifies a throttle as rate-limit', () => {
    const verdict = classifyProviderSignal('deepseek', { httpStatus: 500, retryAfterMs: 1_000 });
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.rule).toBe('retry-after');
  });

  test('a HEADER-channel lane keeps retry-after precedence (Claude rules untouched)', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      { httpStatus: 429, retryAfterMs: 3_741_000 },
      { resetsAt: '2026-09-28T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  // Post-merge #248 review: a non-quota RULE must never derive a release time
  // from the quota observations. `observedReleaseMs` reads quota-window resets,
  // and a throttle that inherited one would park a transient retry on a
  // balance/window boundary — possibly weeks away — while `deferUntilMs` is
  // contractually a QUOTA retry time (`ProviderSignalVerdict`). A throttle's
  // release evidence is the vendor's Retry-After, which stays with the caller.
  test('deepseek: a 429 throttle never inherits an endpoint resetsAt', () => {
    const verdict = classifyProviderSignal(
      'deepseek',
      { httpStatus: 429 },
      { resetsAt: '2026-10-01T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.deferUntilMs).toBeUndefined();
  });

  test('claude-subscription: the status-only 429 also stays reset-free', () => {
    const verdict = classifyProviderSignal(
      'claude-subscription',
      { httpStatus: 429 },
      { resetsAt: '2026-10-01T00:00:00Z' },
    );
    expect(verdict.errorClass).toBe('rate-limit');
    expect(verdict.deferUntilMs).toBeUndefined();
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

  test('an Object.prototype member name is an unknown profile, not a crash', () => {
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(providerProfile(id)).toBeUndefined();
      expect(admissionVerdict(id)).toEqual({ verdict: 'advisory', reasons: ['unknown-profile'] });
      expect(classifyProviderSignal(id, { httpStatus: 429 }).rule).toBe('unknown-profile');
    }
    expect(admissionVerdict('anthropic-api', { model: 'constructor' }).reasons).toContain(
      'model-limits-unverified',
    );
    if (ZAI === undefined) throw new Error('zai profile missing');
    expect(
      creditsForUsage(
        ZAI,
        'toString',
        { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        THURSDAY_UTC_MIDNIGHT,
      ),
    ).toBeUndefined();
  });
});
