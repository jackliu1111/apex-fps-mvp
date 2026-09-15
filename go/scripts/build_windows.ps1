param(
    [ValidateSet('amd64', 'arm64')][string]$Architecture = 'amd64',
    [string]$FFmpegDir = ''
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Repo = Split-Path $Root -Parent
$Bundle = Join-Path $Repo "dist/go/windows-$Architecture"
$OldCGO = $env:CGO_ENABLED
$OldGOOS = $env:GOOS
$OldGOARCH = $env:GOARCH

# Go modules are downloaded on the first build; no Python or C compiler is needed.
if (!$FFmpegDir) { $FFmpegDir = Join-Path $Repo "bin/windows-$Architecture" }
$MediaRoot = (Resolve-Path $FFmpegDir).Path
$MediaBin = $MediaRoot
if (Test-Path (Join-Path $MediaRoot 'bin/ffmpeg.exe')) { $MediaBin = Join-Path $MediaRoot 'bin' }
foreach ($Name in @('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe')) {
    if (!(Test-Path (Join-Path $MediaBin $Name))) { throw "Missing $Name in $MediaBin" }
}
# Check before replacing the executable, so an incomplete rebuild cannot alter an old bundle.
if (Test-Path $Bundle) {
    $Backup = Join-Path $Repo ("build/previous-windows-$Architecture-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force (Split-Path $Backup -Parent) | Out-Null
    Move-Item $Bundle $Backup
}
Push-Location $Root
try {
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = $Architecture
    New-Item -ItemType Directory -Force $Bundle | Out-Null
    $Exe = Join-Path $Bundle 'apex-highlight.exe'
    & go build -trimpath -o $Exe ./cmd/apex-highlight
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
    $GoRoot = & go env GOROOT
    if ($LASTEXITCODE -ne 0) { throw 'Cannot determine Go toolchain location' }
    Copy-Item (Join-Path $GoRoot 'LICENSE') (Join-Path $Bundle 'Go-LICENSE.txt')
    Copy-Item (Join-Path $Root 'RELEASE_README.txt') (Join-Path $Bundle 'README.txt')
    $TargetBin = Join-Path $Bundle 'bin'
    New-Item -ItemType Directory $TargetBin | Out-Null
    Get-ChildItem $MediaBin -File | Where-Object { $_.Name -in @('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe') -or $_.Extension -eq '.dll' } | Copy-Item -Destination $TargetBin
    $Notices = Join-Path $Bundle 'licenses/FFmpeg'
    New-Item -ItemType Directory -Force $Notices | Out-Null
    Get-ChildItem $MediaRoot | Where-Object { $_.Name -match '^(license|copying|notice|readme)' } | Copy-Item -Destination $Notices -Recurse
    $Manifest = @{
        go = (& go version)
        target = "windows/$Architecture"
        cgo_enabled = $false
        python_required = $false
        signed = $false
        executable_sha256 = (Get-FileHash $Exe -Algorithm SHA256).Hash
    }
    $Manifest | ConvertTo-Json | Set-Content (Join-Path $Bundle 'build-info.json') -Encoding UTF8
    if ($env:OS -eq 'Windows_NT') {
        $OldPath = $env:PATH
        $Smoke = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory $Smoke | Out-Null
        Push-Location $Smoke
        try {
            $env:PATH = Join-Path $env:SystemRoot 'System32'
            foreach ($Command in @('--help', 'doctor')) {
                & $Exe $Command
                if ($LASTEXITCODE -ne 0) { throw "Packaged application failed: $Command" }
            }
            foreach ($Name in @('ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe')) {
                & (Join-Path $TargetBin $Name) -version
                if ($LASTEXITCODE -ne 0) { throw "Packaged media tool failed: $Name" }
            }
        } finally {
            $env:PATH = $OldPath
            Pop-Location
            Remove-Item $Smoke -Recurse -Force
        }
    }
    $Archive = Join-Path $Repo "dist/go/apex-highlight-windows-$Architecture.zip"
    Compress-Archive -Path $Bundle -DestinationPath $Archive -Force
    Write-Host "Archive: $Archive"
    Write-Host "Built: $Exe"
    Write-Host 'On a matching Windows machine, run --help, doctor, and a real recording test before release.'
} finally {
    $env:CGO_ENABLED = $OldCGO
    $env:GOOS = $OldGOOS
    $env:GOARCH = $OldGOARCH
    Pop-Location
}
