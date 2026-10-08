[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PythonExecutable,
    [Parameter(Mandatory = $true)][string]$ModelWorkspace,
    [Parameter(Mandatory = $true)][string]$FFmpeg,
    [Parameter(Mandatory = $true)][string]$FFprobe,
    [Parameter(Mandatory = $true)][string]$MediaLicenseDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$Checkpoint,
    [switch]$StageOnly
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
$report = [ordered]@{
    schema_version = 1; recorded_at = [DateTime]::UtcNow.ToString('o')
    scope = 'native Windows x64 build; installation and clean-machine acceptance are separate'
    status = 'blocked'; native_windows_build = $false; native_windows_acceptance = $false
    platform = [Environment]::OSVersion.ToString(); error = $null
}
$exitCode = 2
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    $report.error = @{code = 'windows_required'; message = 'Run the builder on Windows x64; Mac cross-compilation is not a native Windows build.'}
} else {
    $previousUtf8 = $env:PYTHONUTF8
    $previousConsoleEncoding = [Console]::OutputEncoding
    try {
        $processors = @(Get-CimInstance Win32_Processor)
        if (-not [Environment]::Is64BitProcess -or @($processors | Where-Object { $_.Architecture -ne 9 }).Count) {
            throw 'A native x64 Windows host and 64-bit PowerShell are required; ARM emulation is not this acceptance target.'
        }
        $report.os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
        $report.processors = $processors | Select-Object Name, Architecture
        foreach ($file in @($PythonExecutable, $FFmpeg, $FFprobe)) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing explicit build executable: $file" }
        }
        $repo = Split-Path -Parent $PSScriptRoot
        $arguments = @((Join-Path $repo 'scripts/build_model_desktop.py'), '--model-workspace',
            [IO.Path]::GetFullPath($ModelWorkspace), '--ffmpeg', [IO.Path]::GetFullPath($FFmpeg),
            '--ffprobe', [IO.Path]::GetFullPath($FFprobe), '--media-license-dir', [IO.Path]::GetFullPath($MediaLicenseDirectory))
        if ($Checkpoint) { $arguments += @('--checkpoint', [IO.Path]::GetFullPath($Checkpoint)) }
        if ($StageOnly) { $arguments += '--stage-only' }
        $env:PYTHONUTF8 = '1'
        [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8
        $report.builder = 'scripts/build_model_desktop.py'
        $report.builder_sha256 = (Get-FileHash -LiteralPath (Join-Path $repo $report.builder) -Algorithm SHA256).Hash.ToLowerInvariant()
        $log = Join-Path $destination 'build.log'
        & $PythonExecutable @arguments 2>&1 | ForEach-Object {
            [IO.File]::AppendAllText($log, ([string]$_ + [Environment]::NewLine), $utf8)
            Write-Output $_
        }
        $report.builder_exit_code = $LASTEXITCODE
        if ($LASTEXITCODE -ne 0) { throw "Native builder returned $LASTEXITCODE; inspect build.log." }
        $manifestPath = Join-Path $repo 'desktop/resources/manifest.json'
        $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
        if ($manifest.platform -ne 'win-x64') { throw 'Builder did not emit a win-x64 manifest.' }
        $report.manifest = $manifest; $report.manifest_path = $manifestPath
        $report.status = 'built'; if ($StageOnly) { $report.status = 'staged' }
        $report.native_windows_build = $true; $exitCode = 0
    } catch {
        $report.status = 'failed'; $exitCode = 1
        $report.error = @{code = 'build_failed'; message = $_.Exception.Message}
    } finally { $env:PYTHONUTF8 = $previousUtf8; [Console]::OutputEncoding = $previousConsoleEncoding }
}
$json = $report | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText((Join-Path $destination 'report.json'), $json, $utf8)
Write-Output $json
exit $exitCode
