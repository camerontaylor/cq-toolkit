#!/usr/bin/env python3
"""Prepare inert host configuration and stopped units; never starts CRQ.

`--live-config` re-renders only config.json on the LIVE runner (after a
fast-forward that changed the committed config): it holds state/tick.lock,
skips the stopped-unit check, never writes runner-disabled and never touches
units."""
import fcntl
import json
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
# This helper is deliberately host-specific. It refuses an active deployment.
if str(root) != '/home/operator/repos/coderabbit-queue':
    sys.exit('run only from the dedicated queue-host checkout')
live = sys.argv[1:] == ['--live-config']
if sys.argv[1:] and not live:
    sys.exit('usage: prepare-host.py [--live-config]')
units = [p.name for p in (root / 'ops/systemd').glob('crq-*')]
for unit in ([] if live else units):
    status = subprocess.run(['systemctl', '--user', 'is-active', unit], capture_output=True, text=True)
    if status.stdout.strip() in ('active', 'activating', 'reloading', 'deactivating'):
        sys.exit('refusing to prepare over an active CRQ unit: ' + unit)
sys.path.insert(0, str(root))
from crq_repair import atomic
# Render from the COMMITTED config: the working-tree copy is this script's own output.
config = json.loads(subprocess.run(['git', '-C', str(root), 'show', 'HEAD:config.json'],
                                   capture_output=True, text=True, check=True).stdout)
config.update(clone='/home/operator/repos/crq-toolkit-runtime', worktree_root='/home/operator/repos/worktrees',
              timeout_bin='/usr/bin/timeout', paseo_hosts=['worker-host.tailnet.example:6767', '127.0.0.1:6767'])
config['promotion']['record_url_template'] = 'http://queue-host.tailnet.example:6778/promotion/{item}'
config['promotion']['alert_agent_host'] = 'worker-host.tailnet.example:6767'  # the chancellor's daemon
config['promotion']['signer']['spool'].update(ssh_alias='operator@127.0.0.1', ssh_key='~/.ssh/crq-spool-ed25519')
config['repair'].update(enabled=False, spend_authorization=None,
                       cq_bin='/home/operator/repos/crq-toolkit-runtime/dist/cli.js', paseo_host='127.0.0.1:6767')
if live:
    with (root / 'state/tick.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # never rewrite config under a running tick
        atomic(root / 'config.json', config)
    print('re-rendered live config.json from HEAD; runner and units untouched')
    sys.exit(0)
atomic(root / 'config.json', config)
(root / 'state').mkdir(exist_ok=True)
(root / 'state/runner-disabled').write_text('queue-host prepared; worker-host owns the runner until locked handover.\n')
destination = Path.home() / '.config/systemd/user'
destination.mkdir(parents=True, exist_ok=True)
for unit in units:
    shutil.copy2(root / 'ops/systemd' / unit, destination / unit)
subprocess.run(['systemd-analyze', '--user', 'verify', *[str(destination / p) for p in units]], check=True)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
print('prepared inert configuration and verified stopped units; repair disabled')
