import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/queue-runner/runner.js';
import {
  runWatchdog,
  type WatchdogSendResult,
  type WatchdogValue,
} from '../../src/queue-runner/watchdog.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const LAST = '2026-11-12T11:00:00Z';

async function fixture(
  heartbeat: Record<string, unknown>,
  state?: string,
): Promise<{ home: string; crq: string }> {
  const home = await mkdtemp(join(tmpdir(), 'crq-watchdog-'));
  const crq = join(home, 'crq');
  await mkdir(crq, { recursive: true });
  await writeFile(join(crq, 'heartbeat.json'), `${JSON.stringify(heartbeat)}\n`);
  if (state !== undefined) await writeFile(join(crq, 'watchdog-state.json'), state);
  return { home, crq };
}

function valueOf(result: Awaited<ReturnType<typeof runWatchdog>>): WatchdogValue {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

function sender(result: WatchdogSendResult = { code: 0, stderr: '' }) {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  return {
    calls,
    send: (args: string[], timeoutMs: number) => {
      calls.push({ args, timeoutMs });
      return result;
    },
  };
}

describe('watchdog live command', () => {
  it('reports a fresh heartbeat without writing state', async () => {
    const { home, crq } = await fixture({ last_tick: '2026-11-12T11:59:00Z' });
    const { calls, send } = sender();
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(value).toEqual({
      message: '2026-11-12T12:00:00Z ok: last tick 2026-11-12T11:59:00Z (1m ago)',
      lastTick: '2026-11-12T11:59:00Z',
      gapMinutes: 1,
      limitMinutes: 36,
      alert: 'none',
      state: null,
    });
    expect(calls).toEqual([]);
    await expect(readFile(join(crq, 'watchdog-state.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('records recovery after a prior alert', async () => {
    const { home, crq } = await fixture(
      { last_tick: '2026-11-12T11:59:00Z' },
      '{"alerted_for": "2026-11-12T11:00:00Z"}\n',
    );
    const value = valueOf(
      await runWatchdog({ stateHome: home, clock: () => NOW, send: sender().send }),
    );
    expect(value.alert).toBe('none');
    expect(value.state).toEqual({
      recovered_seen_at: '2026-11-12T12:00:00Z',
      last_outage: '2026-11-12T11:00:00Z',
    });
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(
      '{"recovered_seen_at": "2026-11-12T12:00:00Z", "last_outage": "2026-11-12T11:00:00Z"}\n',
    );
  });

  it('sends one alert and writes Python-shaped state bytes', async () => {
    const { home, crq } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
    });
    const { calls, send } = sender();
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(value.message).toBe('2026-11-12T12:00:00Z ALERTED stale 60m (paseo send exit 0)');
    expect(value.alert).toBe('sent');
    expect(calls).toEqual([
      {
        args: [
          'send',
          '--no-wait',
          'agent-1',
          'crq STALLED: no completed tick for 60m (last 2026-11-12T11:00:00Z, alarm at 36m). systemd crq-tick.timer. Inspect heartbeat and systemctl --user status crq-tick.timer; do not run tests or model probes.',
        ],
        timeoutMs: 90_000,
      },
    ]);
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(
      '{"alerted_for": "2026-11-12T11:00:00Z", "attempted_at": "2026-11-12T12:00:00Z", "gap_min": 60, "paseo_send": 0, "paseo_err": ""}\n',
    );
  });

  it('passes the optional alert host before the agent id', async () => {
    const { home } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
      alert_agent_host: 'worker.example.invalid:6767',
    });
    const { calls, send } = sender();
    valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      'send',
      '--no-wait',
      '--host',
      'worker.example.invalid:6767',
      'agent-1',
    ]);
  });

  it('does not resend for the same alerted tick', async () => {
    const { home, crq } = await fixture(
      { last_tick: LAST, alert_agent_id: 'agent-1' },
      `{"alerted_for": "${LAST}"}\n`,
    );
    const before = await readFile(join(crq, 'watchdog-state.json'), 'utf8');
    const { calls, send } = sender();
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(value.message).toBe('2026-11-12T12:00:00Z stale 60m; already alerted');
    expect(value.alert).toBe('already');
    expect(value.state).toBeNull();
    expect(calls).toEqual([]);
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(before);
  });

  it('records a failed send as a retryable successful run', async () => {
    const { home, crq } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
    });
    const { send } = sender({ code: 9, stderr: 'boom\n' });
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(value.message).toBe('2026-11-12T12:00:00Z ALERT FAILED stale 60m (paseo send exit 9)');
    expect(value.alert).toBe('failed');
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(
      '{"failed_attempt_for": "2026-11-12T11:00:00Z", "attempted_at": "2026-11-12T12:00:00Z", "gap_min": 60, "paseo_send": 9, "paseo_err": "boom"}\n',
    );
    const retry = sender();
    const retried = valueOf(
      await runWatchdog({ stateHome: home, clock: () => NOW, send: retry.send }),
    );
    expect(retried.alert).toBe('sent');
    expect(retry.calls).toHaveLength(1);
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toContain(
      '"alerted_for": "2026-11-12T11:00:00Z"',
    );
  });

  it('samples the post-send clock after a delayed successful alert', async () => {
    const { home, crq } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
    });
    let now = NOW;
    const send = () => {
      now += 60_000;
      return { code: 0, stderr: '' };
    };
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => now, send }));
    expect(value.gapMinutes).toBe(60);
    expect(value.message).toBe('2026-11-12T12:01:00Z ALERTED stale 60m (paseo send exit 0)');
    expect(value.state).toEqual({
      alerted_for: LAST,
      attempted_at: '2026-11-12T12:01:00Z',
      gap_min: 60,
      paseo_send: 0,
      paseo_err: '',
    });
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(
      '{"alerted_for": "2026-11-12T11:00:00Z", "attempted_at": "2026-11-12T12:01:00Z", "gap_min": 60, "paseo_send": 0, "paseo_err": ""}\n',
    );
  });

  it('samples the post-send clock after a delayed failed alert', async () => {
    const { home, crq } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
    });
    let now = NOW;
    const send = () => {
      now += 60_000;
      return { code: 9, stderr: 'boom\n' };
    };
    const value = valueOf(await runWatchdog({ stateHome: home, clock: () => now, send }));
    expect(value.gapMinutes).toBe(60);
    expect(value.message).toBe('2026-11-12T12:01:00Z ALERT FAILED stale 60m (paseo send exit 9)');
    expect(value.state).toEqual({
      failed_attempt_for: LAST,
      attempted_at: '2026-11-12T12:01:00Z',
      gap_min: 60,
      paseo_send: 9,
      paseo_err: 'boom',
    });
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toBe(
      '{"failed_attempt_for": "2026-11-12T11:00:00Z", "attempted_at": "2026-11-12T12:01:00Z", "gap_min": 60, "paseo_send": 9, "paseo_err": "boom"}\n',
    );
  });

  it('escapes non-ASCII send stderr like Python json.dumps', async () => {
    const { home, crq } = await fixture({
      last_tick: LAST,
      alert_agent_id: 'agent-1',
    });
    const { send } = sender({ code: 9, stderr: 'é\n' });
    valueOf(await runWatchdog({ stateHome: home, clock: () => NOW, send: send }));
    expect(await readFile(join(crq, 'watchdog-state.json'), 'utf8')).toContain(
      '"paseo_err": "\\u00e9"',
    );
  });

  it('rounds gaps like Python round', async () => {
    const cases = [
      ['2026-11-12T11:58:30Z', 2],
      ['2026-11-12T11:57:30Z', 2],
      ['2026-11-12T11:56:30Z', 4],
    ] as const;
    for (const [lastTick, expected] of cases) {
      const { home } = await fixture({ last_tick: lastTick });
      const value = valueOf(
        await runWatchdog({ stateHome: home, clock: () => NOW, send: sender().send }),
      );
      expect(value.gapMinutes).toBe(expected);
    }
  });

  it('fails typed on missing or malformed inputs', async () => {
    const missing = await runWatchdog({
      stateHome: await mkdtemp(join(tmpdir(), 'crq-watchdog-empty-')),
      clock: () => NOW,
      send: sender().send,
    });
    expect(missing.status).toBe('failed');

    const { home } = await fixture({ last_tick: 'not-a-timestamp' });
    expect(
      (await runWatchdog({ stateHome: home, clock: () => NOW, send: sender().send })).status,
    ).toBe('failed');

    const stale = await fixture({ last_tick: LAST });
    expect(
      (await runWatchdog({ stateHome: stale.home, clock: () => NOW, send: sender().send })).status,
    ).toBe('failed');

    const arrayState = await fixture({ last_tick: '2026-11-12T11:59:00Z' }, '[]\n');
    expect(
      (
        await runWatchdog({
          stateHome: arrayState.home,
          clock: () => NOW,
          send: sender().send,
        })
      ).status,
    ).toBe('failed');
  });

  it('dispatches only declared live commands', async () => {
    const calls: string[] = [];
    const live = async (command: string, args: string[]) => {
      calls.push(`${command}:${args.length}`);
      return { status: 'ok' as const, value: { command } };
    };
    const options = { shadowRoot: '/unused', tick: 'x', live };
    expect(await run(['watchdog'], options)).toEqual({
      artifact: { status: 'ok', value: { command: 'watchdog' } },
      exitCode: 0,
    });
    expect(calls).toEqual(['watchdog:0']);
    expect((await run(['watchdog', '--dry-run'], options)).exitCode).toBe(2);
    expect((await run(['watchdog'], { shadowRoot: '/unused', tick: 'x' })).exitCode).toBe(1);
    expect((await run(['slot'], options)).exitCode).toBe(1);
    expect(
      (
        await run(['tick'], {
          ...options,
          planner: async () => ({ value: null, mutations: [] }),
        })
      ).exitCode,
    ).toBe(1);
  });

  it('returns a failed artifact when a live handler throws', async () => {
    const result = await run(['watchdog'], {
      shadowRoot: '/unused',
      tick: 'x',
      live: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({
      artifact: { status: 'failed', error: 'boom' },
      exitCode: 1,
    });
  });
});
