#!/usr/bin/env python3
"""Build an SDK dataset from OSM PBF with the pinned native Valhalla tools.

Only local files are produced. No upload, existing-release overwrite or custom
graph/index encoding is performed. Run with --help for the CLI.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
METADATA_LIMIT = 4 * 1024 * 1024
TILE_LIMIT = 64 * 1024 * 1024


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def bbox(value):
    try:
        west, south, east, north = map(float, value.split(','))
        if not all(map(math.isfinite, (west, south, east, north))):
            raise ValueError()
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError()
        return [west, south, east, north]
    except ValueError:
        raise argparse.ArgumentTypeError('Use west,south,east,north in degrees; antimeridian-spanning bounds are unsupported.')


def inspect_archive(archive_path):
    """Read upstream's index and cross-check TAR members and native tile headers."""
    with tarfile.open(archive_path, 'r:') as archive:
        members = archive.getmembers()
        if not members or members[0].name != 'index.bin' or members[0].offset_data != 512:
            raise ValueError('Expected a native uncompressed archive beginning with index.bin.')
        first = members[0]
        if not first.isfile() or not 0 < first.size <= TILE_LIMIT or first.size % 16:
            raise ValueError('Invalid native index size.')
        index = archive.extractfile(first).read()
        by_offset = {}
        paths = set()
        for member in members[1:]:
            if (not member.isfile() or not re.fullmatch(r'[012]/(?:\d{3}/)*\d{3}\.gph', member.name)
                    or member.name in paths or not 272 <= member.size <= TILE_LIMIT):
                raise ValueError(f'Unsupported, duplicate or oversized tile: {member.name}')
            paths.add(member.name)
            by_offset[member.offset_data] = member
        tiles = {}
        used = set()
        for offset, tile_id, size in struct.iter_unpack('<QII', index):
            member = by_offset.get(offset)
            if (member is None or member.size != size or str(tile_id) in tiles or offset in used
                    or tile_id >= 1 << 25 or (tile_id & 7) > 2):
                raise ValueError('Native index does not match archive members.')
            parts = member.name[:-4].split('/')
            path_id = int(''.join(parts[1:])) * 8 + int(parts[0])
            stream = archive.extractfile(member)
            header = stream.read(8)
            if (struct.unpack('<Q', header)[0] & ((1 << 46) - 1)) != tile_id or path_id != tile_id:
                raise ValueError(f'Native GraphId mismatch: {member.name}')
            checksum = hashlib.sha256(header)
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
            tiles[str(tile_id)] = {'path': member.name, 'offset': str(offset), 'size': str(size),
                                   'sha256': checksum.hexdigest()}
            used.add(offset)
        if not tiles or len(tiles) != len(by_offset):
            raise ValueError('Native index must cover every tile exactly once.')
    return index, tiles


