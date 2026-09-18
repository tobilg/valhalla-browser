---
title: Cancellation and errors
---

# Cancellation and errors

`router.route(request, { signal })` accepts an AbortSignal, including during
initialization. `router.cancel()` and an aborted signal terminate the worker,
reject all outstanding requests and discard decoded tiles. A subsequent route
creates a fresh worker. `dispose()` permanently closes the Router.

This is session-wide cancellation: cancelling one queued request cancels the
other pending requests too. A worker message alone cannot interrupt uninterrupted
WASM computation; termination provides that guarantee without reentering a
suspended actor. Stale worker messages are suppressed.

Catch `RoutingError` to distinguish `CANCELLED`, `OUTSIDE_COVERAGE`, `NO_ROUTE`,
transport errors, and integrity/version mismatches. `nativeCode` retains the
native Valhalla code when available. `retryable` describes a transient transport
or timeout failure; it does not instruct the application to retry indefinitely.
Built-in retries are bounded by `retries` and `timeoutMs`.

Transient fetch failures do not enter the native reader's negative cache. They
must remain errors rather than silently turning into a no-route result. A later
route can succeed on the same actor after a recoverable tile failure. Runtime or
initialization failures recreate the worker when necessary.

The README demonstrates cancellation followed by a successful route and typed
error handling. Retain one router between completed requests for cache reuse;
create separate routers only when independent sessions are needed.
