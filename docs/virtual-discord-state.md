# Virtual Discord state

`VirtualState` is an in-memory deterministic resource store used by the core and CLI. It stores Discord-shaped records without querying Discord. The word “Discord-shaped” does not mean every resource type or relationship is schema-validated.

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

It does not automatically validate parent relationships, cascade deletes, maintain Discord caches, attach trace links to every record, or apply resource-specific lifecycle rules. Those behaviors must come from the calling engine where implemented.

## Virtual clock

The core clock supports `paused`, `realtime`, and `accelerated` modes. Paused time can move forward explicitly, and scheduled callbacks run deterministically by due time and insertion order. Time cannot move backward. The default scheduler retains at most 100,000 tasks and executes at most 100,000 callbacks in one advance; both limits are configurable, cancellation is indexed, and recursive advance calls fail closed.

Core scenarios use a paused clock. Electron currently uses a real-time clock for its runtime. External bot code is not forced to use either clock.

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

## Persistence and desktop boundary

Snapshots and fixture strings are core values. Export encodes `bigint` values in the stable JSON representation. CLI scenarios and recordings have their own current file contracts, but v0.1 has no persistent workspace database, migration system, automatic fixture save, archive format, or retention manager.

The guild/channel/member data visible in the Discord-like renderer is seeded visual preview state. Editing those panels does not currently mutate `VirtualState`, persist a fixture, or change a CLI scenario run.

Partial/stale-cache simulation, deleted-reference semantics, versioned Discord profiles, and full resource validation are planned. See [Compatibility](../COMPATIBILITY.md).
