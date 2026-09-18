import type { SerializedRoutingError } from './errors.js';
import type { Coordinates, Diagnostics, ProgressDetail, RouteResult, RouterOptions, StartupResult } from './types.js';

/** Validated request with explicit correlation radius, reachability, units and language defaults. */
export interface NormalizedRequest {
  /** Ordered start/end coordinates with the SDK's explicit correlation defaults. */
  locations: Array<Coordinates & {
    /** Correlation search radius in meters; the SDK sets 30. */
    radius: number;
    /** Minimum connected-node reachability; the SDK sets 0. */
    minimum_reachability: number;
  }>;
  /** Validated driving profile. */
  costing: 'auto';
  /** Native response distance units. */
  units: 'kilometers';
  /** Native instruction language. */
  language: 'en-US';
}
export type WorkerOptions = Pick<RouterOptions, 'manifestUrl' | 'transport' | 'timeoutMs' | 'retries' | 'memoryBudgetBytes'> & { wasmUrl: string };
export interface Operations {
  initialize: { payload: { options: WorkerOptions }; result: Omit<StartupResult, 'workerReadyMs'> };
  route: { payload: { request: NormalizedRequest }; result: Omit<RouteResult, 'diagnostics'> & { diagnostics: Omit<RouteResult['diagnostics'], 'hostRouteMs'> } };
  diagnostics: { payload: Record<string, never>; result: Diagnostics };
}
export type WorkerRequest = {
  [K in keyof Operations]: { id: number; type: K } & Operations[K]['payload']
}[keyof Operations];
export type WorkerResponse =
  | { type: 'ready' }
  | { id: number; type: 'progress'; detail: ProgressDetail }
  | { id: number; type: 'result'; result: Operations[keyof Operations]['result'] }
  | { id: number; type: 'error'; error: SerializedRoutingError };
