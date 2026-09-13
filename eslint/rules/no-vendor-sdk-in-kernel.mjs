// no-vendor-sdk-in-kernel — boundary rule backing invariant I10: the kernel
// stays vendor-neutral. The rule CORE reports every vendor-SDK-shaped module
// source it sees; the kernel-only scoping lives in eslint.config.js (the rule
// is registered under the "cq" plugin and applied to src/kernel/** only).
// Stub in T0.2; becomes load-bearing in phase 1.

const VENDOR_SDK_SOURCE = /^(?:@anthropic-ai\/|@ai-sdk\/|ai(?:\/|$)|openai(?:\/|$))/;

// Module-source text: plain string literals, or template literals with no
// substitutions (import(`ai`) parses as a TemplateLiteral, not a Literal).
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
  if (source === null) return;
  if (VENDOR_SDK_SOURCE.test(source)) {
    context.report({
      node: reportNode,
      messageId: 'vendorSdk',
      data: { source },
    });
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid vendor SDK imports in kernel code (invariant I10: kernel stays vendor-neutral).',
    },
    schema: [],
    messages: {
      vendorSdk:
        "Vendor SDK import source '{{source}}' is banned in kernel code (invariant I10: kernel stays vendor-neutral).",
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
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length > 0
        ) {
          checkSource(context, node.arguments[0], node);
        }
      },
    };
  },
};
