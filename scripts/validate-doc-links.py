#!/usr/bin/env python3
"""Validate repository Markdown file targets; external URLs and fragments are not fetched."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from lib.doc_links import require_document_links


def read_working_files(root):
    output = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    files = {}
    for raw in output.split(b'\0'):
        if not raw:
            continue
        name = raw.decode('utf-8')
        path = root / name
        if path.is_symlink():
            raise ValueError('Symlink document source is unsupported: ' + name)
        if not path.exists():
            continue
        if not path.resolve().is_relative_to(root) or not path.is_file():
            raise ValueError('Document inventory must contain regular in-root files: ' + name)
        files[name] = path.read_bytes() if name.lower().endswith('.md') else b''
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    files = read_working_files(args.root.resolve())
    templates = [name for name in files if name.endswith('.template.md')]
    result = require_document_links(files, exclude_sources=templates)
    print(json.dumps({'checkedRelativeFileTargets': result['checked'], 'templateSourcesNotInstantiated': templates, 'externalUrlsFetched': False, 'fragmentsChecked': False}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
