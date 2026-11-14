// RuleTester suite for the process.env confinement rule (config contract C7).
// The src/** scoping and the allowlist overrides live in .oxlintrc.json.
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-process-env.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

const bad = (code: string) => ({
  code,
  filename: 'src/ops/x.ts',
  errors: [{ messageId: 'processEnv' }],
});
const ok = (code: string) => ({ code, filename: 'src/ops/x.ts' });

ruleTester.run('no-process-env', rule, {
  valid: [
    ok('let p = process; p &&= {}; p.env;'),
    ok('let p = process; p = p && other; p.env;'),
    ok('let p = process; p ||= {}; p = {}; p.env;'),
    ok('let p = process; p = cond ? other : {}; p.env;'),
    ok('let p = process; if (useFallback) { p = {}; p.env; }'),
    ok('let p = process; if (useFallback) { p = {}; } p = {}; p.env;'),
    ok('let p; function reset() { p = process; } p.env;'),
    ok('let p = process; function f() { p = {}; return p.env; }'),
    ok('let p = process; p = {}; function f() { return p.env; }'),
    ok('var p = process; { var p = other; } p.env;'),
    ok('const p = process; function f(p) { return p.env; }'),
    ok('const p = process; { const p = { env: {} }; p.env; }'),
    ok("import proc from 'node:process'; function f(proc) { return proc.env; }"),
    ok("import * as proc from 'process'; { const proc = { env: {} }; proc.env; }"),
    ok('let p = process; p = { env: {} }; p.env;'),
    ok('let p = process; ({ p } = other); p.env;'),
    ok('let p = process; p++; p.env;'),
    ok('var p = process; var p = other; p.env;'),
    ok('function f(process) { const p = process; return p.env; }'),
    ok("import { currentEntryEnv } from '../config/run-env.js'; const v = currentEntryEnv()['A'];"),
    ok('const env = { PATH: "/bin" }; env.PATH;'),
    ok('process.argv.slice(2);'),
    ok('process.cwd();'),
    ok('const o = { process: { env: {} } }; o.process.env;'),
    ok('const x = other.process.env;'),
    ok('const { argv } = process;'),
    ok('const e = process.environment;'),
    ok("import { argv } from 'node:process'; argv.slice(2);"),
    ok("import proc from 'node:process'; proc.cwd();"),
    ok('function f({ argv } = process) { return argv; }'),
    ok('let a; ({ argv: a } = process);'),
  ],
  invalid: [
    bad('let p = process; p ||= {}; p.env;'),
    bad('let p = process; p ??= {}; p.env;'),
    bad('let p = process; p ||= process; p.env;'),
    bad('let p = process; p ??= process; p.env;'),
    bad('let p = process; p &&= process; p.env;'),
    bad('let p = process; p = p || other; p.env;'),
    bad('let p = process; p = p ?? other; p.env;'),
    bad('let p = process; p = cond ? p : other; p.env;'),
    bad('let p = process; p = other || p; p.env;'),
    bad('const p = cond ? process : other; p.env;'),
    bad('const p = other && process; p.env;'),
    bad('let p = process; if (useFallback) { p = { env: {} }; } p.env;'),
    bad('let p = process; useFallback && (p = {}); p.env;'),
    bad('let p = process; useFallback ? p = {} : null; p.env;'),
    bad('let p = process; while (useFallback) { p = {}; } p.env;'),
    bad('let p = process; function reset() { p = {}; } p.env;'),
    bad('let p = process; function reset() { p = {}; } function read() { return p.env; }'),
    bad('var p = process; var p = process; p.env;'),
    bad('var p = other; var p = process; p.env;'),
    bad('let p = process; p = process; p.env;'),
    bad('let p = process; p = p; p.env;'),
    {
      ...bad('process.env;'),
      languageOptions: { globals: { process: 'readonly' } },
    },
    bad('const p = process; function f(p) { return p.env; } p.env;'),
    bad('const p = process; const q = p; q.env;'),
    bad('let p = process; p = p.env;'),
    bad('function a() { const p = process; } function b(p) { return p.env; } process.env;'),
    bad('let p = process; const q = p; p = other; q.env;'),
    bad('let p = process; p.env; p = other; p.env;'),
    bad("import proc from 'node:process'; function f(proc) { return proc.env; } proc.env;"),
    bad('const p = process; p.env.A;'),
    bad('const v = (process as any).env.A;'),
    bad('const p = process as NodeJS.Process; const v = p.env.A;'),
    bad("const v = process.env['A'];"),
    bad('const v = process.env.A;'),
    bad('const copy = { ...process.env };'),
    bad("const v = process['env'].A;"),
    bad('const v = globalThis.process.env.A;'),
    bad('const { env } = process;'),
    bad('function f(env = process.env) { return env; }'),
    bad("import { env } from 'node:process';"),
    bad("import { env as e } from 'process';"),
    bad("import proc from 'node:process'; const v = proc.env.A;"),
    bad("import * as proc from 'node:process'; const v = proc.env.A;"),
    bad("import { default as proc } from 'node:process'; const v = proc.env;"),
    bad('let env; ({ env } = process);'),
    bad('function f({ env } = process) { return env; }'),
  ],
});
