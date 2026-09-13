// Ambient declaration for the untyped .mjs rule module, so the (now
// typechecked) RuleTester suite imports it with a real ESLint rule type.
import type { Rule } from 'eslint';

declare const noVendorSdkInKernel: Rule.RuleModule;

export default noVendorSdkInKernel;
