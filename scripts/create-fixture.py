#!/usr/bin/env python3
"""Deterministic synthetic OSM input, processed by the real native tile builder."""
import json
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring
from profile_corpus import extend

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
def way(name, refs, highway='residential', oneway=False, extra=None):
    global way_id
    way_id += 1
    w = SubElement(osm, 'way', id=str(way_id), version='1')
    for ref in refs: SubElement(w, 'nd', ref=str(ref))
    tags = {'highway': highway, 'name': name, 'maxspeed': '40'}
    if oneway: tags['oneway'] = 'yes'
    tags.update(extra or {})
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
# Isolated networks keep the established driving grid unchanged. Requests start
# on ordinary approach roads so correlation cannot snap around a restriction.
profile_cases = []
def request(name, start, end, costing, options=None):
    value = {'locations': [{'lat': p[0], 'lon': p[1], 'radius': 30, 'minimum_reachability': 0} for p in [start, end]],
             'costing': costing, 'units': 'kilometers', 'language': 'en-US'}
    if options is not None: value['costing_options'] = {costing: options}
    profile_cases.append({'name': name, 'profileCase': True, 'request': value})

networks = [('cycle-shortcut', 'cycleway', {'foot': 'no', 'bicycle': 'yes'}),
            ('walk-shortcut', 'footway', {'bicycle': 'no', 'foot': 'yes'}),
            ('cycle-contraflow', 'residential', {'oneway': 'yes', 'oneway:bicycle': 'no'}),
            *[(f'truck-{key}', 'residential', {tag: value}) for key, tag, value in [
                ('height', 'maxheight', '3.5'), ('width', 'maxwidth', '2.4'), ('length', 'maxlength', '10'),
                ('weight', 'maxweight', '10'), ('axle_load', 'maxaxleload', '5'), ('hazmat', 'hazmat', 'no')]]]
for index, (name, highway, tags) in enumerate(networks):
    lat, lon = round(47.34 + index * .015, 6), 9.35
    positions = [(lat, lon), (lat, lon+.002), (lat, lon+.01), (lat, lon+.012),
                 (lat+.006, lon+.002), (lat+.006, lon+.01)]
    ids = [300 + index * 10 + i for i in range(6)]
    for node_id, (y, x) in zip(ids, positions):
        SubElement(osm, 'node', id=str(node_id), version='1', lat=str(y), lon=str(round(x, 6)))
    way(name+' west approach', ids[:2])
    way(name+' east approach', ids[2:4])
    way(name+' shortcut', ids[1:3], highway, extra=tags)
    way(name+' detour', [ids[1], ids[4], ids[5], ids[2]])
    start, end = [lat, lon+.001], [lat, lon+.011]
    if name == 'cycle-contraflow': start, end = end, start
    if name.startswith('truck-'):
        small = {'height': 2, 'width': 2, 'length': 6, 'weight': 4, 'axle_load': 2, 'hazmat': False}
        large = {**small, name[6:]: {'height': 4, 'width': 3, 'length': 12, 'weight': 15, 'axle_load': 7, 'hazmat': True}[name[6:]]}
        request(name+'-allowed', start, end, 'truck', small)
        request(name+'-restricted', start, end, 'truck', large)
    else:
        for costing in ['auto', 'bicycle', 'pedestrian']: request(name+'-'+costing, start, end, costing)

# OSM requires nodes before ways and relations, including the added networks.
osm[:] = sorted(osm, key=lambda element: {'node': 0, 'way': 1, 'relation': 2}[element.tag])
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
extend(corpus, ['short', 'cross-tile', 'disconnected', 'outside'])
corpus.extend(profile_cases)
(out / 'requests.json').write_text(json.dumps(corpus, indent=2) + '\n')
(out / 'requests.jsonl').write_text(''.join(json.dumps(c['request']) + '\n' for c in corpus))
