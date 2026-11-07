// no-process-env — confines direct `process.env` access (config contract C7,
// ADR-0009). CQ_* configuration is read once at the entry through readCqEnv
// and threaded down; a reader that has no snapshot goes through
// `processEnv()` from src/config/process-env.ts. The only files that may name
// `process.env` are src/config/** and the driver/adapter child-env builders,
// which compose a child's environment from foreign names. That allowlist lives
// in .oxlintrc.json as per-file "off" overrides, each with a reason in
// docs/adr/0009-config-contract-v2.md's allowlist table; the rule itself
// reports every use and is scoped to src/**.
//
// Forms caught: `process.env`, `process['env']`, `globalThis.process.env`,
// and destructuring `const { env } = process`.

const isProcess = (node) =>
  (node.type === 'Identifier' && node.name === 'process') ||
  (node.type === 'MemberExpression' &&
    isPlainKey(node, 'process') &&
    node.object.type === 'Identifier' &&
    node.object.name === 'globalThis');

function isPlainKey(member, name) {
  if (!member.computed)
    return member.property.type === 'Identifier' && member.property.name === name;
  return member.property.type === 'Literal' && member.property.value === name;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid direct process.env access in src outside src/config and the allowlisted child-env builders (config contract C7).',
    },
    schema: [],
    messages: {
      processEnv:
        'Do not read process.env here: take the CqEnv snapshot (or its values) from the caller, or use processEnv() from src/config/process-env.ts.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isProcess(node.object) && isPlainKey(node, 'env')) {
          context.report({ node, messageId: 'processEnv' });
        }
      },
      VariableDeclarator(node) {
        if (
          node.init &&
          isProcess(node.init) &&
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some(
            (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'env',
          )
        ) {
          context.report({ node, messageId: 'processEnv' });
        }
      },
    };
  },
};
