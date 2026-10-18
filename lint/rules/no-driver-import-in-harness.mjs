// no-driver-import-in-harness — the harness→driver boundary rule from
// migration plan step 1.1 (ADR-0005 layered-monorepo revision). After 1.1
// moved the process-ladder and CLI-schema helpers to src/shared/{proc,
// json-schema}.ts, the harness must never reach into the driver tree again:
// src/harness/** consumes src/shared/** (and, once the contracts package
// exists, src/contracts) — while the REVERSE edge (driver → harness, e.g.
// src/driver/subprocess/index.ts importing the harness surface) stays legal.
// The rule CORE reports every relative import whose RESOLVED path lands in
// src/driver/; the scoping and severity live in .oxlintrc.json (the rule is
// registered under the "cq" plugin and applied to src/harness/** in WARN
// mode — flipped to error only when the last documented violation is gone).
//
// DOCUMENTED REMAINING VIOLATIONS (warn, not error — each is a TYPE-ONLY
// import of src/driver/types.ts that becomes a `contracts` import when the
// contracts layer lands, migration 1.1/1.8; do not add new entries here):
//   - src/harness/surface.ts  (import type { SandboxLevel, ToolPolicy })
//   - src/harness/tools.ts    (import type { SandboxLevel, ToolDenial })
//
// Same resolve-then-contain discipline as no-cli-beyond-registry-kernel:
// relative sources are resolved LEXICALLY (posix join + normalize against
// the importing file's repo-relative directory — no fs, no extension
// guessing) before containment, so traversal spellings cannot dodge the
// prefix ('../shared/../driver/types.js' resolves into src/driver/ and is
// reported). Bare specifiers ('zod', 'node:*') are out of scope — this rule
// guards the INTERNAL layer edge only. COMPUTED sources fail closed: an
// import whose source is not a plain string literal or a substitution-free
// template hides its real target from resolve-then-contain and is reported
// outright. The rule core checks every import source it sees; file scoping
// and severity come from the config, keeping this file testable with
// RuleTester alone.

import path from 'node:path';

// The banned target root, repo-relative POSIX. The config scopes this rule
// to 'src/harness/**', so every importing file's repo-relative path is
// anchored at 'src/'.
const DRIVER_DIR = 'src/driver';

// Repo-relative POSIX path of the importing file. RuleTester filenames are
// already repo-relative; real lint runs hand the rule an absolute path whose
// repo-relative form starts at the LAST '/src/' segment (the config only
// applies this rule to 'src/harness/**'). Windows separators are normalized
// to forward slashes first, and the '/src/' slice is deliberately NOT gated
// on path.posix.isAbsolute (a Windows absolute path carries a drive prefix,
// not a leading '/') — the same anchoring no-cli-beyond-registry-kernel uses.
function repoRelative(filename) {
  const normalized = filename.split('\\').join('/');
  const srcIndex = normalized.lastIndexOf('/src/');
  if (srcIndex !== -1) return normalized.slice(srcIndex + 1);
  return normalized;
}

// True when `child` IS `parent` or lives underneath it — a segment-boundary
// prefix check ('src/driver-x' is NOT inside 'src/driver').
function isInside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

// Lexically resolve a RELATIVE source against the importing file's
// repo-relative path: join + posix.normalize. Purely textual — traversal
// segments ('..') are collapsed before any containment check.
function resolveRelative(source, importerPath) {
  const importerDir = path.posix.dirname(importerPath);
  return path.posix.normalize(path.posix.join(importerDir, source));
}

function isRelativeSpecifier(source) {
  return source === '.' || source === '..' || source.startsWith('./') || source.startsWith('../');
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
  const importerPath = repoRelative(context.filename);
  const source = sourceText(sourceNode);
  if (source === null) {
    // FAIL CLOSED: a COMPUTED source makes the import's real target
    // invisible to resolve-then-contain — exactly the bypass
    // (`const t = '../driver/types.js'; await import(t);`). Reported
    // outright; inside the harness the source must be literal.
    context.report({
      node: reportNode,
      messageId: 'computedSource',
    });
    return;
  }
  if (isRelativeSpecifier(source) && isInside(resolveRelative(source, importerPath), DRIVER_DIR)) {
    context.report({
      node: reportNode,
      messageId: 'driverImport',
      data: { source, resolved: resolveRelative(source, importerPath) },
    });
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid imports from src/driver/** in harness code (migration 1.1 boundary: harness consumes shared/contracts, never the driver tree).',
    },
    schema: [],
    messages: {
      driverImport:
        "Harness code must not import the driver tree: '{{source}}' resolves to '{{resolved}}' (migration 1.1 boundary — import from src/shared/** or contracts instead).",
      computedSource:
        'Computed import sources must be literal inside the harness layer (the driver-import boundary cannot be resolved from a computed source).',
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
      TSImportType(node) {
        checkSource(context, node.source ?? { type: 'Identifier' }, node);
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
