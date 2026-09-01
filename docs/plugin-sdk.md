# Plugin SDK (planned)

DisRunner v0.1 does not ship a public plugin SDK, plugin loader, manifest schema, capability system, marketplace, signature verifier, or plugin sandbox. Settings and plugin-like labels in the desktop renderer are seeded visual previews and must not be treated as security controls or supported extension APIs.

## Intended scope

A future SDK may support narrowly defined adapters, event templates, risk rules, scenario actions, mock services, local protocol extensions, renderers, or report exporters. Shipping any of these requires a versioned API and a compatibility declaration; an internal core class is not automatically a plugin API.

## Design requirements before availability

The planned boundary should include:

- a versioned manifest and SDK compatibility range;
- explicit, deny-by-default capabilities;
- schemas and size limits for every input and output;
- attribution of findings, mutations, logs, and failures to plugin identity/version;
- bounded execution, crash/timeout handling, and deterministic test requirements;
- plugin-scoped storage rather than arbitrary filesystem access;
- an explicit network policy with strict Offline Mode denying network access;
- lifecycle behavior for disable, upgrade, incompatibility, and removal;
- documentation that artifact signatures identify a publisher/build but do not prove safe behavior.

Whether isolation uses a separate process, another runtime boundary, or an OS facility is undecided. No current DisRunner behavior should be described as plugin isolation.

## Contributor guidance

Do not publish against private implementation details or ask users to weaken renderer isolation, IPC validation, or Offline Mode. A proposal should include a threat model, stable namespaced identifiers, deterministic positive/negative tests, bounded evidence, migration policy, and failure-containment plan.

A plugin cannot turn an unsupported Discord surface into a compatibility claim. Future support still requires contract tests and an entry in [Compatibility](../COMPATIBILITY.md).
