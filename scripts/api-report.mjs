#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DEFAULT_BASELINE = path.join(ROOT, 'baselines/api-report.json');
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  console.error(`api-report: ${message}`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const options = { draft: false, baseline: DEFAULT_BASELINE };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--draft') options.draft = true;
    else if (arg === '--baseline') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--baseline requires a path');
      options.baseline = path.resolve(ROOT, value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function collectTargets(value, conditions = [], targets = []) {
  if (typeof value === 'string') {
    targets.push({ conditions, target: value });
    return targets;
  }
  if (Array.isArray(value)) throw new Error('array export targets are unsupported');
  if (value && typeof value === 'object') {
    for (const [condition, child] of Object.entries(value)) {
      collectTargets(child, [...conditions, condition], targets);
    }
    return targets;
  }
  throw new Error('package export contains an unsupported target value');
}

function declarationPath(target) {
  if (/\.d\.(?:ts|mts|cts)$/.test(target)) return target;
  if (target.endsWith('.mjs')) return target.replace(/\.mjs$/, '.d.mts');
  if (target.endsWith('.cjs')) return target.replace(/\.cjs$/, '.d.cts');
  if (target.endsWith('.js')) return target.replace(/\.js$/, '.d.ts');
  throw new Error(`export target has no supported declaration mapping: ${target}`);
}

// Blank out comments (keeping `/// <reference path>` directives and string literals)
// so imports quoted in JSDoc examples are not counted as declaration dependencies.
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      if (/^\/\/\/\s*<reference\s+path\s*=/.test(source.slice(i, stop))) {
        out += source.slice(i, stop);
      }
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function declarationReferences(rawSource) {
  const source = stripComments(rawSource);
  const references = new Set();
  const fromPattern = /\bfrom\s*(['"])([^'"]+)\1/g;
  const sideEffectImportPattern = /\bimport\s*(['"])([^'"]+)\1/g;
  const importTypePattern = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  const referencePathPattern = /\/\/\/\s*<reference\s+path\s*=\s*(['"])([^'"]+)\1/g;
  for (const pattern of [fromPattern, sideEffectImportPattern, importTypePattern, requirePattern]) {
    for (const match of source.matchAll(pattern)) references.add(match[2]);
  }
  // `/// <reference path>` is file-relative even when written bare (`foo.d.ts`),
  // unlike module specifiers, so normalize it to a relative form to keep it in the graph.
  for (const match of source.matchAll(referencePathPattern)) {
    const target = match[2];
    references.add(target.startsWith('.') || path.isAbsolute(target) ? target : `./${target}`);
  }
  return [...references].sort(compareStrings);
}

function declarationCandidates(target) {
  if (/\.d\.(?:ts|mts|cts)$/.test(target)) return [target];
  if (target.endsWith('.mjs')) return [target.replace(/\.mjs$/, '.d.mts')];
  if (target.endsWith('.cjs')) return [target.replace(/\.cjs$/, '.d.cts')];
  if (target.endsWith('.js')) return [target.replace(/\.js$/, '.d.ts')];
  return [
    `${target}.d.ts`,
    `${target}.d.mts`,
    `${target}.d.cts`,
    path.join(target, 'index.d.ts'),
    path.join(target, 'index.d.mts'),
    path.join(target, 'index.d.cts'),
  ];
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

async function resolveInside(root, candidate, label) {
  const actual = await realpath(candidate);
  if (!isInside(root, actual)) throw new Error(`${label} resolves outside package root`);
  return actual;
}

async function resolveDeclaration(root, containingFile, specifier) {
  const unresolved = path.resolve(path.dirname(containingFile), specifier);
  if (!isInside(root, unresolved))
    throw new Error(`declaration import escapes package root: ${specifier}`);
  for (const candidate of declarationCandidates(unresolved)) {
    try {
      return await resolveInside(root, candidate, `declaration import ${specifier}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`cannot resolve package declaration import ${specifier}`);
}

async function declarationGraph(root, entry) {
  const pending = [entry];
  const seen = new Set();
  const graph = [];
  while (pending.length > 0) {
    const current = pending.shift();
    const actual = await resolveInside(root, current, 'declaration');
    if (seen.has(actual)) continue;
    seen.add(actual);
    const bytes = await readFile(actual);
    graph.push({
      path: `./${path.relative(root, actual).split(path.sep).join('/')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const source = bytes.toString('utf8');
    for (const reference of declarationReferences(source)) {
      if (reference.startsWith('.'))
        pending.push(await resolveDeclaration(root, actual, reference));
    }
  }
  graph.sort((a, b) => compareStrings(a.path, b.path));
  return graph;
}

function canonicalExportMap(value) {
  if (typeof value === 'string') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, canonicalExportMap(child)]),
  );
}

async function makeReport(root = ROOT) {
  root = await realpath(path.resolve(root));
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (!pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
    throw new Error('package.json must declare an exports object');
  }

  const entries = [];
  for (const [specifier, exportValue] of Object.entries(pkg.exports).sort(([a], [b]) =>
    compareStrings(a, b),
  )) {
    const targets = collectTargets(exportValue);
    const reportedTargets = [];
    for (const { conditions, target } of targets) {
      if (!target.startsWith('./') || target.includes('..')) {
        throw new Error(`${specifier} has an unsafe or non-relative target: ${target}`);
      }
      const jsPath = path.resolve(root, target);
      if (!isInside(root, jsPath)) throw new Error(`${specifier} target escapes package root`);
      await resolveInside(root, jsPath, `${specifier} target`);
      const declaration = declarationPath(target);
      const declarationFile = path.resolve(root, declaration);
      if (!isInside(root, declarationFile))
        throw new Error(`${specifier} declaration escapes package root`);
      reportedTargets.push({
        conditions,
        target,
        declaration,
        declarationGraph: await declarationGraph(root, declarationFile),
      });
    }
    if (targets.length === 0) throw new Error(`${specifier} has no targets`);
    entries.push({
      specifier,
      exportMap: canonicalExportMap(exportValue),
      targets: reportedTargets,
    });
  }

  entries.sort((a, b) => compareStrings(a.specifier, b.specifier));
  return { schemaVersion: 1, package: pkg.name, entries };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const report = await makeReport();
    if (options.draft) {
      process.stdout.write(
        stableJson({
          ...report,
          draft: true,
          baselineStatus: 'not-established',
        }),
      );
      return;
    }

    let baseline;
    try {
      baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new Error(
          `baseline is missing (${path.relative(ROOT, options.baseline)}); use --draft until all public API integrations land`,
        );
      throw error;
    }
    if (stableJson(baseline) !== stableJson(report)) {
      process.stdout.write(stableJson(report));
      throw new Error('public API report differs from baseline');
    }
    process.stdout.write('api-report: public API matches baseline\n');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export { makeReport, parseArgs };
