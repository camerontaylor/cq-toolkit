import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const testApi = process.env.NODE_TEST_CONTEXT ? await import('node:test') : await import('vitest');
const { afterEach, describe, it } = testApi;
import {
  main,
  parseArgs,
  readPackedManifest,
  resolveEsmExportTarget,
  sha256File,
  validatePackageManifest,
} from '../scripts/smoke-packed-package.mjs';

const PACKAGE_NAME = '@camerontaylor/cq-toolkit';
const VERSION = '0.2.0';
const scratchDirs = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeScratchDir() {
  const directory = await mkdtemp(path.join(tmpdir(), 'cq-pack-smoke-test-'));
  scratchDirs.push(directory);
  return directory;
}

async function makeTarball(directory, manifest) {
  const packageDir = path.join(directory, 'package');
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest)}\n`);
  const tarball = path.join(directory, 'candidate.tgz');
  const result = spawnSync('tar', ['-czf', tarball, '-C', directory, 'package'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `tar exited ${result.status}`);
  return tarball;
}

function createFakeInstalledPackage(consumerDir, manifest) {
  const packageDir = path.join(consumerDir, 'node_modules', ...PACKAGE_NAME.split('/'));
  const binDir = path.join(consumerDir, 'node_modules', '.bin');
  mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest)}\n`);
  for (const target of Object.values(manifest.exports)) {
    const file = target.import ?? target;
    const targetPath = path.join(packageDir, file.slice(2));
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, 'export const packedSmoke = true;\n');
  }
  const binTarget = path.join(packageDir, manifest.bin.cq);
  mkdirSync(path.dirname(binTarget), { recursive: true });
  writeFileSync(binTarget, '#!/usr/bin/env node\nprocess.stdout.write("cq help\\n");\n');
  chmodSync(binTarget, 0o755);
  symlinkSync(binTarget, path.join(binDir, 'cq'));
}

function validManifest(overrides = {}) {
  return {
    name: PACKAGE_NAME,
    version: VERSION,
    type: 'module',
    exports: {
      '.': './dist/index.js',
      './ops': './dist/ops.js',
    },
    bin: { cq: './dist/cli.js' },
    ...overrides,
  };
}

describe('packed package smoke', () => {
  it('requires a tarball, exact digest, and exact version', () => {
    assert.throws(() => parseArgs([]), /Missing required argument: --tarball/);
    assert.throws(() => parseArgs(['--tarball', 'x.tgz', '--sha256', 'bad', '--version', VERSION]), /64 hexadecimal characters/);
    assert.throws(() => parseArgs(['--tarball', 'x.tgz', '--sha256', 'a'.repeat(64), '--version', '^0.2.0']), /exact semantic version/);
  });

  it('checks packed identity and rejects local dependency specs before npm can run', async () => {
    const directory = await makeScratchDir();
    const tarball = await makeTarball(directory, validManifest({ dependencies: { escape: 'file:../outside' } }));
    const digest = await sha256File(tarball);
    const commands = [];
    const fakeRun = (command, args, options) => {
      commands.push(command);
      if (command === 'npm') throw new Error('npm must not run for a rejected manifest');
      return spawnSync(command, args, { encoding: 'utf8', ...options }).stdout;
    };

    await assert.rejects(main(['--tarball', tarball, '--sha256', digest, '--version', VERSION], { runCommand: fakeRun }), /Local dependency spec is not allowed/);
    assert(commands.includes('tar'));
    assert(!commands.includes('npm'));

    const wrongTarball = path.join(directory, 'wrong-identity.tgz');
    const wrongManifest = validManifest({ name: 'wrong-package' });
    const packageDir = path.join(directory, 'package');
    writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(wrongManifest)}\n`);
    const repacked = spawnSync('tar', ['-czf', wrongTarball, '-C', directory, 'package'], { encoding: 'utf8' });
    if (repacked.error) throw repacked.error;
    if (repacked.status !== 0) throw new Error(repacked.stderr || `tar exited ${repacked.status}`);
    const wrongIdentityCommands = [];
    const wrongIdentityRunner = (command, args, options) => {
      wrongIdentityCommands.push(command);
      if (command === 'npm') throw new Error('npm must not run for a wrong-identity package');
      return spawnSync(command, args, { encoding: 'utf8', ...options }).stdout;
    };
    await assert.rejects(
      main(['--tarball', wrongTarball, '--sha256', await sha256File(wrongTarball), '--version', VERSION], {
        runCommand: wrongIdentityRunner,
      }),
      /Packed package identity mismatch/,
    );
    assert(!wrongIdentityCommands.includes('npm'));
    assert.throws(() => validatePackageManifest(validManifest({ name: 'other-package' }), VERSION), /Packed package identity mismatch/);
    assert.throws(() => validatePackageManifest(validManifest(), '0.3.0'), /Packed version mismatch/);
  });

  it('reads exactly one manifest from the tarball', async () => {
    const directory = await makeScratchDir();
    const tarball = await makeTarball(directory, validManifest());
    assert.deepEqual(readPackedManifest(tarball), validManifest());
  });

  it('selects and checks the Node ESM export branch', () => {
    assert.equal(resolveEsmExportTarget({
      types: './types/index.d.ts',
      node: { require: './dist/index.cjs', import: './dist/index.js' },
      default: './fallback.js',
    }, '.'), './dist/index.js');
    assert.throws(() => resolveEsmExportTarget({ require: './dist/index.cjs' }, '.'), /No Node ESM runtime target/);
  });

  it('imports every public ESM export, runs the installed CLI, and cleans its consumer', async () => {
    const directory = await makeScratchDir();
    const manifest = validManifest();
    const tarball = await makeTarball(directory, manifest);
    const digest = await sha256File(tarball);
    let consumerDir;
    let npmArgs;
    const commands = [];
    const fakeRun = (command, args, options = {}) => {
      commands.push({ command, args });
      if (command === 'npm') {
        npmArgs = args;
        consumerDir = options.cwd;
        createFakeInstalledPackage(consumerDir, manifest);
        return '';
      }
      const result = spawnSync(command, args, { encoding: 'utf8', ...options });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
      return result.stdout;
    };

    await main(['--tarball', tarball, '--sha256', digest, '--version', VERSION], { runCommand: fakeRun });
    assert(npmArgs.includes('--offline'));
    assert(npmArgs.includes('--ignore-scripts'));
    assert.equal(commands.filter(({ command, args }) => command === process.execPath && args[0].endsWith('smoke-exports.mjs')).length, 1);
    assert.equal(commands.filter(({ command, args }) => /[\\/]cq(?:\.cmd)?$/.test(command) && args[0] === '--help').length, 1);
    await assert.rejects(lstat(consumerDir), { code: 'ENOENT' });
  });
});
