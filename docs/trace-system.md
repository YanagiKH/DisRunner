# Trace and observability status

DisRunner v0.1 records bounded core spans and includes them in scenario reports. The richer causal graph, runtime profiler, comparison workflow, and fully connected desktop inspector are design targets.

## Implemented core span shape

Each completed core span contains:

- span ID and trace ID, with an optional parent ID;
- kind and name;
- virtual start time and duration;
- `ok`, `warning`, or `error` status;
- bounded metadata.

Supported span kinds include user action, Gateway, interaction, bot handler, REST, state mutation, database, external, and render. A kind being accepted by the data model does not mean every adapter emits it or that the core automatically instruments imported bot/database code.

Core scenario reports include a run ID, seed, start time, pass/status, spans, findings, state hash, assertions, and selected metadata. The CLI sanitizes supported report values before rendering JSON/JUnit/HTML/SARIF.

Raw trace/report/snapshot objects do **not** all carry a public format version, adapter/profile version set, redaction manifest, or complete correlation attributes in v0.1. Only CLI recording files have the versioned replay envelope described in [Protocol compatibility](protocol-compatibility.md).

## Retention and capacity behavior

The core defaults are deliberately finite:

- metadata is limited to 256 KiB per open or completed span;
- at most 512 spans may be open concurrently; a further `start` fails closed with `TraceCapacityError`;
- at most 4,096 completed spans are retained, with deterministic oldest-first eviction;
- open and completed span records share a 32 MiB serialized-byte budget; completed records are evicted oldest-first to admit newer evidence;
- risk evidence retains at most 1,024 distinct findings within an 8 MiB serialized-byte budget. A new finding or oversized update that cannot fit fails closed with `RiskCapacityError` and leaves existing findings unchanged.

All of these capacities can be configured through the core constructors within hard validation ceilings; invalid, non-integer, zero, or excessively large values are rejected. Ending a known span removes it from the open set before processing end metadata, including error paths. If a completed record cannot fit beside still-open spans, `end` returns that record to its caller but does not retain it in `spans()`.

The byte budgets measure serialized records, not exact JavaScript heap overhead. The separate count limits bound Map/ring bookkeeping; callers that hold returned spans or cloned report arrays are responsible for bounding those copies too.

`spans(limit)` clones only the newest requested completed spans. `all(limit)` clones only the requested highest-priority findings (severity descending, then rule ID); the no-argument methods retain their full-snapshot behavior. The Electron runtime uses these bounded queries for its 250 ms evidence refresh, with at most 100 traces and 100 risks per refresh.

Metadata is bounded while it is sanitized, before serialized retention sizing. Trace metadata uses a maximum depth of 16, 2,048 visited values, 512 entries per container, 16,384 characters per input string, and a 1 MiB source-string byte budget. Risk findings use the same depth with 4,096 values, 1,024 entries per container, 32,768 characters per string, and a 2 MiB source-string byte budget. Oversized arrays—including sparse arrays with a huge declared length—produce only the bounded prefix plus a truncation marker.

The public redactor also has finite defaults: 100,000 visited values, 10,000 entries per container, and 16 MiB of source property-name/string bytes. Accessor properties are represented without invoking their getter. Custom enumerable array properties, unsupported values, cycles, depth limits, breadth limits, and byte truncation produce explicit `REDACTION_*` markers; `containsLikelySecret` treats any such incomplete inspection as a potential secret. JavaScript Proxy traps are executable caller code and are not an isolation boundary; a throwing trap can reject sanitization, but a trace `end` still releases its open span first.

## Electron evidence

Electron runtime entries can record a local interaction trace/risk and the renderer can display the raw-webhook callback outcome and duration. Bot stdout/stderr is shown separately and does not carry a guaranteed trace ID. Most inspector payload, state diff, permission, rate-limit, risk, waterfall, and timeline details are seeded visual fixtures.

## Planned views

Future connected-desktop work may add:

- causal flow and sequence views across UI, transport, bot, REST/Gateway, state, and render;
- a real timing waterfall separating queue, handler, dependency, REST, delivery, and render;
- authoritative before/after state diffs and permission/intent/bucket decisions;
- search/filter and semantic trace comparison;
- CPU, memory, event-loop, queue, concurrency, error-rate, and throughput measurements when instrumented;
- versioned trace export with explicit redaction metadata.

These are not v0.1 compatibility claims.

## Interpretation and privacy

Core virtual durations are deterministic simulation evidence. Electron `/ping` duration is host-time loopback evidence. Neither predicts Internet, regional Discord, production dependency, or user-render latency.

Trace metadata and process output can contain sensitive values. CLI sanitization and bot-output redaction reduce common leakage but do not replace manual review. See [Privacy](privacy.md).
