# Workspaces

A project keeps its editable simulation data in `.disrunner/workspace.json`. This file contains fixtures, saved scenario sources, seed, and strict/lenient mode. Bot launch settings and adapter configuration remain in `discord-simulator.config.json`.

## Edit and save

1. Open a project in Settings and stop any running Bot.
2. Use Guild Editor to edit the resource JSON. IDs, supported resource types, and relationships are checked when saving.
3. Use Scenario Lab to name, edit, validate, and save a JSON or YAML scenario.
4. Save the workspace. Reopening the project loads the saved resources and options for the next run.

The editor indicates unsaved changes and provides bounded Undo/Redo history for fixture edits. A running session keeps the state it started with; saving is disabled until that run stops. A Scenario Lab run starts a separate clean session from the saved project data, with Run, Cancel, and report export controls.

## File format

```json
{
  "version": 1,
  "resources": [
    { "resourceType": "guild", "id": "1000", "name": "Local Guild", "owner_id": "3000" },
    { "resourceType": "user", "id": "3000", "username": "Developer", "bot": false },
    {
      "resourceType": "channel",
      "id": "2000",
      "guild_id": "1000",
      "type": 0,
      "name": "bot-testing"
    }
  ],
  "scenarios": [],
  "options": { "seed": 42, "mode": "strict" }
}
```

Resource collections support guilds, channels, roles, users, members, and messages. Resource IDs are canonical positive decimal uint64 strings. A resource key is its type plus ID, so a guild and its everyone role may share an ID. References must point to existing resources; member roles must belong to the member's guild.

For a direct message, create a channel with `type: 1`, no `guild_id`, and explicit recipients:

```json
{ "resourceType": "channel", "id": "9000", "type": 1, "recipients": [{ "id": "3000" }] }
```

The recipient must be a loaded user. DM message scenarios specify actor and channel without a guild. Guild-installed commands continue to require a guild. Voice/category placeholders may be preserved as fixtures, but do not enable voice behavior.

Each saved scenario has `name`, `format` (`json` or `yaml`), and `source` fields. See [Scenario v2](scenario-v2.md) for real Bot actions and assertions. Workspaces are limited to 8 MiB and 10,000 resources; each scenario source is limited to 256 KiB. Credentials and secret-bearing fields are not accepted in workspace data.

## Conflicts and backups

Saving writes a temporary file in the same directory, flushes it, and replaces the main file only after validation and a complete write. The previous valid save is retained as `.disrunner/workspace.backup.json`. Failed writes leave the last valid main file intact.

DisRunner checks the saved file's hash before replacement. If another instance or external editor changed it, saving reports a conflict instead of overwriting that change. Reload the workspace, reconcile the edits, and save again. A save lock prevents two instances from writing at once.

If a crashed process left `workspace.lock`, first confirm that the process named in the lock has stopped and no other instance is saving. Remove only that stale lock, then reopen the workspace.

## Recovery and upgrades

Settings offers **Restore previous save** when a valid backup is available. Recovery is explicit and preserves the replaced bytes in `workspace.displaced.json`. It restores project data; it does not restart a Bot or restore process memory.

An unknown newer workspace version is not overwritten by an older DisRunner. Keep a copy before upgrading the application or editing the format externally. To roll back an application, restore a workspace backup compatible with that application's version. Keep the newer data separately until the rollback is confirmed.

Application removal does not delete project workspaces, fixtures, scenarios, or exported reports. Delete those files separately only when they are no longer needed.
