# Installation manual

Canonical packages are published on [DisRunner Releases](https://github.com/YanagiKH/DisRunner/releases). Read the selected release's supported platforms, signatures, known limitations, and migration notes.

## Requirements

- Node.js 22.23.2 for the tested source/CLI toolchain; manifests accept `>=22.23.2 <23`.
- pnpm 11.19.0 and Git for a source checkout.
- Python 3.12.14 when using the `discord.py` adapter.
- The Bot's prepared dependencies: `discord.js` 14.27.0 or `discord.py` 2.6.4 for the corresponding SDK adapter.
- Free disk space for the application, Bot dependencies, workspace backups, and reports.

Desktop package targets are Windows 11 x64, Ubuntu 24.04 x64, and macOS 14+ arm64/x64. The actual tested OS/architecture and signing/notarization results belong to each release; a target alone is not platform certification.

DisRunner does not install project dependencies during a run. Prepare them before disconnecting, including Python wheels if an offline machine needs a new environment.

## Install a packaged release

1. Download the matching installer/AppImage/DMG and `SHA256SUMS.txt` from the same release.
2. Verify the exact filename and SHA-256 value.
3. Check the platform signature and notarization stated for that artifact.
4. Install and open the application. Copy examples to a writable project directory before editing them.

Checksum commands include:

```powershell
Get-ChildItem .\DisRunner-*-win-*.exe | Get-FileHash -Algorithm SHA256
```

```sh
shasum -a 256 DisRunner-*-mac-*.dmg
sha256sum DisRunner-*-linux-*.AppImage
```

GitHub's generated source archives are source code, not desktop installers. Do not infer signing from the existence of a package or checksum.

## Standalone CLI bundle

The CLI bundle includes DisRunner's JavaScript dependencies, adapter bootstraps, licenses, and a raw-webhook example. It needs Node.js but does not require Electron, a repository checkout, or an additional DisRunner package installation.

Extract the bundle while preserving its directory structure:

```sh
node disrunner.mjs help
node disrunner.mjs bot-test examples/ping.bot-case.json --project examples/raw-webhook-bot
```

Your own Bot's dependencies remain separate. A Python project still needs its selected interpreter/environment, and a JavaScript project still needs its exact supported SDK installed near the entry file.

## Install from source

```sh
git clone https://github.com/YanagiKH/DisRunner.git
cd DisRunner
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run build
pnpm run dev
```

For renderer-only development, `pnpm run dev:web` opens the browser demo. A browser tab cannot launch local Bot processes or access the Electron file/runtime bridge.

Verify a checkout with `pnpm run verify`; release validation additionally runs `pnpm run verify:release`. See [Getting started](getting-started.md) for the first real Bot scenario.

## Runtime paths

A bare `node`, `python`, or `python3` in `bot.startCommand` uses the inherited executable search path. To select a specific installation or Python virtual environment, put its quoted absolute executable path in that command. Entry point and working directory remain project-relative. The startup diagnostic reports incompatible runtime/SDK versions and missing dependencies.

## Platform notes

- Windows paths containing spaces must be quoted in the configured start command. A Python environment normally uses `.venv\Scripts\python.exe`.
- macOS local builds are not automatically signed or notarized. Inspect the actual downloaded release's identity and Gatekeeper result.
- An AppImage may need `chmod +x DisRunner-*-linux-*.AppImage`. Required Electron system libraries must be installed on the target distribution. Disabling the Electron sandbox is not a normal installation step.

## Updating and uninstalling

Updates are explicit offline installations; no online updater is required. Stop active Bots, keep a copy of the project directory and `.disrunner` data, and follow the new release's migration notes.

Workspace saves are versioned and backed up. An older application refuses to overwrite a newer workspace format. For rollback, restore a compatible backup while preserving the newer copy. Uninstalling the application does not delete your project workspaces, source files, recordings, or reports.

See [Workspaces](workspaces.md) for recovery and [Debugging](debugging.md#installation-debugging) for launch failures.
