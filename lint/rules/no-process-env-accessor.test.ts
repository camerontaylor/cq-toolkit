// RuleTester suite for the processEnv() accessor guard (config contract C7).
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import rule from './no-process-env-accessor.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

const filename = 'src/ops/x.ts';
const bad = (code: string, count = 1) => ({
  code,
  filename,
  errors: Array.from({ length: count }, () => ({ messageId: 'accessor' })),
});

ruleTester.run('no-process-env-accessor', rule, {
  valid: [
    { code: "import { readCqEnv } from '../config/env.js';", filename },
    { code: "import { x } from './process-environment.js';", filename },
    { code: 'const env = readCqEnv(); env.values;', filename },
    { code: 'obj.processEnv;', filename },
    { code: 'obj.processEnv();', filename },
  ],
  invalid: [
    bad("import { processEnv } from '../config/process-env.js';"),
    bad("import { processEnv } from './process-env';"),
    bad("export { processEnv } from '../config/process-env.js';"),
    bad("const m = await import('../config/process-env.js');"),
    bad('const e = processEnv();'),
  ],
});
