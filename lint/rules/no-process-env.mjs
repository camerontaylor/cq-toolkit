// no-process-env — confines direct `process.env` access (config contract C7,
// ADR-0009). CQ_* configuration is read once at the entry through readCqEnv
// and threaded down; a reader that has no snapshot goes through
// `processEnv()` from src/config/process-env.ts. The only files that may name
// `process.env` are src/config/** and the driver/adapter child-env builders,
// which compose a child's environment from foreign names. That allowlist lives
// in .oxlintrc.json as per-file "off" overrides; the reasons are in the
// appendix of docs/adr/0009-config-contract-v2.md. The rule itself reports
// every use and is scoped to src/**. The sibling rule no-process-env-accessor
// guards the `processEnv()` escape hatch; follow-up: issue #1185.
//
// Forms caught: `process.env`, `process['env']`, `globalThis.process.env`,
// destructuring `{ env } = process` in declarations, assignments and
// parameters, `import { env } from 'node:process'`, and `.env` on a default
// or namespace import of `node:process` / `process`, a local alias
// (`const p = process`), and TS assertions around any of these.

const WRAPPERS = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'ParenthesizedExpression',
]);

/** Strip TS assertions and parentheses: `(process as any)` is `process`. */
function unwrap(node) {
  let n = node;
  while (n && WRAPPERS.has(n.type)) n = n.expression;
  return n;
}

const isProcess = (raw) => {
  const node = unwrap(raw);
  return (
    (node.type === 'Identifier' && node.name === 'process') ||
    (node.type === 'MemberExpression' &&
      isPlainKey(node, 'process') &&
      unwrap(node.object).type === 'Identifier' &&
      unwrap(node.object).name === 'globalThis')
  );
};

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
    const processNames = new Set(); // local names bound to the process module
    const isProcessNode = (raw) => {
      const node = unwrap(raw);
      return isProcess(node) || (node.type === 'Identifier' && processNames.has(node.name));
    };
    const hasEnvKey = (pattern) =>
      pattern.properties.some(
        (p) =>
          p.type === 'Property' &&
          ((p.key.type === 'Identifier' && !p.computed && p.key.name === 'env') ||
            (p.key.type === 'Literal' && p.key.value === 'env')),
      );
    const checkPattern = (pattern, init, node) => {
      if (
        pattern &&
        init &&
        pattern.type === 'ObjectPattern' &&
        isProcessNode(init) &&
        hasEnvKey(pattern)
      ) {
        context.report({ node, messageId: 'processEnv' });
      }
    };
    return {
      ImportDeclaration(node) {
        const src = node.source.value;
        if (src !== 'node:process' && src !== 'process') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.name ?? spec.imported.value;
            if (imported === 'env') context.report({ node: spec, messageId: 'processEnv' });
            if (imported === 'default') processNames.add(spec.local.name);
          } else {
            processNames.add(spec.local.name);
          }
        }
      },
      MemberExpression(node) {
        if (isProcessNode(node.object) && isPlainKey(node, 'env')) {
          context.report({ node, messageId: 'processEnv' });
        }
      },
      VariableDeclarator(node) {
        // A plain alias: `const p = process;` makes `p.env` a process.env read.
        if (node.id.type === 'Identifier' && node.init && isProcessNode(node.init)) {
          processNames.add(node.id.name);
        }
        checkPattern(node.id, node.init, node);
      },
      AssignmentExpression(node) {
        checkPattern(node.left, node.right, node);
      },
      AssignmentPattern(node) {
        // function f({ env } = process) {}
        checkPattern(node.left, node.right, node);
      },
    };
  },
};
