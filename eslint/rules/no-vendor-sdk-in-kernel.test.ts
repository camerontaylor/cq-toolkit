// RuleTester suite for the kernel vendor-neutrality boundary rule (I10).
// The rule CORE reports every vendor-SDK-shaped import source it sees; the
// kernel-only scoping lives in eslint.config.js (the rule is applied to
// files matching src/kernel/** there). Because RuleTester runs the rule core
// without the repo config's file scoping, an `import ... from "ai"` OUTSIDE
// src/kernel is a valid case of the CONFIG, not of the rule, and cannot be
// expressed here — it is covered by the eslint.config.js files scoping.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './no-vendor-sdk-in-kernel.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('no-vendor-sdk-in-kernel', rule, {
  valid: [
    { code: 'import x from "zod";', filename: 'src/kernel/a.ts' },
    { code: 'import z from "@ast-grep/napi";', filename: 'src/kernel/a.ts' },
  ],
  invalid: [
    {
      code: 'import { x } from "ai";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import y from "@anthropic-ai/claude-agent-sdk";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import z from "@ai-sdk/openai";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import w from "openai";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import codex from "@openai/codex-sdk";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import mistral from "@mistralai/sdk";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import gemini from "@google/genai";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import p from "ai/provider";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import q from "openai/resources";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'export * from "ai";',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import(`ai`);',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'require(`@anthropic-ai/claude-agent-sdk`);',
      errors: [{ messageId: 'vendorSdk' }],
    },
    {
      code: 'import OpenAI = require("openai");',
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        parser: tseslint.parser,
      },
      errors: [{ messageId: 'vendorSdk' }],
    },
  ],
});
