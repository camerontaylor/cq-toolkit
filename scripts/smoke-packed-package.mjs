#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@camerontaylor/cq-toolkit';

function usage() {
  return [
    'Usage: node scripts/smoke-packed-package.mjs --tarball <path> --sha256 <hex> --version <semver>',
    '',
    'Installs the exact tarball into an isolated temporary consumer with npm offline,',
    'checks its identity and every declared public export, then runs cq --help.',
  ].join('\n');
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return { help: true };
    if (!['--tarball', '--sha256', '--version'].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    values.set(name, value);
    index += 1;
  }
  for (const name of ['--tarball', '--sha256', '--version']) {
    if (!values.has(name)) throw new Error(`Missing required argument: ${name}`);
  }
  const sha256 = values.get('--sha256');
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('--sha256 must be 64 hexadecimal characters');
  const version = values.get('--version');
  const identifier = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
  const versionPattern = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier})(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  );
  if (!versionPattern.test(version)) {
    throw new Error('--version must be an exact semantic version');
  }
  return { tarball: values.get('--tarball'), sha256: sha256.toLowerCase(), version };
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? 'without a status'}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const RUNTIME_CONDITIONS = new Set(['node', 'import', 'default']);

function resolveEsmExportTarget(value, key) {
  if (typeof value === 'string') return value;
  if (value === null) throw new Error(`Export ${key} is disabled for Node ESM consumers`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid export target for ${key}`);
  }
  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'types') continue;
    if (RUNTIME_CONDITIONS.has(condition)) return resolveEsmExportTarget(target, key);
  }
  throw new Error(`No Node ESM runtime target for export ${key}`);
}

function exportSpecifier(key) {
  if (key === '.') return PACKAGE_NAME;
  if (!key.startsWith('./') || key.slice(2).includes('*')) {
    throw new Error(`Export ${key} is not a concrete, auditable package subpath`);
  }
  return `${PACKAGE_NAME}/${key.slice(2)}`;
}

function assertNoLocalDependencySpecs(manifest) {
  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`Invalid ${field} map in package manifest`);
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== 'string') throw new Error(`Invalid ${field} spec for ${name}`);
      if (/^(?:file:|link:|workspace:|\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(spec)) {
        throw new Error(`Local dependency spec is not allowed: ${field}.${name}=${spec}`);
      }
    }
  }
}

function validatePackageManifest(manifest, expectedVersion) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Packed package manifest must be an object');
  }
  if (manifest.name !== PACKAGE_NAME) throw new Error(`Packed package identity mismatch: ${manifest.name}`);
  if (manifest.version !== expectedVersion) {
    throw new Error(`Packed version mismatch: expected ${expectedVersion}, got ${manifest.version}`);
  }
  assertNoLocalDependencySpecs(manifest);
  return manifest;
}

function readPackedManifest(tarballPath, runCommand = run) {
  const files = runCommand('tar', ['-tzf', tarballPath]).split(/\r?\n/);
  const manifests = files.filter((file) => file === 'package/package.json');
  if (manifests.length !== 1) {
    throw new Error(`Tarball must contain exactly one package/package.json (found ${manifests.length})`);
  }
  const content = runCommand('tar', ['-xOzf', tarballPath, 'package/package.json']);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Tarball package/package.json is invalid JSON: ${error.message}`);
  }
}

async function auditInstalledPackage(consumerDir, expectedVersion, runCommand = run) {
  const packageDir = path.join(consumerDir, 'node_modules', ...PACKAGE_NAME.split('/'));
  const manifest = validatePackageManifest(JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8')), expectedVersion);

  const exportsMap = manifest.exports;
  if (!exportsMap || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    throw new Error('Package must declare an object exports map');
  }
  if (!Object.hasOwn(exportsMap, '.')) throw new Error('Package exports map is missing the required root export (.)');
  const specifiers = Object.keys(exportsMap).map(exportSpecifier);
  if (specifiers.length === 0) throw new Error('Package exports map is empty');

  for (const key of Object.keys(exportsMap)) {
    const target = resolveEsmExportTarget(exportsMap[key], key);
    if (!target.startsWith('./') || target.includes('*')) {
      throw new Error(`Export ${key} must resolve to a concrete package-relative target`);
    }
    const targetPath = path.resolve(packageDir, target);
    const realTarget = await realpath(targetPath);
    const realPackage = await realpath(packageDir);
    if (!realTarget.startsWith(`${realPackage}${path.sep}`)) {
      throw new Error(`Export ${key} escapes the installed package`);
    }
    if (!(await stat(realTarget)).isFile()) throw new Error(`Export ${key} does not target a file`);
  }

  const probePath = path.join(consumerDir, 'smoke-exports.mjs');
  const source = specifiers.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n');
  await writeFile(probePath, `${source}\n`, 'utf8');
  runCommand(process.execPath, [probePath], { cwd: consumerDir });

  if (!manifest.bin || typeof manifest.bin !== 'object' || typeof manifest.bin.cq !== 'string') {
    throw new Error('Package is missing the required cq executable');
  }
  const binTarget = path.resolve(packageDir, manifest.bin.cq);
  const realBin = await realpath(binTarget);
  const realPackage = await realpath(packageDir);
  if (!realBin.startsWith(`${realPackage}${path.sep}`) || !(await stat(realBin)).isFile()) {
    throw new Error('cq executable must resolve to a file inside the installed package');
  }
  const executable = path.join(consumerDir, 'node_modules', '.bin', process.platform === 'win32' ? 'cq.cmd' : 'cq');
  const help = runCommand(executable, ['--help'], { cwd: consumerDir, shell: process.platform === 'win32' });
  if (!help.trim()) throw new Error('cq --help completed without output');
}

async function main(argv, { runCommand = run } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const tarball = await realpath(path.resolve(options.tarball));
  if (!(await stat(tarball)).isFile()) throw new Error(`Tarball is not a file: ${tarball}`);
  const actualHash = await sha256File(tarball);
  if (actualHash !== options.sha256) {
    throw new Error(`Tarball SHA-256 mismatch: expected ${options.sha256}, got ${actualHash}`);
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), 'cq-packed-consumer-'));
  try {
    const consumerDir = path.join(scratchDir, 'consumer');
    const auditedTarball = path.join(scratchDir, 'audited-package.tgz');
    await copyFile(tarball, auditedTarball);
    if ((await sha256File(auditedTarball)) !== options.sha256) {
      throw new Error('Tarball changed while preparing the isolated consumer');
    }
    validatePackageManifest(readPackedManifest(auditedTarball, runCommand), options.version);
    await mkdir(consumerDir);
    await writeFile(path.join(consumerDir, 'package.json'), '{"private":true,"type":"module"}\n');
    runCommand('npm', [
      'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=false', '--no-save', auditedTarball,
    ], { cwd: consumerDir, env: { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' } });
    await auditInstalledPackage(consumerDir, options.version, runCommand);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
  process.stdout.write(`Packed consumer smoke passed for ${PACKAGE_NAME}@${options.version} (${actualHash}).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`packed consumer smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export {
  assertNoLocalDependencySpecs,
  auditInstalledPackage,
  main,
  parseArgs,
  readPackedManifest,
  resolveEsmExportTarget,
  sha256File,
  validatePackageManifest,
};
