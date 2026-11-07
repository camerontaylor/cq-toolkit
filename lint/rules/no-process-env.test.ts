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
    ok("import { processEnv } from '../config/process-env.js'; const v = processEnv()['A'];"),
    ok('const env = { PATH: "/bin" }; env.PATH;'),
    ok('process.argv.slice(2);'),
    ok('process.cwd();'),
    ok('const o = { process: { env: {} } }; o.process.env;'),
    ok('const x = other.process.env;'),
    ok('const { argv } = process;'),
    ok('const e = process.environment;'),
  ],
  invalid: [
    bad("const v = process.env['A'];"),
    bad('const v = process.env.A;'),
    bad('const copy = { ...process.env };'),
    bad("const v = process['env'].A;"),
    bad('const v = globalThis.process.env.A;'),
    bad('const { env } = process;'),
    bad('function f(env = process.env) { return env; }'),
  ],
});
