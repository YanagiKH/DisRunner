# Protocol compatibility

DisRunner v0.1 implements selected Discord-shaped contracts for deterministic local tests. It does not claim full API, Gateway, SDK, or desktop-client parity.

## Evidence layers

| Layer            | What v0.1 evidence covers                                                          |
| ---------------- | ---------------------------------------------------------------------------------- |
| Core/CLI         | In-process state, timing, interactions, selected REST/Gateway behavior, assertions |
| Electron runtime | Raw-webhook lifecycle, signed requests, HMAC-authenticated responses, and `/ping`  |
| Desktop renderer | Mainly seeded visual fixtures; only explicitly labeled runtime values are evidence |

A core unit test does not establish that the equivalent desktop/imported-bot path is connected.

## Timing contracts

- Core simulation profile: initial interaction response deadline `3,000 ms` under virtual time.
- Core interaction token lifetime: `900,000 ms` from receipt under virtual time.
- CLI scenarios can exercise exact virtual-time boundaries when represented by supported actions.
- Electron raw-webhook invocation uses a 3-second host-time abort. It does not expose a controllable 15-minute desktop token lifecycle.
- UI render timing is not bot-handler, network, or core virtual time.

## Receive paths

- **Core Gateway:** partial lifecycle and dispatch/intent primitives, plus a local WebSocket transport. Desktop fixtures are not bootstrapped or synchronized as a supported imported-bot environment.
- **Raw interaction webhook:** Ed25519-signed local HTTP request with body/timestamp/replay controls, followed by per-run HMAC verification of the response status and exact bytes before callback validation. Transport peer authentication and Discord-shaped callback validation are distinct failure stages. This is the supported Electron adapter in v0.1.
- **Core REST:** partial local routes for gateway discovery, bot user, guild/channel/message resources, interaction callbacks, and follow-ups. Application-command registration and many Discord routes are absent.

These paths have different authentication, retry, state, and failure semantics and must not be treated as interchangeable.

## Strict and lenient behavior

Strict/lenient handling is currently local to the parser or validator being exercised:

- invalid interaction lifecycle transitions still fail;
- selected REST message validation can reject in strict mode or return validator warnings in lenient mode;
- lenient REST warnings are not yet propagated consistently to reports or desktop UI;
- scenario parsing normalizes supported fields and does not promise preservation of unknown fields.

Do not use `mode: lenient` as a security bypass or assume it turns permission/timing failures into success.

## Saved-format status

CLI recording files have an explicit kind and format version and are verified during replay. Scenario version 1 and the project config version are explicit. Raw report/trace/snapshot envelopes do not all carry a public format version in v0.1; treat them as Preview formats and pin the DisRunner version that produced them.

## Drift management

1. Reduce drift to a minimal anonymized public-contract fixture.
2. Add a contract test at the affected layer.
3. Document the old/new behavior and whether desktop wiring is included.
4. Provide migration handling before promoting a saved format to stable.
5. Update [COMPATIBILITY.md](../COMPATIBILITY.md) and the changelog.

Latency, CDN behavior, regional routing, platform incidents, anti-abuse systems, undocumented rendering, and rollout differences are not reproduced. Voice transport/audio/encryption is out of scope. See [Known limitations](limitations.md).
