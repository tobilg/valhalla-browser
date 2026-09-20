import type { SerializedRoutingError } from './errors.js';
import type { Coordinates, Costing, CostingOptions, Diagnostics, ProgressDetail, RouteResult, RouterOptions, StartupResult } from './types.js';

export type { NormalizedRequest } from '@tobilg/valhalla-core/protocol';
import type { NormalizedRequest } from '@tobilg/valhalla-core/protocol';
export type WorkerOptions = Pick<RouterOptions, 'manifestUrl' | 'transport' | 'timeoutMs' | 'retries' | 'memoryBudgetBytes' | 'searchMemory' | 'wasmMemory'> & { wasmUrl: string };
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
