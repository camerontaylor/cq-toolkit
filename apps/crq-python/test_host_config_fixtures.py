"""Shared fixture surface for the split host-config characterization suite.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py. This module holds the detached-clone fixture mixin
and the importlib-loaded ops/prepare-host.py module; it defines no tests.
"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('host_prepare', ROOT / 'ops/prepare-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostConfigFixture:
    """P2 deployment characterization: temporary detached clones, never a live host."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crq-p2-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'deploy'
        self.root.mkdir()
        self.runner = self.root / 'apps/crq-python'
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / 'config.json', self.runner / 'config.json')
        shutil.copytree(ROOT / 'ops/systemd', self.runner / 'ops/systemd')
        shutil.copy(ROOT / 'ops/prepare-host.py', self.runner / 'ops/prepare-host.py')
        for path in (ROOT / 'ops').glob('com.crq.*.plist'):
            shutil.copy(path, self.runner / 'ops' / path.name)
        (self.root / '.gitignore').write_text('apps/crq-python/state/\n')
        self.command('init', '-q')
        self.command('config', 'user.email', 'fixture@example.invalid')
        self.command('config', 'user.name', 'Fixture')
        self.command('add', '.')
        self.command('commit', '-qm', 'baseline')
        self.before = self.command('rev-parse', 'HEAD').strip()
        c = json.loads((self.runner / 'config.json').read_text())
        c['quiet_minutes'] = 31
        (self.runner / 'config.json').write_bytes(host.encode(c))
        self.command('commit', '-qam', 'next policy')
        self.target = self.command('rev-parse', 'HEAD').strip()
        self.command('update-ref', 'refs/remotes/origin/main', self.target)
        self.tag = 'crq-runner/20261016-1'
        self.command('tag', '-a', self.tag, '-m', 'owner fixture approval')
        self.command('checkout', '-q', '--detach', self.before)
        self.overlay = {
            'schema_version': 1, 'deploy_root': str(self.root),
            'record_dir': str(self.base / 'records'),
            'fleet_reader': {'ssh_host': 'queue.example.invalid', 'source': '/srv/state/crq/summary.json'},
            'config': {
                'clone': str(self.base / 'runtime'), 'worktree_root': str(self.base / 'worktrees'),
                'timeout_bin': '/usr/bin/timeout',
                'paseo_hosts': ['worker.example.invalid:6767', '127.0.0.1:6767'],
                'alerts': {'alert_agent_host': 'worker.example.invalid:6767'},
                'repair': {'enabled': False, 'cq_bin': str(self.base / 'runtime/dist/cli.js'),
                           'paseo_host': '127.0.0.1:6767'},
            },
        }
        self.raw = host.encode(self.overlay)
        self.overlay_path = self.base / 'host.json'
        self.overlay_path.write_bytes(self.raw)
        self.overlay_path.chmod(0o600)
        self.floor = mock.patch.object(host, 'POLICY_FLOOR', self.before)
        self.floor.start()
        self.addCleanup(self.floor.stop)

    def command(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout

    def stopped(self, argv):
        if argv[0] == 'systemctl':
            if argv[2] in {'list-unit-files', 'list-units'}:
                return ''
            return 'inactive\n'
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout

    def rendered(self):
        data = host.render(self.root, self.overlay)
        (self.runner / 'config.json').write_bytes(data)
        return data
