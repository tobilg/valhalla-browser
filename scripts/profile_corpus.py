"""Additional requests for the same native actor; never precomputed route output."""
import copy

def extend(corpus, names):
    original = [case for case in corpus if case['name'] in names]
    for costing in ['bicycle', 'pedestrian', 'truck']:
        for case in original:
            request = copy.deepcopy(case['request'])
            request['costing'] = costing
            corpus.append({'name': f'{case["name"]}-{costing}', 'profileCase': True, 'request': request})
    first = original[0]
    settings = [('bicycle', {'bicycle_type': 'road', 'cycling_speed': 24, 'use_roads': 0.2}),
                ('pedestrian', {'walking_speed': 4}),
                ('truck', {'height': 2.5, 'width': 2, 'length': 6, 'weight': 5, 'axle_load': 2, 'hazmat': False})]
    for costing, options in settings:
        request = copy.deepcopy(first['request'])
        request.update(costing=costing, costing_options={costing: options})
        corpus.append({'name': f'{first["name"]}-{costing}-configured', 'profileCase': True, 'request': request})
