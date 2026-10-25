# Plugin SDK availability

DisRunner v1.0 does not provide a public plugin SDK, plugin loader, manifest schema, capability system, marketplace, signature verifier, or plugin sandbox. The built-in raw/discord.js/discord.py adapters are application components, not dynamically installed plugins. Private package exports and renderer labels are not a supported extension API or security control.

## Customize local tests

Use [project configuration](project-configuration.md), [workspaces](workspaces.md), and [scenarios](scenario-v2.md) to select a supported adapter, edit fixtures, run Bot actions, apply scoped faults, and export results. These are validated application formats; they do not load arbitrary renderer extensions.

The supported SDK versions are listed in [SDK adapters](sdk-adapters.md). A generic Gateway or stdio process does not become a supported adapter merely by launching successfully.

## Contributing an integration

An additional adapter needs an explicit SDK/version contract, real-process positive and negative tests, bounded inputs/evidence, cancellation/cleanup, and a compatibility declaration. Preserve renderer isolation, IPC validation, and local transport restrictions. Importing a private core class is not a stable third-party API.

See [Compatibility](../COMPATIBILITY.md) and [Security model](security-model.md) before proposing changes to these boundaries.
