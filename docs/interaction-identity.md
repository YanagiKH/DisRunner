# Interaction identity

The simulator can bind every interaction to an application and record where it came from.
The token-authenticated HTTP routes use that binding to decide whether a request may act on
an interaction.

## Binding an application ID

```ts
const interactions = new InteractionEngine({
  clock,
  random,
  snowflakes,
  profile,
  applicationId: '111111111111111111',
});
const interaction = interactions.create();
interaction.applicationId; // '111111111111111111'
```

- `applicationId` is set once, when the engine is constructed. Every interaction the engine
  creates carries it.
- It must be a canonical positive decimal unsigned 64-bit ID string: no leading zeros, no sign,
  no decimal point, no whitespace, at most `18446744073709551615`. Anything else throws a
  `TypeError`. These are the same rules the bootstrap profile applies to user and application
  IDs.
- Interaction input cannot change it. An `applicationId` field in `create()` input is ignored,
  and an `applicationId` key inside `data` is stored as ordinary data.
- An engine created without `applicationId` creates unbound interactions. They have no
  `applicationId` key.

## Interaction context

```ts
const interaction = interactions.create({
  context: {
    actorId: '300000000000000001',
    channelId: '400000000000000001',
    guildId: '500000000000000001', // optional
  },
});
```

- `InteractionContext` records fixed provenance: who sent the interaction and where. It is
  not a role or permission check.
- All IDs use the same canonical ID rule as `applicationId`. An invalid context throws a
  `TypeError`, and nothing is created.
- The context is copied when the interaction is created. Later changes to the caller's object,
  and changes to objects returned by `create`, `get`, `getByToken` or `list`, do not affect the
  stored interaction. Interactions never share a context object.
- Context is optional. An interaction created without it has no `context` key.

## Token routes

Both routes check identity before any rate-limit quota is spent and before the request body is
read. A rejected request creates no follow-up, leaves the original response unchanged, and does
not use any rate-limit bucket.

`POST /interactions/{interactionId}/{token}/callback` is rejected with `404` / `10062` when:

- the interaction ID is unknown,
- the token does not match that interaction,
- the interaction is not bound to an application, or
- the interaction has expired.

`POST /webhooks/{applicationId}/{token}` is rejected with `404` / `10015` when:

- the token is unknown,
- the interaction is not bound to an application,
- the path application ID is not exactly the bound ID, compared as a string (a leading-zero or
  out-of-range form never matches), or
- the token has expired. In this case the `EXPIRED_INTERACTION_TOKEN` risk is still reported;
  it does not contain the token.

A malformed percent-encoded token is rejected with `400` / `50035`, also before quota is spent.

These status codes are the simulator's own contract and are not claimed for every Discord case.
Tokens are checked exactly as sent. The equal-length comparison helper uses `timingSafeEqual`
as defense in depth; token lookup and length checks do not provide a constant-time protocol
guarantee. Tokens do not appear in error messages, trace span names (routes are recorded as
`:token`), or response bodies. The rate-limit bucket
for a webhook follow-up is keyed on the verified application ID and token, so rotating the path
ID cannot create new buckets.

A bound interaction without a context is accepted on both routes. Only the application binding
is required.

## Changes from earlier behavior and integration notes

- Earlier, the webhook route checked only the token, and any numeric path ID was accepted. A
  request with the correct token and a different application ID is now rejected and does not
  use the legitimate interaction's quota.
- Earlier, an expired token passed the route check and used quota before being rejected. It is
  now rejected before any quota is used.
- Model-only use is unchanged. An engine without `applicationId` keeps every model method
  (`respond`, `followup`, `editOriginal`, `deleteOriginal`, `editFollowup`, `deleteFollowup`).
  Its interactions cannot be used through the token HTTP routes, which fail closed for them.
- To serve the token routes, construct the engine with the same application ID that the bot
  sees, and use that ID as the webhook path ID.
- If the engine is created without an `applicationId`, the token HTTP routes reject every
  request for its interactions: callbacks with `404` / `10062` and webhook follow-ups with
  `404` / `10015`.
- Pass the verified actor, channel and guild as `context` when creating interactions, so that
  their provenance is recorded.
