param([string]$MsysRoot = 'C:\msys64')
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Bash = Join-Path $MsysRoot 'usr/bin/bash.exe'
if (-not (Test-Path $Bash)) {
    throw 'Install MSYS2 UCRT64 and the build prerequisites listed in go/README.md, or use GitHub Actions.'
}
$PreviousSystem = $env:MSYSTEM
$PreviousHere = $env:CHERE_INVOKING
try {
    $env:MSYSTEM = 'UCRT64'
    $env:CHERE_INVOKING = '1'
    & $Bash -lc 'cd -- "$(cygpath -u "$1")"; exec python go/scripts/build_native.py --test --package' 'apex-cgo-build' $Repo
    if ($LASTEXITCODE -ne 0) { throw "CGO build failed with exit code $LASTEXITCODE" }
} finally {
    $env:MSYSTEM = $PreviousSystem
    $env:CHERE_INVOKING = $PreviousHere
}
