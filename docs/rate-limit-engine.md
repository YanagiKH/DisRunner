# Rate-limit engine

`RateLimitEngine` is a deterministic, configurable in-process bucket engine. It is used by the scenario runner and partial REST emulator. It is not a complete model of Discord's changing production limits.

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

The scenario runner and Electron runtime each configure a representative shared message-create rule:

```text
POST /channels/:channelId/messages
5 requests / 5,000 ms
major parameter: channelId
```

Scenario `rate-limit-request` actions call that engine. Once denied, the runner emits the implemented `RATE_LIMIT_HOT_BUCKET` finding. There is no version 1 scenario syntax for arbitrary bucket definitions.

## Current limits

v0.1 does not implement an automatic client retry queue, backoff/jitter policy, retry scheduling, malformed-header injection, response-loss/commit faults, latency simulation, invalid-request bans, adaptive Discord quota discovery, or production global-budget prediction. Rules are local test inputs.

The renderer's Rate Limits panel and `/rate-limit` browser-preview behavior are seeded visual data; they are not a live view of every core bucket. Use core/CLI results for executable evidence.
