[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$InspectOnly,
    [switch]$MacProtocolCheck,
    [string[]]$Source = @(),
    [int[]]$AudioStream = @(),
    [ValidateRange(1, 7200)][int]$RequestTimeoutSeconds = 300,
    [ValidateRange(1, 7200)][int]$TaskTimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
$report = [ordered]@{
    schema_version = 1
    recorded_at = [DateTime]::UtcNow.ToString('o')
    scope = 'native Windows package validation'
    status = 'blocked'
    native_windows_acceptance = $false
    native_execution = 'not_run'
    human_review = 'required'
    clean_machine_acceptance = 'not_evaluated'
    request_timeout_seconds = $RequestTimeoutSeconds
    platform = [Environment]::OSVersion.ToString()
    powershell_version = $PSVersionTable.PSVersion.ToString()
    error = $null
}
$exitCode = 2

function Read-PeInfo([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $reader = New-Object IO.BinaryReader -ArgumentList $stream
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { throw 'Missing PE DOS header.' }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ([long]$offset + 26 -gt $stream.Length) { throw 'Invalid PE header offset.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Missing PE signature.' }
        $machine = $reader.ReadUInt16()
        $stream.Position = [long]$offset + 24
        $magic = $reader.ReadUInt16()
        return @{path = $File; machine = ('0x{0:x4}' -f $machine); optional_magic = ('0x{0:x4}' -f $magic); x64 = ($machine -eq 0x8664 -and $magic -eq 0x20b)}
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Quote-ProcessArgument([string]$Value) {
    $escaped = [regex]::Replace($Value, '(\\*)"', { param($match) $match.Groups[1].Value + $match.Groups[1].Value + '\"' })
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Read-CoreMessage($Reader) {
    $line = $Reader.ReadLineAsync()
    if (-not $line.Wait($RequestTimeoutSeconds * 1000)) { throw ('Core response timeout (' + $RequestTimeoutSeconds + ' seconds).') }
    if ($null -eq $line.Result) { throw 'Core closed its NDJSON output.' }
    return $line.Result | ConvertFrom-Json
}

function Save-Evidence([string]$Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $destination $Name), ($Value | ConvertTo-Json -Depth 40), $utf8)
}

function Invoke-CoreOperation($Session, [string]$Operation, $Payload) {
    $Session.sequence++
    $identifier = 'powershell-' + $Session.sequence
    $request = @{id = $identifier; operation = $Operation; payload = $Payload}
    $Session.writer.WriteLine(($request | ConvertTo-Json -Compress -Depth 40)); $Session.writer.Flush()
    $response = Read-CoreMessage $Session.reader
    if ($response.type -ne 'response' -or $response.id -ne $identifier) { throw 'Core response envelope/id mismatch.' }
    if ($Session.transcript) {
        [IO.File]::AppendAllText($Session.transcript, (@{request = $request; response = $response} | ConvertTo-Json -Compress -Depth 40) + "`n", $utf8)
    }
    if ($response.error) { throw ($Operation + ': ' + $response.error.code + ': ' + $response.error.message) }
    return $response.result
}

function Wait-CoreTask($Session, $Submission, [string]$Name) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($watch.Elapsed.TotalSeconds -lt $TaskTimeoutSeconds) {
        $task = Invoke-CoreOperation $Session 'get_task' @{task_id = $Submission.task_id}
        if ($task.status -in @('completed', 'failed', 'cancelled')) {
            Save-Evidence ($Name + '.json') $task
            if ($task.status -ne 'completed') { throw ($Name + ': ' + $task.status + ': ' + $task.error.code + ': ' + $task.error.message) }
            return $task
        }
        Start-Sleep -Milliseconds 500
    }
    Invoke-CoreOperation $Session 'cancel_task' @{task_id = $Submission.task_id} | Out-Null
    throw ($Name + ': bounded task timeout; cancellation requested, diagnostics retained.')
}

function Get-OwnedProcesses([int]$CorePid) {
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($CorePid)
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $found = New-Object System.Collections.Generic.List[object]
    while ($queue.Count -and $seen.Count -lt 256) {
        $parent = $queue.Dequeue()
        if (-not $seen.Add($parent)) { continue }
        foreach ($child in @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $parent))) {
            $found.Add(($child | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath))
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
    return $found.ToArray()
}

function Invoke-CoreConfig([string]$Runtime, $Manifest, [string]$DataDirectory, [scriptblock]$AfterConfig = $null) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $Runtime $Manifest.service
    $arguments = @('--data-dir', $DataDirectory, '--ffmpeg', (Join-Path $Runtime $Manifest.ffmpeg),
        '--ffprobe', (Join-Path $Runtime $Manifest.ffprobe), '--model-workspace', (Join-Path $Runtime $Manifest.model_workspace),
        '--checkpoint', (Join-Path $Runtime $Manifest.checkpoint), '--parent-pid', [string]$PID)
    $startInfo.Arguments = ($arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $startInfo.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
    } else { $startInfo.EnvironmentVariables['PATH'] = '/usr/bin:/bin' }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    $writer = $null
    $started = $false
    $owned = @()
    try {
        if (-not $process.Start()) { throw 'Could not start the bundled core.' }
        $started = $true
        $stderr = $process.StandardError.ReadToEndAsync()
        $writer = New-Object IO.StreamWriter -ArgumentList @($process.StandardInput.BaseStream, $utf8)
        $ready = Read-CoreMessage $process.StandardOutput
        if ($ready.type -ne 'ready' -or $ready.schema_version -ne 1) { throw 'Core readiness schema mismatch.' }
        $session = @{writer = $writer; reader = $process.StandardOutput; sequence = 0; transcript = (Join-Path $destination 'operations.ndjson')}
        $config = Invoke-CoreOperation $session 'get_config' @{}
        if (-not $config) { throw 'Core get_config returned no result.' }
        $workflow = $null
        if ($AfterConfig) { $workflow = & $AfterConfig $session $config }
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $owned = @(Get-OwnedProcesses $process.Id) }
        $writer.Close(); $writer = $null
        if (-not $process.WaitForExit(10000)) { throw 'Core did not exit after normal EOF.' }
        if ($process.ExitCode -ne 0) { throw 'Core normal EOF returned a failure.' }
        $remaining = @()
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
            $limit = [DateTime]::UtcNow.AddSeconds(10)
            do {
                $remaining = @($owned | Where-Object {
                    $old = $_
                    @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + $old.ProcessId) |
                        Where-Object { $_.CreationDate -eq $old.CreationDate }).Count -gt 0
                })
                if ($remaining.Count) { Start-Sleep -Milliseconds 200 }
            } while ($remaining.Count -and [DateTime]::UtcNow -lt $limit)
            if ($remaining.Count) { throw 'Owned runtime processes remain after normal EOF.' }
        }
        return @{config = $config; workflow = $workflow; core_exit_code = $process.ExitCode; core_pid = $process.Id; stderr = $stderr.Result;
            cleanup = @{tracked = $owned; remaining = $remaining}}
    } finally {
        if ($writer) { try { $writer.Close() } catch {} }
        if ($started -and -not $process.HasExited) {
            if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
                & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $process.Id /T /F | Out-Null
            } else { $process.Kill() }
            $process.WaitForExit(5000) | Out-Null
        }
        if ($started -and $process.HasExited) {
            [IO.File]::WriteAllText((Join-Path $destination 'core-stderr.log'), $stderr.Result, $utf8)
        }
        $process.Dispose()
    }
}

