#!/usr/bin/env python3
"""Read-only queue-host summary mirror for existing worker-host fleet readers. No tick."""
import argparse
import datetime as dt
import importlib.util
import shlex
import json
import os
from pathlib import Path
import subprocess
import tempfile

def source_settings(path):
    spec = importlib.util.spec_from_file_location('crq_host', Path(__file__).with_name('prepare-host.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    overlay, _ = module.load_overlay(path)
    return overlay['fleet_reader']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--overlay", required=True, type=Path)
    settings = source_settings(parser.parse_args(argv).overlay)
    # SSH transport only reads the allow-listed fleet summary, never queue,
    # secrets, arbitrary commands, reviews, gates or model endpoints.
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                             settings['ssh_host'], 'cat -- ' + shlex.quote(settings['source'])], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('queue-host summary unavailable; previous snapshot remains stale')
    summary = json.loads(result.stdout)
    if not isinstance(summary, dict) or not summary.get('last_tick') or summary.get('schema_version') != 2:
        raise ValueError('queue-host has not published a valid completed tick summary')
    dt.datetime.fromisoformat(summary['last_tick'].replace('Z', '+00:00'))
    summary['source_host'] = settings['ssh_host']
    summary['source_path'] = settings['source']
    # Preserve source last_tick/generated_at; mirroring never claims a new tick.
    for directory in (Path.home() / 'Library/Application Support/crq',
                      Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'crq'):
        directory.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.summary-', dir=directory)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(summary, out, separators=(',', ':'))
                out.write('\n')
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, directory / 'summary.json')
        finally:
            Path(name).unlink(missing_ok=True)
    print('queue-host summary mirrored; completed tick ' + summary['last_tick'])


if __name__ == '__main__':
    main()
