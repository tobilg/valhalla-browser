import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRequest } from '../packages/valhalla-browser/src/profiles.ts';
import { TileLoader } from '../packages/valhalla-browser/src/loader.ts';

const points = { origin: { lat: 47, lon: 9 }, destination: { lat: 47.1, lon: 9.1 } };
test('driving remains the default; inputs and selected options are copied', () => {
  assert.equal(validateRequest(points).costing, 'auto');
  for (const [costing, options] of [['bicycle', { bicycle_type: 'road', cycling_speed: 25, use_roads: 0 }],
    ['pedestrian', { walking_speed: 4 }], ['truck', { height: 4, width: 2.5, length: 12, weight: 20, axle_load: 8, hazmat: true }]]) {
    const input = { ...points, costing, costing_options: { [costing]: options } };
    const result = validateRequest(input);
    assert.equal(result.costing, costing);
    assert.deepEqual(result.costing_options, input.costing_options);
    assert.notStrictEqual(result.costing_options[costing], options);
    assert.deepEqual(validateRequest({ ...points, costing }).costing_options, undefined);
  }
});
test('profile settings reject mismatched groups, unknown fields and invalid values', () => {
  for (const costing of ['transit', 'multimodal', 'motorcycle', null, '', 1])
    assert.throws(() => validateRequest({ ...points, costing }), { code: 'UNSUPPORTED_COSTING' });
  for (const [costing, costing_options] of [
    ['auto', { auto: {} }], ['bicycle', { truck: {} }], ['bicycle', { bicycle: {}, truck: {} }],
    ['bicycle', null], ['bicycle', []], ['bicycle', { bicycle: [] }], ['truck', { truck: { ignore_restrictions: true } }],
    ['bicycle', { bicycle: { bicycle_type: 'electric' } }], ['bicycle', { bicycle: { cycling_speed: '20' } }],
    ['bicycle', { bicycle: { cycling_speed: 4.99 } }], ['bicycle', { bicycle: { cycling_speed: 60.01 } }],
    ['bicycle', { bicycle: { use_roads: -0.1 } }], ['pedestrian', { pedestrian: { walking_speed: 0 } }],
    ['pedestrian', { pedestrian: { walking_speed: NaN } }], ['truck', { truck: { height: Infinity } }],
    ['truck', { truck: { width: 11 } }], ['truck', { truck: { length: 51 } }],
    ['truck', { truck: { weight: 101 } }], ['truck', { truck: { axle_load: 41 } }], ['truck', { truck: { hazmat: 1 } }],
  ]) assert.throws(() => validateRequest({ ...points, costing, costing_options }), { code: 'INVALID_REQUEST' });
});
test('dataset capabilities accept legacy auto, non-auto subsets and known profiles alongside future ones', async () => {
  const manifest = JSON.parse(await readFile('fixtures/manifest.json'));
  const url = `https://routing.example.com/datasets/${manifest.release}/manifest.json`;
  for (const costings of [['auto'], ['bicycle'], ['pedestrian', 'truck'], ['auto', 'future']])
    assert.doesNotThrow(() => new TileLoader({ ...manifest, costings }, url));
  for (const costings of [undefined, [], ['auto', 'auto'], [null], 'auto'])
    assert.throws(() => new TileLoader({ ...manifest, costings }, url), { code: 'DATASET' });
  assert.throws(() => new TileLoader({ ...manifest, costings: ['transit'] }, url), { code: 'INCOMPATIBLE_DATASET' });
});

test('native fixture proves access, bicycle contraflow, truck restrictions and speed settings', async () => {
  const { cases } = JSON.parse(await readFile('fixtures/reference.json'));
  const trip = name => {
    const fixture = cases.find(item => item.name === name);
    assert(fixture?.expected.trip, `Expected a native route for ${name}`);
    return fixture.expected.trip;
  };
  for (const [short, long] of [
    ['cycle-shortcut-bicycle', 'cycle-shortcut-auto'], ['cycle-shortcut-bicycle', 'cycle-shortcut-pedestrian'],
    ['walk-shortcut-pedestrian', 'walk-shortcut-bicycle'], ['walk-shortcut-pedestrian', 'walk-shortcut-auto'],
    ['cycle-contraflow-bicycle', 'cycle-contraflow-auto'],
    ...['height', 'width', 'length', 'weight', 'axle_load', 'hazmat'].map(key => [`truck-${key}-allowed`, `truck-${key}-restricted`]),
  ]) {
    assert(trip(short).summary.length < trip(long).summary.length / 2, `${long} must detour`);
    assert.notEqual(trip(short).legs[0].shape, trip(long).legs[0].shape);
  }
  for (const [costing, mode] of [['bicycle', 'bicycle'], ['pedestrian', 'pedestrian'], ['truck', 'drive']])
    assert(trip(`short-${costing}`).legs[0].maneuvers.every(m => m.travel_mode === mode));
  assert(trip('short-bicycle-configured').summary.time < trip('short-bicycle').summary.time);
  assert(trip('short-pedestrian-configured').summary.time > trip('short-pedestrian').summary.time);
});
