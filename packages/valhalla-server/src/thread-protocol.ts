import type { EngineOptions, EngineRoute, EngineStartup, EngineDiagnostics } from '@tobilg/valhalla-core/engine';
import type { NormalizedRequest } from '@tobilg/valhalla-core/protocol';
import type { SerializedRoutingError } from '@tobilg/valhalla-core/errors';
import type { ProgressDetail } from '@tobilg/valhalla-core/types';
export interface ThreadOperations {
  initialize: { options: EngineOptions; result: EngineStartup };
  route: { request: NormalizedRequest; result: EngineRoute };
  diagnostics: { result: EngineDiagnostics };
}
export type ThreadRequest = { [K in keyof ThreadOperations]: { id: number; type: K } & Omit<ThreadOperations[K], 'result'> }[keyof ThreadOperations];
export type ThreadResponse = { id: number } & (
  { type: 'result'; result: ThreadOperations[keyof ThreadOperations]['result'] } |
  { type: 'error'; error: SerializedRoutingError } |
  { type: 'progress'; detail: ProgressDetail });
