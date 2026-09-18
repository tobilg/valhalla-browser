#!/usr/bin/env python3
"""Deterministic synthetic OSM input, processed by the real native tile builder."""
import json
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

out = Path('fixtures')
out.mkdir(exist_ok=True)
osm = Element('osm', version='0.6', generator='valhalla-browser-fixture-v1')
nodes = {}
for row in range(7):
    for col in range(7):
        node_id = 1 + row * 7 + col
        point = {'lat': round(47.235 + row * .005, 6), 'lon': round(9.235 + col * .005, 6)}
        nodes[row, col] = node_id
        SubElement(osm, 'node', id=str(node_id), version='1', **{k: str(v) for k, v in point.items()})
for node_id, lat, lon in [(100, 47.30, 9.30), (101, 47.30, 9.31), (102, 47.31, 9.31),
                          (110, 47.55, 9.55), (111, 47.55, 9.56)]:
    SubElement(osm, 'node', id=str(node_id), version='1', lat=str(lat), lon=str(lon))

ways = {}
way_id = 1000
def way(name, refs, highway='residential', oneway=False):
    global way_id
    way_id += 1
    w = SubElement(osm, 'way', id=str(way_id), version='1')
    for ref in refs: SubElement(w, 'nd', ref=str(ref))
    tags = {'highway': highway, 'name': name, 'maxspeed': '40'}
    if oneway: tags['oneway'] = 'yes'
    for key, value in tags.items(): SubElement(w, 'tag', k=key, v=value)
    return way_id

for row in range(7):
    for col in range(6):
        ways['h', row, col] = way(f'Row {row}', [nodes[row, col], nodes[row, col+1]],
            'primary' if row == 3 else 'residential', row == 2 and col == 2)
for col in range(7):
    for row in range(6):
        ways['v', row, col] = way(f'Column {col}', [nodes[row, col], nodes[row+1, col]],
            'secondary' if col == 3 else 'residential')
way('Disconnected road', [100, 101, 102])
way('Unused distant road', [110, 111])
r = SubElement(osm, 'relation', id='2000', version='1')
SubElement(r, 'member', type='way', ref=str(ways['h', 3, 2]), role='from')
SubElement(r, 'member', type='node', ref=str(nodes[3, 3]), role='via')
SubElement(r, 'member', type='way', ref=str(ways['v', 3, 3]), role='to')
SubElement(r, 'tag', k='type', v='restriction')
SubElement(r, 'tag', k='restriction', v='no_left_turn')
(out / 'development.osm').write_bytes(tostring(osm, encoding='utf-8', xml_declaration=True))

cases = [
    ('short', [47.240, 9.2355], [47.240, 9.2395]),
    ('cross-tile', [47.235, 9.2355], [47.265, 9.2645]),
    ('oneway-forward', [47.245, 9.2455], [47.245, 9.2495]),
    ('oneway-reverse', [47.245, 9.2495], [47.245, 9.2455]),
    ('restricted-turn', [47.250, 9.2455], [47.2545, 9.250]),
    ('disconnected', [47.240, 9.2355], [47.300, 9.305]),
    ('outside', [48.5, 10.5], [48.51, 10.51])
]
corpus = []
for name, start, end in cases:
    request = {'locations': [{'lat': p[0], 'lon': p[1], 'radius': 30, 'minimum_reachability': 0} for p in [start, end]],
               'costing': 'auto', 'units': 'kilometers', 'language': 'en-US'}
    corpus.append({'name': name, 'request': request})
(out / 'requests.json').write_text(json.dumps(corpus, indent=2) + '\n')
(out / 'requests.jsonl').write_text(''.join(json.dumps(c['request']) + '\n' for c in corpus))
