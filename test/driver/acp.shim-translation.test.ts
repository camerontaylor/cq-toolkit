import { describe, expect, test } from 'vitest';
import { argvForShimSpawn } from '../../src/driver/acp/process.js';

describe('win32 .cmd/.bat shim spawn translation (review-debt #54/#55)', () => {
  test('a resolved .cmd/.bat shim routes through cmd.exe /d /s /c as ONE verbatim token', () => {
    // The PATHEXT walk (issue #40) resolves npm's .cmd shims, but Node's
    // CVE-2024-27980 hardening rejects a DIRECT shell-less spawn of them
    // (EINVAL) — the launch must route through cmd.exe. Pure argv mapping,
    // keyed on the injected platform so it is testable everywhere.
    expect(argvForShimSpawn('C:\\tools\\zcode-acp-server.cmd', ['--flag', 'v'], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\tools\\zcode-acp-server.cmd --flag v"'],
      windowsVerbatimArguments: true,
    });
    expect(argvForShimSpawn('C:\\tools\\dsh.BAT', [], 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\tools\\dsh.BAT"'],
      windowsVerbatimArguments: true,
    });
    // Case-insensitive extension match (PATHEXT is uppercase by default,
    // but a lowercase-suffixed shim is the same file).
    expect(argvForShimSpawn('C:\\x\\tool.CMD', ['a'], 'win32')?.command).toBe('cmd.exe');
    // Element boundaries survive: a space-bearing path and a two-word
    // argument each stay ONE element, inside the ONE outer quote pair
    // that /s strips (PR #111 + PR #119 reviews).
    const quoted = argvForShimSpawn(
      'C:\\Program Files\\nodejs\\zcode-acp-server.cmd',
      ['--prompt', 'two words'],
      'win32',
    );
    expect(quoted.command).toBe('cmd.exe');
    expect(quoted.args[3]).toBe(
      `""C:\\Program Files\\nodejs\\zcode-acp-server.cmd" --prompt "two words""`,
    );
  });

  test('everything else passes through verbatim: exes, scripts, and any non-win32 platform', () => {
    expect(argvForShimSpawn('C:\\tools\\zcode.exe', ['--x'], 'win32')).toEqual({
      command: 'C:\\tools\\zcode.exe',
      args: ['--x'],
      windowsVerbatimArguments: false,
    });
    expect(argvForShimSpawn('node', ['server.js'], 'win32')).toEqual({
      command: 'node',
      args: ['server.js'],
      windowsVerbatimArguments: false,
    });
    // A .cmd path on POSIX is a plain file like any other — no routing.
    expect(argvForShimSpawn('/usr/local/bin/tool.cmd', [], 'darwin')).toEqual({
      command: '/usr/local/bin/tool.cmd',
      args: [],
      windowsVerbatimArguments: false,
    });
    expect(argvForShimSpawn('/usr/local/bin/tool.cmd', [], 'linux')).toEqual({
      command: '/usr/local/bin/tool.cmd',
      args: [],
      windowsVerbatimArguments: false,
    });
  });
});
