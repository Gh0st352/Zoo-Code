[CmdletBinding()]
param(
	[string]$OutputRoot,
	[string]$VsixPath,
	[switch]$SkipVsixBuild,
	[switch]$AllowDirtySource,
	[ValidateRange(315532800, 4354819198)]
	[int64]$SourceDateEpoch,
	[switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:KitManifestSchemaVersion = 1
$script:KitFormatVersion = 1
$script:ManifestPlaceholder = "__KIT_MANIFEST_SHA256__"
$script:PackagerPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$script:PackagerRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetDirectoryName($script:PackagerPath))
$script:RepositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $script:PackagerRoot "..\.."))
$script:Utf8Strict = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false, $true)
$script:Utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
$script:SourceDateEpochSpecified = $PSBoundParameters.ContainsKey("SourceDateEpoch")

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Throw-PackagerError {
	param([string]$Code, [string]$Message)
	$exception = New-Object -TypeName System.InvalidOperationException -ArgumentList @($Message)
	$exception.Data["ZooCodeErrorCode"] = $Code
	throw $exception
}

function Test-PathWithin {
	param([string]$Candidate, [string]$Parent)
	$candidateFull = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
	$parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
	if ($candidateFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
	return $candidateFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePath {
	param([string]$LiteralPath, [switch]$AllowMissingLeaf)
	$full = [System.IO.Path]::GetFullPath($LiteralPath)
	$root = [System.IO.Path]::GetPathRoot($full)
	$current = $root
	$parts = $full.Substring($root.Length).Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)
	for ($index = 0; $index -lt $parts.Count; $index += 1) {
		$current = Join-Path $current $parts[$index]
		if (-not (Test-Path -LiteralPath $current)) {
			if ($AllowMissingLeaf) { return }
			Throw-PackagerError "PATH_MISSING" "A required packaging path does not exist."
		}
		$item = Get-Item -LiteralPath $current -Force
		if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
			Throw-PackagerError "REPARSE_PATH" "Packaging paths may not traverse reparse points."
		}
	}
}

function Assert-RegularFile {
	param([string]$LiteralPath, [string]$Description)
	if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
		Throw-PackagerError "SOURCE_INPUT_MISSING" "$Description is missing."
	}
	Assert-NoReparsePath -LiteralPath $LiteralPath
	$item = Get-Item -LiteralPath $LiteralPath -Force
	if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
		Throw-PackagerError "SOURCE_INPUT_UNSAFE" "$Description must be a regular non-reparse file."
	}
	return $item
}

function Read-StrictUtf8File {
	param([string]$LiteralPath, [int64]$MaximumBytes)
	$item = Assert-RegularFile -LiteralPath $LiteralPath -Description "UTF-8 source file"
	if ($item.Length -gt $MaximumBytes) { Throw-PackagerError "SOURCE_INPUT_TOO_LARGE" "A bounded source file is too large." }
	$bytes = [System.IO.File]::ReadAllBytes($item.FullName)
	if ($bytes.Length -ne $item.Length) { Throw-PackagerError "SOURCE_INPUT_CHANGED" "A source file changed while it was read." }
	try { return $script:Utf8Strict.GetString($bytes) } catch { Throw-PackagerError "SOURCE_INPUT_UTF8" "A source file is not valid UTF-8." }
}

function Read-JsonFile {
	param([string]$LiteralPath, [int64]$MaximumBytes)
	$text = Read-StrictUtf8File -LiteralPath $LiteralPath -MaximumBytes $MaximumBytes
	try { return $text | ConvertFrom-Json } catch { Throw-PackagerError "SOURCE_JSON" "A required source JSON file is malformed." }
}

function Get-Sha256File {
	param([string]$LiteralPath)
	return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Bytes {
	param([byte[]]$Bytes)
	$algorithm = [System.Security.Cryptography.SHA256]::Create()
	try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() } finally { $algorithm.Dispose() }
}

