#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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

function collectTargets(value, targets) {
  if (typeof value === 'string') {
    targets.add(value);
    return;
  }
  if (Array.isArray(value)) throw new Error('array export targets are unsupported');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectTargets(child, targets);
    return;
  }
  throw new Error('package export contains an unsupported target value');
}

function declarationPath(target) {
  if (target.endsWith('.d.ts')) return target;
  if (/\.(?:[cm]?js)$/.test(target)) return target.replace(/\.(?:[cm]?js)$/, '.d.ts');
  throw new Error(`export target has no supported declaration mapping: ${target}`);
}

async function makeReport(root = ROOT) {
  root = path.resolve(root);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (!pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
    throw new Error('package.json must declare an exports object');
  }

  const entries = [];
  for (const [specifier, exportValue] of Object.entries(pkg.exports).sort(([a], [b]) =>
    compareStrings(a, b),
  )) {
    const targets = new Set();
    collectTargets(exportValue, targets);
    for (const target of targets) {
      if (!target.startsWith('./') || target.includes('..')) {
        throw new Error(`${specifier} has an unsafe or non-relative target: ${target}`);
      }
      const jsPath = path.resolve(root, target);
      if (!jsPath.startsWith(`${root}${path.sep}`))
        throw new Error(`${specifier} target escapes package root`);
      await readFile(jsPath);
      const declaration = declarationPath(target);
      const declarationFile = path.resolve(root, declaration);
      if (!declarationFile.startsWith(`${root}${path.sep}`))
        throw new Error(`${specifier} declaration escapes package root`);
      const declarationBytes = await readFile(declarationFile);
      entries.push({
        specifier,
        target,
        declaration,
        declarationSha256: createHash('sha256').update(declarationBytes).digest('hex'),
      });
    }
    if (targets.size === 0) throw new Error(`${specifier} has no targets`);
  }

  entries.sort(
    (a, b) => compareStrings(a.specifier, b.specifier) || compareStrings(a.target, b.target),
  );
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
        stableJson({ ...report, draft: true, baselineStatus: 'not-established' }),
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
