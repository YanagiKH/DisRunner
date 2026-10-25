# Virtual Discord state

`VirtualState` is the in-memory resource store used by model scenarios and real Bot sessions. It stores Discord-shaped records without querying Discord. The generic store accepts broader records than the validated workspace and runtime domains.

## Implemented resource store

Each resource has a non-empty string `id`, a non-empty string `resourceType`, and additional bounded values made from finite numbers, strings, booleans, `null`, `bigint`, plain objects, and arrays. Undefined values, non-plain objects, cycles, and shared object references are rejected. The public type lists familiar Discord resource names and also accepts other string types. Creating a resource without an ID uses the seeded Snowflake-like generator.

The store supports:

- create, get/require, list, update, and delete;
- deep-cloned reads and deterministic ordering;
- grouped transactions with rollback on an exception;
- mutation history plus in-memory undo/redo;
- version 1 snapshots with a stable SHA-256 resource hash;
- hash-checked snapshot restore, reset, clone, and state diff;
- in-memory JSON fixture import/export.

Default capacities are 10,000 resources, 1 MiB per resource, 64 MiB total state, a 16 MiB fixture, 1,000 history entries, and 32 MiB of history. One resource is also bounded to 32 nested levels and 10,000 visited nodes. Callers can lower or explicitly change these positive safe-integer limits. If one mutation is too large to retain within the history-byte limit, it becomes an undo barrier rather than leaving older incompatible undo entries active.

The generic store does not automatically validate parent relationships, cascade deletes, maintain SDK caches, or attach trace links to every record. The workspace validator checks supported resource relationships; runtime message/interaction/resource domain services add their declared authorization, mutation, deletion, and Gateway event rules. Those guarantees come from the domain layer rather than a generic `state.create` call.

## Virtual clock

The core clock supports `paused`, `realtime`, and `accelerated` modes. Paused time can move forward explicitly, and scheduled callbacks run deterministically by due time and insertion order. Time cannot move backward. The default scheduler retains at most 100,000 tasks and executes at most 100,000 callbacks in one advance; both limits are configurable, cancellation is indexed, and recursive advance calls fail closed.

Version 1 model scenarios use a paused clock. Desktop and CLI version 2 sessions use realtime. External Bot code is not forced to use the core scheduler, so seeded state alone cannot make host timers or SDK execution deterministic.

## Selected payload limits

`validateMessagePayload` implements a bounded subset:

| Rule              | Current validator                                                                       |
| ----------------- | --------------------------------------------------------------------------------------- |
| Message content   | string, at most 2,000 characters                                                        |
| Embeds            | at most 10; selected title/description/footer/author/field lengths; 6,000 combined text |
| Attachments array | at most 10 entries; attachment contents are not otherwise validated                     |
| Legacy components | at most five top-level rows and five child components per row                           |
| Components V2     | content/embed conflict and at most 40 scanned components when the flag is set           |
| Component IDs     | `custom_id` length 1–100 and uniqueness across scanned nodes                            |
| Traversal safety  | at most 16 nested levels and 1,000 scanned component nodes; cycles rejected             |

Strict mode reports these as errors. Lenient mode records them as warnings, although warning surfacing is not consistent across every caller. The validator does not implement the complete component catalog, every field/type constraint, upload byte limits, attachment presentation semantics, poll/sticker restrictions, or all Components V2 rules.

This table describes the generic validator, not the full runtime protocol contract. Runtime domains additionally validate legacy component/modal fields and bounded attachment metadata/uploads. Components V2 remains unsupported even though the generic validator recognizes some of its structural constraints. See [REST emulator](rest-emulator.md) and [Interaction engine](interaction-engine.md).

## Persistence and desktop boundary

Snapshots and fixture strings are core values. Export encodes `bigint` values in the stable JSON representation. Project persistence uses versioned `.disrunner/workspace.json`, with validated resources, saved scenarios/options, conflict checks, atomic saves, and backup/recovery files. Desktop fixture edits affect the next clean session after saving; they do not rewrite a running Session's frozen inputs. See [Workspaces](workspaces.md).

Live Desktop resources/messages are projections of the current retained state. Public snapshots omit private records; actor views apply the supported channel/recipient rules and include that actor's ephemeral replies. CLI Scenario v2 uses those same views for assertions. The browser demo remains separate.

The current Session profile considers up to 2,000 resources within a 1 MiB serialized projection. This includes the reference workspace with 1 guild, 10 channels, 100 users, 1,000 messages and 50 registered commands. If the count limit is exceeded, structural resources remain available and the newest timestamped messages fill the remaining slots. Earlier raw compatibility profiles retain their 1,000-resource bound. Count or byte loss sets `evidenceComplete: false`; Scenario v2 cannot pass with that incomplete view. Expected privacy filtering is reported separately from capture loss.

There is no general stale-cache model, process-memory checkpoint, or complete Discord resource validator. Reproduction bundles describe inputs for a fresh Bot rerun and require the original project. See [Compatibility](../COMPATIBILITY.md).
