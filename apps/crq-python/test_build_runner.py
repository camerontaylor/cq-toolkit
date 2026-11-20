"""Locked build/staging route tests; no real pnpm, network or host mutation."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    'build_runner', Path(__file__).parent / 'ops/build-runner.py')
build_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_runner)

ELF = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'
SHA = 'a' * 40


class Result:
    def __init__(self, stdout='', stderr='', returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class FakeRun:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, argv, cwd=None, env=None, timeout=None):
        self.calls.append(list(argv))
        result = self.handler(argv, cwd, env)
        if isinstance(result, Exception):
            raise result
        return result


def checkout_handler(repo, sha=SHA, status='', node_version='v24.21.0',
                     pnpm_version='12.8.1', abi='137', deploy=None, state=None):
    state = state if state is not None else {'status': status}

    def handler(argv, cwd, env):
        if argv[0] == 'git':
            args = argv[3:]
            if args == ['rev-parse', '--show-toplevel']:
                return Result(str(repo))
            if args == ['rev-parse', 'HEAD']:
                return Result(sha)
            if args == ['rev-parse', '--absolute-git-dir']:
                return Result(str(repo / '.git'))
            if args == ['status', '--porcelain', '--untracked-files=normal']:
                return Result(state['status'])
            raise AssertionError('unexpected git command: ' + repr(argv))
        if argv[0] == 'node':
            if argv[1] == '--version':
                return Result(node_version)
            if argv[1] == '-p':
                return Result(json.dumps({'platform': 'linux', 'arch': 'x64',
                                          'modules': abi}))
            raise AssertionError('unexpected node command: ' + repr(argv))
        if argv[0] == 'pnpm':
            if argv[1] == '--version':
                return Result(pnpm_version)
            if argv[1] == 'deploy' and argv[2] == '--help':
                return Result('--legacy\n')
            if argv[1] in ('install', 'rebuild', 'run'):
                return Result()
            if argv[1] == 'deploy' and deploy is not None:
                return deploy(argv)
            raise AssertionError('unexpected pnpm command: ' + repr(argv))
        raise AssertionError('unexpected command: ' + repr(argv))

    return handler, state


class BuildRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        (self.repo / 'package.json').write_text(
            json.dumps({'packageManager': 'pnpm@12.8.1'}))
        (self.repo / 'pnpm-lock.yaml').write_text('lockfileVersion: 9.0\n')
        (self.repo / '.git').mkdir()

    def fake(self, **kwargs):
        handler, state = checkout_handler(self.repo, **kwargs)
        return FakeRun(handler), state

    def test_validate_checkout_accepts_clean_head(self):
        run, _ = self.fake()
        checkout = build_runner.validate_checkout(self.repo, SHA, run=run)
        self.assertEqual(checkout['sha'], SHA)
        self.assertEqual(checkout['package_manager'], '12.8.1')

    def test_validate_checkout_rejects_dirty_tree(self):
        run, _ = self.fake(status=' M package.json')
        with self.assertRaisesRegex(build_runner.BuildError, 'not clean'):
            build_runner.validate_checkout(self.repo, SHA, run=run)

    def test_validate_checkout_rejects_sha_mismatch(self):
        run, _ = self.fake(sha='b' * 40)
        with self.assertRaisesRegex(build_runner.BuildError, 'does not match'):
            build_runner.validate_checkout(self.repo, SHA, run=run)

    def test_validate_checkout_rejects_unpinned_package_manager(self):
        (self.repo / 'package.json').write_text(json.dumps({'packageManager': 'pnpm'}))
        run, _ = self.fake()
        with self.assertRaisesRegex(build_runner.BuildError, 'packageManager'):
            build_runner.validate_checkout(self.repo, SHA, run=run)

    def test_tool_versions_rejects_wrong_node_major(self):
        run, _ = self.fake(node_version='v22.0.0')
        with self.assertRaisesRegex(build_runner.BuildError, 'node major'):
            build_runner.tool_versions(self.repo, env={}, run=run)

    def test_tool_versions_records_exact_runtime(self):
        run, _ = self.fake()
        versions = build_runner.tool_versions(self.repo, env={}, run=run)
        self.assertEqual(versions['node_version'], 'v24.21.0')
        self.assertEqual(versions['pnpm_version'], '12.8.1')
        self.assertEqual(versions['node_abi'], '137')
        self.assertEqual(versions['platform'], 'linux')
        self.assertEqual(versions['arch'], 'x64')

    def test_build_env_isolates_project_store(self):
        env = build_runner.build_env()
        self.assertEqual(env['PNPM_CONFIG_VIRTUAL_STORE_TYPE'], 'project')
        self.assertEqual(env['CI'], '1')

    def test_provenance_for_shape(self):
        facts = {'dependencies': {'fs-ext': '2.1.1'},
                 'fs_ext': {'version': '2.1.1', 'native_sha256': 'c' * 64,
                            'elf': {'class': 2, 'data': 1, 'machine': 62}}}
        versions = {'node_version': 'v24.21.0', 'node_major': 24, 'node_abi': '137',
                    'platform': 'linux', 'arch': 'x64', 'pnpm_version': '12.8.1'}
        provenance = build_runner.provenance_for(
            SHA, 'd' * 64, versions, facts,
            {'install': 'pnpm install', 'build': 'pnpm run build',
             'deploy': 'pnpm deploy'})
        self.assertEqual(provenance['schema_version'], 1)
        self.assertEqual(provenance['source_sha'], SHA)
        self.assertEqual(provenance['lockfile_sha256'], 'd' * 64)
        self.assertEqual(provenance['runtime']['node_abi'], '137')
        self.assertEqual(provenance['toolchain']['virtual_store_type'], 'project')
        self.assertEqual(provenance['dependencies'], {'fs-ext': '2.1.1'})

    def test_deploy_uses_default_and_records_command(self):
        staging = self.base / 'stage'
        run, _ = self.fake(deploy=lambda argv: Result())
        command = build_runner.deploy(self.repo, staging, 'pnpm', {}, run=run)
        self.assertEqual(command, ['pnpm', 'deploy', '--prod', '--offline', str(staging)])

    def test_deploy_retries_known_compat_error_before_staging_mutation(self):
        staging = self.base / 'stage'

        def deploy(argv):
            if '--legacy' in argv:
                return Result()
            return build_runner.BuildError('ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE')

        run, _ = self.fake(deploy=deploy)
        command = build_runner.deploy(self.repo, staging, 'pnpm', {}, run=run)
        self.assertIn('--legacy', command)
        self.assertTrue(any('--legacy' in call for call in run.calls))

    def test_deploy_refuses_legacy_after_staging_written(self):
        staging = self.base / 'stage'

        def deploy(argv):
            if '--legacy' in argv:
                return Result()
            staging.mkdir()
            (staging / 'partial').write_text('x')
            return build_runner.BuildError('ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE')

        run, _ = self.fake(deploy=deploy)
        with self.assertRaisesRegex(build_runner.BuildError, 'refusing a legacy retry'):
            build_runner.deploy(self.repo, staging, 'pnpm', {}, run=run)
        self.assertFalse(any('--legacy' in call for call in run.calls))

    def test_deploy_does_not_retry_arbitrary_error(self):
        staging = self.base / 'stage'

        def deploy(argv):
            return build_runner.BuildError('boom')

        run, _ = self.fake(deploy=deploy)
        with self.assertRaisesRegex(build_runner.BuildError, 'boom'):
            build_runner.deploy(self.repo, staging, 'pnpm', {}, run=run)
        self.assertFalse(any('--legacy' in call for call in run.calls))

    def test_build_refuses_a_checkout_another_build_owns(self):
        run, _ = self.fake()
        with build_runner._exclusive_checkout(self.repo, run=run):
            with self.assertRaisesRegex(build_runner.BuildError, 'another build owns'):
                build_runner.build(self.repo, SHA, self.base / 'stage',
                                   self.base / 'out/runner.tar.gz', run=run)
        self.assertTrue(all(call[3:] == ['rev-parse', '--absolute-git-dir']
                            for call in run.calls))
        # The lock is released on exit, so the checkout can be owned again.
        with build_runner._exclusive_checkout(self.repo, run=run):
            pass

    def test_lock_excludes_builds_with_different_temp_dirs(self):
        # Two real processes, each with its own TMPDIR, on one real checkout:
        # the lock must not follow the temp directory.
        repo = self.base / 'real'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        script = (
            'import importlib.util, sys\n'
            'spec = importlib.util.spec_from_file_location("b", sys.argv[1])\n'
            'b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)\n'
            'try:\n'
            '    with b._exclusive_checkout(sys.argv[2]):\n'
            '        print("acquired", flush=True); sys.stdin.read()\n'
            'except b.BuildError as error:\n'
            '    print("refused", error, flush=True)\n')
        runner = str(Path(__file__).parent / 'ops/build-runner.py')

        def spawn(name):
            tmp = self.base / name
            tmp.mkdir()
            env = dict(os.environ, TMPDIR=str(tmp), TEMP=str(tmp), TMP=str(tmp))
            return subprocess.Popen([sys.executable, '-c', script, runner, str(repo)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    text=True, env=env)

        holder = spawn('tmpA')
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'acquired')
            second = spawn('tmpB')
            out, _ = second.communicate(timeout=30)
            self.assertTrue(out.startswith('refused another build owns'), out)
        finally:
            holder.communicate(timeout=30)

    def test_run_command_timeout_kills_descendants_before_lock_release(self):
        # A timed-out command must not leave descendants that can write to the
        # checkout after the exclusive lock is released: record the PID of a
        # grandchild spawned by the command and require it to have exited while
        # the lock is still held, before run_command raises.
        repo = self.base / 'real'
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        record = self.base / 'descendant.pid'
        command = ['sh', '-c',
                   'sleep 30 & echo $! > ' + shlex.quote(str(record)) + '; wait']
        with build_runner._exclusive_checkout(repo):
            with self.assertRaisesRegex(build_runner.BuildError, 'timed out'):
                build_runner.run_command(command, cwd=repo, timeout=1)
            descendant = int(record.read_text())
            if sys.platform == 'linux':
                try:
                    stat = Path(f'/proc/{descendant}/stat').read_bytes()
                except (FileNotFoundError, ProcessLookupError):
                    pass
                else:
                    self.assertIn(stat.rsplit(b') ', 1)[1].split()[0], (b'Z', b'X'))
            else:
                with self.assertRaises(ProcessLookupError):
                    os.kill(descendant, 0)

    def test_run_command_interrupt_cleans_up_then_propagates(self):
        process = mock.MagicMock()
        interruption = KeyboardInterrupt()
        process.communicate.side_effect = interruption
        with mock.patch.object(build_runner.subprocess, 'Popen', return_value=process), \
                mock.patch.object(build_runner, '_kill_process_group') as cleanup:
            with self.assertRaises(KeyboardInterrupt) as caught:
                build_runner.run_command(['build'], cwd=self.repo)
        cleanup.assert_called_once_with(process)
        self.assertIs(caught.exception, interruption)

    def test_build_rejects_pnpm_pin_mismatch(self):
        run, _ = self.fake(pnpm_version='12.18.0')
        with self.assertRaisesRegex(build_runner.BuildError, 'packageManager pin'):
            build_runner.build(self.repo, SHA, self.base / 'stage',
                               self.base / 'out/runner.tar.gz', run=run)

    def test_build_runs_locked_route_and_removes_staging(self):
        staging = self.base / 'stage'
        output = self.base / 'out/runner.tar.gz'

        def deploy(argv):
            (staging / 'dist/queue-runner').mkdir(parents=True)
            (staging / 'dist/queue-runner/crq.js').write_text('runner')
            (staging / 'package.json').write_text('{"name":"runner"}')
            native = staging / 'node_modules/fs-ext/build/Release'
            native.mkdir(parents=True)
            (staging / 'node_modules/fs-ext/package.json').write_text(
                '{"name":"fs-ext","version":"2.1.1"}')
            (native / 'fs_ext.node').write_bytes(ELF)
            return Result()

        run, _ = self.fake(deploy=deploy)
        packager = build_runner._packager()
        fake_report = {'archive': str(output), 'archive_sha256': 'e' * 64,
                       'source_sha': SHA, 'content_sha256': 'f' * 64,
                       'file_count': 1, 'provenance': {}, 'observed': None,
                       'runner': None}
        with mock.patch.object(packager, 'verify_archive', return_value=fake_report):
            report = build_runner.build(self.repo, SHA, staging, output, run=run)
        self.assertTrue(output.is_file())
        self.assertTrue(Path(str(output) + '.sha256').is_file())
        provenance_path = Path(str(output) + '.provenance.json')
        self.assertTrue(provenance_path.is_file())
        self.assertEqual(json.loads(provenance_path.read_text())['source_sha'], SHA)
        self.assertEqual(report['provenance_path'], str(provenance_path))
        self.assertFalse(staging.exists())
        install = next(call for call in run.calls if call[:2] == ['pnpm', 'install'])
        self.assertIn('--frozen-lockfile', install)
        self.assertIn('--offline', install)

    def test_build_removes_a_stale_dist_directory_before_compile(self):
        stale = self.repo / 'dist' / 'removed-source.js'
        stale.parent.mkdir()
        stale.write_text('obsolete')
        inner, _ = self.fake(deploy=lambda argv: Result())
        seen = {}

        def run(argv, cwd=None, env=None, timeout=None):
            if argv[:3] == ['pnpm', 'run', 'build']:
                seen['dist_present'] = (self.repo / 'dist').exists()
                raise RuntimeError('stop after build')
            return inner(argv, cwd=cwd, env=env, timeout=timeout)

        with self.assertRaisesRegex(RuntimeError, 'stop after build'):
            build_runner.build(self.repo, SHA, self.base / 'stage',
                               self.base / 'out/runner.tar.gz', run=run)
        self.assertFalse(seen['dist_present'])

    def test_build_fails_when_stale_dist_cleanup_fails(self):
        (self.repo / 'dist').mkdir()
        run, _ = self.fake(deploy=lambda argv: Result())
        with mock.patch.object(build_runner.shutil, 'rmtree',
                               side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(build_runner.BuildError,
                                        'cannot remove stale dist/'):
                build_runner.build(self.repo, SHA, self.base / 'stage',
                                   self.base / 'out/runner.tar.gz', run=run)
        self.assertNotIn(['pnpm', 'run', 'build'], run.calls)

    def test_build_unlinks_a_stale_dist_symlink_without_touching_its_target(self):
        target = self.base / 'elsewhere'
        target.mkdir()
        (target / 'keep.txt').write_text('keep')
        (self.repo / 'dist').symlink_to(target, target_is_directory=True)
        inner, _ = self.fake(deploy=lambda argv: Result())
        seen = {}

        def run(argv, cwd=None, env=None, timeout=None):
            if argv[:3] == ['pnpm', 'run', 'build']:
                seen['dist_present'] = (self.repo / 'dist').is_symlink() or (
                    self.repo / 'dist').exists()
                raise RuntimeError('stop after build')
            return inner(argv, cwd=cwd, env=env, timeout=timeout)

        with self.assertRaisesRegex(RuntimeError, 'stop after build'):
            build_runner.build(self.repo, SHA, self.base / 'stage',
                               self.base / 'out/runner.tar.gz', run=run)
        self.assertFalse(seen['dist_present'])
        self.assertEqual((target / 'keep.txt').read_text(), 'keep')

    def test_build_rejects_staging_inside_checkout(self):
        run, _ = self.fake(deploy=lambda argv: Result())
        with self.assertRaisesRegex(build_runner.BuildError, 'outside the source checkout'):
            build_runner.build(self.repo, SHA, self.repo / 'stage',
                               self.base / 'out/runner.tar.gz', run=run)

    def test_build_rejects_dirty_tree_after_build(self):
        staging = self.base / 'stage'
        output = self.base / 'out/runner.tar.gz'
        state = {'status': ''}

        def deploy(argv):
            staging.mkdir()
            state['status'] = ' M package.json'
            return Result()

        run = FakeRun(checkout_handler(self.repo, deploy=deploy, state=state)[0])
        with self.assertRaisesRegex(build_runner.BuildError, 'changed the tracked tree'):
            build_runner.build(self.repo, SHA, staging, output, run=run)


if __name__ == '__main__':
    unittest.main()