function Invoke-MediaCheck([string]$Command, [string[]]$Arguments, [string]$Name) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Command; $info.Arguments = ($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8; $info.StandardErrorEncoding = $utf8
    $info.EnvironmentVariables['PATH'] = Join-Path $env:SystemRoot 'System32'
    $process = New-Object Diagnostics.Process; $process.StartInfo = $info
    $started = $false; $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { throw 'Bundled media tool did not start.' }; $started = $true
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(300000)) { throw 'Full media check exceeded 300 seconds.' }
        [IO.File]::WriteAllText((Join-Path $destination ($Name + '-stdout.log')), $stdout.Result, $utf8)
        [IO.File]::WriteAllText((Join-Path $destination ($Name + '-stderr.log')), $stderr.Result, $utf8)
        $result = @{command = $Command; arguments = $Arguments; exit_code = $process.ExitCode; elapsed_s = $watch.Elapsed.TotalSeconds}
        Save-Evidence ($Name + '.json') $result
        if ($process.ExitCode -ne 0) { throw ($Name + ': media tool failed; see complete stderr log.') }
        return $result
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
}

function Invoke-RecordingWorkflow($Session, $Config) {
    $mediaIds = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $Source.Count; $index++) {
        $media = Invoke-CoreOperation $Session 'probe_media' @{path = [IO.Path]::GetFullPath($Source[$index])}
        Save-Evidence (('source-{0:000}-probe.json' -f ($index + 1))) $media
        Invoke-CoreOperation $Session 'confirm_audio' @{media_id = $media.media_id; stream_index = $AudioStream[$index]} | Out-Null
        $mediaIds.Add($media.media_id)
    }
    $batch = Wait-CoreTask $Session (Invoke-CoreOperation $Session 'analyze' @{media_ids = $mediaIds.ToArray()}) 'batch-task'
    $results = @($batch.results)
    if (@($results | Where-Object { $_.status -ne 'completed' }).Count) { throw 'One or more recordings failed; batch-task.json retains each diagnostic.' }
    $warm = Wait-CoreTask $Session (Invoke-CoreOperation $Session 'analyze' @{media_id = $mediaIds[0]}) 'warm-task'
    $warmResult = Invoke-CoreOperation $Session 'get_result' @{result_id = $warm.result_id}
    Save-Evidence 'warm-result.json' $warmResult
    $artifacts = New-Object System.Collections.Generic.List[object]
    $runtimeRecords = New-Object System.Collections.Generic.List[object]
    foreach ($record in $results) {
        $result = Invoke-CoreOperation $Session 'get_result' @{result_id = $record.result_id}
        $runtimeRecords.Add($result.prediction.runtime)
        if ($result.prediction.model.name -ne 'BEATs_strong_1' -or $result.prediction.runtime.reported_by -ne 'engine') {
            throw 'Require real BEATs engine evidence, not an external fixture.'
        }
        Save-Evidence ($record.result_id + '-original.json') $result
        $scoreHash = (Get-FileHash -LiteralPath $result.prediction.scores_path -Algorithm SHA256).Hash
        $recomputed = Invoke-CoreOperation $Session 'recompute_candidates' @{result_id = $result.result_id;
            candidate_version = $result.candidate_version; parameters = @{threshold = 0.2; merge_gap_s = 5; before_s = 5; after_s = 5}}
        if ($recomputed.prediction_id -ne $result.prediction_id -or
            (Get-FileHash -LiteralPath $recomputed.prediction.scores_path -Algorithm SHA256).Hash -ne $scoreHash) {
            throw 'Postprocessing changed the saved prediction.'
        }
        Save-Evidence ($record.result_id + '-recomputed.json') $recomputed
        if (-not @($recomputed.candidates).Count) { continue }
        $clips = @($recomputed.candidates | ForEach-Object { @{candidate_id = $_.candidate_id; selected = $true; start_s = $_.start_s; end_s = $_.end_s} })
        $ref = @{result_id = $recomputed.result_id; candidate_version = $recomputed.candidate_version}
        Invoke-CoreOperation $Session 'update_selection' @{result_id = $ref.result_id; candidate_version = $ref.candidate_version; clips = $clips} | Out-Null
        $preview = Wait-CoreTask $Session (Invoke-CoreOperation $Session 'request_preview' @{result_id = $ref.result_id;
            candidate_version = $ref.candidate_version; candidate_id = $clips[0].candidate_id}) ($record.result_id + '-preview-task')
        $exported = Wait-CoreTask $Session (Invoke-CoreOperation $Session 'export' @{result_id = $ref.result_id;
            candidate_version = $ref.candidate_version; output_dir = (Join-Path $destination 'exports'); mode = 'copy'}) ($record.result_id + '-export-task')
        if (@($exported.exports).Count -ne $clips.Count) { throw 'Expected one independent output for every selected candidate.' }
        foreach ($identifier in @($preview.preview_id) + @($exported.exports | ForEach-Object { $_.artifact_id })) {
            $artifact = Invoke-CoreOperation $Session 'get_artifact' @{artifact_id = $identifier}
            $probe = Invoke-MediaCheck $Config.ffprobe @('-v', 'error', '-show_format', '-show_streams', '-of', 'json', $artifact.path) ($identifier + '-probe')
            $decode = Invoke-MediaCheck $Config.ffmpeg @('-nostdin', '-v', 'error', '-xerror', '-i', $artifact.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-') ($identifier + '-full-decode')
            $artifacts.Add(@{artifact = $artifact; probe = $probe; decode = $decode; human_review = 'pending'})
        }
    }
    $runtimeRecords.Add($warmResult.prediction.runtime)
    $first = $runtimeRecords[0]; $last = $warmResult.prediction.runtime
    if ($first.engine_instance_id -ne $last.engine_instance_id -or -not $last.model_reused -or
        $last.inference_index -ne ($results.Count + 1) -or $last.load_count -ne 1) { throw 'Cold/warm real engine reuse did not match the sequential task contract.' }
    return @{batch_task_id = $batch.task_id; warm_task_id = $warm.task_id; runtime = $runtimeRecords.ToArray(); artifacts = $artifacts.ToArray();
        empty_candidate_recordings = @($results).Count - @($artifacts | Where-Object { $_.artifact.kind -eq 'preview' }).Count}
}

