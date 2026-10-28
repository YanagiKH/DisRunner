$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') { throw 'NSIS roundtrip requires Windows.' }
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$nodePath = (Get-Command node -ErrorAction Stop).Source
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json).version
$installer = if ($env:DISRUNNER_INSTALLER_ARTIFACT) { $env:DISRUNNER_INSTALLER_ARTIFACT } else { Join-Path $repositoryRoot "apps/desktop/release/DisRunner-$version-win-x64.exe" }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'NSIS installer is missing.' }
$taskDirectory = Join-Path ([IO.Path]::GetTempPath()) ('DisRunner installer 測試 ' + [Guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $taskDirectory 'application'
$evidenceDirectory = if ($env:DISRUNNER_INSTALLER_EVIDENCE) { $env:DISRUNNER_INSTALLER_EVIDENCE } else { Join-Path $repositoryRoot 'apps/desktop/release/installer-evidence' }
New-Item -ItemType Directory -Path $taskDirectory, $evidenceDirectory -Force | Out-Null
$workspace = Join-Path $taskDirectory 'project/.disrunner/workspace.json'
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($workspace)) -Force | Out-Null
'{"version":1,"resources":[],"scenarios":[],"options":{"seed":42042,"mode":"strict"}}' | Set-Content -LiteralPath $workspace -Encoding utf8
$workspaceHash = (Get-FileHash -LiteralPath $workspace -Algorithm SHA256).Hash
$executable = Join-Path $installDirectory 'DisRunner.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall DisRunner.exe'
$installed = $false

function Invoke-BoundedInstaller([string]$File, [string[]]$Arguments) {
    $ownedProcess = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
    if (-not $ownedProcess.WaitForExit(180000)) {
        & taskkill /PID $ownedProcess.Id /T /F | Out-Null
        throw 'Installer process exceeded its three-minute deadline.'
    }
    if ($ownedProcess.ExitCode -ne 0) { throw "Installer exited with code $($ownedProcess.ExitCode)." }
}

function Assert-WorkspacePreserved {
    if (-not (Test-Path -LiteralPath $workspace -PathType Leaf) -or (Get-FileHash -LiteralPath $workspace -Algorithm SHA256).Hash -ne $workspaceHash) { throw 'Installation changed the external workspace fixture.' }
}

try {
    $env:DISRUNNER_SMOKE_RENDERER_CDP = '1'
    $env:DISRUNNER_PACKAGED_EXECUTABLE = $executable
    foreach ($stage in @('installed', 'reinstalled')) {
        # NSIS requires /D last and unquoted; the rest of the command line is its directory.
        $installed = $true
        Invoke-BoundedInstaller $installer @('/S', '/currentuser', "/D=$installDirectory")
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'NSIS did not install into the requested isolated directory.' }
        if ($env:RELEASE_PRERELEASE -eq 'false') {
            $signature = Get-AuthenticodeSignature -LiteralPath $executable
            if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw 'Installed application signature is invalid.' }
        }
        $env:DISRUNNER_SDK_UI_EVIDENCE = Join-Path $evidenceDirectory "$stage-sdk-ui"
        & $nodePath (Join-Path $repositoryRoot 'apps/desktop/tests/e2e/package-smoke.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Installed raw-webhook UI acceptance failed.' }
        & $nodePath (Join-Path $repositoryRoot 'apps/desktop/tests/e2e/sdk-ui-smoke.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Installed SDK UI acceptance failed.' }
        Assert-WorkspacePreserved
    }
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Installed NSIS uninstaller is missing.' }
    Invoke-BoundedInstaller $uninstaller @('/S', "_?=$installDirectory")
    $installed = $false
    if ((Test-Path -LiteralPath $executable) -or (Test-Path -LiteralPath (Join-Path $installDirectory 'resources/app.asar'))) { throw 'Uninstall left the application executable or payload behind.' }
    Assert-WorkspacePreserved
    [ordered]@{
        schemaVersion = 1
        sourceSha = $env:GITHUB_SHA
        platform = 'windows-x64'
        osRelease = [Environment]::OSVersion.VersionString
        installer = [IO.Path]::GetFileName($installer)
        installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        stages = @('installed-raw-and-sdk-ui', 'reinstalled-raw-and-sdk-ui', 'uninstalled')
        workspaceSentinelPreserved = $true
        completedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'result.json') -Encoding utf8
    if ($env:RELEASE_TAG) { Copy-Item -LiteralPath (Join-Path $evidenceDirectory 'result.json') -Destination (Join-Path $repositoryRoot "apps/desktop/release/disrunner-$($env:RELEASE_TAG)-installation-windows-x64.json") }
} finally {
    try {
        if ($installed -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
            Invoke-BoundedInstaller $uninstaller @('/S', "_?=$installDirectory")
        }
    } finally { Remove-Item -LiteralPath $taskDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