def publish_files(destination, files):
    """Install a complete local release atomically, or verify an identical repeat."""
    if destination.exists():
        expected = set(files)
        actual = {str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()}
        if expected != actual or any(digest(destination / name) != digest(source) for name, source in files.items()):
            raise ValueError(f'Refusing to overwrite different immutable bytes at {destination}')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix='.dataset-', dir=destination.parent))
    try:
        for name, source in files.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        staging.rename(destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def run(args, **options):
    return subprocess.run([str(a) for a in args], check=True, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pbf', required=True, type=Path, help='Local .osm.pbf extract; never downloaded implicitly.')
    parser.add_argument('--name', required=True, help='Release prefix, e.g. my-region-2026-09.')
    parser.add_argument('--bbox', required=True, type=bbox, help='Declared coverage west,south,east,north; does not clip the graph.')
    parser.add_argument('--source-url', help='Public provenance URL for the input extract (no signed/private credentials).')
    parser.add_argument('--timezone-db', type=Path, help='Existing compatible timezones.sqlite; otherwise build the pinned global timezone input.')
    parser.add_argument('--threads', type=int, default=1, help='Native builder concurrency (default: 1).')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/datasets', help='Parent directory for immutable releases.')
    parser.add_argument('--work-dir', type=Path, help='New, nonexistent working directory; default: unique build/osm-* directory.')
    parser.add_argument('--source-dir', type=Path, default=ROOT / 'build/sources/valhalla', help='Pinned patched upstream checkout.')
    parser.add_argument('--native-dir', type=Path, default=ROOT / 'build/native', help='CMake output with native-reference and upstream/ tools.')
    parser.add_argument('--source-date-epoch', type=int, default=1789603200, help='Reproducible TAR timestamp, default: 2026-09-17 UTC.')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}', args.name):
        parser.error('--name must be 1–80 letters, digits, dots, underscores or hyphens, starting with a letter/digit.')
    if not 1 <= args.threads <= 256 or args.source_date_epoch < 0:
        parser.error('Invalid --threads or --source-date-epoch.')
    pbf = args.pbf.resolve(strict=True)
    if not pbf.is_file() or pbf.suffix != '.pbf':
        parser.error('--pbf must be an existing OSM PBF file.')
    if args.source_url:
        url = urlsplit(args.source_url)
        if url.scheme not in ('http', 'https') or not url.netloc or url.username or url.password or url.query or url.fragment:
            parser.error('--source-url must be a public HTTP(S) URL without credentials, query parameters or fragments.')
    source_hash = digest(pbf)
    pins = json.loads((ROOT / 'versions.json').read_text())
    source = args.source_dir.resolve(strict=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != pins['valhalla']:
        raise ValueError('Upstream revision differs from versions.json; use the SDK-pinned builder.')
    native = args.native_dir.resolve(strict=True)
    for tool in ['native-reference', 'upstream/valhalla_build_admins', 'upstream/valhalla_build_tiles']:
        if not os.access(native / tool, os.X_OK):
            raise ValueError(f'Missing native executable {native / tool}; run pnpm run build:native.')
    version = subprocess.check_output([str(native / 'upstream/valhalla_build_tiles'), '--version'], text=True).strip()
    if pins['valhallaRelease'] not in version:
        raise ValueError(f'Unexpected native builder version: {version}')
    if args.work_dir:
        work = args.work_dir.resolve()
        work.mkdir(parents=True, exist_ok=False)
    else:
        (ROOT / 'build').mkdir(exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix='osm-', dir=ROOT / 'build'))
    print(f'Working directory: {work}', flush=True)
    if args.timezone_db:
        timezone = args.timezone_db.resolve(strict=True)
        timezone_source = {'kind': 'provided-database', 'sha256': digest(timezone)}
    else:
        from region_data import timezone_database
        timezone, timezone_source = timezone_database(ROOT, work)
    config = json.loads(subprocess.check_output([sys.executable, str(source / 'scripts/valhalla_build_config')]))
    config['mjolnir'].update(tile_dir=str(work / 'tiles'), tile_url='', admin=str(work / 'admins.sqlite'),
                             timezone=str(timezone), concurrency=args.threads, include_driving=True,
                             include_bicycle=True, include_pedestrian=True, max_cache_size=32 * 1024 * 1024,
                             use_lru_mem_cache=True, lru_mem_cache_hard_control=True, global_synchronized_cache=False)
    config['mjolnir'].pop('tile_extract', None)
    config['mjolnir']['data_processing']['use_admin_db'] = True
    config['loki'].update(use_connectivity=False, actions=['route'])
    for section in ['mjolnir', 'loki', 'thor', 'odin']:
        config[section]['logging'] = {'type': 'std_err', 'color': False}
    config_file = work / 'native-config.json'
    config_file.write_bytes(json_bytes(config))
    run([native / 'upstream/valhalla_build_admins', '-c', config_file, pbf])
    run([native / 'upstream/valhalla_build_tiles', '-c', config_file, pbf])
    archive_config = json.loads(json.dumps(config))
    archive_config['mjolnir']['tile_extract'] = str(work / 'graph.tar')
    (work / 'archive-config.json').write_bytes(json_bytes(archive_config))
    run([sys.executable, source / 'scripts/valhalla_build_extract', '-c', work / 'archive-config.json'],
        env={**os.environ, 'SOURCE_DATE_EPOCH': str(args.source_date_epoch)})
    archive = work / 'graph.tar'
    index, tiles = inspect_archive(archive)
    runtime = json.loads(json.dumps(config))
    runtime['mjolnir'].update(tile_dir='', tile_url='', admin='', timezone='')
    config_bytes = json_bytes(runtime)
    if len(config_bytes) > METADATA_LIMIT:
        raise ValueError('Runtime configuration exceeds the SDK 4 MiB limit.')
    (work / 'config.json').write_bytes(config_bytes)
    if digest(pbf) != source_hash:
        raise ValueError('PBF changed during the build; refusing to publish inconsistent provenance.')
    provenance = {'kind': 'openstreetmap', 'sha256': source_hash, 'timezone': timezone_source,
                  'attribution': '© OpenStreetMap contributors, ODbL 1.0.',
                  'licenseUrl': 'https://www.openstreetmap.org/copyright'}
    if args.source_url:
        provenance['url'] = args.source_url
    archive_hash = digest(archive)
    costings = ['auto', 'bicycle', 'pedestrian', 'truck']
    identity = {'archiveSha256': archive_hash, 'configSha256': sha(config_bytes), 'valhallaRevision': revision, 'costings': costings,
                'coverage': args.bbox, 'source': provenance, 'sourceDateEpoch': args.source_date_epoch}
    release = f'{args.name}-{sha(json_bytes(identity))[:16]}'
    with archive.open('rb') as stream:
        header_hash = sha(stream.read(512))
    manifest = {'schema': 1, 'release': release, 'valhallaRevision': revision, 'valhallaVersion': pins['valhallaRelease'],
                'costings': costings, 'coverage': args.bbox, 'source': provenance,
                'build': {'includedModes': ['driving', 'bicycle', 'pedestrian'], 'sourceDateEpoch': args.source_date_epoch},
                'config': {'url': 'config.json', 'sha256': sha(config_bytes)},
                'archive': {'url': 'graph.tar', 'size': str(archive.stat().st_size), 'etag': f'"{archive_hash}"',
                            'headerSha256': header_hash, 'indexSize': str(len(index)), 'indexSha256': sha(index)},
                'tiles': tiles}
    manifest_bytes = json_bytes(manifest)
    if len(manifest_bytes) > METADATA_LIMIT:
        raise ValueError('Manifest exceeds the SDK 4 MiB limit. Build a smaller region; archive sharding is not supported.')
    (work / 'manifest.json').write_bytes(manifest_bytes)
    files = {'graph.tar': archive, 'config.json': work / 'config.json', 'manifest.json': work / 'manifest.json'}
    for tile in tiles.values():
        tile_path = work / 'tiles' / tile['path']
        if digest(tile_path) != tile['sha256']:
            raise ValueError('Individual tile differs from archive payload.')
        files['tiles/' + tile['path']] = tile_path
    audit = json.loads(subprocess.check_output([str(native / 'native-reference'), str(config_file), '--inspect'], text=True))
    if not audit['nodes']:
        raise ValueError('The extract produced no routable nodes.')
    if audit['nodesWithTimezone'] != audit['nodes'] or audit['nodesWithCountry'] != audit['nodes']:
        print('WARNING: some nodes lack timezone/country assignments; inspect build-report.json and input boundary completeness.', file=sys.stderr)
    destination = args.output.resolve() / release
    publish_files(destination, files)
    report = {**identity, 'release': release, 'output': str(destination), 'workDir': str(work), 'audit': audit,
              'nativeConfigSha256': digest(config_file), 'archiveBytes': archive.stat().st_size,
              'tiles': len(tiles), 'manifestBytes': len(manifest_bytes),
              'nativeBuilderVersion': version, 'nativeBuilderSha256': digest(native / 'upstream/valhalla_build_tiles')}
    (work / 'build-report.json').write_bytes(json_bytes(report))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f'Dataset build failed: {error}')
