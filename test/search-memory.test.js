import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSearchMemory } from '../packages/valhalla-browser/src/search-memory.ts';

test('search reservations default independently and preserve zero and explicit false', () => {
  assert.deepEqual(resolveSearchMemory(undefined), { astar: 16384, bidirectionalAstar: 16384, clearReservedMemory: false });
  const options = { astar: 0, clearReservedMemory: true };
  assert.deepEqual(resolveSearchMemory(options), { astar: 0, bidirectionalAstar: 16384, clearReservedMemory: true });
  assert.deepEqual(options, { astar: 0, clearReservedMemory: true });
  assert.deepEqual(resolveSearchMemory({ astar: 2000000, bidirectionalAstar: 1000000, clearReservedMemory: false }),
    { astar: 2000000, bidirectionalAstar: 1000000, clearReservedMemory: false });
  assert.equal(resolveSearchMemory({ bidirectionalAstar: undefined }).bidirectionalAstar, 16384);
});

test('invalid search reservations reject instead of silently using native defaults', () => {
  for (const input of [null, [], true, 1, '16384', { unknown: 1 }, { dijkstra: 4096 },
    ...['astar', 'bidirectionalAstar'].flatMap(key => [-1, 0.1, 2000001, NaN, Infinity, '100', null, true].map(value => ({ [key]: value }))),
    ...[0, 1, 'false', null].map(clearReservedMemory => ({ clearReservedMemory })),
  ]) assert.throws(() => resolveSearchMemory(input), { code: 'INVALID_REQUEST' });
});
