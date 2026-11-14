"""Package and verify a self-contained, prebuilt CRQ runner staging tree offline.

The staging tree must be built for linux-x64 with Node 24 and contain its
production dependencies. Packaging does not install or compile dependencies.
`build-runner.py` produces the locked staging tree and the provenance file this
tool records; packaging cross-checks that provenance against the staging tree
and, when supplied, against the source lockfile.

The schema-2 manifest records the exact build inputs it can observe: source
commit, lockfile digest, Node and pnpm versions, Node ABI, platform, the staged
production dependency versions, the built fs-ext version and native digest, and
a canonical inventory of every staged path (files with digests and modes,
symlinks with targets, directories including empty ones). `verify` extracts an
archive into a temporary directory, re-hashes every entry, validates the
manifest and provenance, and by default loads the extracted fs-ext addon in
Node and proves real flock/unlock behaviour.

Trust boundary: the manifest and its sidecars are integrity records, not
authenticity records. A self-consistent manifest can be rewritten together
with the archive, so hashes alone do not prove who built it or that the source
commit is genuine. Verification proves the archive matches its recorded
inventory and that the recorded build inputs match the staged tree; it does not
provide a cryptographic attestation, a bit-for-bit reproducible archive, or
authorization to cut over.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

SCHEMA_VERSION = 2
PROVENANCE_VERSION = 1
MANIFEST_NAME = 'artifact-manifest.json'
FS_EXT_VERSION = '2.1.1'
NODE_MAJOR = 24
PLATFORM = 'linux'
ARCH = 'x64'
REQUIRED_ENTRIES = (
    'dist/queue-runner/crq.js',
    'package.json',
    'node_modules/fs-ext/package.json',
    'node_modules/fs-ext/build/Release/fs_ext.node',
)
SHA_RE = re.compile(r'[0-9a-f]{40}')
DIGEST_RE = re.compile(r'[0-9a-f]{64}')
NODE_VERSION_RE = re.compile(r'v\d+\.\d+\.\d+')
VERSION_RE = re.compile(r'\d+\.\d+\.\d+')
ELF = {'class': 2, 'data': 1, 'machine': 62}


class ArtifactError(ValueError):
    """A staging tree, manifest, archive or verification claim is invalid."""


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _entry_kind(path):
    if path.is_symlink():
        return 'symlink'
    if path.is_dir():
        return 'directory'
    if path.is_file():
        return 'file'
    return None


def _walk(root):
    # followlinks=False keeps a symlinked directory an entry, never a subtree.
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        dirnames.sort()
        filenames.sort()
        current_path = Path(current)
        for name in dirnames + filenames:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            kind = _entry_kind(path)
            if kind is None:
                raise ArtifactError('unsupported staging entry: ' + relative)
            yield path, relative, kind


def inventory(root, exclude=()):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ArtifactError('staging root must be a directory')
    excluded = set(exclude)
    entries = []
    for path, relative, kind in _walk(root):
        if relative in excluded:
            continue
        if kind == 'symlink':
            target = os.readlink(path)
            if os.path.isabs(target):
                raise ArtifactError('absolute symlink: ' + relative)
            try:
                path.resolve(strict=True).relative_to(root)
            except (ValueError, OSError, RuntimeError) as exc:
                raise ArtifactError('escaping or broken symlink: ' + relative) from exc
            entries.append({'path': relative, 'type': 'symlink', 'target': target})
        elif kind == 'file':
            entries.append({'path': relative, 'type': 'file',
                            'sha256': sha256_file(path),
                            'mode': path.stat().st_mode & 0o777})
        else:
            entries.append({'path': relative, 'type': 'directory',
                            'mode': path.stat().st_mode & 0o777})
    return sorted(entries, key=lambda entry: entry['path'])


def content_digest(entries):
    canonical = json.dumps(sorted(entries, key=lambda entry: entry['path']),
                           sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def fs_ext_facts(root):
    root = Path(root).resolve(strict=True)
    package = root / 'node_modules/fs-ext/package.json'
    native = root / 'node_modules/fs-ext/build/Release/fs_ext.node'
    try:
        dependency = json.loads(package.read_text())
        with native.open('rb') as stream:
            header = stream.read(20)
    except (OSError, ValueError) as exc:
        raise ArtifactError('staging tree lacks built fs-ext') from exc
    if not isinstance(dependency, dict) or dependency.get('version') != FS_EXT_VERSION:
        raise ArtifactError('staging tree must contain fs-ext ' + FS_EXT_VERSION)
    if (len(header) < 20 or header[:5] != b'\x7fELF\x02'
            or header[5] != 1 or header[18:20] != b'\x3e\x00'):
        raise ArtifactError('fs-ext must be a little-endian linux-x64 ELF binary')
    return {'version': FS_EXT_VERSION,
            'native_sha256': sha256_file(native),
            'elf': dict(ELF)}


def dependency_inventory(root):
    node_modules = Path(root).resolve(strict=True) / 'node_modules'
    if not node_modules.is_dir():
        raise ArtifactError('staging tree lacks node_modules')
    dependencies = {}
    for entry in sorted(node_modules.iterdir(), key=lambda item: item.name):
        if entry.name.startswith('.'):
            continue
        candidates = ([child for child in sorted(entry.iterdir(), key=lambda item: item.name)]
                      if entry.name.startswith('@') and entry.is_dir() else [entry])
        for candidate in candidates:
            package = candidate / 'package.json'
            if not package.is_file():
                continue
            try:
                document = json.loads(package.read_text())
            except (OSError, ValueError) as exc:
                raise ArtifactError('unreadable dependency metadata: ' + str(package)) from exc
            name = document.get('name')
            version = document.get('version')
            if not isinstance(name, str) or not isinstance(version, str):
                raise ArtifactError('dependency metadata lacks name/version: ' + str(package))
            dependencies[name] = version
    if not dependencies:
        raise ArtifactError('staging tree has no production dependencies')
    return dict(sorted(dependencies.items()))


def staging_facts(root):
    return {'dependencies': dependency_inventory(root), 'fs_ext': fs_ext_facts(root)}


def _check_string(value, label):
    if not isinstance(value, str) or not value:
        raise ArtifactError('provenance ' + label + ' must be a non-empty string')
    return value


def _check_digest(value, label):
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        raise ArtifactError('provenance ' + label + ' must be a lowercase sha256')
    return value


def validate_provenance(provenance, sha=None, staging=None, lockfile=None):
    if not isinstance(provenance, dict):
        raise ArtifactError('provenance must be an object')
    if set(provenance) != {'schema_version', 'source_sha', 'lockfile_sha256',
                           'runtime', 'toolchain', 'dependencies', 'fs_ext'}:
        raise ArtifactError('provenance has unexpected fields')
    if provenance.get('schema_version') != PROVENANCE_VERSION:
        raise ArtifactError('provenance schema_version must be ' + str(PROVENANCE_VERSION))
    source_sha = _check_string(provenance.get('source_sha'), 'source_sha')
    if not SHA_RE.fullmatch(source_sha):
        raise ArtifactError('provenance source_sha must be a full commit SHA')
    if sha is not None and source_sha != sha:
        raise ArtifactError('provenance source_sha does not match the requested source identity')
    lockfile_sha = _check_digest(provenance.get('lockfile_sha256'), 'lockfile_sha256')
    if lockfile is not None:
        if sha256_file(lockfile) != lockfile_sha:
            raise ArtifactError('provenance lockfile_sha256 does not match the supplied lockfile')
    runtime = provenance.get('runtime')
    if not isinstance(runtime, dict):
        raise ArtifactError('provenance runtime must be an object')
    node_version = _check_string(runtime.get('node_version'), 'runtime.node_version')
    if not NODE_VERSION_RE.fullmatch(node_version):
        raise ArtifactError('provenance runtime.node_version must be a full Node version')
    if runtime.get('node_major') != NODE_MAJOR:
        raise ArtifactError('provenance runtime.node_major must be ' + str(NODE_MAJOR))
    if int(node_version[1:].split('.')[0]) != runtime['node_major']:
        raise ArtifactError('provenance runtime.node_version and node_major disagree')
    node_abi = _check_string(runtime.get('node_abi'), 'runtime.node_abi')
    if not node_abi.isdigit():
        raise ArtifactError('provenance runtime.node_abi must be numeric')
    if runtime.get('platform') != PLATFORM or runtime.get('arch') != ARCH:
        raise ArtifactError('provenance runtime must be ' + PLATFORM + '-' + ARCH)
    toolchain = provenance.get('toolchain')
    if not isinstance(toolchain, dict):
        raise ArtifactError('provenance toolchain must be an object')
    pnpm_version = _check_string(toolchain.get('pnpm_version'), 'toolchain.pnpm_version')
    if not VERSION_RE.fullmatch(pnpm_version):
        raise ArtifactError('provenance toolchain.pnpm_version must be a full version')
    for key in ('install_command', 'build_command', 'deploy_command'):
        _check_string(toolchain.get(key), 'toolchain.' + key)
    dependencies = provenance.get('dependencies')
    if not isinstance(dependencies, dict) or not dependencies:
        raise ArtifactError('provenance dependencies must be a non-empty object')
    for name, version in dependencies.items():
        if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
            raise ArtifactError('provenance dependencies must map names to versions')
    if dependencies.get('fs-ext') != FS_EXT_VERSION:
        raise ArtifactError('provenance dependencies must contain fs-ext ' + FS_EXT_VERSION)
    fs_ext = provenance.get('fs_ext')
    if not isinstance(fs_ext, dict):
        raise ArtifactError('provenance fs_ext must be an object')
    if fs_ext.get('version') != FS_EXT_VERSION:
        raise ArtifactError('provenance fs_ext.version must be ' + FS_EXT_VERSION)
    _check_digest(fs_ext.get('native_sha256'), 'fs_ext.native_sha256')
    if fs_ext.get('elf') != ELF:
        raise ArtifactError('provenance fs_ext.elf must be little-endian linux-x64')
    if staging is not None:
        facts = staging_facts(staging)
        if provenance.get('dependencies') != facts['dependencies']:
            raise ArtifactError('provenance dependencies do not match the staging tree')
        if provenance.get('fs_ext') != facts['fs_ext']:
            raise ArtifactError('provenance fs_ext does not match the staging tree')
    return provenance


def read_provenance(path):
    try:
        document = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise ArtifactError('unreadable provenance file: ' + str(path)) from exc
    return validate_provenance(document)


def _validate_entry(entry):
    if not isinstance(entry, dict):
        raise ArtifactError('manifest file entries must be objects')
    path = entry.get('path')
    if not isinstance(path, str) or not path:
        raise ArtifactError('manifest entry path must be a non-empty string')
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(part in ('', '.', '..') for part in pure.parts):
        raise ArtifactError('manifest entry path is not relative: ' + path)
    kind = entry.get('type')
    mode = entry.get('mode')
    if kind == 'directory':
        if set(entry) != {'path', 'type', 'mode'}:
            raise ArtifactError('directory entry has unexpected fields: ' + path)
    elif kind == 'file':
        if set(entry) != {'path', 'type', 'sha256', 'mode'}:
            raise ArtifactError('file entry has unexpected fields: ' + path)
        if not isinstance(entry.get('sha256'), str) or not DIGEST_RE.fullmatch(entry['sha256']):
            raise ArtifactError('file entry digest is invalid: ' + path)
    elif kind == 'symlink':
        if set(entry) != {'path', 'type', 'target'}:
            raise ArtifactError('symlink entry has unexpected fields: ' + path)
        target = entry.get('target')
        if not isinstance(target, str) or not target or os.path.isabs(target):
            raise ArtifactError('symlink target is not relative: ' + path)
        resolved = os.path.normpath(os.path.join(str(pure.parent), target))
        if resolved == '..' or resolved.startswith('../') or os.path.isabs(resolved):
            raise ArtifactError('symlink target escapes the archive: ' + path)
        return
    else:
        raise ArtifactError('manifest entry type is unsupported: ' + path)
    if not isinstance(mode, int) or isinstance(mode, bool) or not 0 <= mode <= 0o777:
        raise ArtifactError('manifest entry mode is invalid: ' + path)


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or manifest.get('schema_version') != SCHEMA_VERSION:
        raise ArtifactError('manifest schema_version must be ' + str(SCHEMA_VERSION))
    if set(manifest) != {'schema_version', 'source_sha', 'content_sha256',
                         'provenance', 'files'}:
        raise ArtifactError('manifest has unexpected fields')
    source_sha = _check_string(manifest.get('source_sha'), 'source_sha')
    if not SHA_RE.fullmatch(source_sha):
        raise ArtifactError('manifest source_sha must be a full commit SHA')
    provenance = validate_provenance(manifest.get('provenance'), sha=source_sha)
    if provenance['source_sha'] != source_sha:
        raise ArtifactError('manifest source_sha and provenance disagree')
    files = manifest.get('files')
    if not isinstance(files, list) or not files:
        raise ArtifactError('manifest files must be a non-empty list')
    paths = set()
    for entry in files:
        _validate_entry(entry)
        if entry['path'] in paths:
            raise ArtifactError('manifest contains a duplicate path: ' + entry['path'])
        paths.add(entry['path'])
    if manifest.get('content_sha256') != content_digest(files):
        raise ArtifactError('manifest content_sha256 does not match its file inventory')
    return manifest


def _write_archive(raw, root, sha, entries, manifest):
    prefix = 'crq-' + sha
    with gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w',
                          format=tarfile.PAX_FORMAT) as archive:
            for entry in entries:
                path = root / entry['path']
                info = tarfile.TarInfo(prefix + '/' + entry['path'])
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                if entry['type'] == 'directory':
                    info.type = tarfile.DIRTYPE
                    info.mode = entry['mode']
                    archive.addfile(info)
                elif entry['type'] == 'symlink':
                    info.type = tarfile.SYMTYPE
                    info.mode = 0o777
                    info.linkname = entry['target']
                    archive.addfile(info)
                else:
                    info.type = tarfile.REGTYPE
                    info.mode = entry['mode']
                    info.size = path.stat().st_size
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
            data = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
            info = tarfile.TarInfo(prefix + '/' + MANIFEST_NAME)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            archive.addfile(info, io.BytesIO(data))


def package(root, output, sha, provenance, lockfile=None):
    root = Path(root).resolve(strict=True)
    output = Path(output).resolve()
    if not SHA_RE.fullmatch(sha):
        raise ArtifactError('source identity must be a full commit SHA')
    if output.is_relative_to(root):
        raise ArtifactError('output must be outside staging tree')
    sidecar = output.with_name(output.name + '.sha256')
    if output.exists() or sidecar.exists():
        raise FileExistsError('artifact or sidecar already exists: ' + str(output))
    for required in REQUIRED_ENTRIES:
        if not (root / required).is_file():
            raise ArtifactError('staging tree lacks runner entry point: ' + required)
    if (root / MANIFEST_NAME).exists():
        raise ArtifactError('staging tree already contains ' + MANIFEST_NAME)
    provenance = validate_provenance(provenance, sha=sha, staging=root, lockfile=lockfile)
    entries = inventory(root)
    manifest = {'schema_version': SCHEMA_VERSION,
                'source_sha': sha,
                'content_sha256': content_digest(entries),
                'provenance': provenance,
                'files': entries}
    # Cleanup must only remove files this invocation created: losing the
    # exclusive open means another packager owns the surviving artifact.
    created_output = False
    created_sidecar = False
    try:
        raw = output.open('xb')
        created_output = True
        with raw:
            _write_archive(raw, root, sha, entries, manifest)
        digest = sha256_file(output)
        with sidecar.open('x') as stream:
            created_sidecar = True
            stream.write(f'{digest}  {output.name}\n')
    except BaseException:
        if created_sidecar:
            sidecar.unlink(missing_ok=True)
        if created_output:
            output.unlink(missing_ok=True)
        raise
    return manifest


def _ensure_directory(path, root):
    if path == root:
        return
    _ensure_directory(path.parent, root)
    if path.is_symlink():
        raise ArtifactError('archive directory path is a symlink: ' + str(path))
    path.mkdir(mode=0o700, exist_ok=True)


def _safe_extract(archive, destination):
    destination = Path(destination).resolve(strict=True)
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
    if not members:
        raise ArtifactError('archive is empty')
    manifest_members = [member for member in members
                        if len(PurePosixPath(member.name).parts) == 2
                        and PurePosixPath(member.name).name == MANIFEST_NAME]
    if len(manifest_members) != 1:
        raise ArtifactError('archive must contain exactly one manifest')
    manifest_parts = PurePosixPath(manifest_members[0].name).parts
    if len(manifest_parts) != 2:
        raise ArtifactError('archive manifest must be at the top level')
    prefix = manifest_parts[0]
    if not prefix:
        raise ArtifactError('archive manifest prefix is empty')
    kinds = {}
    normalized_members = []
    for member in members:
        if '\x00' in member.name:
            raise ArtifactError('archive member name contains a NUL byte')
        parts = PurePosixPath(member.name).parts
        if not parts or '..' in parts or parts[0] == '/':
            raise ArtifactError('archive member path is not normalized: ' + member.name)
        normalized = str(PurePosixPath(member.name))
        if normalized == prefix and member.isdir():
            if normalized in kinds:
                raise ArtifactError('archive contains a duplicate member: ' + normalized)
            kinds[normalized] = 'directory'
            normalized_members.append((member, normalized))
            continue
        if not normalized.startswith(prefix + '/'):
            raise ArtifactError('archive member escapes its prefix: ' + member.name)
        if member.islnk():
            raise ArtifactError('archive hard links are not supported: ' + normalized)
        if member.issym():
            kind = 'symlink'
            if os.path.isabs(member.linkname):
                raise ArtifactError('archive symlink target is absolute: ' + normalized)
            target = os.path.normpath(os.path.join(
                os.path.dirname(normalized), member.linkname))
            if target == '..' or target.startswith('../') or os.path.isabs(target):
                raise ArtifactError('archive symlink escapes: ' + normalized)
            if not (target == prefix or target.startswith(prefix + '/')):
                raise ArtifactError('archive symlink escapes its prefix: ' + normalized)
        elif member.isreg():
            kind = 'file'
        elif member.isdir():
            kind = 'directory'
        else:
            raise ArtifactError('archive special files are not supported: ' + normalized)
        if normalized in kinds:
            raise ArtifactError('archive contains a duplicate member: ' + normalized)
        kinds[normalized] = kind
        normalized_members.append((member, normalized))
    for normalized, kind in kinds.items():
        parent = PurePosixPath(normalized).parent
        while str(parent) not in ('.', prefix):
            if str(parent) in kinds and kinds[str(parent)] != 'directory':
                raise ArtifactError('archive entry is beneath a non-directory: ' + normalized)
            parent = parent.parent
    directories = []
    with tarfile.open(archive) as tar:
        for member, normalized in normalized_members:
            if normalized == prefix:
                continue
            target = destination / normalized
            if member.isdir():
                _ensure_directory(target, destination)
                directories.append((target, member.mode & 0o777))
            elif member.issym():
                _ensure_directory(target.parent, destination)
                if target.exists() or target.is_symlink():
                    raise ArtifactError('archive target already exists: ' + normalized)
                os.symlink(member.linkname, target)
            else:
                _ensure_directory(target.parent, destination)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                     | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, 'wb') as stream:
                    source = tar.extractfile(member)
                    if source is None:
                        raise ArtifactError('archive file has no content: ' + normalized)
                    shutil.copyfileobj(source, stream)
                os.chmod(target, member.mode & 0o777)
    for target, mode in directories:
        os.chmod(target, mode)
    return destination / prefix


def _first_difference(expected, actual):
    expected_by_path = {entry['path']: entry for entry in expected}
    actual_by_path = {entry['path']: entry for entry in actual}
    for path in sorted(set(expected_by_path) | set(actual_by_path)):
        if path not in expected_by_path:
            return 'archive contains an unrecorded path: ' + path
        if path not in actual_by_path:
            return 'archive is missing a recorded path: ' + path
        if expected_by_path[path] != actual_by_path[path]:
            return 'archive entry does not match its record: ' + path
    return None


def smoke_fs_ext(root, node=None):
    node = node or shutil.which('node')
    if not node:
        raise ArtifactError('node executable not found for fs-ext smoke')
    script = r'''
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const lockPath = process.argv[2];
const ext = require(path.join(root, 'node_modules/fs-ext'));
const first = fs.openSync(lockPath, 'w');
const second = fs.openSync(lockPath, 'r');
let blocked = false;
try {
  ext.flockSync(first, 'exnb');
  try {
    ext.flockSync(second, 'exnb');
  } catch (error) {
    blocked = Boolean(error) && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK');
  }
  ext.flockSync(first, 'un');
} finally {
  fs.closeSync(first);
  fs.closeSync(second);
}
if (!blocked) throw new Error('fs-ext flock did not block a second descriptor');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/fs-ext/package.json'), 'utf8'));
process.stdout.write(JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  modules: process.versions.modules,
  fsExt: pkg.version,
  flock: 'blocked-second-descriptor',
}));
'''
    with tempfile.TemporaryDirectory(prefix='crq-fs-ext-') as temp:
        lock_path = Path(temp) / 'flock'
        result = subprocess.run([node, '-e', script, str(root), str(lock_path)],
                                cwd=root, check=False, capture_output=True,
                                text=True, timeout=60)
    if result.returncode != 0:
        raise ArtifactError('fs-ext smoke failed: ' + (result.stderr or result.stdout).strip())
    try:
        observed = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise ArtifactError('fs-ext smoke emitted no JSON') from exc
    if observed.get('flock') != 'blocked-second-descriptor':
        raise ArtifactError('fs-ext smoke did not prove flock contention')
    for key in ('node', 'platform', 'arch', 'modules', 'fsExt'):
        if not isinstance(observed.get(key), str) or not observed[key]:
            raise ArtifactError('fs-ext smoke lacks ' + key)
    return observed


SMOKE_RUNNER_ITEM = 'runner-smoke-item'


def _run_smoke_tick(node, runner, fixture):
    """Run one `tick --dry-run` in a fixture root; read the shadow in-place."""
    result = subprocess.run([node, str(runner), 'tick', '--dry-run'],
                            cwd=str(fixture), check=False, capture_output=True,
                            text=True, timeout=60)
    try:
        artifact = json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise ArtifactError('runner smoke emitted no usable JSON artifact '
                            '(exit ' + str(result.returncode) + '): '
                            + (result.stderr or result.stdout).strip()[:300]
                            ) from exc
    if not isinstance(artifact, dict):
        raise ArtifactError('runner smoke emitted an invalid artifact')
    if result.returncode != 1:
        raise ArtifactError('runner smoke expected exit 1, got '
                            + str(result.returncode) + ': '
                            + (result.stderr or result.stdout).strip())
    if artifact.get('status') != 'indeterminate':
        raise ArtifactError('runner smoke expected indeterminate refusal, got '
                            + repr(artifact.get('status'))
                            + ': ' + json.dumps(artifact, sort_keys=True)[:300])
    detail = artifact.get('detail')
    if not isinstance(detail, str) or not detail:
        raise ArtifactError('runner smoke expected a non-empty detail')
    shadows = [json.loads(path.read_text())
               for path in sorted((fixture / 'shadow').glob('*.json'))]
    if len(shadows) != 1:
        raise ArtifactError('runner smoke expected one shadow plan, got '
                            + str(len(shadows)))
    return detail, shadows[0]


def smoke_runner(root, node=None):
    """Prove the packaged runner entry reaches its real planning boundary.

    Two fixture roots exercise the two contracts the entry owns. The first
    carries only ``state/runner-disabled`` and no config or queue: the disarm
    short-circuit must report itself before reading either document, plan no
    mutations and refuse with the runtime's structured ``indeterminate``
    result. The second is a complete runner root: a ``config.json`` with the
    bindings tick needs and a schema-valid ``state/queue.json`` holding one
    pending item. ``tick --dry-run`` therefore loads the real policy code,
    parses both documents, plans the item and writes its shadow artifact
    before refusing with the runtime's own incomplete-plan result.

    A broken entry that cannot read the fixture emits a typed ``failed``
    artifact (for example ENOENT for ``config.json`` when the marker is not
    where the runtime reads it) and is rejected: an arbitrary non-zero exit is
    never accepted as capability.
    """
    node = node or shutil.which('node')
    if not node:
        raise ArtifactError('node executable not found for runner smoke')
    runner = (Path(root) / 'dist/queue-runner/crq.js').resolve()
    with tempfile.TemporaryDirectory(prefix='crq-runner-') as temp:
        base = Path(temp)
        disarmed = base / 'disarmed'
        (disarmed / 'state').mkdir(parents=True)
        (disarmed / 'state/runner-disabled').write_text('')
        disarm_detail, disarm_shadow = _run_smoke_tick(node, runner, disarmed)
        fixture = base / 'planned'
        state = fixture / 'state'
        state.mkdir(parents=True)
        (fixture / 'config.json').write_text(json.dumps(
            {'repo': 'acme/widgets', 'clone': 'clone-not-created'}))
        (state / 'queue.json').write_text(json.dumps({
            'items': [{'id': SMOKE_RUNNER_ITEM, 'kind': 'delta',
                       'state': 'pending', 'order': 1}]}))
        detail, shadow = _run_smoke_tick(node, runner, fixture)
    disarm_value = (disarm_shadow.get('value')
                    if isinstance(disarm_shadow, dict) else None)
    if not isinstance(disarm_value, dict) \
            or disarm_value.get('disabled') is not True:
        raise ArtifactError('runner smoke did not observe the disarm '
                            'short-circuit')
    if not isinstance(disarm_shadow, dict) \
            or disarm_shadow.get('mutations') != []:
        raise ArtifactError('runner smoke disarm planned effects')
    value = shadow.get('value') if isinstance(shadow, dict) else None
    if not isinstance(value, dict) or value.get('complete') is not False:
        raise ArtifactError('runner smoke did not reach the incomplete-plan '
                            'boundary')
    candidates = value.get('candidates')
    planned = ([candidate.get('id') for candidate in candidates
                if isinstance(candidate, dict)]
               if isinstance(candidates, list) else [])
    if SMOKE_RUNNER_ITEM not in planned:
        raise ArtifactError('runner smoke did not plan the fixture item')
    return {'exit_code': 1, 'status': 'indeterminate', 'detail': detail,
            'planned': planned,
            'disarmed': {'detail': disarm_detail,
                         'mutations': len(disarm_shadow['mutations'])}}


def verify_archive(archive, expected_sha256=None, lockfile=None, smoke=True,
                   node=None, keep=False):
    archive = Path(archive).resolve(strict=True)
    sidecar = archive.with_name(archive.name + '.sha256')
    recorded = None
    if sidecar.exists():
        fields = sidecar.read_text().split()
        if not fields:
            raise ArtifactError('archive sidecar is empty')
        recorded = fields[0]
        if expected_sha256 is not None and expected_sha256 != recorded:
            raise ArtifactError('archive sidecar does not match the expected digest')
        expected_sha256 = recorded
    # Hashing and extraction must observe the same bytes: stage a private
    # copy first so a replacement at the original pathname cannot make a
    # self-consistent replacement verify against the original digest.
    private = tempfile.TemporaryDirectory(prefix='crq-verify-archive-')
    try:
        staged = Path(private.name) / archive.name
        shutil.copyfile(archive, staged)
        digest = sha256_file(staged)
        if expected_sha256 is not None and digest != expected_sha256:
            raise ArtifactError('archive digest does not match the recorded digest')
    except BaseException:
        private.cleanup()
        raise
    manager = None
    if keep:
        temp = Path(tempfile.mkdtemp(prefix='crq-verify-'))
    else:
        manager = tempfile.TemporaryDirectory(prefix='crq-verify-')
        temp = Path(manager.name)
    try:
        root = _safe_extract(staged, temp)
        try:
            manifest = json.loads((root / MANIFEST_NAME).read_text())
        except (OSError, ValueError) as exc:
            raise ArtifactError('archive manifest is unreadable') from exc
        validate_manifest(manifest)
        if root.name != 'crq-' + manifest['source_sha']:
            raise ArtifactError('archive prefix does not match the recorded source')
        for required in REQUIRED_ENTRIES:
            if not (root / required).is_file():
                raise ArtifactError('archive lacks required entry: ' + required)
        actual = inventory(root, exclude=(MANIFEST_NAME,))
        difference = _first_difference(manifest['files'], actual)
        if difference is not None:
            raise ArtifactError(difference)
        validate_provenance(manifest['provenance'], sha=manifest['source_sha'],
                            staging=root, lockfile=lockfile)
        observed = None
        runner = None
        if smoke:
            observed = smoke_fs_ext(root, node=node)
            runtime = manifest['provenance']['runtime']
            if observed['platform'] != runtime['platform'] or observed['arch'] != runtime['arch']:
                raise ArtifactError('fs-ext smoke platform does not match provenance')
            if observed['modules'] != runtime['node_abi']:
                raise ArtifactError('fs-ext smoke Node ABI does not match provenance')
            if int(observed['node'][1:].split('.')[0]) != runtime['node_major']:
                raise ArtifactError('fs-ext smoke Node major does not match provenance')
            if observed['fsExt'] != manifest['provenance']['fs_ext']['version']:
                raise ArtifactError('fs-ext smoke version does not match provenance')
            runner = smoke_runner(root, node=node)
        report = {'archive': str(archive),
                  'archive_sha256': digest,
                  'source_sha': manifest['source_sha'],
                  'content_sha256': manifest['content_sha256'],
                  'file_count': len(manifest['files']),
                  'provenance': manifest['provenance'],
                  'observed': observed,
                  'runner': runner}
        if keep:
            report['root'] = str(root)
        return report
    finally:
        if manager is not None:
            manager.cleanup()
        private.cleanup()


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
                                    subcommand='package-runner')
    parser.add_argument('command', nargs='?', choices=('package', 'verify'),
                        default='package')
    parser.add_argument('--staging', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--sha')
    parser.add_argument('--provenance', type=Path)
    parser.add_argument('--lockfile', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--no-smoke', action='store_true')
    parser.add_argument('--node')
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'package':
            if args.staging is None or args.sha is None or args.provenance is None:
                parser.error('package requires --staging, --sha and --provenance')
            manifest = package(args.staging, args.output, args.sha,
                               read_provenance(args.provenance),
                               lockfile=args.lockfile)
            summary = {'archive': str(args.output.resolve()),
                       'archive_sha256': sha256_file(args.output),
                       'content_sha256': manifest['content_sha256'],
                       'file_count': len(manifest['files']),
                       'source_sha': manifest['source_sha']}
            print(json.dumps(summary, sort_keys=True, indent=2))
        else:
            report = verify_archive(args.output, expected_sha256=args.expected_sha256,
                                    lockfile=args.lockfile,
                                    smoke=not args.no_smoke, node=args.node,
                                    keep=args.keep)
            print(json.dumps(report, sort_keys=True, indent=2))
            if not args.json:
                print('verified ' + report['archive_sha256'] + ' ' + report['archive'],
                      file=sys.stderr)
                if report['observed'] is not None:
                    print('fs-ext ' + report['observed']['fsExt'] + ' Node '
                          + report['observed']['node'] + ' ABI '
                          + report['observed']['modules'] + ' flock ok', file=sys.stderr)
                if report['runner'] is not None:
                    print('runner exit ' + str(report['runner']['exit_code']) + ' status '
                          + report['runner']['status'] + ' detail '
                          + report['runner']['detail'], file=sys.stderr)
                if args.keep:
                    print('extracted tree ' + report['root'], file=sys.stderr)
    except (ArtifactError, OSError, ValueError, subprocess.TimeoutExpired,
            tarfile.TarError) as exc:
        if machine:
            _machine_error('thrown', 'package-runner', str(exc), 1)
        parser.exit(1, 'package-runner: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
