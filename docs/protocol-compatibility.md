# Protocol compatibility

DisRunner's local profile uses Discord API v10 and a single-shard JSON Gateway. The same session state drives Desktop, CLI, REST, Gateway, and version 2 assertions. SDK support applies to the exact versions listed in [Compatibility](../COMPATIBILITY.md).

## Execution paths

| Path                  | Behavior                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Version 1 core model  | Virtual clock, controlled state and model actions; no imported Bot process                                      |
| Raw webhook           | Separate process, Ed25519-signed requests, per-run response HMAC, actual callback observation                   |
| JavaScript/Python SDK | Separate process with version-checked bootstrap, local REST/Gateway, normal SDK handlers/cache/collectors/Views |
| Desktop               | Actions and views over the shared session; saved workspace resources and scenarios                              |

Request signing, raw peer authentication, interaction-token authorization, and synthetic Bot authorization are different protocol boundaries. An accepted TCP connection alone does not establish Bot readiness or a valid callback.

## Timing contracts

The model accepts an initial callback at 2,999 ms and rejects it at 3,000 ms. Its token is valid at 899,999 ms and expired at 900,000 ms. Version 1 tests can exercise those exact virtual boundaries.

Real Bot sessions use a realtime clock and separate host deadlines/cancellation. SDK timers are not accelerated. A deferred response acknowledges the interaction; completing the original response, fetching it, and sending a followup remain separate operations. UI animation and rendering duration are not handler or transport duration.

## Receive paths and state

Gateway bootstrap supplies the selected Bot/application and fixture guild/channel/role/member data through READY and GUILD_CREATE. Requested intents are validated against known bits and the local privileged-intent allowlist. MESSAGE_CONTENT filtering distinguishes guild messages, mentions, DMs, and own messages. Reconnect/resume uses the actual dynamic URL and bounded retained sequence history.

REST supports discovery, bootstrap identities, command registration, the declared resource/message operations, interaction callback, original/followup routes, and bounded local attachments. Messages use one authoritative state model. Public committed messages can emit Gateway events; ephemeral messages remain actor/token-bound and do not broadcast to the guild.

PATCH preserves omitted fields, distinguishes explicit clearing, and does not revive deleted messages. Routes validate resource/message/application ownership and token expiry before accepting mutation. See [REST emulator](rest-emulator.md) and [Interaction engine](interaction-engine.md) for exact profiles and errors.

## Configuration and payload validation

Project configuration, workspace envelopes, and scenario actions reject unknown closed fields. Resource payloads and protocol extension fields follow their specific validators. Version 2 does not accept model actions that directly specify a fabricated Bot response.

Strict/lenient mode applies to the selected payload validators. It does not disable authentication, change legal callback transitions, grant permissions, or extend token lifetimes. Unlisted routes and unsupported fields do not receive empty success responses.

## Commands and components

`command-registry-v1` preserves the earlier restricted registration contract. `command-registry-v2` supports the documented typed options, nested subcommands, choices, autocomplete and context-command subset. SDK projects select v2 by default; raw projects opt in explicitly.

Legacy message buttons/selects and text-input modals use real interaction payloads and the SDK dispatch pipeline. Disabled/link buttons do not produce component interactions, and cancelling a modal does not produce a submission. Components V2, new modal controls, and user-installed command contexts are outside this profile.

## Saved formats and results

Project configs and workspaces use version 1 envelopes. Version 1 scenarios retain model semantics; [version 2](scenario-v2.md) explicitly selects a real Bot and realtime clock. Recordings carry their own format version. Version 2 reports identify run ID, adapter, normalized scenario hash, completeness, and fault receipts.

Version 2 returns 0 for pass, 1 for behavior failure, 2 for invalid/unsupported input, 3 for runtime/cleanup/output failure, 130 for Ctrl+C/SIGINT cancellation, and 143 for SIGTERM cancellation on POSIX systems. Use Ctrl+C for graceful Windows cancellation. Expected negative behavior requires an explicit assertion; an unconsumed error or unused declared fault cannot be silently treated as success.

## Drift management

Reduce a discrepancy to a redacted fixture and record the DisRunner, SDK, and interpreter versions. Add a check at the affected transport/state/UI boundary and update the documented profile before expanding support. A core unit test alone does not establish an installed desktop or SDK path.

Regional routing, CDN behavior, anti-abuse systems, platform incidents, arbitrary process timing, voice systems, and undocumented client behavior are not reproduced.