function Get-Sha256Stream {
	param([System.IO.Stream]$Stream)
	$algorithm = [System.Security.Cryptography.SHA256]::Create()
	try { return ([System.BitConverter]::ToString($algorithm.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant() } finally { $algorithm.Dispose() }
}

function Write-NewFileBytes {
	param([string]$LiteralPath, [byte[]]$Bytes)
	$stream = $null
	try {
		$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($LiteralPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
		$stream.Write($Bytes, 0, $Bytes.Length)
		$stream.Flush($true)
	} finally {
		if ($null -ne $stream) { $stream.Dispose() }
	}
}

function Get-OrdinalSortedStrings {
	param([string[]]$Values)
	[string[]]$copy = @($Values)
	[System.Array]::Sort($copy, [System.StringComparer]::Ordinal)
	return $copy
}

function Get-NormalizedRelativePath {
	param([string]$Child, [string]$Parent)
	$childFull = [System.IO.Path]::GetFullPath($Child)
	$parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
	if (-not (Test-PathWithin -Candidate $childFull -Parent $parentFull) -or $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
		Throw-PackagerError "PATH_ESCAPE" "A generated path escaped its required root."
	}
	return $childFull.Substring($parentFull.Length + 1).Replace('\', '/')
}

function Get-SafeTreeFiles {
	param([string]$Root)
	Assert-NoReparsePath -LiteralPath $Root
	$stack = New-Object System.Collections.Stack
	$stack.Push([System.IO.Path]::GetFullPath($Root))
	$files = New-Object System.Collections.Generic.List[object]
	while ($stack.Count -gt 0) {
		$current = [string]$stack.Pop()
		foreach ($entry in @(Get-ChildItem -LiteralPath $current -Force)) {
			if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
				Throw-PackagerError "REPARSE_PAYLOAD" "A generated tree contains a reparse point."
			}
			if ($entry.PSIsContainer) { $stack.Push($entry.FullName) } else { $files.Add($entry) }
		}
	}
	return $files.ToArray()
}

function ConvertTo-WindowsArgument {
	param([AllowEmptyString()][string]$Value)
	if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
	$builder = New-Object System.Text.StringBuilder
	[void]$builder.Append('"')
	$backslashes = 0
	foreach ($character in $Value.ToCharArray()) {
		if ($character -eq '\') { $backslashes += 1; continue }
		if ($character -eq '"') {
			[void]$builder.Append(('\' * (($backslashes * 2) + 1)))
			[void]$builder.Append('"')
			$backslashes = 0
			continue
		}
		if ($backslashes -gt 0) { [void]$builder.Append(('\' * $backslashes)); $backslashes = 0 }
		[void]$builder.Append($character)
	}
	if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
	[void]$builder.Append('"')
	return $builder.ToString()
}

function ConvertTo-WindowsCommandLine {
	param([string[]]$ArgumentList)
	return (($ArgumentList | ForEach-Object { ConvertTo-WindowsArgument -Value ([string]$_) }) -join " ")
}

function Invoke-DirectProcess {
	param(
		[string]$FilePath,
		[string[]]$ArgumentList,
		[string]$WorkingDirectory = $script:RepositoryRoot,
		[int]$TimeoutMilliseconds = 120000
	)
	$startInfo = New-Object System.Diagnostics.ProcessStartInfo
	$startInfo.FileName = $FilePath
	$startInfo.Arguments = ConvertTo-WindowsCommandLine -ArgumentList $ArgumentList
	$startInfo.WorkingDirectory = $WorkingDirectory
	$startInfo.UseShellExecute = $false
	$startInfo.CreateNoWindow = $true
	$startInfo.RedirectStandardOutput = $true
	$startInfo.RedirectStandardError = $true
	$process = New-Object System.Diagnostics.Process
	$process.StartInfo = $startInfo
	try {
		if (-not $process.Start()) { Throw-PackagerError "PROCESS_START" "A packaging prerequisite process could not start." }
		$stdoutTask = $process.StandardOutput.ReadToEndAsync()
		$stderrTask = $process.StandardError.ReadToEndAsync()
		if (-not $process.WaitForExit($TimeoutMilliseconds)) {
			try { $process.Kill() } catch {}
			Throw-PackagerError "PROCESS_TIMEOUT" "A packaging prerequisite process timed out."
		}
		$stdout = $stdoutTask.GetAwaiter().GetResult()
		$stderr = $stderrTask.GetAwaiter().GetResult()
		return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
	} finally {
		$process.Dispose()
	}
}

function Resolve-NodeRuntime {
	$candidate = $null
	$command = Get-Command node.exe, node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -ne $command) { $candidate = $command.Source }
	if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
		Throw-PackagerError "NODE_NOT_FOUND" "Node 22 or newer was not found on PATH."
	}
	$resolvedNodePath = [System.IO.Path]::GetFullPath($candidate)
	Assert-NoReparsePath -LiteralPath $resolvedNodePath
	$probe = Invoke-DirectProcess -FilePath $resolvedNodePath -ArgumentList @("-e", 'process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform,webSocket:typeof WebSocket}))')
	if ($probe.ExitCode -ne 0 -or $probe.Stdout.Length -gt 1024) { Throw-PackagerError "NODE_UNSUPPORTED" "Node runtime validation failed." }
	try { $runtime = $probe.Stdout | ConvertFrom-Json } catch { Throw-PackagerError "NODE_UNSUPPORTED" "Node runtime validation returned malformed output." }
	if ($null -eq $runtime.PSObject.Properties["version"] -or $null -eq $runtime.PSObject.Properties["arch"] -or
		$null -eq $runtime.PSObject.Properties["platform"] -or $null -eq $runtime.PSObject.Properties["webSocket"] -or
		$runtime.version -notmatch '^\d+\.\d+\.\d+' -or [int]($runtime.version.Split('.')[0]) -lt 22 -or
		$runtime.platform -ne "win32" -or $runtime.arch -notin @("x64", "arm64") -or $runtime.webSocket -ne "function") {
		Throw-PackagerError "NODE_UNSUPPORTED" "Node 22 or newer with built-in WebSocket support on Windows x64 or arm64 is required."
	}
	return [pscustomobject]@{ Path = $resolvedNodePath; Version = [string]$runtime.version; Architecture = [string]$runtime.arch }
}

function Resolve-CodeForValidation {
	$candidates = New-Object System.Collections.Generic.List[string]
	if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe")) }
	if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) { $candidates.Add((Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe")) }
	$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
	if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) { $candidates.Add((Join-Path $programFilesX86 "Microsoft VS Code\Code.exe")) }
	foreach ($command in @(Get-Command Code.exe, code -CommandType Application -ErrorAction SilentlyContinue)) {
		if ([System.IO.Path]::GetFileName($command.Source).Equals("Code.exe", [System.StringComparison]::OrdinalIgnoreCase)) { $candidates.Add($command.Source) }
	}
	$candidate = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
	if ($candidate.Count -ne 1) { Throw-PackagerError "CODE_NOT_FOUND" "Stable Visual Studio Code was not found for generated-kit validation." }
	$resolved = [System.IO.Path]::GetFullPath($candidate[0])
	Assert-NoReparsePath -LiteralPath $resolved
	if (-not [System.IO.Path]::GetFileName($resolved).Equals("Code.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
		Throw-PackagerError "CODE_NOT_STABLE" "Generated-kit validation requires a concrete stable Code.exe."
	}
	$probe = Invoke-DirectProcess -FilePath $resolved -ArgumentList @("--version") -TimeoutMilliseconds 15000
	if ($probe.ExitCode -ne 0 -or -not [regex]::IsMatch($probe.Stdout, '(?m)^[0-9]+\.[0-9]+\.[0-9]+(?:\r)?$')) {
		Throw-PackagerError "CODE_VERSION" "The selected Code.exe did not report a stable VS Code version."
	}
	return $resolved
}

function Resolve-PowerShellHost {
	$name = if ($PSVersionTable.PSEdition -eq "Core") { "pwsh.exe" } else { "powershell.exe" }
	$path = Join-Path $PSHOME $name
	if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Throw-PackagerError "POWERSHELL_HOST" "The current PowerShell host executable could not be resolved." }
	return [System.IO.Path]::GetFullPath($path)
}

function Get-GitProvenance {
	$git = Get-Command git.exe, git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $git) { Throw-PackagerError "GIT_NOT_FOUND" "Git is required to record portable-kit source provenance." }
	$insideResult = Invoke-DirectProcess -FilePath $git.Source -ArgumentList @("-C", $script:RepositoryRoot, "rev-parse", "--is-inside-work-tree")
	$prefixResult = Invoke-DirectProcess -FilePath $git.Source -ArgumentList @("-C", $script:RepositoryRoot, "rev-parse", "--show-prefix")
	if ($insideResult.ExitCode -ne 0 -or $insideResult.Stdout.Trim() -ne "true" -or
		$prefixResult.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($prefixResult.Stdout)) {
		Throw-PackagerError "GIT_ROOT" "The packager must reside at the expected root of a Git worktree."
	}
	$revisionResult = Invoke-DirectProcess -FilePath $git.Source -ArgumentList @("-C", $script:RepositoryRoot, "rev-parse", "HEAD")
	$timestampResult = Invoke-DirectProcess -FilePath $git.Source -ArgumentList @("-C", $script:RepositoryRoot, "show", "-s", "--format=%ct", "HEAD")
	$statusResult = Invoke-DirectProcess -FilePath $git.Source -ArgumentList @("-C", $script:RepositoryRoot, "status", "--porcelain=v1", "--untracked-files=all")
	$revision = $revisionResult.Stdout.Trim().ToLowerInvariant()
	$timestampText = $timestampResult.Stdout.Trim()
	if ($revisionResult.ExitCode -ne 0 -or $revision -notmatch '^[a-f0-9]{40,64}$' -or
		$timestampResult.ExitCode -ne 0 -or $timestampText -notmatch '^\d{9,12}$' -or $statusResult.ExitCode -ne 0) {
		Throw-PackagerError "GIT_PROVENANCE" "Git source provenance could not be resolved."
	}
	if ($statusResult.Stdout.Length -gt 4 * 1024 * 1024) { Throw-PackagerError "GIT_STATUS_TOO_LARGE" "Git status output is unexpectedly large." }
	$dirty = -not [string]::IsNullOrWhiteSpace($statusResult.Stdout)
	if ($dirty -and -not $AllowDirtySource) {
		Throw-PackagerError "DIRTY_SOURCE" "The source worktree is dirty. Commit/stash changes or pass -AllowDirtySource for a marked private build."
	}
	return [pscustomobject]@{ Revision = $revision; Dirty = $dirty; CommitEpoch = [int64]$timestampText; GitPath = $git.Source }
}

function Resolve-ArchiveTimestamp {
	param([int64]$CommitEpoch)
	$epoch = $CommitEpoch
	if ($script:SourceDateEpochSpecified) {
		$epoch = $SourceDateEpoch
	} elseif (-not [string]::IsNullOrWhiteSpace($env:SOURCE_DATE_EPOCH)) {
		$value = [int64]0
		if (-not [int64]::TryParse($env:SOURCE_DATE_EPOCH, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$value) -or
			$value -lt 315532800 -or $value -gt 4354819198) {
			Throw-PackagerError "SOURCE_DATE_EPOCH" "SOURCE_DATE_EPOCH must be a whole Unix second supported by the ZIP format."
		}
		$epoch = $value
	}
	$epoch -= ($epoch % 2)
	$unixStart = New-Object -TypeName datetime -ArgumentList @(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
	$utcDate = $unixStart.AddSeconds($epoch)
	$localDate = $utcDate.ToLocalTime()
	return [pscustomobject]@{ Epoch = $epoch; Utc = New-Object -TypeName System.DateTimeOffset -ArgumentList @($utcDate); ZipLocal = New-Object -TypeName System.DateTimeOffset -ArgumentList @($localDate) }
}

function Assert-OutputRoot {
	param([string]$LiteralPath)
	$full = [System.IO.Path]::GetFullPath($LiteralPath)
	if ($full.StartsWith("\\", [System.StringComparison]::Ordinal)) { Throw-PackagerError "OUTPUT_UNC" "Portable-kit build output must be on a local drive." }
	Assert-NoReparsePath -LiteralPath $full -AllowMissingLeaf
	[System.IO.Directory]::CreateDirectory($full) | Out-Null
	Assert-NoReparsePath -LiteralPath $full
	$root = [System.IO.Path]::GetPathRoot($full)
	$drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @($root)
	if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { Throw-PackagerError "OUTPUT_NOT_FIXED" "Portable-kit build output must be on a local fixed drive." }
	return $full
}

function Assert-SourceContract {
	$rootPackagePath = Join-Path $script:RepositoryRoot "package.json"
	$extensionPackagePath = Join-Path $script:RepositoryRoot "src\package.json"
	$nodeVersionPath = Join-Path $script:RepositoryRoot ".nvmrc"
	$launcherPath = Join-Path $script:PackagerRoot "Start-ZooCodeGrayScreenCapture.ps1"
	$readmePath = Join-Path $script:PackagerRoot "README.md"
	$operatorGuidePath = Join-Path $script:PackagerRoot "OPERATOR-GUIDE.md"
	$collectorEntryPath = Join-Path $script:RepositoryRoot "scripts\live-gray-screen-capture.mjs"
	$collectorRoot = Join-Path $script:RepositoryRoot "scripts\live-gray-screen-capture"
	$constantsPath = Join-Path $collectorRoot "constants.mjs"
	$licensePath = Join-Path $script:RepositoryRoot "LICENSE"
	foreach ($input in @(
		@($rootPackagePath, "root package metadata"),
		@($extensionPackagePath, "extension package metadata"),
		@($nodeVersionPath, "pinned Node version"),
		@($launcherPath, "portable launcher template"),
		@($readmePath, "portable offline documentation"),
		@($operatorGuidePath, "portable explicit operator guide"),
		@($collectorEntryPath, "collector entry point"),
		@($constantsPath, "collector constants"),
		@($licensePath, "ZooCode license")
	)) { [void](Assert-RegularFile -LiteralPath $input[0] -Description $input[1]) }
	Assert-NoReparsePath -LiteralPath $collectorRoot

	$rootPackage = Read-JsonFile -LiteralPath $rootPackagePath -MaximumBytes 1048576
	$extensionPackage = Read-JsonFile -LiteralPath $extensionPackagePath -MaximumBytes 2097152
	if ($null -eq $rootPackage.PSObject.Properties["engines"] -or $null -eq $rootPackage.engines.PSObject.Properties["node"] -or
		$null -eq $extensionPackage.PSObject.Properties["name"] -or $null -eq $extensionPackage.PSObject.Properties["publisher"] -or
		$null -eq $extensionPackage.PSObject.Properties["version"] -or $null -eq $extensionPackage.PSObject.Properties["engines"] -or
		$null -eq $extensionPackage.engines.PSObject.Properties["vscode"] -or $null -eq $extensionPackage.PSObject.Properties["main"]) {
		Throw-PackagerError "PACKAGE_METADATA" "Required extension package metadata is missing."
	}
	if ($extensionPackage.name -ne "zoo-code" -or $extensionPackage.publisher -ne "ZooCodeOrganization" -or
		$extensionPackage.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' -or
		$extensionPackage.engines.vscode -notmatch '^\^[0-9]+\.[0-9]+\.[0-9]+$' -or $extensionPackage.main -ne "./dist/extension.js") {
		Throw-PackagerError "PACKAGE_METADATA" "Extension identity, version, engine, or production entry metadata is unexpected."
	}
	$testedNodeVersion = (Read-StrictUtf8File -LiteralPath $nodeVersionPath -MaximumBytes 128).Trim()
	if ($testedNodeVersion -notmatch '^22\.[0-9]+\.[0-9]+$' -or [string]$rootPackage.engines.node -ne $testedNodeVersion) {
		Throw-PackagerError "NODE_VERSION_CONTRACT" "The root Node engine and .nvmrc must declare the same Node 22 release."
	}
	$launcherText = Read-StrictUtf8File -LiteralPath $launcherPath -MaximumBytes 2097152
	$placeholderCount = [regex]::Matches($launcherText, [regex]::Escape($script:ManifestPlaceholder)).Count
	if ($placeholderCount -ne 1) { Throw-PackagerError "LAUNCHER_PLACEHOLDER" "The launcher template must contain exactly one manifest hash placeholder." }
	$constantsText = Read-StrictUtf8File -LiteralPath $constantsPath -MaximumBytes 1048576
	$schemaMatches = [regex]::Matches($constantsText, '(?m)^export const SCHEMA_VERSION = ([0-9]+)\s*$')
	if ($schemaMatches.Count -ne 1 -or [int]$schemaMatches[0].Groups[1].Value -ne 1) {
		Throw-PackagerError "COLLECTOR_SCHEMA" "The portable launcher supports collector schema version 1 only."
	}
	$moduleItems = @(Get-ChildItem -LiteralPath $collectorRoot -Filter "*.mjs" -File -Force)
	if ($moduleItems.Count -lt 1) { Throw-PackagerError "COLLECTOR_MODULES" "No collector runtime modules were found." }
	foreach ($requiredWorker in @("process-sampler-worker.mjs", "snapshot-validator-worker.mjs")) {
		if (@($moduleItems | Where-Object { $_.Name -ceq $requiredWorker }).Count -ne 1) {
			Throw-PackagerError "COLLECTOR_WORKER" "A required collector worker is missing."
		}
	}
	foreach ($module in $moduleItems) {
		if (($module.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $module.Length -le 0) {
			Throw-PackagerError "COLLECTOR_MODULES" "Collector runtime modules must be nonempty regular files."
		}
	}
	return [pscustomobject]@{
		RootPackage = $rootPackage
		ExtensionPackage = $extensionPackage
		TestedNodeVersion = $testedNodeVersion
		LauncherPath = $launcherPath
		LauncherText = $launcherText
		ReadmePath = $readmePath
		OperatorGuidePath = $operatorGuidePath
		CollectorEntryPath = $collectorEntryPath
		CollectorRoot = $collectorRoot
		CollectorModules = $moduleItems
		CollectorSchemaVersion = 1
		LicensePath = $licensePath
	}
}

function Invoke-VsixBuild {
	$pnpm = Get-Command pnpm.cmd, pnpm.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $pnpm) { Throw-PackagerError "PNPM_NOT_FOUND" "The pinned pnpm command executable is required to build the production VSIX." }
	$previousLocation = Get-Location
	try {
		Set-Location -LiteralPath $script:RepositoryRoot
		& $pnpm.Source "--dir" $script:RepositoryRoot "vsix"
		if ($LASTEXITCODE -ne 0) { Throw-PackagerError "VSIX_BUILD_FAILED" "The repository VSIX task failed." }
	} finally {
		Set-Location -LiteralPath $previousLocation.Path
	}
}

function Assert-SafeArchivePath {
	param([string]$ArchivePath, [switch]$AllowDirectory)
	if ([string]::IsNullOrWhiteSpace($ArchivePath) -or $ArchivePath.Contains('\') -or $ArchivePath.StartsWith('/') -or
		$ArchivePath -match '^[A-Za-z]:' -or $ArchivePath.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
		Throw-PackagerError "ARCHIVE_PATH" ("An archive contains an unsafe path: '{0}'." -f $ArchivePath)
	}
	$isDirectory = $ArchivePath.EndsWith('/', [System.StringComparison]::Ordinal)
	if ($isDirectory -and -not $AllowDirectory) { Throw-PackagerError "ARCHIVE_DIRECTORY" "The generated transport ZIP may contain files only." }
	$value = if ($isDirectory) { $ArchivePath.Substring(0, $ArchivePath.Length - 1) } else { $ArchivePath }
	if ([string]::IsNullOrWhiteSpace($value)) { Throw-PackagerError "ARCHIVE_PATH" "An archive contains an empty path." }
	foreach ($segment in $value.Split('/')) {
		if ([string]::IsNullOrEmpty($segment) -or $segment -eq "." -or $segment -eq "..") {
			Throw-PackagerError "ARCHIVE_PATH" "An archive contains an unsafe path segment."
		}
	}
}

function Read-ZipEntryText {
	param([System.IO.Compression.ZipArchiveEntry]$Entry, [int64]$MaximumBytes)
	if ($Entry.Length -lt 1 -or $Entry.Length -gt $MaximumBytes) { Throw-PackagerError "VSIX_METADATA_SIZE" "VSIX metadata has an invalid size." }
	$stream = $null
	$memory = $null
	try {
		$stream = $Entry.Open()
		$memory = New-Object System.IO.MemoryStream
		$stream.CopyTo($memory)
		$bytes = $memory.ToArray()
		if ($bytes.Length -ne $Entry.Length) { Throw-PackagerError "VSIX_METADATA_CHANGED" "A VSIX metadata entry changed while it was read." }
		try { return $script:Utf8Strict.GetString($bytes) } catch { Throw-PackagerError "VSIX_METADATA_UTF8" "VSIX metadata is not valid UTF-8." }
	} finally {
		if ($null -ne $memory) { $memory.Dispose() }
		if ($null -ne $stream) { $stream.Dispose() }
	}
}

function Normalize-ExtensionMainPath {
	param([string]$Value)
	if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('\') -or $Value.StartsWith('/') -or $Value -match '^[A-Za-z]:') {
		Throw-PackagerError "VSIX_MAIN" "The VSIX extension main path is unsafe."
	}
	$normalized = $Value
	while ($normalized.StartsWith("./", [System.StringComparison]::Ordinal)) { $normalized = $normalized.Substring(2) }
	if ([string]::IsNullOrWhiteSpace($normalized)) { Throw-PackagerError "VSIX_MAIN" "The VSIX extension main path is empty." }
	foreach ($segment in $normalized.Split('/')) {
		if ([string]::IsNullOrEmpty($segment) -or $segment -eq "." -or $segment -eq "..") { Throw-PackagerError "VSIX_MAIN" "The VSIX extension main path is unsafe." }
	}
	return $normalized
}

function Assert-VsixManifestXml {
	param([string]$XmlText, [object]$ExpectedPackage)
	$settings = New-Object System.Xml.XmlReaderSettings
	$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
	$settings.XmlResolver = $null
	$settings.MaxCharactersInDocument = 1048576
	$stringReader = $null
	$reader = $null
	$document = New-Object System.Xml.XmlDocument
	$document.XmlResolver = $null
	try {
		$stringReader = New-Object -TypeName System.IO.StringReader -ArgumentList @($XmlText)
		$reader = [System.Xml.XmlReader]::Create($stringReader, $settings)
		$document.Load($reader)
	} catch {
		Throw-PackagerError "VSIX_MANIFEST_XML" "The VSIX package manifest is malformed or unsafe."
	} finally {
		if ($null -ne $reader) { $reader.Dispose() }
		if ($null -ne $stringReader) { $stringReader.Dispose() }
	}
	$identities = @($document.SelectNodes("//*[local-name()='Identity']"))
	$manifestAssets = @($document.SelectNodes("//*[local-name()='Asset' and @Type='Microsoft.VisualStudio.Code.Manifest']"))
	if ($identities.Count -ne 1 -or $manifestAssets.Count -ne 1 -or
		$identities[0].GetAttribute("Id") -cne [string]$ExpectedPackage.name -or
		$identities[0].GetAttribute("Version") -cne [string]$ExpectedPackage.version -or
		$identities[0].GetAttribute("Publisher") -cne [string]$ExpectedPackage.publisher -or
		$manifestAssets[0].GetAttribute("Path") -cne "extension/package.json") {
		Throw-PackagerError "VSIX_MANIFEST_IDENTITY" "The VSIX package manifest does not match extension package metadata."
	}
}

function Inspect-Vsix {
	param([string]$LiteralPath, [object]$ExpectedPackage)
	$item = Assert-RegularFile -LiteralPath $LiteralPath -Description "production VSIX"
	if ($item.Length -le 0) { Throw-PackagerError "VSIX_EMPTY" "The production VSIX is empty." }
	$archive = $null
	try {
		$archive = [System.IO.Compression.ZipFile]::OpenRead($item.FullName)
		$entries = New-Object System.Collections.Generic.List[object]
		foreach ($entry in $archive.Entries) { $entries.Add($entry) }
		if ($entries.Count -lt 4 -or $entries.Count -gt 100000) { Throw-PackagerError "VSIX_ENTRY_COUNT" "The VSIX entry count is invalid." }
		$seen = @{}
		foreach ($entry in $entries) {
			Assert-SafeArchivePath -ArchivePath $entry.FullName -AllowDirectory
			$key = $entry.FullName.ToLowerInvariant()
			if ($seen.ContainsKey($key)) { Throw-PackagerError "VSIX_CASE_COLLISION" "The VSIX has duplicate or case-colliding paths." }
			$seen[$key] = $true
		}
		$packageEntries = @($entries | Where-Object { $_.FullName -ceq "extension/package.json" -and -not [string]::IsNullOrEmpty($_.Name) })
		$vsixManifestEntries = @($entries | Where-Object { $_.FullName -ceq "extension.vsixmanifest" -and -not [string]::IsNullOrEmpty($_.Name) })
		$contentTypeEntries = @($entries | Where-Object { $_.FullName -ceq "[Content_Types].xml" -and -not [string]::IsNullOrEmpty($_.Name) })
		if ($packageEntries.Count -ne 1 -or $vsixManifestEntries.Count -ne 1 -or $contentTypeEntries.Count -ne 1) {
			Throw-PackagerError "VSIX_LAYOUT" "The VSIX does not contain exactly one standard extension package layout."
		}
		$packageText = Read-ZipEntryText -Entry $packageEntries[0] -MaximumBytes 2097152
		try { $package = $packageText | ConvertFrom-Json } catch { Throw-PackagerError "VSIX_PACKAGE_JSON" "The VSIX extension package manifest is malformed." }
		if ($null -eq $package.PSObject.Properties["name"] -or $null -eq $package.PSObject.Properties["publisher"] -or
			$null -eq $package.PSObject.Properties["version"] -or $null -eq $package.PSObject.Properties["engines"] -or
			$null -eq $package.engines.PSObject.Properties["vscode"] -or $null -eq $package.PSObject.Properties["main"] -or
			[string]$package.name -cne [string]$ExpectedPackage.name -or [string]$package.publisher -cne [string]$ExpectedPackage.publisher -or
			[string]$package.version -cne [string]$ExpectedPackage.version -or [string]$package.engines.vscode -cne [string]$ExpectedPackage.engines.vscode -or
			[string]$package.main -cne [string]$ExpectedPackage.main) {
			Throw-PackagerError "VSIX_PACKAGE_IDENTITY" "The VSIX extension package metadata does not match src/package.json."
		}
		$mainPath = "extension/" + (Normalize-ExtensionMainPath -Value ([string]$package.main))
		$mainEntries = @($entries | Where-Object { $_.FullName -ceq $mainPath -and -not [string]::IsNullOrEmpty($_.Name) -and $_.Length -gt 0 })
		$webviewJavaScript = @($entries | Where-Object { $_.FullName.StartsWith("extension/webview-ui/build/assets/", [System.StringComparison]::Ordinal) -and $_.FullName.EndsWith(".js", [System.StringComparison]::OrdinalIgnoreCase) -and $_.Length -gt 0 })
		$webviewCss = @($entries | Where-Object { $_.FullName.StartsWith("extension/webview-ui/build/assets/", [System.StringComparison]::Ordinal) -and $_.FullName.EndsWith(".css", [System.StringComparison]::OrdinalIgnoreCase) -and $_.Length -gt 0 })
		if ($mainEntries.Count -ne 1 -or $webviewJavaScript.Count -lt 1 -or $webviewCss.Count -lt 1) {
			Throw-PackagerError "VSIX_PRODUCTION_ASSETS" "The VSIX is missing its production extension or webview assets."
		}
		$vsixManifestText = Read-ZipEntryText -Entry $vsixManifestEntries[0] -MaximumBytes 1048576
		Assert-VsixManifestXml -XmlText $vsixManifestText -ExpectedPackage $ExpectedPackage
		return [pscustomobject]@{
			Path = $item.FullName
			Id = ([string]$package.publisher + "." + [string]$package.name)
			Name = [string]$package.name
			Version = [string]$package.version
			EnginesVscode = [string]$package.engines.vscode
			Bytes = [int64]$item.Length
			Sha256 = Get-Sha256File -LiteralPath $item.FullName
		}
	} catch [System.IO.InvalidDataException] {
		Throw-PackagerError "VSIX_INVALID_ZIP" "The production VSIX is not a valid ZIP archive."
	} finally {
		if ($null -ne $archive) { $archive.Dispose() }
	}
}

function Copy-RegularFile {
	param([string]$Source, [string]$Destination)
	[void](Assert-RegularFile -LiteralPath $Source -Description "packaging source file")
	$parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Destination))
	[System.IO.Directory]::CreateDirectory($parent) | Out-Null
	[System.IO.File]::Copy($Source, $Destination, $false)
}

function New-PayloadRecords {
	param([string]$BundleRoot)
	$pathMap = @{}
	foreach ($file in @(Get-SafeTreeFiles -Root $BundleRoot)) {
		$relative = Get-NormalizedRelativePath -Child $file.FullName -Parent $BundleRoot
		if ($relative -ceq "kit-manifest.json") { continue }
		$key = $relative.ToLowerInvariant()
		if ($pathMap.ContainsKey($key)) { Throw-PackagerError "PAYLOAD_CASE_COLLISION" "Generated payload paths collide by case." }
		$pathMap[$key] = $relative
	}
	$paths = Get-OrdinalSortedStrings -Values @($pathMap.Values)
	$records = New-Object System.Collections.Generic.List[object]
	foreach ($relative in $paths) {
		$filePath = $BundleRoot
		foreach ($segment in $relative.Split('/')) { $filePath = Join-Path $filePath $segment }
		$item = Get-Item -LiteralPath $filePath -Force
		$records.Add([ordered]@{ path = $relative; bytes = [int64]$item.Length; sha256 = Get-Sha256File -LiteralPath $item.FullName })
	}
	if ($records.Count -lt 4 -or $records.Count -gt 512) { Throw-PackagerError "PAYLOAD_COUNT" "The generated bundle payload count is invalid." }
	return $records.ToArray()
}

function New-DeterministicManifest {
	param([object]$SourceContract, [object]$Provenance, [object]$Node, [object]$Vsix, [string]$BundleRoot)
	$payload = @(New-PayloadRecords -BundleRoot $BundleRoot)
	$extensionRecord = @($payload | Where-Object { $_.path -ceq ("extension/zoo-code-" + $Vsix.Version + ".vsix") })
	if ($extensionRecord.Count -ne 1 -or [int64]$extensionRecord[0].bytes -ne $Vsix.Bytes -or [string]$extensionRecord[0].sha256 -cne $Vsix.Sha256) {
		Throw-PackagerError "EXTENSION_PAYLOAD" "The copied VSIX does not match inspected extension provenance."
	}
	$manifest = [ordered]@{
		schemaVersion = $script:KitManifestSchemaVersion
		kitFormatVersion = $script:KitFormatVersion
		source = [ordered]@{ revision = $Provenance.Revision; dirty = [bool]$Provenance.Dirty }
		prerequisites = [ordered]@{
			minimumNodeMajor = 22
			testedNodeVersion = $SourceContract.TestedNodeVersion
			minimumPowerShellMajor = 5
			platform = "win32"
			architectures = @($Node.Architecture)
		}
		collector = [ordered]@{ schemaVersion = $SourceContract.CollectorSchemaVersion; entry = "collector/live-gray-screen-capture.mjs" }
		extension = [ordered]@{
			id = $Vsix.Id
			name = $Vsix.Name
			version = $Vsix.Version
			enginesVscode = $Vsix.EnginesVscode
			packagePath = "extension/zoo-code-" + $Vsix.Version + ".vsix"
			bytes = [int64]$Vsix.Bytes
			sha256 = $Vsix.Sha256
		}
		payload = $payload
	}
	$json = ($manifest | ConvertTo-Json -Depth 8 -Compress) + "`n"
	return [pscustomobject]@{ Value = $manifest; Text = $json; Bytes = $script:Utf8NoBom.GetBytes($json) }
}

function Stamp-Launcher {
	param([string]$TemplateText, [string]$ManifestSha256, [string]$Destination)
	$count = [regex]::Matches($TemplateText, [regex]::Escape($script:ManifestPlaceholder)).Count
	if ($count -ne 1) { Throw-PackagerError "LAUNCHER_PLACEHOLDER" "The launcher template must contain exactly one manifest hash placeholder." }
	$stamped = $TemplateText.Replace($script:ManifestPlaceholder, $ManifestSha256)
	if ($stamped.Contains($script:ManifestPlaceholder) -or [regex]::Matches($stamped, [regex]::Escape($ManifestSha256)).Count -ne 1) {
		Throw-PackagerError "LAUNCHER_STAMP" "The generated launcher manifest binding is invalid."
	}
	Write-NewFileBytes -LiteralPath $Destination -Bytes $script:Utf8NoBom.GetBytes($stamped)
}

function Invoke-GeneratedKitValidation {
	param([string]$KitRoot, [string]$NodePath, [string]$CodePath, [string]$ValidationOutputRoot)
	$launcherPath = Join-Path $KitRoot "Start-ZooCodeGrayScreenCapture.ps1"
	$powerShellPath = Resolve-PowerShellHost
	[System.IO.Directory]::CreateDirectory($ValidationOutputRoot) | Out-Null
	$result = Invoke-DirectProcess -FilePath $powerShellPath -ArgumentList @(
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $launcherPath,
		"-Action", "Validate", "-WorkspacePath", $KitRoot, "-OutputPath", $ValidationOutputRoot,
		"-NodePath", $NodePath, "-CodePath", $CodePath
	) -WorkingDirectory $KitRoot -TimeoutMilliseconds 120000
	if ($result.ExitCode -ne 0 -or $result.Stdout -notmatch 'Portable ZooCode gray-screen kit is valid\.') {
		if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) { [Console]::Error.Write($result.Stdout) }
		if (-not [string]::IsNullOrWhiteSpace($result.Stderr)) { [Console]::Error.Write($result.Stderr) }
		Throw-PackagerError "GENERATED_KIT_INVALID" "The generated launcher's Validate action failed."
	}
}

function Invoke-BundledCollectorHelp {
	param([string]$KitRoot, [string]$NodePath)
	$collectorPath = Join-Path $KitRoot "ZooCodeGrayScreenCapture.bundle\collector\live-gray-screen-capture.mjs"
	$result = Invoke-DirectProcess -FilePath $NodePath -ArgumentList @($collectorPath, "--help") -WorkingDirectory $KitRoot -TimeoutMilliseconds 30000
	if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Stdout)) {
		if (-not [string]::IsNullOrWhiteSpace($result.Stderr)) { [Console]::Error.Write($result.Stderr) }
		Throw-PackagerError "COLLECTOR_HELP" "The bundled collector help command failed outside its source location."
	}
}

function New-DeterministicZip {
	param([string]$KitRoot, [string]$ArchivePath, [string]$RootName, [System.DateTimeOffset]$Timestamp)
	$filesByPath = @{}
	foreach ($file in @(Get-SafeTreeFiles -Root $KitRoot)) {
		$relative = Get-NormalizedRelativePath -Child $file.FullName -Parent $KitRoot
		$key = $relative.ToLowerInvariant()
		if ($filesByPath.ContainsKey($key)) { Throw-PackagerError "ZIP_CASE_COLLISION" "Generated kit paths collide by case." }
		$filesByPath[$key] = $relative
	}
	$relativePaths = Get-OrdinalSortedStrings -Values @($filesByPath.Values)
	$stream = $null
	$archive = $null
	try {
		$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($ArchivePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
		$archive = New-Object -TypeName System.IO.Compression.ZipArchive -ArgumentList @($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true, $script:Utf8NoBom)
		foreach ($relative in $relativePaths) {
			$source = $KitRoot
			foreach ($segment in $relative.Split('/')) { $source = Join-Path $source $segment }
			$entryName = $RootName + "/" + $relative
			Assert-SafeArchivePath -ArchivePath $entryName
			$entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
			$entry.LastWriteTime = $Timestamp
			$entry.ExternalAttributes = 0
			$input = $null
			$output = $null
			try {
				$input = New-Object -TypeName System.IO.FileStream -ArgumentList @($source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
				$output = $entry.Open()
				$input.CopyTo($output)
			} finally {
				if ($null -ne $output) { $output.Dispose() }
				if ($null -ne $input) { $input.Dispose() }
			}
		}
	} finally {
		if ($null -ne $archive) { $archive.Dispose() }
		if ($null -ne $stream) { $stream.Dispose() }
	}
}

function Get-KitFileMap {
	param([string]$KitRoot)
	$map = @{}
	foreach ($file in @(Get-SafeTreeFiles -Root $KitRoot)) {
		$relative = Get-NormalizedRelativePath -Child $file.FullName -Parent $KitRoot
		$key = $relative.ToLowerInvariant()
		if ($map.ContainsKey($key)) { Throw-PackagerError "KIT_CASE_COLLISION" "A kit tree has case-colliding files." }
		$map[$key] = [pscustomobject]@{ Path = $relative; Bytes = [int64]$file.Length; Sha256 = Get-Sha256File -LiteralPath $file.FullName }
	}
	return $map
}

function Assert-ZipParity {
	param([string]$ArchivePath, [string]$KitRoot, [string]$RootName, [System.DateTimeOffset]$Timestamp)
	$sourceMap = Get-KitFileMap -KitRoot $KitRoot
	$expectedRelative = Get-OrdinalSortedStrings -Values @($sourceMap.Values | ForEach-Object { $_.Path })
	$expectedEntries = @($expectedRelative | ForEach-Object { $RootName + "/" + $_ })
	$archive = $null
	try {
		$archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
		$entries = New-Object System.Collections.Generic.List[object]
		foreach ($entry in $archive.Entries) { $entries.Add($entry) }
		if ($entries.Count -ne $expectedEntries.Count) { Throw-PackagerError "ZIP_INVENTORY" "The transport ZIP entry inventory differs from the unpacked kit." }
		for ($index = 0; $index -lt $entries.Count; $index += 1) {
			$entry = $entries[$index]
			Assert-SafeArchivePath -ArchivePath $entry.FullName
			if ([string]::IsNullOrEmpty($entry.Name) -or $entry.FullName -cne $expectedEntries[$index]) {
				Throw-PackagerError "ZIP_ORDER" "The transport ZIP is not in deterministic sorted order."
			}
			$actualTimestamp = $entry.LastWriteTime.ToUniversalTime()
			$expectedTimestamp = $Timestamp.ToUniversalTime()
			if ($actualTimestamp.Ticks -ne $expectedTimestamp.Ticks) {
				Throw-PackagerError "ZIP_TIMESTAMP" ("The transport ZIP contains a non-deterministic timestamp (actual '{0}', expected '{1}')." -f $actualTimestamp.ToString("o"), $expectedTimestamp.ToString("o"))
			}
			$relative = $entry.FullName.Substring($RootName.Length + 1)
			$record = $sourceMap[$relative.ToLowerInvariant()]
			if ($null -eq $record -or $record.Path -cne $relative -or [int64]$entry.Length -ne $record.Bytes) {
				Throw-PackagerError "ZIP_PARITY" "A transport ZIP entry does not match the unpacked kit."
			}
			$entryStream = $null
			try {
				$entryStream = $entry.Open()
				$hash = Get-Sha256Stream -Stream $entryStream
			} finally { if ($null -ne $entryStream) { $entryStream.Dispose() } }
			if ($hash -cne $record.Sha256) { Throw-PackagerError "ZIP_PARITY" "A transport ZIP entry checksum differs from the unpacked kit." }
		}
	} finally { if ($null -ne $archive) { $archive.Dispose() } }
}

function Expand-ValidatedZip {
	param([string]$ArchivePath, [string]$Destination, [string]$RootName)
	[System.IO.Directory]::CreateDirectory($Destination) | Out-Null
	$archive = $null
	try {
		$archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
		foreach ($entry in $archive.Entries) {
			Assert-SafeArchivePath -ArchivePath $entry.FullName
			if (-not $entry.FullName.StartsWith($RootName + "/", [System.StringComparison]::Ordinal) -or [string]::IsNullOrEmpty($entry.Name)) {
				Throw-PackagerError "ZIP_ROOT" "The transport ZIP must contain exactly one versioned file root."
			}
			$relative = $entry.FullName.Substring($RootName.Length + 1)
			$expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $Destination $RootName))
			$target = $expectedRoot
			foreach ($segment in $relative.Split('/')) { $target = Join-Path $target $segment }
			$target = [System.IO.Path]::GetFullPath($target)
			if (-not (Test-PathWithin -Candidate $target -Parent $expectedRoot) -or $target.Equals($expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
				Throw-PackagerError "ZIP_ESCAPE" "A transport ZIP entry escapes its versioned root."
			}
			[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
			$input = $null
			$output = $null
			try {
				$input = $entry.Open()
				$output = New-Object -TypeName System.IO.FileStream -ArgumentList @($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
				$input.CopyTo($output)
				$output.Flush($true)
			} finally {
				if ($null -ne $output) { $output.Dispose() }
				if ($null -ne $input) { $input.Dispose() }
			}
		}
	} finally { if ($null -ne $archive) { $archive.Dispose() } }
	return [System.IO.Path]::GetFullPath((Join-Path $Destination $RootName))
}

function Assert-TreeParity {
	param([string]$ExpectedRoot, [string]$ActualRoot)
	$expected = Get-KitFileMap -KitRoot $ExpectedRoot
	$actual = Get-KitFileMap -KitRoot $ActualRoot
	if ($expected.Count -ne $actual.Count) { Throw-PackagerError "EXTRACTED_PARITY" "The extracted kit file inventory differs from the unpacked kit." }
	foreach ($key in $expected.Keys) {
		if (-not $actual.ContainsKey($key) -or $actual[$key].Path -cne $expected[$key].Path -or
			$actual[$key].Bytes -ne $expected[$key].Bytes -or $actual[$key].Sha256 -cne $expected[$key].Sha256) {
			Throw-PackagerError "EXTRACTED_PARITY" "An extracted kit file differs from the unpacked kit."
		}
	}
}

function Promote-GeneratedOutputs {
	param([string]$StagingKit, [string]$StagingZip, [string]$FinalKit, [string]$FinalZip, [string]$OperationId)
	$backupKit = $FinalKit + ".backup-" + $OperationId
	$backupZip = $FinalZip + ".backup-" + $OperationId
	$movedKitBackup = $false
	$movedZipBackup = $false
	$promotedKit = $false
	$promotedZip = $false
	try {
		if (Test-Path -LiteralPath $FinalKit) { [System.IO.Directory]::Move($FinalKit, $backupKit); $movedKitBackup = $true }
		if (Test-Path -LiteralPath $FinalZip) { [System.IO.File]::Move($FinalZip, $backupZip); $movedZipBackup = $true }
		[System.IO.Directory]::Move($StagingKit, $FinalKit); $promotedKit = $true
		[System.IO.File]::Move($StagingZip, $FinalZip); $promotedZip = $true
	} catch {
		if ($promotedZip) { Remove-Item -LiteralPath $FinalZip -Force -ErrorAction SilentlyContinue }
		if ($promotedKit) { Remove-Item -LiteralPath $FinalKit -Recurse -Force -ErrorAction SilentlyContinue }
		if ($movedZipBackup -and (Test-Path -LiteralPath $backupZip)) { [System.IO.File]::Move($backupZip, $FinalZip) }
		if ($movedKitBackup -and (Test-Path -LiteralPath $backupKit)) { [System.IO.Directory]::Move($backupKit, $FinalKit) }
		throw
	}
	Remove-Item -LiteralPath $backupZip -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $backupKit -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-PortableKitBuild {
	if ($env:OS -ne "Windows_NT" -or $PSVersionTable.PSVersion.Major -lt 5) {
		Throw-PackagerError "UNSUPPORTED_POWERSHELL" "Windows PowerShell 5.1 or PowerShell 7+ on Windows is required."
	}
	if ($SkipVsixBuild -and [string]::IsNullOrWhiteSpace($VsixPath)) { Throw-PackagerError "VSIX_PATH_REQUIRED" "-SkipVsixBuild requires -VsixPath." }
	if (-not $SkipVsixBuild -and -not [string]::IsNullOrWhiteSpace($VsixPath)) { Throw-PackagerError "VSIX_OPTION_CONFLICT" "-VsixPath is supported only together with -SkipVsixBuild." }

	$sourceContract = Assert-SourceContract
	$provenance = Get-GitProvenance
	$node = Resolve-NodeRuntime
	$codePath = Resolve-CodeForValidation
	$archiveTimestamp = Resolve-ArchiveTimestamp -CommitEpoch $provenance.CommitEpoch
	$outputCandidate = if ([string]::IsNullOrWhiteSpace($OutputRoot)) { Join-Path $script:RepositoryRoot "bin\portable-gray-screen-kit" } else { $OutputRoot }
	$resolvedOutputRoot = Assert-OutputRoot -LiteralPath $outputCandidate

	if (-not $SkipVsixBuild) { Invoke-VsixBuild }
	$expectedVsixPath = Join-Path $script:RepositoryRoot ("bin\zoo-code-" + [string]$sourceContract.ExtensionPackage.version + ".vsix")
	$resolvedVsixPath = if ($SkipVsixBuild) { [System.IO.Path]::GetFullPath($VsixPath) } else { $expectedVsixPath }
	$vsix = Inspect-Vsix -LiteralPath $resolvedVsixPath -ExpectedPackage $sourceContract.ExtensionPackage

	$kitName = "ZooCodeGrayScreenCapture-" + $vsix.Version + "-kit" + $script:KitFormatVersion
	$finalKit = Join-Path $resolvedOutputRoot $kitName
	$finalZip = Join-Path $resolvedOutputRoot ($kitName + ".zip")
	if ((Test-Path -LiteralPath $finalKit) -or (Test-Path -LiteralPath $finalZip)) {
		if (-not $Force) { Throw-PackagerError "OUTPUT_EXISTS" "The exact versioned portable-kit output already exists. Pass -Force to replace it after full validation." }
		if ((Test-Path -LiteralPath $finalKit) -and -not (Test-Path -LiteralPath $finalKit -PathType Container)) { Throw-PackagerError "OUTPUT_TYPE" "The existing unpacked output is not a directory." }
		if ((Test-Path -LiteralPath $finalZip) -and -not (Test-Path -LiteralPath $finalZip -PathType Leaf)) { Throw-PackagerError "OUTPUT_TYPE" "The existing ZIP output is not a file." }
		if (Test-Path -LiteralPath $finalKit) { Assert-NoReparsePath -LiteralPath $finalKit }
		if (Test-Path -LiteralPath $finalZip) { Assert-NoReparsePath -LiteralPath $finalZip }
	}

	$operationId = [guid]::NewGuid().ToString("N")
	$stagingContainer = Join-Path $resolvedOutputRoot (".staging-" + $operationId)
	$stagingKit = Join-Path $stagingContainer $kitName
	$stagingZip = Join-Path $resolvedOutputRoot ("." + $kitName + "." + $operationId + ".zip.tmp")
	$extractContainer = Join-Path $resolvedOutputRoot (".zip validation Ω with spaces-" + $operationId)
	$validationOutput = Join-Path $resolvedOutputRoot (".launcher-validation-" + $operationId)
	$extractedValidationOutput = Join-Path $resolvedOutputRoot (".extracted-validation-" + $operationId)
	$manifestSha256 = $null
	try {
		[System.IO.Directory]::CreateDirectory($stagingKit) | Out-Null
		$bundleRoot = Join-Path $stagingKit "ZooCodeGrayScreenCapture.bundle"
		$collectorDestination = Join-Path $bundleRoot "collector"
		[System.IO.Directory]::CreateDirectory((Join-Path $collectorDestination "live-gray-screen-capture")) | Out-Null
		Copy-RegularFile -Source $sourceContract.CollectorEntryPath -Destination (Join-Path $collectorDestination "live-gray-screen-capture.mjs")
		foreach ($module in $sourceContract.CollectorModules) {
			Copy-RegularFile -Source $module.FullName -Destination (Join-Path $collectorDestination ("live-gray-screen-capture\" + $module.Name))
		}
		$extensionDestination = Join-Path $bundleRoot ("extension\zoo-code-" + $vsix.Version + ".vsix")
		Copy-RegularFile -Source $vsix.Path -Destination $extensionDestination
		Copy-RegularFile -Source $sourceContract.LicensePath -Destination (Join-Path $bundleRoot "notices\Zoo-Code-LICENSE.txt")
		Copy-RegularFile -Source $sourceContract.ReadmePath -Destination (Join-Path $bundleRoot "README.md")
		Copy-RegularFile -Source $sourceContract.OperatorGuidePath -Destination (Join-Path $bundleRoot "OPERATOR-GUIDE.md")

		$manifest = New-DeterministicManifest -SourceContract $sourceContract -Provenance $provenance -Node $node -Vsix $vsix -BundleRoot $bundleRoot
		$manifestPath = Join-Path $bundleRoot "kit-manifest.json"
		Write-NewFileBytes -LiteralPath $manifestPath -Bytes $manifest.Bytes
		$manifestSha256 = Get-Sha256Bytes -Bytes $manifest.Bytes
		Stamp-Launcher -TemplateText $sourceContract.LauncherText -ManifestSha256 $manifestSha256 -Destination (Join-Path $stagingKit "Start-ZooCodeGrayScreenCapture.ps1")

		Invoke-GeneratedKitValidation -KitRoot $stagingKit -NodePath $node.Path -CodePath $codePath -ValidationOutputRoot $validationOutput
		Invoke-BundledCollectorHelp -KitRoot $stagingKit -NodePath $node.Path
		New-DeterministicZip -KitRoot $stagingKit -ArchivePath $stagingZip -RootName $kitName -Timestamp $archiveTimestamp.ZipLocal
		Assert-ZipParity -ArchivePath $stagingZip -KitRoot $stagingKit -RootName $kitName -Timestamp $archiveTimestamp.Utc
		$extractedKit = Expand-ValidatedZip -ArchivePath $stagingZip -Destination $extractContainer -RootName $kitName
		Assert-TreeParity -ExpectedRoot $stagingKit -ActualRoot $extractedKit
		Invoke-GeneratedKitValidation -KitRoot $extractedKit -NodePath $node.Path -CodePath $codePath -ValidationOutputRoot $extractedValidationOutput
		Invoke-BundledCollectorHelp -KitRoot $extractedKit -NodePath $node.Path
		Promote-GeneratedOutputs -StagingKit $stagingKit -StagingZip $stagingZip -FinalKit $finalKit -FinalZip $finalZip -OperationId $operationId
	} finally {
		Remove-Item -LiteralPath $stagingContainer -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath $stagingZip -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath $extractContainer -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath $validationOutput -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -LiteralPath $extractedValidationOutput -Recurse -Force -ErrorAction SilentlyContinue
	}

	[Console]::Out.WriteLine("Portable ZooCode gray-screen kit built and validated.")
	[Console]::Out.WriteLine(("Unpacked kit: {0}" -f $finalKit))
	[Console]::Out.WriteLine(("Transport ZIP: {0}" -f $finalZip))
	[Console]::Out.WriteLine(("Manifest SHA-256: {0}" -f $manifestSha256))
	[Console]::Out.WriteLine(("Extension: {0}@{1}; SHA-256: {2}" -f $vsix.Id, $vsix.Version, $vsix.Sha256))
	[Console]::Out.WriteLine(("Source revision: {0}; dirty: {1}; archive epoch: {2}" -f $provenance.Revision, $provenance.Dirty, $archiveTimestamp.Epoch))
	return 0
}

try {
	exit (Invoke-PortableKitBuild)
} catch {
	$code = if ($_.Exception.Data.Contains("ZooCodeErrorCode")) { [string]$_.Exception.Data["ZooCodeErrorCode"] } else { "PORTABLE_PACKAGER_FAILED" }
	[Console]::Error.WriteLine(("ZooCode portable-kit packaging failed ({0})." -f $code))
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
