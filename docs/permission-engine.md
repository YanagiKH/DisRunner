# Permission engine

The core permission calculator returns an effective `BigInt` bitfield, whether all requested bits are present, a reason, and the sources applied. Calling it does not itself authorize a REST operation. Shared runtime/domain services explicitly apply it to the supported message, resource, and actor-view operations described below.

## Implemented calculation

`calculatePermissions` currently applies:

1. guild-owner bypass;
2. the guild `@everyone` role (the role whose ID equals the guild ID);
3. the union of member-role grants;
4. `ADMINISTRATOR` bypass when the member is not timed out;
5. channel `@everyone` overwrite;
6. combined matching role denies, then matching role allows;
7. member-specific deny, then allow;
8. parent overwrites for a thread with no own overwrites, or for a permission-synced channel;
9. implicit removals when `VIEW_CHANNEL`, `SEND_MESSAGES`, or `CONNECT` is absent;
10. timeout reduction to `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`.

Permission values accept non-negative decimal strings or `bigint`. The named constants are represented with `BigInt`; the calculation does not use JavaScript 32-bit bitwise operators.

The caller should pass `nowMs` for deterministic timeout checks. If it is omitted, the calculator uses the host clock.

## Separate hierarchy helpers

`canManageRole` and `canManageMember` compare the actor's highest role against a target, with explicit owner, self-management, and guild-owner-target rules. These helpers are separate from `calculatePermissions`; callers must request the relevant permission and run the applicable hierarchy helper themselves.

## Decision shape

```ts
const decision = calculatePermissions({
  guildId: '1000',
  ownerId: '9000',
  member: { id: '2000', roleIds: ['3000'] },
  roles: [
    { id: '1000', permissions: '1024', position: 0 },
    { id: '3000', permissions: '2048', position: 1 },
  ],
  requested: '2048',
  nowMs: 0,
});
```

The returned `sources` identify the implemented grants, overwrites, and implicit removals. They are evidence for this local input, not proof of a production guild's current state.

## Runtime enforcement

The `guild-text-own-messages-v1` ordinary-message profile checks the live Bot member, roles, channel overwrites, ownership, and timeout before its covered reads/writes. It returns the documented Discord-shaped denials. Raw projects retain `legacy-unenforced` unless opted in; SDK projects default to enforcement. See [Ordinary message permissions](ordinary-message-permissions.md) for its narrower rules, including ordinary-only history and mutation ownership.

With `command-registry-v2`, supported channel/role/member REST operations also apply Bot permission and hierarchy checks. The runtime action driver checks the selected human actor separately: VIEW_CHANNEL for interactions and VIEW_CHANNEL plus SEND_MESSAGES for message actions when enforcement is enabled. Actor snapshots filter channel/message visibility using the same retained resources; DMs use explicit recipients, and ephemeral responses belong to their invoking actor. These are local actor views, not complete Discord Gateway delivery filtering.

## Current limits

The calculator does not implement command installation policy, `default_member_permissions` invocation enforcement, private/archived/locked thread lifecycle, AutoMod, every Discord permission dependency, or API-version drift beyond the shipped constants. Registering permission metadata is distinct from enforcing it. Resource handlers must choose the required bits and hierarchy rules explicitly; no generic calculator call automatically creates a `403` or a risk finding.

Use the live route result, retained resources, and focused scenario assertions for permission evidence. A complete persisted inspector of every permission decision is not provided.
