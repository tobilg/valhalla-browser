/** Stable error categories for input, transport, integrity, native routing and lifecycle failures. */
export type RoutingErrorCode =
  | 'INVALID_REQUEST' | 'UNSUPPORTED_COSTING' | 'DISPOSED' | 'CANCELLED'
  | 'WORKER_FAILED' | 'RUNTIME' | 'NOT_INITIALIZED' | 'NATIVE' | 'NO_ROUTE'
  | 'LOCATION_NOT_FOUND' | 'OUTSIDE_COVERAGE' | 'NETWORK' | 'TIMEOUT'
  | 'ACCESS_DENIED' | 'DATASET' | 'INCOMPATIBLE_DATASET' | 'INCOMPATIBLE_RUNTIME'
  | 'DATASET_MISMATCH' | 'INCOMPLETE_DATASET' | 'RANGE_UNSUPPORTED'
  | 'INVALID_RANGE' | 'CORRUPT_TILE';
/** Serializable error payload used across the worker boundary. */
export interface SerializedRoutingError {
  /** Stable SDK failure category. */
  code: RoutingErrorCode;
  /** Human-readable context; use code for programmatic decisions. */
  message: string;
  /** Whether the underlying failure is transient. */
  retryable: boolean;
  /** Original native Valhalla error number, when applicable. */
  nativeCode?: number;
}
/** Additional error context, including transient retryability and native error code. */
export interface RoutingErrorOptions {
  /** Whether this is a transient failure; defaults to false. */
  retryable?: boolean;
  /** Original native Valhalla error number, when applicable. */
  nativeCode?: number;
  /** Local underlying exception; omitted from serialization across the worker boundary. */
  cause?: unknown;
}
/** A typed SDK failure. Retryable errors are transient; retries must remain bounded. */
export class RoutingError extends Error {
  /** Stable failure category for application error handling. */
  readonly code: RoutingErrorCode;
  /** Transient failure indicator, not a request to retry indefinitely. */
  readonly retryable: boolean;
  /** Native Valhalla error number, if the failure came from the actor. */
  readonly nativeCode?: number;

  /** Construct a typed failure with optional native/retry context and local cause. */
  constructor(code: RoutingErrorCode, message: string, { retryable = false, nativeCode, cause }: RoutingErrorOptions = {}) {
    super(message, { cause });
    this.name = 'RoutingError';
    this.code = code;
    this.retryable = retryable;
    if (nativeCode !== undefined) this.nativeCode = nativeCode;
  }
  /** Return the serializable worker payload; excludes stack and cause. */
  toJSON(): SerializedRoutingError {
    return { code: this.code, message: this.message, retryable: this.retryable, nativeCode: this.nativeCode };
  }
}
export const cancelled = (): RoutingError => new RoutingError('CANCELLED', 'Route cancelled.');
export const asError = (error: unknown): RoutingError => error instanceof RoutingError ? error :
  new RoutingError('RUNTIME', error instanceof Error ? error.message : String(error));
