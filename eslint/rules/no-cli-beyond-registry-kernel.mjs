// no-cli-beyond-registry-kernel — boundary rule backing the "no-logic-in-CLI"
// claim (I1): src/cli is a THIN dispatcher. In the files the rule is applied
// to (the scoping lives in eslint.config.js — the rule is registered under
// the "cq" plugin and applied to src/cli/** and src/cli.ts), every static or
// dynamic import source must be one of:
//   - a relative path starting './'            (intra-CLI modules),
//   - a relative path starting '../registry/'  (op discovery + schemas),
//   - a relative path starting '../kernel/'    (runner/governor/taxonomy),
//   - a 'node:' prefixed builtin,
//   - the bare specifier 'zod' ONLY in the configured zodFiles (the one
//     schema-defining subcommand module, src/cli/run-plan.ts — the same act
//     a family registry performs).
// Anything else (../ops/, ../driver/, ../harness/, ../plans/, vendor
// packages) drags logic or machinery into the CLI layer and is reported.
// The rule CORE checks every import source it sees; file scoping and the
// zodFiles option come from the config, keeping this file testable with
// RuleTester alone.

// The zodFiles option: repo-relative paths of CLI modules allowed to import
// 'zod'. Matched on a normalized (forward-slash) filename either exactly or
// as a path suffix, so both RuleTester's relative filenames and real
// absolute paths from the config resolve the same way.
function isAllowedZodFile(filename, zodFiles) {
  const normalized = filename.split('\\').join('/');
  return zodFiles.some((allowed) => normalized === allowed || normalized.endsWith(`/${allowed}`));
}

function isAllowedSource(source, zodFiles, filename) {
  if (source.startsWith('node:')) return true;
  if (source.startsWith('./')) return true; // intra-CLI siblings
  if (source.startsWith('../registry/') || source.startsWith('../kernel/')) return true;
  if (source === 'zod' && isAllowedZodFile(filename, zodFiles)) return true;
  return false;
}

// Module-source text: plain string literals, or template literals with no
// substitutions (import(`./x.js`) parses as a TemplateLiteral, not a Literal).
function sourceText(sourceNode) {
  if (sourceNode.type === 'Literal' && typeof sourceNode.value === 'string') {
    return sourceNode.value;
  }
  if (sourceNode.type === 'TemplateLiteral' && sourceNode.expressions.length === 0) {
    return sourceNode.quasis[0].value.cooked;
  }
  return null;
}

function checkSource(context, sourceNode, reportNode) {
  if (!sourceNode) return;
  const source = sourceText(sourceNode);
  if (source === null) return; // dynamic, computed sources are not statically checkable
  const [options] = context.options;
  const zodFiles = options?.zodFiles ?? [];
  if (!isAllowedSource(source, zodFiles, context.filename)) {
    context.report({
      node: reportNode,
      messageId: 'beyondRegistryKernel',
      data: { source },
    });
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep the CLI inside the registry/kernel boundary: only ./ siblings, ../registry/, ../kernel/, node: builtins, and (in configured files) zod.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          zodFiles: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Repo-relative paths of CLI modules allowed to import the bare specifier "zod".',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      beyondRegistryKernel:
        "Import source '{{source}}' is beyond the registry/kernel boundary (no-logic-in-CLI: src/cli imports only ./ intra-CLI modules, ../registry/, ../kernel/, node: builtins, and 'zod' solely in schema-defining subcommand modules).",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        checkSource(context, node.source, node);
      },
      ImportExpression(node) {
        checkSource(context, node.source, node);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(context, node.source, node);
      },
      ExportAllDeclaration(node) {
        checkSource(context, node.source, node);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          checkSource(context, node.moduleReference.expression, node);
        }
      },
      CallExpression(node) {
        const isRequire =
          (node.callee.type === 'Identifier' && node.callee.name === 'require') ||
          (node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'require');
        if (isRequire && node.arguments.length > 0) {
          checkSource(context, node.arguments[0], node);
        }
      },
    };
  },
};
