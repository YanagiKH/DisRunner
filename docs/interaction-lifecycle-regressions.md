# Interaction lifecycle regressions (roadmap M0-03 / F05)

This note records the expected behavior that `packages/core/tests/unit/interaction-lifecycle-regression.test.ts`
pins for `InteractionEngine`. The expectations were written before each fix. Each rule is marked as
either a **source** (a documented Discord behavior) or a **simulator policy** (a choice DisRunner makes
where Discord does not state the behavior, or where the engine does not model enough to follow Discord).
Behavior the engine does not model is listed as unmodeled, not claimed as supported.

## 1. Interaction kinds and the initial callback matrix

**Simulator policy (input validation).** `InteractionEngine.create()` still stores any bounded
caller-supplied kind label, but `respond()` only answers four labels: `command` (application command:
chat input, user, or message command; the default), `component`, `autocomplete`, and `modal-submit`.
For any other label, including `ping` (PING is not modeled) and aliases such as `button` or `select`,
every initial callback is rejected with 400 / 50035 before it is applied: the interaction stays
`pending` with no initial response, and the retained byte count is unchanged. These labels are
DisRunner's own vocabulary, not a Discord string format; 50035 is reused only as the simulator's
validation error.

**Compatibility with existing scenarios.** The scenario schema
(`docs/schemas/discord-scenario.schema.json`, `interactionType: { "type": "string" }`) and
`packages/core/src/scenario.ts` (scenario parsing and the `interaction-create` step) still accept any
string as `interactionType`, and `create()` still stores it. A scenario written before this change that
uses another label, such as `button` or `ping`, still loads and creates the interaction, but its
initial callback now fails at `respond()` with 400 / 50035.

Engine response names map to Discord callback types as `message`=4, `defer`=5, `defer-update`=6,
`update`=7, `autocomplete`=8, `modal`=9.

| Interaction kind | Accepted initial callbacks                            | Rejected (400, code 50035)               |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- |
| `command`        | `message`, `defer`, `modal`                           | `update`, `defer-update`, `autocomplete` |
| `component`      | `message`, `defer`, `defer-update`, `update`, `modal` | `autocomplete`                           |
| `autocomplete`   | `autocomplete`                                        | every other callback                     |
| `modal-submit`   | `message`, `defer`, `defer-update`, `update`          | `autocomplete`, `modal`                  |

**Official source.** Discord's interaction callback type table
([receiving and responding](https://docs.discord.com/developers/interactions/receiving-and-responding))
marks `DEFERRED_UPDATE_MESSAGE` (6) and `UPDATE_MESSAGE` (7) with "\* Only valid for `MODAL_SUBMIT` and
component-based interactions." That is the basis for rejecting `update` / `defer-update` for the
`command` kind only; it is not a blanket ban.

**Simulator policy.** `autocomplete` interactions accept only the `autocomplete` (8) callback. The
official table describes type 8 as "Respond to an autocomplete interaction with suggested choices" but
does not state that other callbacks are invalid for autocomplete interactions.

**Simulator policy (not yet modeled / not certified).** `modal-submit` keeps accepting `update` /
`defer-update`. The engine does not record where a modal was opened from; whether these callbacks
depend on the modal's origin is not yet modeled, and this row is not certified against Discord.
PING/PONG and premium/launch-activity callbacks are not modeled.

A rejected callback leaves the interaction `pending` with unchanged retained bytes, so a legal callback
can still be sent before the deadline.

## 2. Deleted original response

**Simulator contract.**

- `editOriginal` on a deleted original fails with 404 / 10008 (Unknown Message) and cannot revive it.
- Deleting an already deleted original also fails with 404 / 10008.
- A rejection leaves `status`, the stored response data, follow-ups, and retained bytes unchanged.
- Deleting the original does not revoke the interaction token: while the token is valid, follow-ups can
  still be created, edited, and deleted. After the 15-minute token expiry the existing expired-token
  behavior (404 / 10015) applies.

The 404 / 10008 choice is the simulator's contract for "the original message no longer exists"; it is
not a claim about the exact error Discord returns in every case.

## 3. PATCH (edit original / edit follow-up) contract

PATCH is a merge, not a replace, applied to the top-level fields of the stored message data
([edit webhook message](https://docs.discord.com/developers/resources/webhook#edit-webhook-message):
all fields are optional and nullable).

- An omitted field is left unchanged, except for `allowed_mentions` as described below.
- A field set to a non-null value replaces that whole field. Nested values are not deep-merged (for
  example, a new `embeds` array replaces the stored array).
- A field set to explicit `null` is cleared: it is removed from the stored data.
- A field set to an empty array (for example `embeds: []`, `components: []`) clears that list: it is
  stored as `[]`.
- Both the patch and the merged result must fit the configured payload limit, and the merged result
  must fit the per-interaction and global retained-byte limits. The configured limits are not raised.
- Any failed PATCH leaves the interaction (status, response, follow-ups) and retained bytes unchanged.

### `allowed_mentions`

**Source.** When `content` is edited, Discord rebuilds the mentions from the new content using the
`allowed_mentions` of the edit request; if the edit request has no explicit `allowed_mentions`, default
allowances apply, regardless of the `allowed_mentions` sent when the message was created (edit webhook
message).

**Simulator policy.** When a PATCH includes `content` (including `content: null`) and omits
`allowed_mentions`, the stored `allowed_mentions` is removed, representing "default for this edit". An
explicit `allowed_mentions` value is stored, and `allowed_mentions: null` clears it. A PATCH that does
not include `content` (for example embeds-only) leaves the stored `allowed_mentions` unchanged. The
engine has no mention parser; this only tracks which `allowed_mentions` value is retained and does not
model which users or roles are actually mentioned.

### EPHEMERAL flag

**Source.** Ephemeral visibility is chosen when a message is created
([create follow-up message](https://docs.discord.com/developers/interactions/receiving-and-responding#create-followup-message)).
The edit webhook message endpoint documents only `SUPPRESS_EMBEDS` (4) and `IS_COMPONENTS_V2` as
editable flags (see also [edit message](https://docs.discord.com/developers/resources/message#edit-message)).
Discord does not explicitly document that a webhook PATCH ignores an EPHEMERAL change.

**Simulator policy.** The `ephemeral` field never changes after creation, and a PATCH that tries to flip
the EPHEMERAL bit (64) is not rejected. Instead the bit change is ignored while the other flag bits and
fields in the same PATCH are applied, so the stored `flags` always agree with `ephemeral`:

| Message | PATCH `flags` | Stored `flags` |
| ------- | ------------- | -------------- |
| public  | `64`          | `0`            |
| public  | `68` (64\|4)  | `4`            |
| public  | `null`        | removed        |
| private | `0`           | `64`           |
| private | `null`        | `64`           |
| private | `4`           | `68`           |
| private | `68` (64\|4)  | `68`           |

Other flag bits are stored as sent; the `IS_COMPONENTS_V2` set-only rule and other per-flag
restrictions are not modeled. Only `null` and non-negative safe integer `flags` values are normalized.

## Not changed in this work

- A follow-up before the initial response keeps failing with 400 / 40061.
- Full modal-origin, attachment, and mention semantics are separate roadmap items.
- PATCH `flags` values that are not `null` or a non-negative safe integer (for example strings,
  booleans, negative or fractional numbers) are not validated or normalized; they are stored as sent.
  Flag value validation is out of scope.
