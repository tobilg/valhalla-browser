import type { Coordinates, Costing, CostingOptions } from './types.js';

/** Validated request with explicit correlation radius, reachability, units and language defaults. */
export interface NormalizedRequest {
  /** Ordered start/end coordinates with the SDK's explicit correlation defaults. */
  locations: Array<Coordinates & {
    /** Correlation search radius in meters; the SDK sets 30. */
    radius: number;
    /** Minimum connected-node reachability; the SDK sets 0. */
    minimum_reachability: number;
  }>;
  /** Validated road profile. */
  costing: Costing;
  /** Validated options belonging to the selected profile. Unspecified values use native defaults. */
  costing_options?: CostingOptions;
  /** Native response distance units. */
  units: 'kilometers';
  /** Native instruction language. */
  language: 'en-US';
}
