// no-cli-beyond-registry-kernel — boundary rule backing the "no-logic-in-CLI"
// claim (I1): src/cli is a THIN dispatcher. In the files the rule is applied
// to (the scoping lives in eslint.config.js — the rule is registered under
// the "cq" plugin and applied to src/cli/** and src/cli.ts), every static or
// dynamic import source is checked by RESOLVE-THEN-CONTAIN: relative sources
// are resolved LEXICALLY (posix join + normalize against the importing file's
// repo-relative directory — no fs, no extension guessing) and the RESOLVED
// path must be
//   - inside src/cli/            (intra-CLI modules), or
//   - inside src/registry/ or src/kernel/ — ONLY when the importing file
//     itself sits under src/cli/** (op discovery + schemas; runner,
//     governor, taxonomy).
// For the src/cli.ts bin shim (which lives in src/, not src/cli/), that means
// the ONLY allowed relative targets are src/cli/**: './cli/main.js' resolves
// inside; './driver/x.js' resolves OUTSIDE the CLI layer and is reported.
// Resolving before containment is the point: a raw prefix match is bypassable
// by traversal spellings — './../ops/index.js' textually starts with './'
// and '../kernel/../driver/index.js' textually starts with '../kernel/', yet
// both resolve outside the CLI layer and are reported here.
//   - 'node:' prefixed builtins stay allowed everywhere;
//   - the bare specifier 'zod' ONLY in the configured zodFiles (the one
//     schema-defining subcommand module, src/cli/run-plan.ts — the same act
//     a family registry performs).
// Anything else (bare vendor packages, absolute paths, ../ops, ../driver,
// ../harness, ../plans, or a relative source resolving outside the allowed
// roots) drags logic or machinery into the CLI layer and is reported.
// The rule CORE checks every import source it sees; file scoping and the
// zodFiles option come from the config, keeping this file testable with
// RuleTester alone.

import path from 'node:path';

// Layer roots, repo-relative POSIX. The config scopes this rule to
// 'src/cli/**' + 'src/cli.ts', so every importing file's repo-relative path
// is anchored at 'src/'.
const CLI_DIR = 'src/cli';
const REGISTRY_DIR = 'src/registry';
const KERNEL_DIR = 'src/kernel';

// The zodFiles option: repo-relative paths of CLI modules allowed to import
// 'zod'. Matched on a normalized (forward-slash) filename either exactly or
// as a path suffix, so both RuleTester's relative filenames and real
// absolute paths from the config resolve the same way.
function isAllowedZodFile(filename, zodFiles) {
  const normalized = filename.split('\\').join('/');
  return zodFiles.some((allowed) => normalized === allowed || normalized.endsWith(`/${allowed}`));
}

// Repo-relative POSIX path of the importing file. RuleTester filenames are
// already repo-relative; real lint runs hand the rule an absolute path whose
// repo-relative form starts at the LAST '/src/' segment (the config only ever
// applies this rule to 'src/cli/**' and 'src/cli.ts'). Windows separators are
// normalized to forward slashes first.
function repoRelative(filename) {
  const normalized = filename.split('\\').join('/');
  if (path.posix.isAbsolute(normalized)) {
    const srcIndex = normalized.lastIndexOf('/src/');
    if (srcIndex !== -1) return normalized.slice(srcIndex + 1);
  }
  return normalized;
}

// True when `child` IS `parent` or lives underneath it — a segment-boundary
// prefix check ('src/cli-x' is NOT inside 'src/cli').
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

// Resolve-then-contain for one relative source: allowed iff the RESOLVED path
// lands inside src/cli/, or — only when the importing file itself is under
// src/cli/** — inside src/registry/ or src/kernel/. The src/cli.ts shim (in
// src/, not src/cli/) may therefore reach ONLY src/cli/** relatively.
function isAllowedRelativeSource(source, importerPath) {
  const resolved = resolveRelative(source, importerPath);
  if (isInside(resolved, CLI_DIR)) return true;
  if (isInside(importerPath, CLI_DIR)) {
    return isInside(resolved, REGISTRY_DIR) || isInside(resolved, KERNEL_DIR);
  }
  return false;
}

function isAllowedSource(source, zodFiles, importerPath) {
  if (source.startsWith('node:')) return true;
  if (source === 'zod' && isAllowedZodFile(importerPath, zodFiles)) return true;
  if (isRelativeSpecifier(source)) return isAllowedRelativeSource(source, importerPath);
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
  const importerPath = repoRelative(context.filename);
  if (!isAllowedSource(source, zodFiles, importerPath)) {
    const arrow = isRelativeSpecifier(source) ? ` (resolves to '${resolveRelative(source, importerPath)}')` : '';
    context.report({
      node: reportNode,
      messageId: 'beyondRegistryKernel',
      data: { source, arrow },
    });
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep the CLI inside the registry/kernel boundary: relative imports must RESOLVE into src/cli/ (or, from src/cli/**, into src/registry/ or src/kernel/); node: builtins anywhere; zod only in configured files.',
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
        "Import source '{{source}}'{{arrow}} is beyond the registry/kernel boundary (no-logic-in-CLI: relative imports must resolve inside src/cli/, or — from src/cli/** — into src/registry/ or src/kernel/; node: builtins everywhere, and 'zod' solely in schema-defining subcommand modules).",
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
