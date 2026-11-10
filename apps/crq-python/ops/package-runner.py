"""Package a self-contained, prebuilt CRQ runner staging tree offline.

The staging tree must be built for linux-x64 with Node 24 and contain its
production dependencies. This tool does not install or compile dependencies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tarfile


def inventory(root):
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError('staging root must be a directory')
    entries = []
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if os.path.isabs(target):
                raise ValueError('absolute symlink: ' + relative)
            try:
                path.resolve(strict=True).relative_to(root)
            except (ValueError, OSError, RuntimeError) as exc:
                raise ValueError('escaping or broken symlink: ' + relative) from exc
            entries.append({'path': relative, 'type': 'symlink', 'target': target})
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            entries.append({'path': relative, 'type': 'file',
                            'sha256': digest.hexdigest(),
                            'mode': path.stat().st_mode & 0o777})
        elif not path.is_dir():
            raise ValueError('unsupported staging entry: ' + relative)
    return entries


def package(root, output, sha):
    root = Path(root).resolve(strict=True)
    output = Path(output).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('source identity must be a full commit SHA')
    if output.is_relative_to(root):
        raise ValueError('output must be outside staging tree')
    if not (root / 'dist/queue-runner/crq.js').is_file():
        raise ValueError('staging tree lacks runner entry point')
    if not (root / 'package.json').is_file():
        raise ValueError('staging tree lacks package metadata')
    entries = inventory(root)
    native = root / 'node_modules/fs-ext/build/Release/fs_ext.node'
    try:
        dependency = json.loads((root / 'node_modules/fs-ext/package.json').read_text())
        with native.open('rb') as stream:
            header = stream.read(20)
    except (OSError, ValueError) as exc:
        raise ValueError('staging tree lacks built fs-ext') from exc
    if not isinstance(dependency, dict) or dependency.get('version') != '2.1.1':
        raise ValueError('staging tree must contain fs-ext 2.1.1')
    if len(header) < 20 or header[:5] != b'\x7fELF\x02' or header[5] != 1 or header[18:20] != b'\x3e\x00':
        raise ValueError('fs-ext must be a little-endian linux-x64 ELF binary')
    if (root / 'artifact-manifest.json').exists():
        raise ValueError('staging tree already contains artifact-manifest.json')
    manifest = {'schema_version': 1, 'declared_source_sha': sha,
                'declared_platform': 'linux-x64', 'declared_node_major': 24,
                'files': entries}
    # Exclusive creation prevents accidental replacement of a prior artifact.
    with output.open('xb') as raw:
        with tarfile.open(fileobj=raw, mode='w:gz', dereference=False) as archive:
            archive.add(root, arcname='crq-' + sha, recursive=True)
            data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
            import io
            info = tarfile.TarInfo('crq-' + sha + '/artifact-manifest.json')
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staging', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    package(args.staging, args.output, args.sha)


if __name__ == '__main__':
    main()
