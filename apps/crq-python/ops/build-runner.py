#!/usr/bin/env python3
"""Build, stage, package and verify the CRQ runner from a locked clean checkout.

The route is deliberately narrow and offline:

1. require a clean checkout whose HEAD is the requested full commit SHA and
   whose packageManager pin names a full pnpm version;
2. run `pnpm install --frozen-lockfile --offline` with an isolated project
   virtual store, then `pnpm rebuild fs-ext` and `pnpm run build`;
3. deploy the production tree with `pnpm deploy --prod --offline`;
4. re-check HEAD, the tracked tree and the lockfile digest;
5. record provenance from the actual staging tree (source, lockfile, Node
   version and ABI, pnpm version, platform, staged dependency versions, fs-ext
   digest and ELF header) and hand it to `package-runner.py`;
6. verify the extracted archive, including a real fs-ext load plus flock
   contention smoke and a runner-entry smoke.

The provenance is a record of the inputs and the staged bytes, not a
cryptographic attestation. The archive, sidecar and manifest are integrity
records; a self-consistent manifest can be rewritten with the archive. This
route does not switch a production unit or authorize a cutover.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

EXPECTED_NODE_MAJOR = 24
EXPECTED_PLATFORM = 'linux'
EXPECTED_ARCH = 'x64'
PACKAGE_MANAGER_RE = re.compile(r'pnpm@(\d+\.\d+\.\d+)')
NODE_VERSION_RE = re.compile(r'v(\d+)\.\d+\.\d+')
VERSION_RE = re.compile(r'\d+\.\d+\.\d+')
SHA_RE = re.compile(r'[0-9a-f]{40}')
OUTPUT_TAIL = 8000
COMMAND_TIMEOUT = 1800
DEPLOY_COMPAT_ERRORS = ('ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE',
                        'inject-workspace-packages')

_PACKAGER = None


class BuildError(RuntimeError):
    """A checkout, toolchain, command or staged tree violates the route."""


def _packager():
    global _PACKAGER
    if _PACKAGER is None:
        path = Path(__file__).with_name('package-runner.py')
        spec = importlib.util.spec_from_file_location('package_runner', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _PACKAGER = module
    return _PACKAGER


def _tail(text):
    return text[-OUTPUT_TAIL:] if len(text) > OUTPUT_TAIL else text


def run_command(argv, cwd, env=None, timeout=COMMAND_TIMEOUT):
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, check=False,
                                capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise BuildError('command not found: ' + argv[0]) from exc
    except subprocess.TimeoutExpired as exc:
        raise BuildError('command timed out after ' + str(timeout) + 's: '
                         + shlex.join(argv)) from exc
    if result.returncode != 0:
        detail = ['command failed (' + str(result.returncode) + '): ' + shlex.join(argv)]
        if result.stdout:
            detail.append('stdout tail:\n' + _tail(result.stdout))
        if result.stderr:
            detail.append('stderr tail:\n' + _tail(result.stderr))
        raise BuildError('\n'.join(detail))
    return result


def _git(repo, *args, run=run_command):
    return run(['git', '-C', str(repo), *args], cwd=repo).stdout.strip()


def _lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def lockfile_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def validate_checkout(repo, sha, run=run_command):
    repo = Path(repo).resolve(strict=True)
    if not repo.is_dir():
        raise BuildError('repo must be a directory')
    if not SHA_RE.fullmatch(sha):
        raise BuildError('source identity must be a full commit SHA')
    if Path(_git(repo, 'rev-parse', '--show-toplevel', run=run)).resolve() != repo:
        raise BuildError('repo must be the full checkout root')
    head = _git(repo, 'rev-parse', 'HEAD', run=run)
    if head != sha:
        raise BuildError('checkout HEAD ' + head + ' does not match the requested ' + sha)
    status = _git(repo, 'status', '--porcelain', '--untracked-files=normal', run=run)
    if status:
        raise BuildError('checkout is not clean:\n' + status)
    package_path = repo / 'package.json'
    lockfile = repo / 'pnpm-lock.yaml'
    if not package_path.is_file() or not lockfile.is_file():
        raise BuildError('checkout lacks package.json or pnpm-lock.yaml')
    try:
        package = json.loads(package_path.read_text())
    except (OSError, ValueError) as exc:
        raise BuildError('package.json is unreadable') from exc
    match = PACKAGE_MANAGER_RE.fullmatch(str(package.get('packageManager', '')))
    if match is None:
        raise BuildError('package.json packageManager must pin pnpm@x.y.z')
    return {'repo': repo, 'sha': sha, 'lockfile': lockfile,
            'package_manager': match.group(1)}


def _runtime_facts(node, env, run=run_command, cwd=None):
    result = run([node, '-p',
                  "JSON.stringify({platform:process.platform,arch:process.arch,modules:process.versions.modules})"],
                 cwd=cwd, env=env)
    lines = _lines(result.stdout)
    if not lines:
        raise BuildError('node runtime probe emitted no JSON')
    try:
        facts = json.loads(lines[-1])
    except ValueError as exc:
        raise BuildError('node runtime probe emitted invalid JSON') from exc
    if not isinstance(facts, dict):
        raise BuildError('node runtime probe must emit an object')
    if facts.get('platform') != EXPECTED_PLATFORM or facts.get('arch') != EXPECTED_ARCH:
        raise BuildError('build host must be ' + EXPECTED_PLATFORM + '-' + EXPECTED_ARCH)
    modules = facts.get('modules')
    if not isinstance(modules, str) or not modules.isdigit():
        raise BuildError('node runtime probe must report a numeric ABI')
    return {'platform': facts['platform'], 'arch': facts['arch'], 'node_abi': modules}


def tool_versions(repo, node='node', pnpm='pnpm', env=None, run=run_command):
    node_lines = _lines(run([node, '--version'], cwd=repo, env=env).stdout)
    pnpm_lines = _lines(run([pnpm, '--version'], cwd=repo, env=env).stdout)
    if not node_lines or not pnpm_lines:
        raise BuildError('node or pnpm version probe emitted nothing')
    node_version = node_lines[-1]
    pnpm_version = pnpm_lines[-1]
    match = NODE_VERSION_RE.fullmatch(node_version)
    if match is None:
        raise BuildError('node must report a full version, got ' + node_version)
    node_major = int(match.group(1))
    if node_major != EXPECTED_NODE_MAJOR:
        raise BuildError('node major must be ' + str(EXPECTED_NODE_MAJOR))
    if not VERSION_RE.fullmatch(pnpm_version):
        raise BuildError('pnpm must report a full version, got ' + pnpm_version)
    facts = _runtime_facts(node, env, run=run, cwd=repo)
    return {'node_version': node_version, 'node_major': node_major,
            'pnpm_version': pnpm_version, **facts}


def build_env(node='node', pnpm='pnpm'):
    env = os.environ.copy()
    paths = []
    for tool in (node, pnpm):
        if os.sep in tool:
            paths.append(str(Path(tool).resolve().parent))
    if paths:
        env['PATH'] = os.pathsep.join(paths + [env.get('PATH', '')])
    env.update({'CI': '1', 'PNPM_CONFIG_VIRTUAL_STORE_TYPE': 'project',
                'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'})
    return env


def _deploy_compat_error(error):
    text = str(error)
    return any(token in text for token in DEPLOY_COMPAT_ERRORS)


def deploy(repo, staging, pnpm, env, run=run_command):
    help_text = run([pnpm, 'deploy', '--help'], cwd=repo, env=env).stdout
    supports_legacy = '--legacy' in help_text
    base = [pnpm, 'deploy', '--prod', '--offline']
    command = base + [str(staging)]
    try:
        run(command, cwd=repo, env=env)
    except BuildError as exc:
        if not supports_legacy or not _deploy_compat_error(exc):
            raise
        if staging.exists():
            contents = list(staging.iterdir())
            if contents:
                raise BuildError('deploy failed after writing to staging; '
                                 'refusing a legacy retry') from exc
            staging.rmdir()
        command = base + ['--legacy', str(staging)]
        run(command, cwd=repo, env=env)
    return command


def provenance_for(sha, lockfile_sha, versions, facts, commands):
    return {'schema_version': 1,
            'source_sha': sha,
            'lockfile_sha256': lockfile_sha,
            'runtime': {'node_version': versions['node_version'],
                        'node_major': versions['node_major'],
                        'node_abi': versions['node_abi'],
                        'platform': versions['platform'],
                        'arch': versions['arch']},
            'toolchain': {'pnpm_version': versions['pnpm_version'],
                          'install_command': commands['install'],
                          'build_command': commands['build'],
                          'deploy_command': commands['deploy'],
                          'virtual_store_type': 'project',
                          'ci': '1'},
            'dependencies': facts['dependencies'],
            'fs_ext': facts['fs_ext']}


def _check_unchanged(checkout, lockfile_sha, run=run_command):
    head = _git(checkout['repo'], 'rev-parse', 'HEAD', run=run)
    if head != checkout['sha']:
        raise BuildError('build moved HEAD from ' + checkout['sha'] + ' to ' + head)
    status = _git(checkout['repo'], 'status', '--porcelain', '--untracked-files=normal',
                  run=run)
    if status:
        raise BuildError('build changed the tracked tree:\n' + status)
    if lockfile_digest(checkout['lockfile']) != lockfile_sha:
        raise BuildError('build changed the lockfile')


def build(repo, sha, staging, output, node='node', pnpm='pnpm',
          run=run_command, keep_staging=False):
    checkout = validate_checkout(repo, sha, run=run)
    env = build_env(node=node, pnpm=pnpm)
    versions = tool_versions(checkout['repo'], node=node, pnpm=pnpm, env=env, run=run)
    if versions['pnpm_version'] != checkout['package_manager']:
        raise BuildError('pnpm ' + versions['pnpm_version'] + ' does not match the '
                         'packageManager pin ' + checkout['package_manager']
                         + '; use the pinned corepack shim or --pnpm')
    staging = Path(staging).resolve()
    output = Path(output).resolve()
    if staging.exists():
        raise BuildError('staging path already exists: ' + str(staging))
    if staging.is_relative_to(checkout['repo']):
        raise BuildError('staging must be outside the source checkout')
    if output.is_relative_to(checkout['repo']):
        raise BuildError('output must be outside the source checkout')
    provenance_path = output.with_name(output.name + '.provenance.json')
    for path in (output, provenance_path, output.with_name(output.name + '.sha256')):
        if path.exists():
            raise BuildError('refusing to overwrite ' + str(path))
    staging.parent.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    lockfile_sha = lockfile_digest(checkout['lockfile'])
    install = [pnpm, 'install', '--frozen-lockfile', '--offline']
    rebuild = [pnpm, 'rebuild', 'fs-ext']
    compile_runner = [pnpm, 'run', 'build']
    run(install, cwd=checkout['repo'], env=env)
    run(rebuild, cwd=checkout['repo'], env=env)
    run(compile_runner, cwd=checkout['repo'], env=env)
    deploy_command = deploy(checkout['repo'], staging, pnpm, env, run=run)
    if not staging.is_dir():
        raise BuildError('deploy did not create the staging directory')
    _check_unchanged(checkout, lockfile_sha, run=run)
    packager = _packager()
    for required in packager.REQUIRED_ENTRIES:
        if not (staging / required).is_file():
            raise BuildError('staging tree lacks ' + required)
    facts = packager.staging_facts(staging)
    commands = {'install': shlex.join(install), 'build': shlex.join(compile_runner),
                'deploy': shlex.join(deploy_command)}
    provenance = provenance_for(sha, lockfile_sha, versions, facts, commands)
    with provenance_path.open('x') as stream:
        stream.write(json.dumps(provenance, sort_keys=True, indent=2) + '\n')
    manifest = packager.package(staging, output, sha, provenance,
                                lockfile=checkout['lockfile'])
    report = packager.verify_archive(output, expected_sha256=None,
                                     lockfile=checkout['lockfile'],
                                     smoke=True, node=node)
    report.update({'provenance_path': str(provenance_path),
                   'file_count': len(manifest['files'])})
    if keep_staging:
        report['staging'] = str(staging)
    else:
        shutil.rmtree(staging, ignore_errors=True)
    return report


def _machine_error(kind, subcommand, message, exit_code):
    """One JSON error artifact on stdout; stderr stays empty (doctrine I1)."""
    artifact = {'error': {'kind': kind, 'subcommand': subcommand,
                          'message': message, 'exitCode': exit_code}}
    sys.stdout.write(json.dumps(artifact, sort_keys=True, indent=2) + '\n')
    raise SystemExit(exit_code)


class _MachineArgumentParser(argparse.ArgumentParser):
    """Argument parser whose usage errors honor machine mode (doctrine I1).

    `--json` is detected in argv before parsing; in machine mode an argparse
    usage error writes one JSON error artifact to stdout, keeps stderr empty
    and exits 2 instead of narrating on stderr.
    """

    def __init__(self, *args, machine=False, subcommand=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._machine = machine
        self._subcommand = subcommand

    def error(self, message):
        if self._machine:
            _machine_error('usage', self._subcommand, message, 2)
        super().error(message)


def main():
    machine = '--json' in sys.argv[1:]
    parser = _MachineArgumentParser(description=__doc__, machine=machine,
                                    subcommand='build-runner')
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--staging', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--pnpm', default='pnpm')
    parser.add_argument('--keep-staging', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    try:
        report = build(args.repo, args.sha, args.staging, args.output,
                       node=args.node, pnpm=args.pnpm,
                       keep_staging=args.keep_staging)
        data = json.dumps(report, sort_keys=True, indent=2) + '\n'
        if args.report is not None:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(data)
    except (BuildError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        if machine:
            _machine_error('thrown', 'build-runner', str(exc), 1)
        parser.exit(1, 'build-runner: ' + str(exc) + '\n')
    sys.stdout.write(data)
    if not args.json:
        print('archive ' + report['archive_sha256'] + ' ' + report['archive'],
              file=sys.stderr)
        print('source ' + report['source_sha'] + ' content ' + report['content_sha256']
              + ' files ' + str(report['file_count']), file=sys.stderr)
        print('provenance ' + report['provenance_path'], file=sys.stderr)
        if report['observed'] is not None:
            print('fs-ext ' + report['observed']['fsExt'] + ' Node '
                  + report['observed']['node'] + ' ABI '
                  + report['observed']['modules'] + ' flock ok', file=sys.stderr)
        if report['runner'] is not None:
            print('runner exit ' + str(report['runner']['exit_code']) + ' status '
                  + report['runner']['status'], file=sys.stderr)
        if 'staging' in report:
            print('staging ' + report['staging'], file=sys.stderr)


if __name__ == '__main__':
    main()
