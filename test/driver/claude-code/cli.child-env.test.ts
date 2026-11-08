// Split from test/driver/claude-code/cli.test.ts (pure move). The outer describe
// wrapper is reproduced so every full test title is unchanged.
// Subject: the default-deny child environment (issue #183).

import {
  conformanceRoutingTable,
  invocation,
  narrationOf,
  probeEnvOf,
  withScratch,
} from './cli.helpers.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import type { CliTransportOptions } from '../../../src/driver/claude-code/cli.js';
import { DEFAULT_CHILD_ENV_ALLOWLIST, buildChildEnv } from '../../../src/shared/proc.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';

describe('claude-code driver, CLI transport specifics (fake agent CLI)', () => {
  // -------------------------------------------------------------------------
  // Child env is default-deny (issue #183)
  // -------------------------------------------------------------------------

  test('buildChildEnv: CQ_RUN_ENV_PASSTHROUGH copies only validated, configured names', () => {
    const parent = { FOO: 'foo', BAR: 'bar', MISSING: undefined, GH_TOKEN: 'must-not-copy' };
    const child = buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'FOO BAR,MISSING' });
    expect(child['FOO']).toBe('foo');
    expect(child['BAR']).toBe('bar');
    expect(child['MISSING']).toBeUndefined();
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'A=1' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entry 1 is not an env var name/,
    );
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'BAD.NAME' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entry 1 is not an env var name/,
    );
  });

  test('buildChildEnv: allowlisted basics + explicit route values pass, credential-shaped parent names are withheld (#183)', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/worker',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      PWD: '/parent/dir',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      HTTPS_PROXY: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
      GH_TOKEN: 'ghp_marker_secret',
      CQ_ENV_LEAK_MARKER: 'do-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-marker',
      NPM_TOKEN: 'npm-marker',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      NODE_PATH: '/tmp/evil-modules',
    };
    const child = buildChildEnv(parent, { ANTHROPIC_API_KEY: 'route-key-value' });
    // Allowlisted basics are inherited…
    expect(child['PATH']).toBe('/usr/bin');
    expect(child['HOME']).toBe('/home/worker');
    expect(child['TERM']).toBe('xterm-256color');
    expect(child['LANG']).toBe('en_US.UTF-8');
    // …including network-egress/TLS config a routed CLI needs (r1)…
    expect(child['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/corp.pem');
    expect(child['HTTPS_PROXY']).toBe('http://proxy.example:8080');
    // …both proxy spellings: curl ignores uppercase HTTP_PROXY and honors
    // only lowercase (r2).
    expect(child['https_proxy']).toBe('http://proxy.example:8080');
    // …the explicit route value passes (it is composed deliberately, so the
    // allowlist must never filter it)…
    expect(child['ANTHROPIC_API_KEY']).toBe('route-key-value');
    // …and every credential-shaped parent name is withheld.
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(child['CQ_ENV_LEAK_MARKER']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['NPM_TOKEN']).toBeUndefined();
    expect(child['SSH_AUTH_SOCK']).toBeUndefined();
    expect(child['NODE_OPTIONS']).toBeUndefined(); // code-execution vector, deliberately excluded
    expect(child['NODE_PATH']).toBeUndefined(); // module-resolution vector
    // PWD is NOT inherited: spawn does not rewrite it for cwd, so a copied
    // PWD would be the parent's stale directory (CodeRabbit r1).
    expect(child['PWD']).toBeUndefined();
    // The override layer ALWAYS wins over a copied allowlist value (r1).
    expect(buildChildEnv(parent, { PATH: '/route/bin' })['PATH']).toBe('/route/bin');
    // The shipped allowlist itself must not carry credential-shaped names —
    // an explicit deny-set (the regex alone misses AWS_PROFILE,
    // GOOGLE_APPLICATION_CREDENTIALS, SSH_AUTH_SOCK, …) plus a shape guard.
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SSH_AUTH_SOCK',
      'KRB5CCNAME',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZAI_API_KEY',
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
    ]) {
      expect(DEFAULT_CHILD_ENV_ALLOWLIST).not.toContain(name);
    }
    expect(
      DEFAULT_CHILD_ENV_ALLOWLIST.some((name) => /TOKEN|SECRET|KEY|PASSWORD/i.test(name)),
    ).toBe(false);
    // FROZEN (r1): an in-process push cannot weaken default-deny for later spawns.
    expect(Object.isFrozen(DEFAULT_CHILD_ENV_ALLOWLIST)).toBe(true);
    // The explicit extra allowlist is the only route for a non-default name.
    const extended = buildChildEnv(parent, undefined, ['CQ_ENV_LEAK_MARKER']);
    expect(extended['CQ_ENV_LEAK_MARKER']).toBe('do-not-leak');
    expect(extended['GH_TOKEN']).toBeUndefined();
    // A malformed extra name is rejected at the seam, not silently no-oped (r1/r2).
    expect(() => buildChildEnv(parent, undefined, [''])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['A=B'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['BAD NAME'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    // A null-prototype child carries a `__proto__` override as an OWN property
    // instead of silently dropping it through the inherited setter (r2).
    const protoOverride = Object.create(null) as Record<string, string>;
    protoOverride['__proto__'] = 'carried';
    const protoChild = buildChildEnv(parent, protoOverride);
    expect(Object.prototype.hasOwnProperty.call(protoChild, '__proto__')).toBe(true);
    expect(protoChild['__proto__']).toBe('carried');
    // The parent env object is never mutated.
    expect(parent.GH_TOKEN).toBe('ghp_marker_secret');
  });

  test('a REAL spawned worker cannot see a marker secret in the entry env, while route env still reaches it; envAllowlist opts a name back in (#183)', async () => {
    await withScratch(async (scratchDir, store) => {
      // A probe worker: dumps its OWN process.env as a narration line (the
      // driver folds non-JSON lines into the session record) and then emits
      // the minimal stream-json run so the invocation completes.
      // The probe is a CLI of its own (no MCP client), so it runs over the
      // EMPTY harness surface (ToolPolicy mode 'none': no server, no tools)
      // and reports exactly that init surface — the closed-surface assertion
      // still runs and passes.
      const EMPTY_SURFACE = { allow: [] as string[], mode: 'none' as const };
      const probePath = join(scratchDir, 'env-probe.mjs');
      await writeFile(
        probePath,
        [
          'const env = { ...process.env };',
          "process.stdout.write('CQ_ENV_PROBE:' + JSON.stringify(env) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-probe', model: 'conformance-1', tools: [], mcp_servers: [] }) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'env-probe', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: 'conformance-1' }) + '\\n');",
        ].join('\n'),
        'utf8',
      );
      const marker = 'cq-env-leak-marker-7f3a';
      const savedMarker = process.env.CQ_ENV_LEAK_MARKER;
      const savedGh = process.env.GH_TOKEN;
      const savedTask = process.env.CQ_TASK;
      // GLOBAL process.env mutation, deliberately: the real spawnManaged path
      // reads the LIVE parent env, so withholding can only be proven against
      // it. Restored in finally; this file's tests run sequentially (no
      // vitest .concurrent), so no concurrent test observes the markers.
      process.env.CQ_ENV_LEAK_MARKER = marker;
      process.env.GH_TOKEN = 'ghp_marker_secret';
      const probeOptions: CliTransportOptions = {
        binary: ['node', probePath],
        routingTable: conformanceRoutingTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: {
          ...defaultHarnessConfig,
          workspaceRoot: join(scratchDir, 'workspaces'),
        },
      };
      try {
        // NO spawn override: this is the production spawnManaged path.
        const denied = await new ClaudeCodeDriver(probeOptions).run(
          invocation({ prompt: 'env probe run', toolPolicy: EMPTY_SURFACE }),
        );
        expect(denied.stopReason).toBe('complete');
        const deniedEnv = probeEnvOf(await narrationOf(store, denied.sessionId as string));
        // The marker secret never reaches the worker…
        expect(deniedEnv['CQ_ENV_LEAK_MARKER']).toBeUndefined();
        expect(deniedEnv['GH_TOKEN']).toBeUndefined();
        expect(JSON.stringify(deniedEnv)).not.toContain(marker);
        // …while terminal basics and the configured route env do. Derive the
        // expected values from the live env so an ambient CONFORMANCE_* var
        // cannot flip this test (r2).
        const expectedBaseUrl = process.env.CONFORMANCE_BASE_URL ?? 'http://127.0.0.1:1/anthropic';
        expect(typeof deniedEnv['PATH']).toBe('string');
        expect(deniedEnv['ANTHROPIC_BASE_URL']).toBe(expectedBaseUrl);
        // Diagnostics are redacted before persistence, so the route key is
        // observable as present but never recoverable from the session log.
        expect(deniedEnv['ANTHROPIC_API_KEY']).toBe('[redacted]');
        expect(deniedEnv['ANTHROPIC_AUTH_TOKEN']).toBe('[redacted]');

        // The documented escape hatch is real end-to-end (r1): naming the
        // marker in envAllowlist copies ONLY that parent name back in.
        const allowed = await new ClaudeCodeDriver({
          ...probeOptions,
          envAllowlist: ['CQ_ENV_LEAK_MARKER'],
        }).run(invocation({ prompt: 'allowlist probe run', toolPolicy: EMPTY_SURFACE }));
        expect(allowed.stopReason).toBe('complete');
        const allowedEnv = probeEnvOf(await narrationOf(store, allowed.sessionId as string));
        expect(allowedEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(allowedEnv['GH_TOKEN']).toBeUndefined(); // only the named extra is added

        // The per-instance list is a FROZEN COPY (r2): mutating the caller's
        // array after construction cannot weaken later spawns.
        const mutableAllowlist = ['CQ_ENV_LEAK_MARKER'];
        const frozenDriver = new ClaudeCodeDriver({
          ...probeOptions,
          envAllowlist: mutableAllowlist,
        });
        mutableAllowlist.push('GH_TOKEN');
        const frozen = await frozenDriver.run(
          invocation({ prompt: 'frozen allowlist probe run', toolPolicy: EMPTY_SURFACE }),
        );
        const frozenEnv = probeEnvOf(await narrationOf(store, frozen.sessionId as string));
        expect(frozenEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(frozenEnv['GH_TOKEN']).toBeUndefined(); // pushed AFTER construction — not honored

        // Session-log correlation: the invocation's work id reaches the
        // child, and an absent field REMOVES a stale allowlisted parent
        // value at the spawn boundary (CQ_TASK is on the default allowlist).
        process.env.CQ_TASK = 'stale-outer-task';
        const correlated = await new ClaudeCodeDriver(probeOptions).run(
          invocation({
            prompt: 'correlation probe run',
            toolPolicy: EMPTY_SURFACE,
            correlation: { workId: 'w-probe', role: 'fixer' },
          }),
        );
        expect(correlated.stopReason).toBe('complete');
        const correlatedEnv = probeEnvOf(await narrationOf(store, correlated.sessionId as string));
        expect(correlatedEnv['CQ_WORK_ID']).toBe('w-probe');
        expect(correlatedEnv['CQ_ROLE']).toBe('fixer');
        expect(correlatedEnv['CQ_TASK']).toBeUndefined();
      } finally {
        if (savedTask === undefined) delete process.env.CQ_TASK;
        else process.env.CQ_TASK = savedTask;
        if (savedMarker === undefined) delete process.env.CQ_ENV_LEAK_MARKER;
        else process.env.CQ_ENV_LEAK_MARKER = savedMarker;
        if (savedGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = savedGh;
      }
    });
  }, 20_000);
});
