import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRepairArgv, runRepairCli } from '../../../src/adapters/crq/repairCli.js';
import { LIVE_UNIT_COMMANDS } from '../../../src/queue-runner/capabilities.js';

function root(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'crq-repair-cli-'));
  mkdirSync(join(dir, 'state'));
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

async function invoke(dir: string, argv: readonly string[]) {
  const lines: string[] = [];
  const result = await runRepairCli(argv, { root: dir, stderr: (line) => lines.push(line) });
  return { ...result, stderr: lines };
}

const enabled = { repair: { enabled: true, spend_authorization: 'owner 2026-11-20' } };

describe('parseRepairArgv', () => {
  it('reads argparse values, prefixes and the last repeat', () => {
    expect(parseRepairArgv(['--jo=a', '--job', 'b', '--rec', '-.5'])).toEqual({
      ok: true,
      args: {
        triageDryRun: false,
        job: 'b',
        sourceSha: null,
        findingSha256: null,
        recoverJob: '-.5',
      },
    });
  });

  it('reports every unrecognized argument in order', () => {
    expect(parseRepairArgv(['--bogus', 'y', '--z'])).toEqual({
      ok: false,
      message: 'unrecognized arguments: --bogus y --z',
    });
  });

  it('refuses help rather than print a non-JSON document', () => {
    for (const flag of ['-h', '--help', '--he'])
      expect(parseRepairArgv([flag])).toEqual({
        ok: false,
        message: 'help is not available from the Node runtime',
      });
  });
});

describe('runRepairCli', () => {
  it('refuses every unported mode with the failure artifact and writes nothing', async () => {
    const modes: [readonly string[], string][] = [
      [[], 'the inbox drain'],
      [['--triage-dry-run'], '--triage-dry-run'],
      [['--recover-job', 'crq-a-F1'], '--recover-job'],
      [['--job', 'j', '--source-sha', 's', '--finding-sha256', 'f'], '--job'],
    ];
    for (const [argv, mode] of modes) {
      const dir = root(enabled);
      const result = await invoke(dir, argv);
      const message = `repair ${mode} is not ported to the Node runtime; crq-repair.service stays on Python`;
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        error: { kind: 'failed', subcommand: null, message, exitCode: 1 },
      });
      expect(result.stderr).toEqual([`repair dispatch failed: ${message}`]);
      expect(readdirSync(join(dir, 'state'))).toEqual([]);
    }
  });

  it('fails like Python when repair or config is not an object', async () => {
    for (const config of [{ repair: null }, { repair: [] }, []]) {
      const result = await invoke(root(config), []);
      expect(result.exitCode).toBe(1);
      expect((JSON.parse(result.stdout) as { error: { kind: string } }).error.kind).toBe('failed');
    }
  });

  it('accepts Python-only JSON constants in config.json', async () => {
    const dir = root();
    writeFileSync(join(dir, 'config.json'), '{"x": NaN, "repair": {"enabled": false}}');
    expect((await invoke(dir, [])).stdout).toBe(
      '{"status": "disabled", "reason": "repair.enabled and a recorded spend_authorization are required"}\n',
    );
  });

  it('is not declared as a live unit command while the drain is unported', () => {
    expect(LIVE_UNIT_COMMANDS as readonly string[]).not.toContain('repair');
  });
});
