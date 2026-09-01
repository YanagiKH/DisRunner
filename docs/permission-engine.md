# Permission engine

The v0.1 permission engine is an in-process calculator. It returns an effective `BigInt` bitfield, whether all requested bits are present, a reason, and the sources applied. It is core-tested and used by supported scenario helper paths; it is not enforced by Electron REST routes.

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

## Current limits

The engine does not model owner-only operations, command installation/context/default-member permissions, invoking-user-versus-bot dual checks, private/archived/locked thread lifecycle, AutoMod, every Discord permission dependency, or API-version drift beyond the shipped constants. It does not automatically produce Discord-shaped `403` responses or the richer route-specific finding IDs described by the product roadmap.

The desktop Permissions panel is seeded visual preview data. Use core tests or a CLI scenario permission action for current executable evidence. Full route integration and a persisted decision inspector are planned.
