import { RoutingError } from './errors.js';
import type { EffectiveSearchMemory } from './types.js';

const defaults: EffectiveSearchMemory = {
  astar: 16384,
  bidirectionalAstar: 16384,
  clearReservedMemory: false,
};

export function resolveSearchMemory(input: unknown): EffectiveSearchMemory {
  const invalid = () => { throw new RoutingError('INVALID_REQUEST', 'searchMemory requires astar/bidirectionalAstar integer reservations from 0 to 2,000,000 and a boolean clearReservedMemory.'); };
  if (input === undefined) return { ...defaults };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const options = input as Record<string, unknown>;
  if (Object.keys(options).some(key => !Object.hasOwn(defaults, key))) return invalid();
  const result = { ...defaults };
  for (const key of ['astar', 'bidirectionalAstar'] as const) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2000000) return invalid();
    result[key] = value;
  }
  if (options.clearReservedMemory !== undefined) {
    if (typeof options.clearReservedMemory !== 'boolean') return invalid();
    result.clearReservedMemory = options.clearReservedMemory;
  }
  return result;
}
