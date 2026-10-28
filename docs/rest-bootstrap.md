# REST bootstrap identity profile

`LocalRestEmulator` accepts an optional `bootstrap` profile that fixes the identity returned by two local REST routes. It is synthetic test data supplied by the caller. Shared raw and pinned SDK sessions supply it automatically. These two routes alone do not establish SDK compatibility; the supported versions and wider protocol subset are listed in [SDK adapters](sdk-adapters.md).

## Routes

| Method | Route                      | Configured                      | Not configured (default)                                      |
| ------ | -------------------------- | ------------------------------- | ------------------------------------------------------------- |
| `GET`  | `/users/@me`               | Returns `bootstrap.user`        | Unchanged: first bot user in state, else a synthetic fallback |
| `GET`  | `/oauth2/applications/@me` | Returns `bootstrap.application` | `404` with `{"code":0,"message":"404: Not Found"}`            |

For supported paths, both routes check loopback `Host`, then the per-instance synthetic `Authorization` value (bare or with the `Bot ` prefix), then the injected `RateLimitEngine`, then routing. A wrong, missing, or `Bearer` credential returns `401` before quota is consumed and never includes profile data. An exhausted bucket returns `429`. Other methods and nearby paths (for example a trailing slash, `/oauth2/applications`, or `/oauth2/applications/@me/assets`) return `404`. API v10 is the current profile. Older direct core profiles accept v9-prefixed/unprefixed routes; `command-registry-v2` rejects unsupported explicit API versions with `501` before ordinary authorization/routing.

When no profile is configured, the application route is never inferred from a bot user in state. The profile is never written to `VirtualState`.

## Profile shape

```ts
const bootstrap = {
  user: {
    id: '100000000000000001',
    username: 'DisRunner Test Bot',
    discriminator: '0',
    avatar: null,
    bot: true,
  },
  application: {
    id: '100000000000000002',
    name: 'DisRunner Test Application',
    description: 'Synthetic application profile for local tests.',
    icon: null,
    bot_public: false,
    bot_require_code_grant: false,
    owner: {
      id: '100000000000000003',
      username: 'test-owner',
      discriminator: '0',
      avatar: null,
      bot: false,
    },
    verify_key: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    flags: 0,
    team: null,
  },
};
```

The response bodies contain exactly these fields. The field names follow the public shape of the user and application objects; that shape was used as a reference only and is not evidence of compatibility with any client library.

## Validation

The constructor validates the profile synchronously and throws `TypeError`, naming the field path, before any listener is created. Field values are not echoed in the message.

- Each level (the profile, `user`, `application`, `application.owner`) must be a plain object whose prototype is `Object.prototype` or `null`. Class instances and arrays are rejected.
- Exactly the listed fields are required. Missing fields, unknown fields, symbol keys, non-enumerable properties, inherited fields, and accessors (getters or setters) are rejected. Properties are read through their descriptors, so a getter is never invoked.
- IDs are canonical positive decimal strings within the unsigned 64-bit range (`1` to `18446744073709551615`, no leading zeros). The application ID may equal the user ID.
- `username` and `name` are 1-100 UTF-8 bytes; `description` is 0-1024 bytes. Strings must be well-formed (no lone surrogates).
- `discriminator` is `"0"` or exactly four ASCII digits.
- `avatar`, `icon`, and `team` must be `null`. Boolean fields must be primitive booleans.
- `user.bot` must be `true` and `application.owner.bot` must be `false`.
- `verify_key` is exactly 64 lowercase hexadecimal characters.
- `flags` is a non-negative safe integer; `-0` is accepted and returned as `0`.

`bootstrap: undefined` or an omitted `bootstrap` means not configured.

## Immutability

The profile is deep-copied into frozen plain data at construction. Changing the caller's object afterwards, or changing a parsed response, does not affect later responses. The caller's object itself is not frozen or modified. Each emulator instance keeps its own copy.

## `verify_key`

`LocalRestEmulator` only validates, stores, and returns the caller-provided public `verify_key`; it does not sign or verify requests. An arbitrary core profile does not establish a signing identity.

For the shared runtime's supported `raw-interaction-webhook` adapter, `verify_key` is the exact ephemeral Ed25519 public key injected into that run's bot as `DISRUNNER_PUBLIC_KEY`. Its existing private key stays in the runtime signer. No second key pair is generated, and no credentials are persisted. The existing signed-interaction and webhook response authentication remain unchanged.

## Gateway identity

The Gateway emulator takes its own `botUserId` and `applicationId` options. To keep REST and Gateway identities consistent, pass the same literal IDs to both; the integration test does this and checks that the IDs in `READY` match the two REST routes. Only the IDs are expected to match; other `READY` fields, such as the username, may differ.

## Shared runtime

Session startup supplies the profile for `raw-interaction-webhook`, discord.js 14.27.0, and discord.py 2.6.4. The Bot ID comes from the enforcing/SDK Bot fixture when configured; the legacy raw profile generates its Bot ID. Each run allocates an application ID and synthetic owner. REST `/users/@me`, Gateway `READY.user.id`, and message authors use the same Bot ID. REST `/oauth2/applications/@me`, Gateway `READY.application.id`, and interaction `application_id` share the application ID. `/gateway/bot` returns the actual dynamically allocated Gateway URL.

Bootstrap display fields are bounded synthetic literals: username `DisRunner Bot`, application name `DisRunner Test Application`, and owner username `test-owner`; fixture presentation fields need not match every protocol surface. SDK and v2-registry startup can add missing synthetic Bot/everyone-role/membership records to the run-owned state. Existing explicit permissions remain authoritative and project fixture files are not rewritten. REST identity is available before Gateway IDENTIFY, subject to per-run authentication; SDK cache bootstrap uses the same retained state.

Stopping closes the run's endpoints. Restarting allocates a new profile and signing credentials; old and other-session tokens are not accepted. Separate sessions keep independent profiles and keys. Snowflakes use a realtime clock, so seed alone does not promise deterministic IDs or global uniqueness across independent runs.

## Limitations

- The runtime advertises its per-run public verification key for all supported sessions. Raw interactions use that signing key; SDK interactions use Gateway delivery and authenticated callback routes instead. Other adapters/SDK versions are unsupported.
- `Proxy` inputs are not supported as a guarantee: Proxy reflection traps can run caller code, so freedom from side effects cannot be guaranteed for them. Ordinary own accessors are still rejected without invoking the getter.
- These routes are local test fixtures. They do not model Discord's production behavior, teams, install parameters, or any other application field.
