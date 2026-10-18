// no-driver-import-in-harness — the harness→driver boundary rule from
// migration plan step 1.1 (ADR-0005 layered-monorepo revision). After 1.1
// moved the process-ladder and CLI-schema helpers to src/shared/{proc,
// json-schema}.ts, the harness depends only on shared and contracts: it must
// never reach into the driver tree again — while the REVERSE edge (driver →
// harness, e.g. src/driver/subprocess/index.ts importing the harness surface)
// stays legal. The scoping (src/harness/**) and the ERROR severity live in
// .oxlintrc.json (the rule is registered under the "cq" plugin).
//
// THE CONTRACTS SEAM: src/driver/types.ts is the driver seam's type module,
// which the package topology places in the L0 contracts layer (it becomes
// `@cq/contracts` when the packages are cut). Migration 1.1: "Harness's
// remaining driver/types imports are type-only and become contracts." An
// import that resolves to exactly that file is a contracts edge and is
// allowed; anything else under src/driver/ is reported.
//
// Every module-import FORM is checked: import/export-from declarations,
// dynamic import(), require(), TypeScript inline import types
// (`import('…').T`) and import-equals (`import x = require('…')`). Same
// resolve-then-contain discipline as no-cli-beyond-registry-kernel: relative
// sources are resolved LEXICALLY (backslashes normalized to '/', then posix
// join + normalize against the importing file's repo-relative directory — no
// fs, no extension guessing) before containment, so traversal spellings
// cannot dodge the prefix ('../shared/../driver/types.js' is still a driver
// path). Bare specifiers ('zod', 'node:*') are out of scope — this rule guards
// the INTERNAL layer edge. COMPUTED sources fail closed: an import whose
// source is not a plain string literal or a substitution-free template hides
// its real target and is reported outright. Specifiers tsc cannot resolve
// (percent escapes, ?query/#fragment suffixes) already fail the typecheck, and
// runtime loader APIs (createRequire, process.getBuiltinModule) are not import
// syntax; neither is this rule's concern.

import path from 'node:path';

// The banned target root and the one allowed contracts file inside it,
// repo-relative POSIX, extension-less (the resolved source carries '.js').
const DRIVER_DIR = 'src/driver';
const CONTRACTS_SEAM = 'src/driver/types';

// Candidate repo-relative POSIX paths of the importing file. The config only
// applies this rule to 'src/harness/**', so the repo root sits immediately
// before SOME '/src/harness/' segment of the path — but the checkout's own
// parent path, or a nested directory inside the harness, may contain that
// segment too, and no sentinel search can tell which occurrence is the root.
// So every occurrence is a candidate, and an import is reported when it lands
// in src/driver/ under ANY candidate root (failing closed: a false positive
// needs a nested copy of the src/harness + src/driver layout). RuleTester filenames are
// already repo-relative (a leading '/' is prepended so they match too).
// Windows separators are normalized first; a drive prefix is sliced off.
function repoRelativeCandidates(filename) {
  const normalized = `/${filename.split('\\').join('/')}`;
  const candidates = [];
  for (
    let index = normalized.indexOf('/src/harness/');
    index !== -1;
    index = normalized.indexOf('/src/harness/', index + 1)
  ) {
    candidates.push(normalized.slice(index + 1));
  }
  return candidates.length > 0 ? candidates : [normalized.slice(1)];
}

// True when `child` IS `parent` or lives underneath it — a segment-boundary
// prefix check ('src/driver-x' is NOT inside 'src/driver').
function isInside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

function isRelativeSpecifier(source) {
  return source === '.' || source === '..' || source.startsWith('./') || source.startsWith('../');
}

// The contracts seam, under any of the extensions a source may name.
function isContractsSeam(resolved) {
  return resolved.replace(/\.(?:d\.[cm]?ts|[cm]?[jt]s)$/, '') === CONTRACTS_SEAM;
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
  const raw = sourceText(sourceNode);
  if (raw === null) {
    // FAIL CLOSED: a COMPUTED source makes the import's real target
    // invisible to resolve-then-contain — exactly the bypass
    // (`const t = '../driver/types.js'; await import(t);`).
    context.report({ node: reportNode, messageId: 'computedSource' });
    return;
  }
  // Node's file-URL resolution (and tsc) treat '\' as a separator.
  const source = raw.split('\\').join('/');
  if (!isRelativeSpecifier(source)) return;
  for (const importer of repoRelativeCandidates(context.filename)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), source));
    if (isInside(resolved, DRIVER_DIR) && !isContractsSeam(resolved)) {
      context.report({
        node: reportNode,
        messageId: 'driverImport',
        data: { source: raw, resolved },
      });
      return;
    }
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid imports from src/driver/** in harness code, except the src/driver/types.ts contracts seam (migration 1.1 boundary: harness consumes shared/contracts, never the driver tree).',
    },
    schema: [],
    messages: {
      driverImport:
        "Harness code must not import the driver tree: '{{source}}' resolves to '{{resolved}}' (migration 1.1 boundary — import from src/shared/** or the src/driver/types.ts contracts seam instead).",
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
