# Rate-limit engine

`RateLimitEngine` is a configurable in-process bucket engine used by model scenarios and shared raw/SDK REST sessions. It uses the supplied clock: paused/virtual for model scenarios and realtime for Bot sessions. It does not model all of Discord's changing production limits.

## Implemented rules and buckets

A rule contains a route template, positive limit/window, optional HTTP method, scope (`user`, `shared`, or `global`), optional ID, and optional major-parameter names. Templates use named path segments such as `/channels/:channelId/messages`.

For a matching request, the engine:

- normalizes method and path;
- derives a bucket from the rule, configured major parameters, and identity/scope;
- consumes capacity against the injected virtual clock;
- resets a bucket after its configured window;
- returns a result with limit, remaining, reset time, retry duration, scope, headers, and a Discord-shaped `429` body when denied;
- bounds stored buckets and observed request mappings.

Unmatched routes are unrestricted and return no rate-limit headers.

## Returned headers

Configured buckets can return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Reset-After`, `X-RateLimit-Bucket`, and `X-RateLimit-Scope`. A denied result returns `Retry-After`. A limit activated by `injectGlobalLimit()` also returns `X-RateLimit-Global` and marks the body as global.

`observe()` can update a bucket from a complete set of observed limit, remaining, reset-after, and bucket headers. `injectGlobalLimit()` can impose a deterministic global pause. These are programmatic core APIs, not capture of live Discord traffic.

## Current built-in profile

The model runner and shared Desktop/CLI runtime configure a representative shared message-create rule:

```text
POST /channels/:channelId/messages
5 requests / 5,000 ms
major parameter: channelId
```

Version 1 `rate-limit-request` actions call that engine. Once denied, the model runner emits `RATE_LIMIT_HOT_BUCKET`. There is no version 1 scenario syntax for arbitrary bucket definitions. The extended API profile keeps token-authenticated interaction/webhook requests outside an injected Bot global pause while retaining applicable route buckets.

Version 2 fault plans can return bounded HTTP 429/500/502/503 effects or delay/timeout selected operations. Actual SDK client code handles its own supported retries; DisRunner observes the resulting requests and messages rather than fabricating a successful retry. Plans and receipts belong to one Session and are cleared on stop/reset. See [Fault injection](fault-injection.md).

## Current limits

DisRunner does not provide a general client retry queue, arbitrary backoff/jitter scheduler, malformed-header injection, commit-then-lose-response faults, invalid-request bans, adaptive Discord quota discovery, or production global-budget prediction. Configured buckets and scoped fault plans are local test inputs.

The browser demo's rate-limit examples are illustrative; Desktop does not expose a complete live inspector of every core bucket. Use actual REST status/headers, traces, fault receipts, and scenario assertions for the supported behavior.
