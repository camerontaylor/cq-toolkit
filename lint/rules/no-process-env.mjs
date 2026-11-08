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
// (`const p = process` or `p = process`), and TS assertions. Not tracked:
// interprocedural control flow. Writes in unrelated functions are ignored.

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
    const processBindings = new Map();
    const bindingOf = (node) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const binding = scope.set.get(node.name);
        if (binding) return binding;
      }
      return null;
    };
    const addAlias = (node) => {
      const binding = bindingOf(node);
      if (!binding) return;
      let writes = processBindings.get(binding);
      if (!writes) processBindings.set(binding, (writes = new Set()));
      writes.add(node.range[0]);
    };
    // Keep a possible alias when a write is guarded by a branch/loop that
    // does not also contain the read. This is deliberately not a CFG analysis.
    const isGuardedWrite = (identifier, read, executionBlock) => {
      for (let child = identifier; child.parent && child !== executionBlock; child = child.parent) {
        const parent = child.parent;
        if (
          /^(IfStatement|ConditionalExpression|LogicalExpression|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|SwitchCase|TryStatement|CatchClause|AssignmentPattern|ChainExpression)$/.test(
            parent.type,
          ) &&
          !(child.range[0] <= read.range[0] && child.range[1] >= read.range[1])
        )
          return true;
      }
      return false;
    };
    const isProcessNode = (raw) => {
      const node = unwrap(raw);
      // These expressions can return process on either path. For && only
      // the right operand can be the result when the value is process (truthy).
      if (node.type === 'LogicalExpression') {
        return (node.operator !== '&&' && isProcessNode(node.left)) || isProcessNode(node.right);
      }
      if (node.type === 'ConditionalExpression') {
        return isProcessNode(node.consequent) || isProcessNode(node.alternate);
      }
      if (node.type !== 'Identifier') return isProcess(node);
      const binding = bindingOf(node);
      if (!binding || binding.defs.length === 0) return isProcess(node);
      const aliases = processBindings.get(binding);
      if (!aliases) return false;
      // A function body can precede a read without ever executing. Only writes
      // in this execution scope or an enclosing one can invalidate this read.
      const readScope = context.sourceCode.getScope(node);
      let latestWrite;
      for (const ref of binding.references) {
        if (!ref.isWrite()) continue;
        if ((ref.writeExpr?.range[1] ?? ref.identifier.range[1]) > node.range[0]) continue;
        const writeScope = ref.from.variableScope;
        let scope = readScope;
        while (scope && scope !== writeScope) scope = scope.upper;
        if (!scope) continue;
        if (
          !aliases.has(ref.identifier.range[0]) &&
          isGuardedWrite(ref.identifier, node, writeScope.block)
        )
          continue;
        if (!latestWrite || ref.identifier.range[0] > latestWrite.identifier.range[0]) {
          latestWrite = ref;
        }
      }
      // Imports have no initializing write reference.
      return latestWrite
        ? aliases.has(latestWrite.identifier.range[0])
        : binding.defs.some((def) => def.type === 'ImportBinding');
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
            if (imported === 'default') addAlias(spec.local);
          } else {
            addAlias(spec.local);
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
          addAlias(node.id);
        }
        checkPattern(node.id, node.init, node);
      },
      AssignmentExpression(node) {
        if (
          node.left.type === 'Identifier' &&
          ((['=', '||=', '??=', '&&='].includes(node.operator) && isProcessNode(node.right)) ||
            (['||=', '??='].includes(node.operator) && isProcessNode(node.left)))
        ) {
          addAlias(node.left);
        }
        checkPattern(node.left, node.right, node);
      },
      AssignmentPattern(node) {
        // function f({ env } = process) {}
        checkPattern(node.left, node.right, node);
      },
    };
  },
};
