$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:RUNNER_OS -ne 'Windows') {
    throw 'Windows signature verification requires a Windows runner.'
}

$releaseRoot = Join-Path $PWD 'apps/desktop/release'
$installer = Join-Path $releaseRoot "DisRunner-$($env:RELEASE_VERSION)-win-x64.exe"
$application = Join-Path $releaseRoot 'win-unpacked/DisRunner.exe'
$verified = @()

foreach ($file in @($installer, $application)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required signed file is missing: $([IO.Path]::GetFileName($file))."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode verification failed for $([IO.Path]::GetFileName($file)): $($signature.Status)."
    }
    if ($null -eq $signature.SignerCertificate) {
        throw 'The verified file has no signer certificate.'
    }
    $verified += [ordered]@{
        file = [IO.Path]::GetFileName($file)
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        status = $signature.Status.ToString()
        publisher = $signature.SignerCertificate.Subject
        certificateSha256 = $signature.SignerCertificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
        timestamped = $null -ne $signature.TimeStamperCertificate
    }
}

if ($verified[0].certificateSha256 -ne $verified[1].certificateSha256) {
    throw 'Installer and application must have the same signing identity.'
}

$receipt = [ordered]@{
    schemaVersion = 1
    tag = $env:RELEASE_TAG
    sourceSha = $env:GITHUB_SHA
    platform = 'windows-x64'
    verifier = 'Get-AuthenticodeSignature'
    verifiedAt = [DateTime]::UtcNow.ToString('o')
    files = $verified
}
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $releaseRoot "disrunner-$($env:RELEASE_TAG)-signing-windows-x64.json") -Encoding utf8
