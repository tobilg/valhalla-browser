import { RoutingError, cancelled } from './errors.js';

type Waiter = { admit: (release: () => void) => void; reject: (error: unknown) => void; cleanup: () => void };
/** A permit-only FIFO. Native work resumes in the admitted caller's async context. */
export class AdmissionQueue {
  private busy = false;
  private closed = false;
  private readonly waiters: Waiter[] = [];
  constructor(readonly capacity = 8, readonly timeoutMs = 2000) {
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new RoutingError('INVALID_REQUEST', 'Queue capacity must be 0–1024 and queueTimeoutMs 1–60,000.');
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new RoutingError('DISPOSED', 'Router disposed.'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
    if (!this.busy) { this.busy = true; return Promise.resolve(this.permit()); }
    if (this.waiters.length >= this.capacity) return Promise.reject(new RoutingError('QUEUE_FULL', 'Routing queue is full.', { retryable: true }));
    return new Promise((resolve, reject) => {
      const remove = (reason: unknown) => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) { this.waiters.splice(index, 1); waiter.cleanup(); reject(reason); }
      };
      const abort = () => remove(signal?.reason ?? cancelled());
      // This timer also belongs to the waiting request, not the active request.
      const timer = setTimeout(() => remove(new RoutingError('QUEUE_TIMEOUT', 'Routing queue wait expired.', { retryable: true })), this.timeoutMs);
      const waiter: Waiter = { admit: resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private permit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) { next.cleanup(); next.admit(this.permit()); }
      else this.busy = false;
    };
  }
  rejectWaiting(error: RoutingError): void {
    for (const waiter of this.waiters.splice(0)) { waiter.cleanup(); waiter.reject(error); }
  }
  close(): void { this.closed = true; this.rejectWaiting(new RoutingError('DISPOSED', 'Router disposed.')); }
  /** Close normal admission and acquire a cleanup permit without a queue deadline.
   * Each disposal caller waits in its own context, including repeated disposal. */
  acquireForDisposal(): Promise<() => void> {
    if (!this.closed) this.close();
    if (!this.busy) { this.busy = true; return Promise.resolve(this.permit()); }
    return new Promise((resolve, reject) => {
      // workerd considers a request hung if its only pending promise can be
      // resolved by a different request. Ordinary admission has its deadline
      // timer; draining likewise needs a request-owned event until admission.
      const keepAlive = setInterval(() => {}, 1000);
      this.waiters.push({ admit: resolve, reject, cleanup: () => clearInterval(keepAlive) });
    });
  }
}

export function deadline(external: AbortSignal | undefined, timeoutMs: number): { controller: AbortController; signal: AbortSignal; cleanup: () => void } {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new RoutingError('INVALID_REQUEST', 'routeTimeoutMs must be 1–300,000.');
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new RoutingError('TIMEOUT', 'Routing operation deadline expired.')), timeoutMs);
  return { controller, signal: controller.signal, cleanup: () => { clearTimeout(timer); external?.removeEventListener('abort', abort); } };
}
