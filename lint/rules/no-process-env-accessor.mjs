// no-process-env-accessor — keeps the processEnv() escape hatch from spreading
// (config contract C7). `processEnv()` (src/config/process-env.ts) exists only
// for readers that still lack a CqEnv snapshot from their caller. This rule
// reports any import of it, and any call of an identifier named `processEnv`,
// so new code cannot add a use without also adding the file to the debt list in
// .oxlintrc.json (the override that turns this rule off). src/config/** is off
// as well. Debt list and reasons: appendix of
// docs/adr/0009-config-contract-v2.md; follow-up: issue #1185.

const isAccessorSource = (value) =>
  typeof value === 'string' && /(^|\/)process-env(\.js)?$/.test(value);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid importing or calling processEnv() outside src/config and the labelled debt list (config contract C7).',
    },
    schema: [],
    messages: {
      accessor:
        'processEnv() is migration debt: thread the CqEnv snapshot from the entry instead (issue #1185). Adding a use requires listing the file in .oxlintrc.json, which is reviewed.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (isAccessorSource(node.source.value)) context.report({ node, messageId: 'accessor' });
      },
      ExportNamedDeclaration(node) {
        if (node.source && isAccessorSource(node.source.value)) {
          context.report({ node, messageId: 'accessor' });
        }
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && isAccessorSource(node.source.value)) {
          context.report({ node, messageId: 'accessor' });
        }
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'processEnv') {
          context.report({ node, messageId: 'accessor' });
        }
      },
    };
  },
};