if ($MacProtocolCheck) {
    $report.scope = 'Mac PowerShell 7 packaged-core protocol mechanisms only'
    try {
        if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { throw 'MacProtocolCheck is only a Mac mechanism check.' }
        $runtime = Join-Path ([IO.Path]::GetFullPath($PackageDirectory)) 'Contents/Resources/runtime'
        $manifest = [IO.File]::ReadAllText((Join-Path $runtime 'manifest.json'), $utf8) | ConvertFrom-Json
        if ($manifest.platform -ne 'mac-arm64') { throw 'Provide the verified Mac arm64 package for this explicit mechanism check.' }
        $destination = [IO.Path]::GetFullPath($OutputDirectory)
        [IO.Directory]::CreateDirectory($destination) | Out-Null
        $probe = Invoke-CoreConfig $runtime $manifest (Join-Path $destination 'core-data')
        $report.config = $probe.config
        $report.core_exit_code = $probe.core_exit_code
        $report.core_pid = $probe.core_pid
        [IO.File]::WriteAllText((Join-Path $destination 'core-stderr.log'), $probe.stderr, $utf8)
        $report.status = 'protocol_passed'; $exitCode = 0
        $report.native_execution = 'Mac packaged core get_config only; no Windows workload'
    } catch {
        $report.status = 'failed'
        $report.error = @{code = 'protocol_failed'; message = $_.Exception.Message}
        $exitCode = 1
    }
} elseif ($InspectOnly) {
    try {
    $report.scope = 'package file inspection only; no native Windows execution'
    $report.status = 'failed'
    $exitCode = 1
    $root = [IO.Path]::GetFullPath($PackageDirectory)
    $runtime = Join-Path $root 'resources/runtime'
    $manifestFile = Join-Path $runtime 'manifest.json'
    $missing = New-Object System.Collections.Generic.List[string]
    if (-not [IO.File]::Exists($manifestFile)) {
        $missing.Add('manifest')
    } else {
        $manifest = [IO.File]::ReadAllText($manifestFile, $utf8) | ConvertFrom-Json
        if (-not [IO.File]::Exists((Join-Path $root 'Apex Model Review.exe'))) { $missing.Add('application') }
        foreach ($name in @('service', 'ffmpeg', 'ffprobe', 'model_workspace', 'checkpoint')) {
            $value = $manifest.$name
            if ($value -isnot [string] -or $value -match '^(?:[A-Za-z]:|[\\/])' -or ($value -split '[\\/]') -contains '..') {
                $report.invalid_resource = $name
                $report.error = @{code = 'invalid_resource_reference'; message = 'Manifest resources must remain relative to the installed runtime.'}
                break
            }
            if (-not $value -or -not (Test-Path -LiteralPath (Join-Path $runtime $value))) { $missing.Add($name) }
        }
    }
    $report.missing_resources = @($missing)
    if ($missing.Count) {
        $report.error = @{code = 'package_incomplete'; message = 'Required installed-package resources are missing.'}
    } elseif (-not $report.error) {
        $native = New-Object System.Collections.Generic.List[object]
        $native.Add((Read-PeInfo (Join-Path $root 'Apex Model Review.exe')))
        foreach ($file in (Get-ChildItem -LiteralPath $runtime -Recurse -File)) {
            if ($file.Extension.ToLowerInvariant() -in @('.exe', '.dll', '.pyd')) { $native.Add((Read-PeInfo $file.FullName)) }
        }
        $report.native_files = $native.ToArray()
        $report.invalid_native_files = @($native | Where-Object { -not $_.x64 })
        if ($report.invalid_native_files.Count) {
            $report.error = @{code = 'architecture_mismatch'; message = 'Application and inference/media runtime must contain x64 PE images.'}
        } else {
            $report.status = 'inspected'
            $exitCode = 0
        }
    }
    } catch {
        $report.status = 'failed'
        $report.error = @{code = 'package_invalid'; message = $_.Exception.Message}
        $exitCode = 1
    }
} elseif ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    $report.error = @{code = 'windows_required'; message = 'Run native validation on Windows x64; no Windows workload was executed.'}
} else {
    try {
        if (-not [Environment]::Is64BitProcess -or @(Get-CimInstance Win32_Processor | Where-Object { $_.Architecture -ne 9 }).Count) {
            throw 'Use native Windows x64 and 64-bit PowerShell.'
        }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
        $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $report.user = @{name = $identity.Name; elevated = $elevated}
        if ($elevated) { throw 'Run acceptance from a non-elevated ordinary-user session.' }
        $report.os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture
        $report.hardware = @{processors = @(Get-CimInstance Win32_Processor | Select-Object Name, Architecture, NumberOfLogicalProcessors);
            memory_bytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory}
        if ([Version]$report.os.Version -lt [Version]'10.0') { throw 'Electron 40 requires Windows 10 or newer; bundled dependencies still require native verification.' }
        $destination = [IO.Path]::GetFullPath($OutputDirectory)
        [IO.Directory]::CreateDirectory($destination) | Out-Null
        $inspection = Join-Path $destination 'inspection'
        & (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -InspectOnly -PackageDirectory $PackageDirectory -OutputDirectory $inspection | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Package inspection failed; inspection/report.json preserves the diagnostic.' }
        $runtime = Join-Path ([IO.Path]::GetFullPath($PackageDirectory)) 'resources/runtime'
        $manifest = [IO.File]::ReadAllText((Join-Path $runtime 'manifest.json'), $utf8) | ConvertFrom-Json
        if ($manifest.platform -ne 'win-x64') { throw 'Require a native win-x64 model-desktop manifest.' }
        if ($Source.Count -ne $AudioStream.Count -or @($AudioStream | Where-Object { $_ -lt 0 }).Count) { throw 'Explicitly supply one non-negative container audio stream index per recording.' }
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $PackageDirectory 'Apex Model Review.exe')
        $report.application_signature = @{status = $signature.Status.ToString(); subject = $signature.SignerCertificate.Subject}
        $report.manifest = $manifest
        if (-not $manifest.checkpoint_sha256 -or
            (Get-FileHash -LiteralPath (Join-Path $runtime $manifest.checkpoint) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.checkpoint_sha256) {
            throw 'Bundled checkpoint identity does not match the build manifest.'
        }
        $report.media_versions = @(
            (Invoke-MediaCheck (Join-Path $runtime $manifest.ffmpeg) @('-version') 'ffmpeg-version'),
            (Invoke-MediaCheck (Join-Path $runtime $manifest.ffprobe) @('-version') 'ffprobe-version'))
        $actions = $null
        if ($Source.Count) { $actions = { param($session, $config) Invoke-RecordingWorkflow $session $config } }
        $probe = Invoke-CoreConfig $runtime $manifest (Join-Path $destination 'core-data') $actions
        $report.config = $probe.config; $report.workflow = $probe.workflow; $report.cleanup = $probe.cleanup
        $report.core_exit_code = $probe.core_exit_code; $report.core_pid = $probe.core_pid
        $report.native_execution = 'Windows packaged core; native GUI remains a separate manual gate'
        $report.status = 'native_core_probe_passed'; if ($Source.Count) { $report.status = 'native_core_workflow_passed' }
        $report.scope = 'OS PowerShell + installed native core/media operations; no GUI, clean-machine or human sync acceptance inferred'
        $exitCode = 0
    } catch {
        $report.status = 'failed'; $exitCode = 1
        $report.error = @{code = 'native_validation_failed'; message = $_.Exception.Message}
    }
}
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$json = $report | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText((Join-Path $destination 'report.json'), $json, $utf8)
Write-Output $json
exit $exitCode
