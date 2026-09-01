# Installation manual

DisRunner v0.1 is a Preview. It can run from source on the declared platform targets. Packaged artifacts, when a release has produced them, are published only on the canonical [DisRunner Releases page](https://github.com/YanagiKH/DisRunner/releases).

## Requirements

- 64-bit Windows 11, macOS 14+, or Ubuntu 24.04+ as Preview targets.
- Node.js `>=22.23.2 <23`.
- pnpm `11.19.0`, pinned by `packageManager` and the lockfile.
- Git for a source checkout.
- Approximately 2 GB free disk space for dependencies, builds, fixtures, and reports.

The bundled raw-webhook example uses Node.js. Python is required only if you independently write a raw-webhook process in Python; v0.1 does not include a `discord.py` adapter.

Verify the toolchain:

```bash
node --version
corepack --version
git --version
```

## Install a packaged release

First check that the release actually contains an artifact for your OS and records a green package/smoke result for that target.

1. Open the canonical [release](https://github.com/YanagiKH/DisRunner/releases) and read its known issues.
2. Download the matching package and `SHA256SUMS.txt` from the same release.
3. Verify the package checksum before opening it.
4. Install it. Treat a package as signed or notarized only when the release notes identify the publisher and you independently verify the platform signature; unsigned preview builds may still be published.

The builder uses `DisRunner-<version>-<os>-<arch>.<ext>`. For v0.1.0, examples are:

```powershell
Get-ChildItem .\DisRunner-0.1.0-win-*.exe | Get-FileHash -Algorithm SHA256
```

```bash
shasum -a 256 DisRunner-0.1.0-mac-*.dmg
sha256sum DisRunner-0.1.0-linux-*.AppImage
```

Compare the full hexadecimal value and exact filename with `SHA256SUMS.txt`. Generated GitHub source archives are not DisRunner desktop packages.

## Install from source

```bash
git clone https://github.com/YanagiKH/DisRunner.git
cd DisRunner
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run build
```

Run the Electron Preview:

```bash
pnpm run dev
```

Run only the renderer for visual development:

```bash
pnpm run dev:web
```

The browser renderer uses synthetic preview behavior. It cannot select/start a bot process or perform the real raw-webhook `/ping` path.

## Verify the checkout

```bash
pnpm run verify
```

Release candidates additionally run:

```bash
pnpm run verify:release
```

A green command proves only the suites it executed. Platform support is promoted only from a successful release run on that platform. Do not bypass dependency scripts or security checks to manufacture a green result.

## Platform notes

### Windows

- Keep the checkout path reasonably short if a dependency reports `ENAMETOOLONG`.
- PowerShell execution policy is unrelated to DisRunner's offline network policy.
- Use Windows Sandbox or a VM with networking disabled for untrusted bot code.

### macOS

- A release package is notarized only when its release notes and signature inspection say so; local builds are not.
- Use a network-isolated VM for untrusted bot code. Electron settings do not contain arbitrary child processes.

### Linux

- An AppImage may need `chmod +x DisRunner-*-linux-*.AppImage`.
- Electron may require system libraries supplied by the distribution.
- Do not use `--no-sandbox` as a generic workaround.

## Updating and uninstalling

v0.1 has no supported in-app updater, updater rollback, or persistent workspace/storage manager. Install a newer canonical package explicitly after reading its migration notes. Project fixtures, scenario recordings, and CLI reports remain at the paths where you created them; deleting the application does not remove those files.

See [Debugging](debugging.md#installation-debugging) for installation failures.
