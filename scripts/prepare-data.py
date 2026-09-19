#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
from pathlib import Path

root = Path('/work')
source = root / 'build/sources/valhalla'
regional = '--region' in sys.argv
work = root / ('build/region' if regional else 'build/data')
fixtures = Path('fixtures/region' if regional else 'fixtures')
work.mkdir(parents=True, exist_ok=True)
subprocess.run(['python3', 'scripts/patch-upstream.py'], check=True)
os.environ['SOURCE_DATE_EPOCH'] = '1789603200'
if regional:
    import region_data
    pbf, timezone, provenance = region_data.inputs(root, source, work)
    region_data.requests(fixtures)
else:
    subprocess.run(['python3', 'scripts/create-fixture.py'], check=True)
    pbf = work / 'development.pbf'
    subprocess.run(['osmium', 'cat', 'fixtures/development.osm', '-o', str(pbf), '--overwrite'], check=True)
config = json.loads(subprocess.check_output(['python3', str(source / 'scripts/valhalla_build_config')]))
config['mjolnir'].update(tile_dir=str(work / 'tiles'), tile_extract='', concurrency=1,
                         admin='', timezone='', include_driving=True, include_bicycle=True,
                         include_pedestrian=True, tile_url='', max_cache_size=32*1024*1024,
                         use_lru_mem_cache=True, lru_mem_cache_hard_control=True,
                         global_synchronized_cache=False)
config['mjolnir']['data_processing']['use_admin_db'] = False
if regional:
    config['mjolnir'].update(admin=str(work / 'admins.sqlite'), timezone=str(timezone))
    config['mjolnir']['data_processing']['use_admin_db'] = True
config['loki']['use_connectivity'] = False
config['loki']['actions'] = ['route']
config['mjolnir'].pop('tile_extract')
for section in ['mjolnir', 'loki', 'thor', 'odin']:
    config[section]['logging'] = {'type': 'std_err', 'color': False}
config_file = work / 'native-config.json'
config_file.write_text(json.dumps(config, indent=2))
if regional:
    (work / 'admins.sqlite').unlink(missing_ok=True)
    subprocess.run(['build/native/upstream/valhalla_build_admins', '-c', str(config_file), str(pbf)], check=True)
if (work / 'tiles').exists(): shutil.rmtree(work / 'tiles')
subprocess.run(['build/native/upstream/valhalla_build_tiles', '-c', str(config_file), str(pbf)], check=True)
config['mjolnir']['tile_extract'] = str(work / 'graph.tar')
archive_config = work / 'archive-config.json'
archive_config.write_text(json.dumps(config, indent=2))
subprocess.run(['python3', str(source / 'scripts/valhalla_build_extract'), '-c', str(archive_config), '--overwrite'], check=True)

def sha(data): return hashlib.sha256(data).hexdigest()
archive = (work / 'graph.tar').read_bytes()
archive_hash = sha(archive)
revision = json.loads(Path('versions.json').read_text())['valhalla']
runtime_config = json.loads(json.dumps(config))
runtime_config['mjolnir'].update(tile_dir='', tile_url='')
runtime_config['mjolnir'].pop('tile_extract')
if regional:
    # Administrative and timezone IDs are baked into native tiles. Native
    # builder databases are never shipped or opened by the browser runtime.
    runtime_config['mjolnir'].update(admin='', timezone='')
config_bytes = (json.dumps(runtime_config, sort_keys=True, indent=2) + '\n').encode()
config_hash = sha(config_bytes)
costings = ['auto', 'bicycle', 'pedestrian', 'truck']
identity = archive_hash + config_hash + revision + json.dumps(costings)
if regional:
    build_metadata = {'configSha256': sha(config_file.read_bytes()), 'includedModes': ['driving', 'bicycle', 'pedestrian']}
    identity += json.dumps({'source': provenance, 'build': build_metadata}, sort_keys=True)
