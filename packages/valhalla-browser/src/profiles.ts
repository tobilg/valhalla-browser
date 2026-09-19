import { RoutingError } from './errors.js';
import type { Coordinates, Costing, CostingOptions } from './types.js';
import type { NormalizedRequest } from './protocol.js';

export const SUPPORTED_COSTINGS: readonly Costing[] = ['auto', 'bicycle', 'pedestrian', 'truck'];
const ranges: Record<string, Record<string, readonly [number, number]>> = {
  bicycle: { cycling_speed: [5, 60], use_roads: [0, 1] },
  pedestrian: { walking_speed: [0.5, 25] },
  truck: { height: [0, 10], width: [0, 10], length: [0, 50], weight: [0, 100], axle_load: [0, 40] },
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => { throw new RoutingError('INVALID_REQUEST', message); };

/**
 * Validate and copy a two-location road request without loading WASM.
 * @param request - Unknown input to validate as a {@link RouteRequest}.
 * @returns Native request with explicit correlation, units and language defaults; omitted profile options remain unset.
 * @throws {@link RoutingError} with `INVALID_REQUEST` for invalid settings or `UNSUPPORTED_COSTING` for an unknown profile.
 */
export function validateRequest(request: unknown): NormalizedRequest {
  if (!object(request)) return invalid('A route request is required.');
  const costing = request.costing === undefined ? 'auto' : request.costing;
  if (!SUPPORTED_COSTINGS.includes(costing as Costing)) throw new RoutingError('UNSUPPORTED_COSTING', 'Supported profiles: auto, bicycle, pedestrian, truck.');
  const locations = request.locations ?? [request.origin, request.destination];
  if (!Array.isArray(locations) || locations.length !== 2) return invalid('Exactly two locations are required.');
  for (const point of locations) {
    if (!object(point) || typeof point.lat !== 'number' || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 ||
        typeof point.lon !== 'number' || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180)
      return invalid('Coordinates must be finite latitude/longitude values.');
  }
  const result: NormalizedRequest = {
    locations: (locations as Coordinates[]).map(({ lat, lon }) => ({ lat, lon, radius: 30, minimum_reachability: 0 })),
    costing: costing as Costing, units: 'kilometers', language: 'en-US',
  };
  if (request.costing_options !== undefined) {
    const groups = request.costing_options;
    if (costing === 'auto' || !object(groups) || Object.keys(groups).length !== 1 || !Object.hasOwn(groups, costing as string))
      return invalid('costing_options must contain only the selected profile. Driving options are not exposed.');
    const options = groups[costing as string];
    if (!object(options)) return invalid('Profile options must be an object.');
    const copied: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      const range = Object.hasOwn(ranges[costing as string], key) ? ranges[costing as string][key] : undefined;
      if (range) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1])
          return invalid(`${costing}.${key} must be a finite number from ${range[0]} to ${range[1]}.`);
      } else if (costing === 'bicycle' && key === 'bicycle_type') {
        if (!['road', 'cross', 'hybrid', 'mountain'].includes(value as string)) return invalid('Invalid bicycle_type.');
      } else if (costing === 'truck' && key === 'hazmat') {
        if (typeof value !== 'boolean') return invalid('truck.hazmat must be a boolean.');
      } else return invalid(`Unsupported option: ${costing}.${key}.`);
      copied[key] = value;
    }
    result.costing_options = { [costing as string]: copied } as CostingOptions;
  }
  return result;
}
