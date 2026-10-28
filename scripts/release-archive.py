#!/usr/bin/env python3
"""Deterministic release ZIPs, checked against Git blobs rather than version strings."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import zipfile

from lib.doc_links import require_document_links

REPO = 'haandol/encbird-plugin'
ROOT_FILES = {'README.md', 'LICENSE', 'NOTICE', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'}
PLUGIN_FILES = {'package.json', 'plugin.json', 'mcp.json', '.mcp.json', 'README.md', 'LICENSE', 'NOTICE'}
PLUGIN_DIRS = {'assets', 'dist', 'skills', 'contracts', '.codex-plugin', '.claude-plugin'}
VERSION_FILES = ['package.json', 'package-lock.json', 'plugins/encbird/package.json',
                 'plugins/encbird/plugin.json', 'plugins/encbird/.codex-plugin/plugin.json',
                 'plugins/encbird/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']


def fail(message):
    raise ValueError(message)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    parts = name.split('/')
    if not name or PurePosixPath(name).is_absolute() or any(p in ('', '.', '..') for p in parts) or '\\' in name or any(ord(c) < 32 for c in name):
        fail(f'Unsafe archive path: {name!r}')


def allowed(name):
    parts = name.split('/')
    if any(p in {'.git', 'node_modules', 'src', 'test', 'tests', '__tests__', 'env', '.envrc'} or p.endswith('.env') or p.startswith('.env.') for p in parts):
        return False
    if name in ROOT_FILES:
        return True
    prefix = 'plugins/encbird/'
    if not name.startswith(prefix):
        return False
    relative = name[len(prefix):]
    return relative in PLUGIN_FILES or ('/' in relative and relative.split('/')[0] in PLUGIN_DIRS)


def source(root, commit):
    files = []
    for record in git(root, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        meta, raw_name = record.split(b'\t', 1)
        name = raw_name.decode('utf-8')
        safe_path(name)
        if not allowed(name):
            continue
        mode, kind, oid = meta.decode().split()
        if kind != 'blob' or mode not in ('100644', '100755'):
            fail(f'Symlink or non-regular release source: {name}')
        data = git(root, 'cat-file', 'blob', oid)
        files.append((name, mode, data))
    files.sort(key=lambda item: item[0])
    names = {name for name, _, _ in files}
    required = ROOT_FILES | {'plugins/encbird/' + name for name in PLUGIN_FILES} | {
        'plugins/encbird/.codex-plugin/plugin.json', 'plugins/encbird/.claude-plugin/plugin.json',
        'plugins/encbird/dist/index.js', 'plugins/encbird/dist/cli.js', 'plugins/encbird/dist/build-info.json',
        'plugins/encbird/dist/THIRD_PARTY_LICENSES.txt', 'plugins/encbird/skills/encbird-learning/SKILL.md',
        'plugins/encbird/contracts/tools.json', 'plugins/encbird/contracts/openapi.json',
        'plugins/encbird/contracts/serialization-samples.json'}
    if not required <= names:
        fail(f'Missing committed release files: {sorted(required - names)}')
    return files


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, mode, data in files:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = int(mode, 8) << 16
            archive.writestr(info, data)
    return output.getvalue()


def regular(path, directory=False):
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            fail(f'Symlink is not allowed: {parent}')
    if directory:
        if not path.is_dir():
            fail(f'Missing release directory: {path}')
    elif not stat.S_ISREG(path.stat().st_mode):
        fail(f'Not a regular file: {path}')


def metadata(root, version, commit, files, archive, notes):
    return {
        'schemaVersion': 1, 'repository': REPO, 'version': version,
        'sourceCommit': commit, 'sourceTree': git(root, 'rev-parse', f'{commit}^{{tree}}').decode().strip(),
        'archive': {'name': f'encbird-plugin-{version}.zip', 'sha256': sha(archive), 'size': len(archive)},
        'notes': {'name': f'release-notes-v{version}.md', 'sha256': sha(notes)},
        'files': [{'path': name, 'mode': mode, 'sha256': sha(data), 'size': len(data)} for name, mode, data in files],
    }


def verify_worktree(root, commit):
    for record in git(root, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
        if not record:
            continue
        meta, raw_name = record.split(b'\t', 1)
        name = raw_name.decode('utf-8')
        safe_path(name)
        mode, kind, oid = meta.decode().split()
        if kind != 'blob' or mode not in ('100644', '100755'):
            fail(f'Symlink or non-regular committed source: {name}')
        path = root / name
        regular(path)
        data = path.read_bytes()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        executable = bool(path.stat().st_mode & stat.S_IXUSR)
        if actual != oid or executable != (mode == '100755'):
            fail(f'Working source differs from committed source: {name}')


def verify(root, version, commit, expected_checksum):
    folder = root / '.release' / version / commit
    regular(folder, directory=True)
    expected_names = {f'encbird-plugin-{version}.zip', 'manifest.json', 'SHA256SUMS', f'release-notes-v{version}.md'}
    if {p.name for p in folder.iterdir()} != expected_names:
        fail('Release directory must contain exactly the four prepared files.')
    for name in expected_names:
        regular(folder / name)
    archive = (folder / f'encbird-plugin-{version}.zip').read_bytes()
    if sha(archive) != expected_checksum:
        fail('ZIP SHA-256 mismatch.')
    files = source(root, commit)
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        entries = zipped.infolist()
        if [entry.filename for entry in entries] != [name for name, _, _ in files]:
            fail('ZIP paths differ from the committed allowlist (or duplicate/unsafe entries).')
        for entry, (name, mode, data) in zip(entries, files):
            safe_path(entry.filename)
            if entry.external_attr >> 16 != int(mode, 8) or zipped.read(entry) != data:
                fail(f'ZIP content or mode differs from committed source: {name}')
    if archive != zip_bytes(files):
        fail('ZIP is not the deterministic archive of the source commit.')
    notes = (folder / f'release-notes-v{version}.md').read_bytes()
    if not notes.strip() or commit not in notes.decode() or expected_checksum not in notes.decode():
        fail('Release notes must include the source commit and verified ZIP SHA-256.')
    expected = metadata(root, version, commit, files, archive, notes)
    manifest = (folder / 'manifest.json').read_bytes()
    if json.loads(manifest) != expected:
        fail('Manifest differs from committed source or prepared artifacts.')
    sums = ''.join(f'{sha(data)}  {name}\n' for name, data in [
        (f'encbird-plugin-{version}.zip', archive), ('manifest.json', manifest), (f'release-notes-v{version}.md', notes)])
    sum_bytes = (folder / 'SHA256SUMS').read_bytes()
    if sum_bytes != sums.encode():
        fail('SHA256SUMS differs from prepared artifacts.')
    return {**expected, 'artifactChecksums': {
        f'encbird-plugin-{version}.zip': sha(archive), 'manifest.json': sha(manifest),
        f'release-notes-v{version}.md': sha(notes), 'SHA256SUMS': sha(sum_bytes)}}


def create(root, version, commit, notes_path):
    regular(notes_path)
    notes = notes_path.read_text()
    if not notes.strip():
        fail('Reviewed release notes must not be empty.')
    files = source(root, commit)
    require_document_links({name: data for name, _, data in files})
    archive = zip_bytes(files)
    digest = sha(archive)
    if commit not in notes:
        notes = notes.rstrip() + f'\n\nSource commit: {commit}\n'
    if digest not in notes:
        notes = notes.rstrip() + f'\n\nZIP SHA-256: {digest}\n'
    notes = notes.encode()
    manifest = (json.dumps(metadata(root, version, commit, files, archive, notes), ensure_ascii=False, indent=2) + '\n').encode()
    output = {f'encbird-plugin-{version}.zip': archive, 'manifest.json': manifest, f'release-notes-v{version}.md': notes}
    output['SHA256SUMS'] = ''.join(f'{sha(data)}  {name}\n' for name, data in output.items()).encode()
    folder = root / '.release' / version / commit
    for parent in [folder, *folder.parents]:
        if parent.is_symlink():
            fail(f'Symlink is not allowed: {parent}')
    if folder.exists():
        verify(root, version, commit, digest)
        if any((folder / name).read_bytes() != data for name, data in output.items()):
            fail('Existing prepared release differs; it will not be overwritten.')
        return digest
    folder.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.prepare-', dir=folder.parent) as temporary:
        staged = Path(temporary) / commit
        staged.mkdir()
        for name, data in output.items():
            (staged / name).write_bytes(data)
        os.rename(staged, folder)
    verify(root, version, commit, digest)
    return digest


def main():
    subprocess.run(['sh', str(Path(__file__).resolve().with_name('require-container.sh'))], check=True)
    action, root_arg, version, commit, argument = sys.argv[1:]
    import re
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        fail('Expected stable VERSION and full COMMIT_SHA.')
    root = Path(root_arg).absolute()
    if action == 'create':
        print(create(root, version, commit, Path(argument).absolute()))
    elif action == 'verify':
        print(json.dumps(verify(root, version, commit, argument)))
    elif action == 'worktree':
        verify_worktree(root, commit)
    elif action == 'versions':
        destination = Path(argument)
        for name in VERSION_FILES:
            mode = git(root, 'ls-tree', commit, '--', name).decode().split()[0]
            if mode not in ('100644', '100755'):
                fail(f'Non-regular committed version metadata: {name}')
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(root, 'show', f'{commit}:{name}'))
    else:
        fail('Unknown archive operation.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f'Error: {error}')
