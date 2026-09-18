"""Pinned, small OSM regional benchmark inputs; no live navigation promise."""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

PBF_SHA = 'b8b6c7f2122bd46a65b1d1c669b47c20df4f784a501ace3221d5ea6053121ecc'
TZ_SHA = 'e68090f0c7b1f3574287098baeef7554ac73e21c52c4d548d7edf304efb417f2'
TZ_URL = 'https://github.com/evansiroky/timezone-boundary-builder/releases/download/2026c/timezones-with-oceans-1970.shapefile.zip'

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def timezone_database(root, work):
    """Build the pinned global timezone database using upstream's SpatiaLite schema."""
    archive = root / 'build/inputs/timezones-with-oceans-1970.shapefile.zip'
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        subprocess.run(['curl', '-fL', '--retry', '2', TZ_URL, '-o', str(archive)], check=True)
    if sha(archive) != TZ_SHA: raise RuntimeError('Timezone input checksum mismatch')
    timezone = work / 'timezones.sqlite'
    receipt = work / 'timezone-input.json'
    valid = timezone.exists() and receipt.exists() and json.loads(receipt.read_text()) == {'inputSha256': TZ_SHA, 'databaseSha256': sha(timezone)}
    if not valid:
        unpacked = work / 'timezone-input'
        unpacked.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as zipped:
            for name in zipped.namelist():
                if '/' not in name and name.startswith('combined-shapefile-with-oceans-1970.'):
                    zipped.extract(name, unpacked)
        temporary = work / 'timezones.pending.sqlite'
        temporary.unlink(missing_ok=True)
        subprocess.run(['spatialite_tool', '-i', '-shp', str(unpacked / 'combined-shapefile-with-oceans-1970'),
                        '-d', str(temporary), '-t', 'tz_world', '-s', '4326', '-g', 'geom', '-c', 'UTF-8'], check=True)
        subprocess.run(['spatialite', str(temporary), "SELECT CreateSpatialIndex('tz_world', 'geom'); VACUUM; ANALYZE;"], check=True)
        temporary.rename(timezone)
        receipt.write_text(json.dumps({'inputSha256': TZ_SHA, 'databaseSha256': sha(timezone)}) + '\n')
    return timezone, {'release': '2026c', 'url': TZ_URL, 'sha256': TZ_SHA,
                      'license': 'ODbL 1.0; timezone-boundary-builder / OpenStreetMap contributors'}

def inputs(root, source, work):
    pbf = source / 'test/data/liechtenstein-latest.osm.pbf'
    if sha(pbf) != PBF_SHA: raise RuntimeError('Pinned regional PBF changed')
    timezone, timezone_source = timezone_database(root, work)
    return pbf, timezone, {
        'kind': 'openstreetmap', 'file': 'valhalla/test/data/liechtenstein-latest.osm.pbf',
        'snapshot': '2015-07-27T21:14:01Z', 'sha256': PBF_SHA,
        'attribution': '© OpenStreetMap contributors, ODbL 1.0. Historical benchmark data; not for navigation.',
        'licenseUrl': 'https://www.openstreetmap.org/copyright',
        'timezone': timezone_source,
        'administrativeBoundaries': 'Built by pinned valhalla_build_admins from the same PBF. Extract-boundary completeness is limited.'
    }

def requests(out):
    # Coordinates selected from the pinned OSM snapshot. The synthetic corpus
    # separately provides isolated one-way, restriction and disconnected checks.
    cases = [
        ('vaduz-short', [47.1392862, 9.5227962], [47.1450, 9.5168]),
        ('balzers-ruggell', [47.0666667, 9.5], [47.2397558, 9.5262874]),
        ('vaduz-malbun', [47.1392862, 9.5227962], [47.1027934, 9.6083946]),
        ('restriction-2366291', [47.210584, 9.5023717], [47.210852, 9.5024974]),
        ('outside', [48.5, 10.5], [48.51, 10.51])
    ]
    corpus = [{'name': name, 'request': {
        'locations': [{'lat': p[0], 'lon': p[1], 'radius': 30, 'minimum_reachability': 0} for p in [start, end]],
        'costing': 'auto', 'units': 'kilometers', 'language': 'en-US'
    }} for name, start, end in cases]
    out.mkdir(parents=True, exist_ok=True)
    (out / 'requests.json').write_text(json.dumps(corpus, indent=2) + '\n')
    (out / 'requests.jsonl').write_text(''.join(json.dumps(c['request']) + '\n' for c in corpus))
