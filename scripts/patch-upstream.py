#!/usr/bin/env python3
"""Apply only the documented patches, refusing unrelated source edits."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
source = root / 'build/sources/valhalla'
for patch in sorted((root / 'patches').glob('*.patch')):
    command = ['git', '-C', str(source), 'apply']
    if subprocess.run(command + ['--reverse', '--check', str(patch)], capture_output=True).returncode == 0:
        continue
    subprocess.run(command + ['--check', str(patch)], check=True)
    subprocess.run(command + [str(patch)], check=True)