release = ('liechtenstein-2015-v1-' if regional else 'fixture-v1-') + sha(identity.encode())[:16]
destination = root / 'public/datasets' / release
tiles = {}
with tarfile.open(work / 'graph.tar') as tar:
    first = tar.getmembers()[0]
    assert first.name == 'index.bin' and first.offset_data == 512
    index = tar.extractfile(first).read()
    members = {m.offset_data: m for m in tar.getmembers() if m.name.endswith('.gph')}
    for offset, tile_id, size in struct.iter_unpack('<QII', index):
        member = members[offset]
        assert member.size == size
        payload = tar.extractfile(member).read()
        assert struct.unpack_from('<Q', payload)[0] & ((1 << 46) - 1) == tile_id
        tiles[str(tile_id)] = {'path': member.name, 'offset': str(offset), 'size': str(size), 'sha256': sha(payload)}
    assert len(tiles) == len(members)
manifest = {
    'schema': 1, 'release': release, 'created': '2026-09-17T00:00:00Z',
    'valhallaRevision': revision, 'valhallaVersion': '3.8.3', 'costings': costings,
    'coverage': [9.23, 47.23, 9.57, 47.57],
    'source': {'kind': 'synthetic-osm', 'file': 'fixtures/development.osm',
               'sha256': sha(Path('fixtures/development.osm').read_bytes()),
               'attribution': 'Synthetic test roads authored for this project; not real navigation data.'},
    'config': {'url': 'config.json', 'sha256': config_hash},
    'archive': {'url': 'graph.tar', 'size': str(len(archive)), 'etag': '"' + archive_hash + '"',
                'headerSha256': sha(archive[:512]), 'indexSize': str(len(index)), 'indexSha256': sha(index)},
    'tiles': tiles
}
manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
if regional:
    manifest['coverage'] = [9.471078, 47.047740, 9.636217, 47.271280]
    manifest['source'] = provenance
    manifest['build'] = build_metadata
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
objects = {'graph.tar': archive, 'config.json': config_bytes, 'manifest.json': manifest_bytes}
objects.update({'tiles/' + tile['path']: (work / 'tiles' / tile['path']).read_bytes() for tile in tiles.values()})
if destination.exists():
    for name, payload in objects.items():
        if (destination / name).read_bytes() != payload:
            raise RuntimeError(f'Refusing to overwrite immutable release object: {name}')
else:
    staging = work / 'release'
    if staging.exists(): shutil.rmtree(staging)
    for name, payload in objects.items():
        target = staging / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging.rename(destination)
discovery = 'public/region.json' if regional else 'public/manifest.json'
Path(discovery).write_text(json.dumps({'manifestUrl': f'/datasets/{release}/manifest.json'}) + '\n')
metrics = 'build/reports/region-native.jsonl' if regional else 'build/reports/native.jsonl'
output = subprocess.check_output(['build/native/native-reference', str(config_file), str(fixtures / 'requests.jsonl'), metrics], text=True)
results = [json.loads(line) for line in output.splitlines()]
requests = json.loads((fixtures / 'requests.json').read_text())
assert len(results) == len(requests)
reference = {'release': release, 'valhallaRevision': revision, 'configSha256': config_hash,
             'cases': [dict(case, expected=result) for case, result in zip(requests, results)]}
reference_file = fixtures / 'reference.json'
if reference_file.exists():
    previous = json.loads(reference_file.read_text())
    if previous['release'] == release:
        previous_cases = {case['name']: case for case in previous['cases']}
        for case in reference['cases']:
            old = previous_cases.get(case['name'])
            if old and old['request'] == case['request'] and old['expected'] != case['expected']:
                raise RuntimeError(f"Native reference changed for identical graph/request: {case['name']}")
(fixtures / 'reference.json').write_text(json.dumps(reference, indent=2) + '\n')
(fixtures / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'release': release, 'tiles': len(tiles), 'archiveBytes': len(archive), 'cases': len(results)}))
if regional:
    audit = json.loads(subprocess.check_output(['build/native/native-reference', str(config_file), '--inspect'], text=True))
    assert audit['nodesWithTimezone'] == audit['nodes'] > 0
    assert audit['nodesWithCountry'] == audit['nodes']
    audit.update(adminDatabaseSha256=sha((work / 'admins.sqlite').read_bytes()), timezoneDatabaseSha256=sha(timezone.read_bytes()),
                 archiveSha256=archive_hash, release=release, source=provenance, build=build_metadata)
    Path('build/reports/region-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
