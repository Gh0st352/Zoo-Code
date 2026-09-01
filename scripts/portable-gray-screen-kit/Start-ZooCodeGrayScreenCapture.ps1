[CmdletBinding()]
param(
	[ValidateSet("Start", "Stop", "Snapshot", "Status", "Validate")]
	[string]$Action = "Start",
	[string]$WorkspacePath,
	[string]$OutputPath,
	[string]$NodePath,
	[string]$CodePath,
	[string]$RunPath,
	[ValidateRange(0, 65535)]
	[int]$CdpPort = 0,
	[ValidateSet("Isolated", "Normal")]
	[string]$ProfileMode = "Isolated",
	[string[]]$CodeArgument = @(),
	[switch]$SkipLocalGitExclude,
	[switch]$AcknowledgeRepositoryOutputRisk,
	[switch]$DisableAutoSnapshots,
	[ValidateRange(0.50, 0.95)]
	[double]$SnapshotThreshold = 0.82,
	[ValidateRange(2, 20)]
	[int]$AutoSnapshotSamples = 3,
	[switch]$DisableTransportDiagnostics,
	[switch]$DisablePartialCoalescing,
	[switch]$AcknowledgeProfileReuseRisk,
	[ValidateSet("Wait", "Abort")]
	[string]$SnapshotPolicy = "Wait",
	[switch]$AcknowledgeSnapshotPrivacyRisk,
	[ValidateRange(1, 1000000)]
	[int]$TargetOrdinal = 1,
	[switch]$OverrideCooldown,
	[switch]$AllowUnresponsiveAttempt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:TargetOrdinalSpecified = $PSBoundParameters.ContainsKey("TargetOrdinal")
$script:KitManifestSchemaVersion = 1
$script:KitFormatVersion = 1
$script:StateSchemaVersion = 1
$script:ExpectedManifestSha256 = "__KIT_MANIFEST_SHA256__"
$script:ScriptPath = [System.IO.Path]::GetFullPath($PSCommandPath)
$script:ScriptRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetDirectoryName($script:ScriptPath))
$script:BundleRoot = Join-Path $script:ScriptRoot "ZooCodeGrayScreenCapture.bundle"
$script:Utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false, $true)
$script:Utf8NoBomLenient = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
[Console]::OutputEncoding = $script:Utf8NoBomLenient

function Throw-KitError {
	param([string]$Code, [string]$Message)
	$exception = New-Object -TypeName System.InvalidOperationException -ArgumentList @($Message)
	$exception.Data["ZooCodeErrorCode"] = $Code
	throw $exception
}

function Test-ExactProperties {
	param([object]$Value, [string[]]$Names)
	if ($null -eq $Value) { return $false }
	$actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
	if ($actual.Count -ne $Names.Count) { return $false }
	$expected = @{}
	foreach ($name in $Names) { $expected[$name] = $true }
	foreach ($name in $actual) {
		if (-not $expected.ContainsKey($name)) { return $false }
	}
	return $true
}

function Test-IntegerInRange {
	param([object]$Value, [int64]$Minimum, [int64]$Maximum)
	if ($null -eq $Value -or $Value -is [bool]) { return $false }
	if ($Value -isnot [byte] -and $Value -isnot [sbyte] -and
		$Value -isnot [int16] -and $Value -isnot [uint16] -and
		$Value -isnot [int32] -and $Value -isnot [uint32] -and
		$Value -isnot [int64] -and $Value -isnot [uint64]) {
		return $false
	}
	try { $integer = [int64]$Value } catch { return $false }
	return $integer -ge $Minimum -and $integer -le $Maximum
}

function Get-Sha256File {
	param([string]$LiteralPath)
	return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Text {
	param([string]$Value)
	$algorithm = [System.Security.Cryptography.SHA256]::Create()
	try {
		$bytes = $script:Utf8NoBomLenient.GetBytes($Value)
		return ([System.BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
	} finally {
		$algorithm.Dispose()
	}
}

function Read-BoundedUtf8 {
	param([string]$LiteralPath, [int64]$MaximumBytes)
	$item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
	if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
		Throw-KitError "UNSAFE_FILE" "Expected a regular non-reparse file."
	}
	if ($item.Length -gt $MaximumBytes) { Throw-KitError "FILE_TOO_LARGE" "A bounded metadata file is too large." }
	$bytes = [System.IO.File]::ReadAllBytes($item.FullName)
	if ($bytes.Length -ne $item.Length) { Throw-KitError "FILE_CHANGED" "A metadata file changed while it was being read." }
	try {
		return $script:Utf8NoBom.GetString($bytes)
	} catch {
		Throw-KitError "INVALID_UTF8" "A metadata file is not valid UTF-8."
	}
}

function Read-BoundedJson {
	param([string]$LiteralPath, [int64]$MaximumBytes)
	$text = Read-BoundedUtf8 -LiteralPath $LiteralPath -MaximumBytes $MaximumBytes
	try { return $text | ConvertFrom-Json } catch { Throw-KitError "INVALID_JSON" "A bounded metadata file is not valid JSON." }
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
			Throw-KitError "PATH_MISSING" "A required path does not exist."
		}
		$item = Get-Item -LiteralPath $current -Force
		if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
			Throw-KitError "REPARSE_PATH" "Portable kit and evidence paths may not traverse reparse points."
		}
	}
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
				Throw-KitError "REPARSE_PAYLOAD" "The portable bundle contains a reparse point."
			}
			if ($entry.PSIsContainer) { $stack.Push($entry.FullName) } else { $files.Add($entry) }
		}
	}
	return $files.ToArray()
}

function Get-NormalizedRelativePath {
	param([string]$Child, [string]$Parent)
	$childFull = [System.IO.Path]::GetFullPath($Child)
	$parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
	if (-not (Test-PathWithin -Candidate $childFull -Parent $parentFull) -or $childFull.Equals($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
		Throw-KitError "PATH_ESCAPE" "A path is outside its required parent."
	}
	return $childFull.Substring($parentFull.Length + 1).Replace('\', '/')
}

function Resolve-PayloadPath {
	param([string]$RelativePath)
	if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.Contains('\') -or $RelativePath.StartsWith('/') -or $RelativePath.EndsWith('/')) {
		Throw-KitError "INVALID_PAYLOAD_PATH" "The kit manifest contains an invalid payload path."
	}
	$segments = $RelativePath.Split('/')
	foreach ($segment in $segments) {
		if ([string]::IsNullOrEmpty($segment) -or $segment -eq "." -or $segment -eq ".." -or $segment.IndexOfAny([char[]]@([char]0, [char]10, [char]13)) -ge 0) {
			Throw-KitError "INVALID_PAYLOAD_PATH" "The kit manifest contains an unsafe payload path."
		}
	}
	$candidate = $script:BundleRoot
	foreach ($segment in $segments) { $candidate = Join-Path $candidate $segment }
	$candidate = [System.IO.Path]::GetFullPath($candidate)
	if (-not (Test-PathWithin -Candidate $candidate -Parent $script:BundleRoot)) {
		Throw-KitError "PAYLOAD_ESCAPE" "A kit payload escapes the bundle directory."
	}
	return $candidate
}

function Assert-KitManifest {
	if ($script:ExpectedManifestSha256.StartsWith("__KIT_", [System.StringComparison]::Ordinal)) {
		Throw-KitError "UNSTAMPED_LAUNCHER" "This is an unstamped source launcher. Use a generated portable kit."
	}
	if ($script:ExpectedManifestSha256 -notmatch '^[a-f0-9]{64}$') {
		Throw-KitError "INVALID_LAUNCHER_BINDING" "The launcher manifest binding is invalid."
	}
	Assert-NoReparsePath -LiteralPath $script:BundleRoot
	$manifestPath = Join-Path $script:BundleRoot "kit-manifest.json"
	Assert-NoReparsePath -LiteralPath $manifestPath
	if ((Get-Sha256File -LiteralPath $manifestPath) -cne $script:ExpectedManifestSha256) {
		Throw-KitError "MANIFEST_HASH_MISMATCH" "The launcher and adjacent bundle do not match."
	}
	$manifest = Read-BoundedJson -LiteralPath $manifestPath -MaximumBytes 1048576
	if (-not (Test-ExactProperties -Value $manifest -Names @("schemaVersion", "kitFormatVersion", "source", "prerequisites", "collector", "extension", "payload"))) {
		Throw-KitError "MANIFEST_SCHEMA" "The kit manifest has unexpected fields."
	}
	if ($manifest.schemaVersion -ne $script:KitManifestSchemaVersion -or $manifest.kitFormatVersion -ne $script:KitFormatVersion) {
		Throw-KitError "KIT_VERSION" "The portable kit format is unsupported."
	}
	if (-not (Test-ExactProperties -Value $manifest.source -Names @("revision", "dirty")) -or
		$manifest.source.revision -notmatch '^(unknown|[a-f0-9]{7,64})$' -or $manifest.source.dirty -isnot [bool]) {
		Throw-KitError "SOURCE_SCHEMA" "The kit source provenance is invalid."
	}
	if (-not (Test-ExactProperties -Value $manifest.prerequisites -Names @("minimumNodeMajor", "testedNodeVersion", "minimumPowerShellMajor", "platform", "architectures")) -or
		$manifest.prerequisites.minimumNodeMajor -ne 22 -or $manifest.prerequisites.minimumPowerShellMajor -ne 5 -or
		$manifest.prerequisites.platform -ne "win32" -or $manifest.prerequisites.testedNodeVersion -notmatch '^22\.[0-9]+\.[0-9]+$') {
		Throw-KitError "PREREQUISITE_SCHEMA" "The kit prerequisite declaration is invalid."
	}
	$architectures = @($manifest.prerequisites.architectures)
	if ($architectures.Count -lt 1 -or @($architectures | Where-Object { $_ -notin @("x64", "arm64") }).Count -gt 0) {
		Throw-KitError "ARCHITECTURE_SCHEMA" "The kit architecture declaration is invalid."
	}
	if (-not (Test-ExactProperties -Value $manifest.collector -Names @("schemaVersion", "entry")) -or
		$manifest.collector.schemaVersion -ne 1 -or $manifest.collector.entry -ne "collector/live-gray-screen-capture.mjs") {
		Throw-KitError "COLLECTOR_SCHEMA" "The bundled collector declaration is invalid."
	}
	if (-not (Test-ExactProperties -Value $manifest.extension -Names @("id", "name", "version", "enginesVscode", "packagePath", "bytes", "sha256")) -or
		$manifest.extension.id -ne "ZooCodeOrganization.zoo-code" -or $manifest.extension.name -ne "zoo-code" -or
		$manifest.extension.version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$' -or
		$manifest.extension.enginesVscode -notmatch '^\^[0-9]+\.[0-9]+\.[0-9]+$' -or
		$manifest.extension.packagePath -notmatch '^extension/zoo-code-[0-9A-Za-z.+-]+\.vsix$' -or
		-not (Test-IntegerInRange -Value $manifest.extension.bytes -Minimum 1 -Maximum ([int64]::MaxValue)) -or
		$manifest.extension.sha256 -notmatch '^[a-f0-9]{64}$') {
		Throw-KitError "EXTENSION_SCHEMA" "The bundled extension declaration is invalid."
	}

	$payload = @($manifest.payload)
	if ($payload.Count -lt 4 -or $payload.Count -gt 512) { Throw-KitError "PAYLOAD_COUNT" "The kit payload count is invalid." }
	$declared = @{}
	foreach ($record in $payload) {
		if (-not (Test-ExactProperties -Value $record -Names @("path", "bytes", "sha256")) -or
			$record.path -isnot [string] -or -not (Test-IntegerInRange -Value $record.bytes -Minimum 0 -Maximum ([int64]::MaxValue)) -or
			$record.sha256 -notmatch '^[a-f0-9]{64}$') {
			Throw-KitError "PAYLOAD_SCHEMA" "A kit payload record is invalid."
		}
		$key = $record.path.ToLowerInvariant()
		if ($declared.ContainsKey($key)) { Throw-KitError "DUPLICATE_PAYLOAD" "The kit manifest has duplicate or case-colliding paths." }
		$candidate = Resolve-PayloadPath -RelativePath $record.path
		Assert-NoReparsePath -LiteralPath $candidate
		$item = Get-Item -LiteralPath $candidate -Force
		if ($item.PSIsContainer -or $item.Length -ne [int64]$record.bytes -or (Get-Sha256File -LiteralPath $candidate) -cne $record.sha256) {
			Throw-KitError "PAYLOAD_MISMATCH" "A portable kit payload is missing or changed."
		}
		$declared[$key] = $true
	}

	$actual = @{}
	foreach ($file in @(Get-SafeTreeFiles -Root $script:BundleRoot)) {
		$relative = Get-NormalizedRelativePath -Child $file.FullName -Parent $script:BundleRoot
		if ($relative -eq "kit-manifest.json") { continue }
		$key = $relative.ToLowerInvariant()
		if ($actual.ContainsKey($key)) { Throw-KitError "CASE_COLLISION" "The portable bundle contains case-colliding paths." }
		$actual[$key] = $true
	}
	if ($actual.Count -ne $declared.Count) { Throw-KitError "EXTRA_PAYLOAD" "The portable bundle has missing or unexpected files." }
	foreach ($key in $actual.Keys) {
		if (-not $declared.ContainsKey($key)) { Throw-KitError "EXTRA_PAYLOAD" "The portable bundle has an unexpected file." }
	}

	$extensionPath = Resolve-PayloadPath -RelativePath $manifest.extension.packagePath
	if ((Get-Sha256File -LiteralPath $extensionPath) -cne $manifest.extension.sha256 -or (Get-Item -LiteralPath $extensionPath).Length -ne [int64]$manifest.extension.bytes) {
		Throw-KitError "EXTENSION_MISMATCH" "The bundled VSIX does not match extension provenance."
	}
	$collectorPath = Resolve-PayloadPath -RelativePath $manifest.collector.entry
	return [pscustomobject]@{ Manifest = $manifest; ManifestPath = $manifestPath; ExtensionPath = $extensionPath; CollectorPath = $collectorPath }
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
		[string]$WorkingDirectory = $script:ScriptRoot,
		[int]$TimeoutMilliseconds = 30000
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
		if (-not $process.Start()) { Throw-KitError "PROCESS_START_FAILED" "A prerequisite process could not start." }
		$stdoutTask = $process.StandardOutput.ReadToEndAsync()
		$stderrTask = $process.StandardError.ReadToEndAsync()
		if (-not $process.WaitForExit($TimeoutMilliseconds)) {
			try { $process.Kill() } catch {}
			Throw-KitError "PROCESS_TIMEOUT" "A prerequisite process timed out."
		}
		$stdout = $stdoutTask.GetAwaiter().GetResult()
		$stderr = $stderrTask.GetAwaiter().GetResult()
		return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
	} finally {
		$process.Dispose()
	}
}

function Resolve-RegularExecutable {
	param([string]$ExplicitPath, [string[]]$CommandNames, [string]$DisplayName)
	$candidate = $null
	if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
		if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
			$candidate = [System.IO.Path]::GetFullPath($ExplicitPath)
		} elseif ([System.IO.Path]::IsPathRooted($ExplicitPath) -or $ExplicitPath.IndexOfAny([char[]]@('\', '/')) -ge 0) {
			$candidate = [System.IO.Path]::GetFullPath($ExplicitPath)
		} else {
			$explicitCommand = Get-Command $ExplicitPath -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($null -ne $explicitCommand) { $candidate = $explicitCommand.Source }
		}
	} else {
		foreach ($name in $CommandNames) {
			$command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
			if ($null -ne $command) { $candidate = $command.Source; break }
		}
	}
	if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
		Throw-KitError "EXECUTABLE_NOT_FOUND" "$DisplayName was not found. Pass its explicit path."
	}
	Assert-NoReparsePath -LiteralPath $candidate
	return [System.IO.Path]::GetFullPath($candidate)
}

function Resolve-NodeRuntime {
	param([object]$Manifest)
	$node = Resolve-RegularExecutable -ExplicitPath $NodePath -CommandNames @("node.exe", "node") -DisplayName "Node 22"
	$probe = Invoke-DirectProcess -FilePath $node -ArgumentList @("-e", 'process.stdout.write(JSON.stringify({version:process.versions.node,arch:process.arch,webSocket:typeof WebSocket}))')
	if ($probe.ExitCode -ne 0 -or $probe.Stdout.Length -gt 512) { Throw-KitError "UNSUPPORTED_NODE" "Node runtime validation failed." }
	try { $runtime = $probe.Stdout | ConvertFrom-Json } catch { Throw-KitError "UNSUPPORTED_NODE" "Node runtime validation returned malformed data." }
	if (-not (Test-ExactProperties -Value $runtime -Names @("version", "arch", "webSocket")) -or
		$runtime.version -notmatch '^\d+\.\d+\.\d+' -or [int]($runtime.version.Split('.')[0]) -lt [int]$Manifest.prerequisites.minimumNodeMajor -or
		$runtime.webSocket -ne "function" -or $runtime.arch -notin @($Manifest.prerequisites.architectures)) {
		Throw-KitError "UNSUPPORTED_NODE" "Node 22 or newer with built-in WebSocket support on a packaged architecture is required."
	}
	return [pscustomobject]@{ Path = $node; Version = $runtime.version; Architecture = $runtime.arch }
}

function Resolve-CodeRuntime {
	param([object]$Manifest)
	$candidates = New-Object System.Collections.Generic.List[string]
	if (-not [string]::IsNullOrWhiteSpace($CodePath)) { $candidates.Add([System.IO.Path]::GetFullPath($CodePath)) }
	else {
		if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe")) }
		if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) { $candidates.Add((Join-Path $env:ProgramFiles "Microsoft VS Code\Code.exe")) }
		$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
		if (-not [string]::IsNullOrWhiteSpace($programFilesX86)) { $candidates.Add((Join-Path $programFilesX86 "Microsoft VS Code\Code.exe")) }
		$command = Get-Command code -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($null -ne $command -and [System.IO.Path]::GetFileName($command.Source).Equals("Code.exe", [System.StringComparison]::OrdinalIgnoreCase)) { $candidates.Add($command.Source) }
	}
	$code = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
	if ($code.Count -ne 1) { Throw-KitError "CODE_NOT_FOUND" "Stable Visual Studio Code was not found. Pass -CodePath."
	}
	$resolved = [System.IO.Path]::GetFullPath($code[0])
	Assert-NoReparsePath -LiteralPath $resolved
	if (-not [System.IO.Path]::GetFileName($resolved).Equals("Code.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
		Throw-KitError "CODE_NOT_STABLE" "The selected VS Code executable must be a concrete stable Code.exe."
	}
	$probe = Invoke-DirectProcess -FilePath $resolved -ArgumentList @("--version") -TimeoutMilliseconds 15000
	if ($probe.ExitCode -ne 0) { Throw-KitError "CODE_VERSION" "Visual Studio Code version validation failed." }
	$match = [regex]::Match($probe.Stdout, '(?m)^([0-9]+\.[0-9]+\.[0-9]+)(?:\r)?$')
	if (-not $match.Success) { Throw-KitError "CODE_VERSION" "The selected executable did not report a stable VS Code version." }
	$minimumMatch = [regex]::Match([string]$Manifest.extension.enginesVscode, '([0-9]+\.[0-9]+\.[0-9]+)')
	if (-not $minimumMatch.Success -or [version]$match.Groups[1].Value -lt [version]$minimumMatch.Groups[1].Value) {
		Throw-KitError "CODE_TOO_OLD" "The selected VS Code is older than the bundled extension engine requirement."
	}
	return [pscustomobject]@{ Path = $resolved; Version = $match.Groups[1].Value }
}

function Resolve-Workspace {
	$candidate = if ([string]::IsNullOrWhiteSpace($WorkspacePath)) { $script:ScriptRoot } else { [System.IO.Path]::GetFullPath($WorkspacePath) }
	if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { Throw-KitError "WORKSPACE_NOT_FOUND" "The selected workspace directory does not exist." }
	return [System.IO.Path]::GetFullPath($candidate)
}

function Resolve-EvidenceRoot {
	$explicit = -not [string]::IsNullOrWhiteSpace($OutputPath)
	if ($explicit) { $candidate = [System.IO.Path]::GetFullPath($OutputPath) }
	else {
		if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Throw-KitError "LOCALAPPDATA_MISSING" "LOCALAPPDATA is required for the default private evidence root." }
		$candidate = Join-Path $env:LOCALAPPDATA "ZooCode\GrayScreenCapture\evidence"
	}
	if ($candidate.StartsWith("\\", [System.StringComparison]::Ordinal)) {
		Throw-KitError "OUTPUT_UNC" "Evidence output may not use a UNC or network path."
	}
	$segments = [System.IO.Path]::GetFullPath($candidate).Split(@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)
	if (@($segments | Where-Object { $_.Equals(".git", [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
		Throw-KitError "OUTPUT_IN_GIT_METADATA" "Evidence output may not be inside Git metadata."
	}
	Assert-NoReparsePath -LiteralPath $candidate -AllowMissingLeaf
	[System.IO.Directory]::CreateDirectory($candidate) | Out-Null
	Assert-NoReparsePath -LiteralPath $candidate
	$root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($candidate))
	$drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList @($root)
	if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { Throw-KitError "OUTPUT_NOT_FIXED" "Evidence output must be on a local fixed drive." }
	$probePath = Join-Path $candidate (".zoo-write-test-" + [guid]::NewGuid().ToString("N"))
	$handle = $null
	try {
		$handle = New-Object -TypeName System.IO.FileStream -ArgumentList @($probePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
		$handle.Flush($true)
	} finally {
		if ($null -ne $handle) { $handle.Dispose() }
		Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
	}
	return [pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($candidate); Explicit = $explicit }
}

function Assert-PowerShellCapabilities {
	param([object]$Manifest)
	if ($env:OS -ne "Windows_NT" -or $PSVersionTable.PSVersion.Major -lt [int]$Manifest.prerequisites.minimumPowerShellMajor) {
		Throw-KitError "UNSUPPORTED_POWERSHELL" "Windows PowerShell 5.1 or PowerShell 7+ on Windows is required."
	}
	foreach ($commandName in @("Get-CimInstance", "Get-NetTCPConnection")) {
		if ($null -eq (Get-Command $commandName -ErrorAction SilentlyContinue)) { Throw-KitError "MISSING_CAPABILITY" "$commandName is required by live capture." }
	}
}

function Assert-PortAvailable {
	param([int]$Port)
	if ($Port -eq 0) { return }
	$listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $Port)
	try { $listener.Start() } catch { Throw-KitError "CDP_PORT_IN_USE" "The selected CDP port is unavailable on loopback." } finally { try { $listener.Stop() } catch {} }
}

function Assert-SafeCodeArguments {
	$protected = @{
		"--extensions-dir" = $true
		"--extensiondevelopmentpath" = $true
		"--extension-development-path" = $true
		"--remote-debugging-address" = $true
		"--remote-debugging-pipe" = $true
		"--remote-debugging-port" = $true
		"--user-data-dir" = $true
		"--inspect" = $true
		"--inspect-brk" = $true
		"--inspect-port" = $true
		"--js-flags" = $true
		"--proxy-bypass-list" = $true
		"--proxy-pac-url" = $true
		"--proxy-server" = $true
	}
	foreach ($argument in $CodeArgument) {
		$value = [string]$argument
		if (-not $value.StartsWith("--", [System.StringComparison]::Ordinal)) { continue }
		$equals = $value.IndexOf('=')
		$name = if ($equals -lt 0) { $value } else { $value.Substring(0, $equals) }
		if ($protected.ContainsKey($name.ToLowerInvariant())) {
			Throw-KitError "PROTECTED_CODE_ARGUMENT" "$name is controlled by the capture harness and cannot be forwarded."
		}
	}
}

function Escape-GitIgnorePath {
	param([string]$RelativePath)
	$builder = New-Object System.Text.StringBuilder
	foreach ($character in $RelativePath.Replace('\', '/').ToCharArray()) {
		if ($character -in @('\', '*', '?', '[', ']', '#', '!', ' ')) { [void]$builder.Append('\') }
		[void]$builder.Append($character)
	}
	return $builder.ToString()
}

function Try-AddLocalGitExclusions {
	param([string]$EvidencePath)
	$result = [ordered]@{
		Conventional = $false
		KitProtected = $false
		OutputInsideWorktree = $false
		OutputProtected = -not (Test-PathWithin -Candidate $EvidencePath -Parent $script:ScriptRoot)
		Warning = $null
	}
	if ($SkipLocalGitExclude) { $result.Warning = "Local Git exclusion was skipped explicitly."; return [pscustomobject]$result }
	$gitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $gitCommand) { $result.Warning = "Git was not found; copied kit files were not locally excluded."; return [pscustomobject]$result }
	$rootResult = Invoke-DirectProcess -FilePath $gitCommand.Source -ArgumentList @("-C", $script:ScriptRoot, "rev-parse", "--show-toplevel")
	if ($rootResult.ExitCode -ne 0) { $result.Warning = "The copied kit is not inside a conventional Git worktree."; return [pscustomobject]$result }
	$worktree = [System.IO.Path]::GetFullPath($rootResult.Stdout.Trim())
	$gitDirectory = Join-Path $worktree ".git"
	if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) { $result.Warning = "Linked or unusual worktree detected; Git metadata was not changed."; return [pscustomobject]$result }
	Assert-NoReparsePath -LiteralPath $gitDirectory
	$actualGitResult = Invoke-DirectProcess -FilePath $gitCommand.Source -ArgumentList @("-C", $worktree, "rev-parse", "--absolute-git-dir")
	if ($actualGitResult.ExitCode -ne 0 -or -not ([System.IO.Path]::GetFullPath($actualGitResult.Stdout.Trim())).Equals([System.IO.Path]::GetFullPath($gitDirectory), [System.StringComparison]::OrdinalIgnoreCase)) {
		$result.Warning = "Linked or unusual worktree detected; Git metadata was not changed."
		return [pscustomobject]$result
	}
	$scriptRelative = Get-NormalizedRelativePath -Child $script:ScriptPath -Parent $worktree
	$bundleRelative = Get-NormalizedRelativePath -Child $script:BundleRoot -Parent $worktree
	$pathsToProtect = @($scriptRelative, $bundleRelative)
	$outputInside = Test-PathWithin -Candidate $EvidencePath -Parent $worktree
	$result.OutputInsideWorktree = $outputInside
	$outputRelative = $null
	if ($outputInside) { $outputRelative = Get-NormalizedRelativePath -Child $EvidencePath -Parent $worktree; $pathsToProtect += $outputRelative }
	foreach ($relative in $pathsToProtect) {
		$tracked = Invoke-DirectProcess -FilePath $gitCommand.Source -ArgumentList @("-C", $worktree, "ls-files", "--error-unmatch", "--", $relative)
		if ($tracked.ExitCode -eq 0) { $result.Warning = "At least one copied kit or output path is already tracked; local exclusion cannot protect it."; return [pscustomobject]$result }
	}
	$infoDirectory = Join-Path $gitDirectory "info"
	Assert-NoReparsePath -LiteralPath $infoDirectory -AllowMissingLeaf
	[System.IO.Directory]::CreateDirectory($infoDirectory) | Out-Null
	Assert-NoReparsePath -LiteralPath $infoDirectory
	$excludePath = Join-Path $infoDirectory "exclude"
	if (Test-Path -LiteralPath $excludePath) { Assert-NoReparsePath -LiteralPath $excludePath }
	$existingBytes = [byte[]]@()
	if (Test-Path -LiteralPath $excludePath) { $existingBytes = [System.IO.File]::ReadAllBytes($excludePath) }
	if ($existingBytes.Length -gt 1048576) { $result.Warning = "The local Git exclude file is too large to update safely."; return [pscustomobject]$result }
	try { $existingText = $script:Utf8NoBom.GetString($existingBytes) } catch { $result.Warning = "The local Git exclude file is not safe UTF-8; it was not changed."; return [pscustomobject]$result }
	$marker = "# ZooCode gray-screen portable kit (local only)"
	$desiredLines = New-Object System.Collections.Generic.List[string]
	$desiredLines.Add("/" + (Escape-GitIgnorePath -RelativePath $scriptRelative))
	$desiredLines.Add("/" + (Escape-GitIgnorePath -RelativePath $bundleRelative) + "/")
	if ($outputInside) { $desiredLines.Add("/" + (Escape-GitIgnorePath -RelativePath $outputRelative) + "/") }
	$existingLines = @($existingText -split "`r?`n")
	$appendLines = New-Object System.Collections.Generic.List[string]
	if ($marker -notin $existingLines) { $appendLines.Add($marker) }
	foreach ($line in $desiredLines) {
		if ($line -notin $existingLines) { $appendLines.Add($line) }
	}
	if ($appendLines.Count -gt 0) {
		$prefix = if ($existingBytes.Length -gt 0 -and -not $existingText.EndsWith("`n", [System.StringComparison]::Ordinal)) { "`n" } else { "" }
		$appendText = $prefix + ($appendLines -join "`n") + "`n"
		$stream = $null
		try {
			$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($excludePath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
			if ($stream.Length -ne $existingBytes.Length) { Throw-KitError "GIT_EXCLUDE_CHANGED" "The local Git exclude file changed during the safe append." }
			[void]$stream.Seek(0, [System.IO.SeekOrigin]::End)
			$bytes = $script:Utf8NoBomLenient.GetBytes($appendText)
			$stream.Write($bytes, 0, $bytes.Length)
			$stream.Flush($true)
		} catch {
			$result.Warning = "The local Git exclude file was busy or could not be updated safely."
			return [pscustomobject]$result
		} finally { if ($null -ne $stream) { $stream.Dispose() } }
	}
	$result.Conventional = $true
	$kitChecks = @($scriptRelative, $bundleRelative)
	$result.KitProtected = $true
	foreach ($relative in $kitChecks) {
		$check = Invoke-DirectProcess -FilePath $gitCommand.Source -ArgumentList @("-C", $worktree, "check-ignore", "-q", "--", $relative)
		if ($check.ExitCode -ne 0) { $result.KitProtected = $false }
	}
	if ($outputInside) {
		$check = Invoke-DirectProcess -FilePath $gitCommand.Source -ArgumentList @("-C", $worktree, "check-ignore", "-q", "--", $outputRelative)
		$result.OutputProtected = $check.ExitCode -eq 0
	}
	if (-not $result.KitProtected -or -not $result.OutputProtected) { $result.Warning = "Git verification did not confirm every local exclusion." }
	return [pscustomobject]$result
}

function Get-ProcessCreationUtc {
	param([int]$ProcessId)
	$item = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = " + $ProcessId) -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -eq $item) { return $null }
	try {
		$value = if ($item.CreationDate -is [datetime]) { [datetime]$item.CreationDate } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$item.CreationDate) }
		return $value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [System.Globalization.CultureInfo]::InvariantCulture)
	} catch { return $null }
}

function Protect-PrivateStateDirectory {
	param([string]$LiteralPath)
	try {
		$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
		if ($null -eq $identity.User) { return }
		$security = New-Object System.Security.AccessControl.DirectorySecurity
		$security.SetAccessRuleProtection($true, $false)
		$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
		$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
		$rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
			$identity.User,
			$rights,
			$inheritance,
			[System.Security.AccessControl.PropagationFlags]::None,
			[System.Security.AccessControl.AccessControlType]::Allow
		)
		$security.SetOwner($identity.User)
		$security.AddAccessRule($rule)
		[System.IO.Directory]::SetAccessControl($LiteralPath, $security)
	} catch {
		[Console]::Error.WriteLine("WARNING: Private launcher state retained inherited user-profile permissions because owner-only ACL tightening was unavailable.")
	}
}

function Get-StatePaths {
	if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { Throw-KitError "LOCALAPPDATA_MISSING" "LOCALAPPDATA is required for private launcher state." }
	$directory = Join-Path $env:LOCALAPPDATA "ZooCode\GrayScreenCapture\state"
	[System.IO.Directory]::CreateDirectory($directory) | Out-Null
	Assert-NoReparsePath -LiteralPath $directory
	Protect-PrivateStateDirectory -LiteralPath $directory
	$key = Get-Sha256Text -Value $script:ScriptPath.ToLowerInvariant()
	return [pscustomobject]@{ Directory = $directory; State = Join-Path $directory ("launcher-" + $key + ".json"); Lock = Join-Path $directory ("launcher-" + $key + ".lock") }
}

function Write-AtomicJson {
	param([string]$LiteralPath, [object]$Value)
	$directory = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($LiteralPath))
	$temp = Join-Path $directory ([System.IO.Path]::GetFileName($LiteralPath) + "." + [guid]::NewGuid().ToString("N") + ".tmp")
	$bytes = $script:Utf8NoBomLenient.GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
	$stream = $null
	try {
		$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
		$stream.Write($bytes, 0, $bytes.Length)
		$stream.Flush($true)
		$stream.Dispose(); $stream = $null
		if (Test-Path -LiteralPath $LiteralPath -PathType Leaf) {
			[System.IO.File]::Replace($temp, $LiteralPath, $null)
		} else {
			[System.IO.File]::Move($temp, $LiteralPath)
		}
	} finally {
		if ($null -ne $stream) { $stream.Dispose() }
		Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
	}
}

function Read-LauncherState {
	param([object]$Paths, [switch]$RemoveStale)
	if (-not (Test-Path -LiteralPath $Paths.State -PathType Leaf)) { return $null }
	try { $state = Read-BoundedJson -LiteralPath $Paths.State -MaximumBytes 16384 } catch { if ($RemoveStale) { Remove-Item -LiteralPath $Paths.State -Force -ErrorAction SilentlyContinue }; return $null }
	if (-not (Test-ExactProperties -Value $state -Names @("schemaVersion", "kitFormatVersion", "collectorPid", "collectorCreationTimeUtc", "outputPath", "runPath", "nodePath", "collectorPath", "startedUtc")) -or
		$state.schemaVersion -ne $script:StateSchemaVersion -or $state.kitFormatVersion -ne $script:KitFormatVersion -or
		-not (Test-IntegerInRange -Value $state.collectorPid -Minimum 1 -Maximum ([int32]::MaxValue)) -or
		$state.collectorCreationTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' -or
		$state.startedUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
		if ($RemoveStale) { Remove-Item -LiteralPath $Paths.State -Force -ErrorAction SilentlyContinue }
		return $null
	}
	$statePathValues = @($state.outputPath, $state.runPath, $state.nodePath, $state.collectorPath)
	if (@($statePathValues | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$_) }).Count -gt 0) {
		if ($RemoveStale) { Remove-Item -LiteralPath $Paths.State -Force -ErrorAction SilentlyContinue }
		return $null
	}
	$creation = Get-ProcessCreationUtc -ProcessId ([int]$state.collectorPid)
	if ($null -eq $creation -or $creation -cne $state.collectorCreationTimeUtc) {
		if ($RemoveStale) { Remove-Item -LiteralPath $Paths.State -Force -ErrorAction SilentlyContinue }
		return $null
	}
	return $state
}

function Read-LauncherLock {
	param([string]$LiteralPath, [int64]$MaximumBytes)
	$item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
	if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
		Throw-KitError "UNSAFE_LOCK" "The launcher lock is not a regular non-reparse file."
	}
	if ($item.Length -gt $MaximumBytes) { Throw-KitError "LOCK_TOO_LARGE" "The launcher lock is too large." }
	$stream = $null
	try {
		$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
		$bytes = New-Object System.Collections.Generic.List[byte]
		while (($value = $stream.ReadByte()) -ne -1) {
			if ($bytes.Count -ge $MaximumBytes) { Throw-KitError "LOCK_TOO_LARGE" "The launcher lock is too large." }
			$bytes.Add([byte]$value)
		}
		$text = $script:Utf8NoBom.GetString($bytes.ToArray())
		return $text | ConvertFrom-Json
	} finally {
		if ($null -ne $stream) { $stream.Dispose() }
	}
}

function Acquire-LauncherLock {
	param([object]$Paths)
	$identity = Get-ProcessCreationUtc -ProcessId $PID
	if ($null -eq $identity) { Throw-KitError "LOCK_IDENTITY" "Launcher process identity is unavailable." }
	for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
		try {
			$stream = New-Object -TypeName System.IO.FileStream -ArgumentList @($Paths.Lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
			$bytes = $script:Utf8NoBomLenient.GetBytes((([ordered]@{ pid = $PID; creationTimeUtc = $identity }) | ConvertTo-Json -Compress))
			$stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
			return $stream
		} catch [System.IO.IOException] {
			$lock = $null
			for ($readAttempt = 0; $readAttempt -lt 20 -and $null -eq $lock; $readAttempt += 1) {
				try { $lock = Read-LauncherLock -LiteralPath $Paths.Lock -MaximumBytes 4096 } catch {}
				if ($null -eq $lock) { Start-Sleep -Milliseconds 25 }
			}
			if ($null -eq $lock -or -not (Test-ExactProperties -Value $lock -Names @("pid", "creationTimeUtc")) -or
				-not (Test-IntegerInRange -Value $lock.pid -Minimum 1 -Maximum ([int32]::MaxValue)) -or
				$lock.creationTimeUtc -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') {
				Throw-KitError "LOCK_UNAVAILABLE" "The existing launcher lock is malformed or unreadable and was not removed."
			}
			if ((Get-ProcessCreationUtc -ProcessId ([int]$lock.pid)) -ceq $lock.creationTimeUtc) {
				Throw-KitError "CAPTURE_ALREADY_STARTING" "A matching portable launcher is already active. Use -Action Status or Stop."
			}
			Remove-Item -LiteralPath $Paths.Lock -Force -ErrorAction SilentlyContinue
		}
	}
	Throw-KitError "LOCK_UNAVAILABLE" "The per-launcher instance lock is unavailable."
}

function Read-RunManifest {
	param([string]$Directory)
	foreach ($name in @("manifest.json", "manifest.partial.json")) {
		$path = Join-Path $Directory $name
		if (Test-Path -LiteralPath $path -PathType Leaf) {
			try { return Read-BoundedJson -LiteralPath $path -MaximumBytes 262144 } catch {}
		}
	}
	return $null
}

function Find-RunForProcess {
	param([string]$EvidenceRoot, [int]$ProcessId, [string]$CreationTimeUtc)
	$directories = @(Get-ChildItem -LiteralPath $EvidenceRoot -Directory -Force | Where-Object { $_.Name -match '^run-[A-Za-z0-9-]+$' })
	if ($directories.Count -gt 512) { Throw-KitError "RUN_SCAN_LIMIT" "The evidence root has too many candidate run directories." }
	$matches = New-Object System.Collections.Generic.List[object]
	foreach ($directory in $directories) {
		if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
		$manifest = Read-RunManifest -Directory $directory.FullName
		if ($null -ne $manifest -and $manifest.harnessPid -eq $ProcessId -and $manifest.harnessCreationTimeUtc -ceq $CreationTimeUtc) {
			$matches.Add([pscustomobject]@{ Path = $directory.FullName; Manifest = $manifest })
		}
	}
	if ($matches.Count -gt 1) { Throw-KitError "RUN_AMBIGUOUS" "More than one evidence run matches the collector process identity." }
	if ($matches.Count -eq 1) { return $matches[0] }
	return $null
}

function Assert-ControlRun {
	param([string]$Directory, [object]$ExpectedState)
	$candidate = [System.IO.Path]::GetFullPath($Directory)
	if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { Throw-KitError "RUN_NOT_FOUND" "The selected run directory does not exist." }
	Assert-NoReparsePath -LiteralPath $candidate
	$manifest = Read-RunManifest -Directory $candidate
	if ($null -eq $manifest) { Throw-KitError "RUN_MANIFEST_UNAVAILABLE" "The selected run has no readable manifest." }
	if ($null -ne $ExpectedState) {
		$outputPath = [System.IO.Path]::GetFullPath([string]$ExpectedState.outputPath)
		if (-not (Test-PathWithin -Candidate $candidate -Parent $outputPath) -or
			$manifest.harnessPid -ne $ExpectedState.collectorPid -or
			$manifest.harnessCreationTimeUtc -cne $ExpectedState.collectorCreationTimeUtc) {
			Throw-KitError "STATE_RUN_MISMATCH" "Private launcher state does not match the selected evidence run."
		}
	}
	return $candidate
}

function Resolve-ControlRun {
	param([object]$StatePaths)
	if (-not [string]::IsNullOrWhiteSpace($RunPath)) {
		return Assert-ControlRun -Directory $RunPath -ExpectedState $null
	}
	$state = Read-LauncherState -Paths $StatePaths -RemoveStale
	if ($null -eq $state) { Throw-KitError "RUN_REQUIRED" "No unique active run is recorded. Pass -RunPath." }
	return Assert-ControlRun -Directory ([string]$state.runPath) -ExpectedState $state
}

function Start-ForegroundCollector {
	param([string]$NodeExecutable, [string[]]$CollectorArguments, [string]$WorkingDirectory)
	$startInfo = New-Object System.Diagnostics.ProcessStartInfo
	$startInfo.FileName = $NodeExecutable
	$startInfo.Arguments = ConvertTo-WindowsCommandLine -ArgumentList $CollectorArguments
	$startInfo.WorkingDirectory = $WorkingDirectory
	$startInfo.UseShellExecute = $false
	$startInfo.CreateNoWindow = $false
	$process = New-Object System.Diagnostics.Process
	$process.StartInfo = $startInfo
	if (-not $process.Start()) { $process.Dispose(); Throw-KitError "COLLECTOR_START_FAILED" "The collector process could not start." }
	return $process
}

function Assert-NormalProfileReady {
	param([object]$Code, [object]$Manifest)
	if (-not $AcknowledgeProfileReuseRisk) { Throw-KitError "PROFILE_ACK_REQUIRED" "Normal profile mode requires -AcknowledgeProfileReuseRisk." }
	if ($CdpPort -eq 0) { Throw-KitError "NORMAL_PROFILE_PORT_REQUIRED" "Normal profile mode requires an explicit known unused -CdpPort." }
	if (@(Get-Process -Name Code -ErrorAction SilentlyContinue).Count -gt 0) { Throw-KitError "PROFILE_IN_USE" "Close every VS Code process before normal profile mode." }
	$list = Invoke-DirectProcess -FilePath $Code.Path -ArgumentList @("--list-extensions", "--show-versions") -TimeoutMilliseconds 30000
	$expected = ([string]$Manifest.extension.id + "@" + [string]$Manifest.extension.version).ToLowerInvariant()
	$installed = @($list.Stdout -split "`r?`n" | ForEach-Object { $_.Trim().ToLowerInvariant() })
	if ($list.ExitCode -ne 0 -or $expected -notin $installed) { Throw-KitError "NORMAL_PROFILE_EXTENSION" "Normal profile mode requires the matching ZooCode extension ID and version to be installed." }
}

function Invoke-CollectorControl {
	param([string]$NodeExecutable, [string]$CollectorPath, [string[]]$Arguments, [int]$TimeoutMilliseconds = 120000)
	$result = Invoke-DirectProcess -FilePath $NodeExecutable -ArgumentList (@($CollectorPath) + $Arguments) -WorkingDirectory $script:ScriptRoot -TimeoutMilliseconds $TimeoutMilliseconds
	if (-not [string]::IsNullOrWhiteSpace($result.Stdout)) { [Console]::Out.Write($result.Stdout) }
	if (-not [string]::IsNullOrWhiteSpace($result.Stderr)) { [Console]::Error.Write($result.Stderr) }
	return $result.ExitCode
}

function Stop-OwnedCollector {
	param([object]$Collector, [object]$RunInfo, [string]$NodeExecutable, [string]$CollectorPath)
	if ($null -eq $Collector -or $Collector.HasExited) { return $true }
	if ($null -ne $RunInfo) {
		try {
			[void](Invoke-CollectorControl -NodeExecutable $NodeExecutable -CollectorPath $CollectorPath -Arguments @("stop", "--run-dir", $RunInfo.Path, "--snapshot-policy", "abort") -TimeoutMilliseconds 30000)
		} catch {}
		try { if ($Collector.WaitForExit(15000)) { return $true } } catch {}
	}
	if (-not $Collector.HasExited) {
		try {
			[void](Invoke-DirectProcess -FilePath "taskkill.exe" -ArgumentList @("/PID", [string]$Collector.Id, "/T", "/F") -TimeoutMilliseconds 15000)
		} catch {}
	}
	try { [void]$Collector.WaitForExit(15000) } catch {}
	return $Collector.HasExited
}

function Invoke-PortableMain {
	$kit = Assert-KitManifest
	Assert-PowerShellCapabilities -Manifest $kit.Manifest
	if ($Action -eq "Validate" -or $Action -eq "Start") { Assert-SafeCodeArguments }

	if ($Action -eq "Validate") {
		$workspace = Resolve-Workspace
		$evidence = Resolve-EvidenceRoot
		$node = Resolve-NodeRuntime -Manifest $kit.Manifest
		$code = Resolve-CodeRuntime -Manifest $kit.Manifest
		Assert-PortAvailable -Port $CdpPort
		[Console]::Out.WriteLine("Portable ZooCode gray-screen kit is valid.")
		[Console]::Out.WriteLine(("Kit format: {0}; extension: {1}@{2}" -f $kit.Manifest.kitFormatVersion, $kit.Manifest.extension.id, $kit.Manifest.extension.version))
		[Console]::Out.WriteLine(("Node: {0} ({1}); VS Code: {2}" -f $node.Version, $node.Architecture, $code.Version))
		[Console]::Out.WriteLine(("Workspace: {0}" -f $workspace))
		[Console]::Out.WriteLine(("Evidence root: {0}" -f $evidence.Path))
		[Console]::Out.WriteLine(("Profile mode: {0}; CDP port: {1}" -f $ProfileMode, $CdpPort))
		[Console]::Out.WriteLine(("Automatic snapshots: {0}; threshold: {1}; consecutive samples: {2}" -f (-not $DisableAutoSnapshots), $SnapshotThreshold.ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture), $AutoSnapshotSamples))
		return 0
	}

	if ($Action -eq "Status") {
		$statePaths = Get-StatePaths
		$run = Resolve-ControlRun -StatePaths $statePaths
		$manifest = Read-RunManifest -Directory $run
		if ($null -eq $manifest) { Throw-KitError "RUN_MANIFEST_UNAVAILABLE" "The selected run has no readable manifest." }
		[Console]::Out.WriteLine(("Run: {0}" -f $run))
		[Console]::Out.WriteLine(("State: {0}" -f $manifest.state))
		if ($null -ne $manifest.PSObject.Properties["captureConfig"] -and $null -ne $manifest.captureConfig) {
			[Console]::Out.WriteLine(("Auto snapshots: {0}; threshold: {1}; consecutive samples: {2}" -f $manifest.captureConfig.autoSnapshotEnabled, $manifest.captureConfig.heapCriticalRatio, $manifest.captureConfig.autoSnapshotSamples))
		}
		if ($null -ne $manifest.PSObject.Properties["classification"] -and $null -ne $manifest.classification) {
			[Console]::Out.WriteLine(("Classification: {0}" -f $manifest.classification))
		}
		return 0
	}

	if ($Action -eq "Stop") {
		$node = Resolve-NodeRuntime -Manifest $kit.Manifest
		$statePaths = Get-StatePaths
		$run = Resolve-ControlRun -StatePaths $statePaths
		return Invoke-CollectorControl -NodeExecutable $node.Path -CollectorPath $kit.CollectorPath -Arguments @("stop", "--run-dir", $run, "--snapshot-policy", $SnapshotPolicy.ToLowerInvariant())
	}

	if ($Action -eq "Snapshot") {
		if (-not $AcknowledgeSnapshotPrivacyRisk) { Throw-KitError "SNAPSHOT_ACK_REQUIRED" "Manual snapshots require -AcknowledgeSnapshotPrivacyRisk." }
		$node = Resolve-NodeRuntime -Manifest $kit.Manifest
		$statePaths = Get-StatePaths
		$run = Resolve-ControlRun -StatePaths $statePaths
		$arguments = New-Object System.Collections.Generic.List[string]
		foreach ($value in @("snapshot", "--run-dir", $run, "--reason", "manual", "--acknowledge-manual-snapshot-risk")) { $arguments.Add($value) }
		if ($script:TargetOrdinalSpecified) { $arguments.Add("--target-ordinal"); $arguments.Add([string]$TargetOrdinal) }
		if ($OverrideCooldown) { $arguments.Add("--override-cooldown") }
		if ($AllowUnresponsiveAttempt) { $arguments.Add("--allow-unresponsive-attempt") }
		return Invoke-CollectorControl -NodeExecutable $node.Path -CollectorPath $kit.CollectorPath -Arguments $arguments.ToArray()
	}

	$workspace = Resolve-Workspace
	$evidence = Resolve-EvidenceRoot
	$node = Resolve-NodeRuntime -Manifest $kit.Manifest
	$code = Resolve-CodeRuntime -Manifest $kit.Manifest
	Assert-PortAvailable -Port $CdpPort
	$statePaths = Get-StatePaths
	$activeState = Read-LauncherState -Paths $statePaths -RemoveStale
	if ($null -ne $activeState) { Throw-KitError "CAPTURE_ALREADY_ACTIVE" "A matching capture is already active. Use -Action Status or Stop." }
	$lock = Acquire-LauncherLock -Paths $statePaths
	$collector = $null
	$runInfo = $null
	$collectorReachedExit = $false
	try {
		$gitProtection = Try-AddLocalGitExclusions -EvidencePath $evidence.Path
		if (-not [string]::IsNullOrWhiteSpace($gitProtection.Warning)) { Write-Warning $gitProtection.Warning }
		$repositoryLocalOutput = $gitProtection.OutputInsideWorktree -or
			(Test-PathWithin -Candidate $evidence.Path -Parent $workspace) -or
			(Test-PathWithin -Candidate $evidence.Path -Parent $script:ScriptRoot)
		if ($evidence.Explicit -and $repositoryLocalOutput -and -not $gitProtection.OutputProtected -and -not $AcknowledgeRepositoryOutputRisk) {
			Throw-KitError "REPOSITORY_OUTPUT_ACK_REQUIRED" "Repository-local evidence was not safely excluded. Choose external output or pass -AcknowledgeRepositoryOutputRisk."
		}
		if ($ProfileMode -eq "Normal") { Assert-NormalProfileReady -Code $code -Manifest $kit.Manifest }

		[Console]::Out.WriteLine("IMPORTANT: the currently open VS Code window will remain UNMONITORED.")
		[Console]::Out.WriteLine("A second dedicated monitored window will open. Start the ZooCode task only in that new window.")
		if (-not $DisableAutoSnapshots) {
			[Console]::Out.WriteLine(("PRIVATE SNAPSHOT WARNING: automatic V8 heap snapshots are enabled at ratio {0} for {1} samples." -f $SnapshotThreshold.ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture), $AutoSnapshotSamples))
			[Console]::Out.WriteLine("Snapshots can contain prompts, responses, source, paths, credentials, and other in-memory data, and can pause or destabilize the renderer. Nothing is uploaded.")
		}

		$arguments = New-Object System.Collections.Generic.List[string]
		foreach ($value in @($kit.CollectorPath, "launch", "--code", $code.Path, "--workspace", $workspace, "--output", $evidence.Path, "--cdp-port", [string]$CdpPort)) { $arguments.Add($value) }
		if ($ProfileMode -eq "Isolated") {
			$arguments.Add("--extension-vsix"); $arguments.Add($kit.ExtensionPath); $arguments.Add("--profile-mode"); $arguments.Add("isolated")
		} else {
			$arguments.Add("--profile-mode"); $arguments.Add("default"); $arguments.Add("--acknowledge-profile-reuse-risk")
		}
		if (-not $DisableTransportDiagnostics) { $arguments.Add("--enable-transport-diagnostics") }
		if (-not $DisablePartialCoalescing) { $arguments.Add("--enable-partial-coalescing") }
		if (-not $DisableAutoSnapshots) {
			$arguments.Add("--enable-auto-snapshot"); $arguments.Add("--heap-critical-ratio"); $arguments.Add($SnapshotThreshold.ToString("0.00", [System.Globalization.CultureInfo]::InvariantCulture)); $arguments.Add("--auto-snapshot-samples"); $arguments.Add([string]$AutoSnapshotSamples)
		}
		$arguments.Add("--"); $arguments.Add("--new-window")
		foreach ($value in $CodeArgument) { $arguments.Add([string]$value) }
		$collector = Start-ForegroundCollector -NodeExecutable $node.Path -CollectorArguments $arguments.ToArray() -WorkingDirectory $workspace
		$creation = $null
		for ($attempt = 0; $attempt -lt 50 -and $null -eq $creation; $attempt += 1) { $creation = Get-ProcessCreationUtc -ProcessId $collector.Id; if ($null -eq $creation) { Start-Sleep -Milliseconds 100 } }
		if ($null -eq $creation) { Throw-KitError "COLLECTOR_IDENTITY" "The collector process identity could not be established." }
		$deadline = [datetime]::UtcNow.AddSeconds(30)
		$bannerPrinted = $false
		while (-not $collector.HasExited) {
			if ($null -eq $runInfo) {
				$runInfo = Find-RunForProcess -EvidenceRoot $evidence.Path -ProcessId $collector.Id -CreationTimeUtc $creation
				if ($null -ne $runInfo) {
					$state = [ordered]@{ schemaVersion = $script:StateSchemaVersion; kitFormatVersion = $script:KitFormatVersion; collectorPid = $collector.Id; collectorCreationTimeUtc = $creation; outputPath = $evidence.Path; runPath = $runInfo.Path; nodePath = $node.Path; collectorPath = $kit.CollectorPath; startedUtc = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }
					Write-AtomicJson -LiteralPath $statePaths.State -Value $state
				}
			}
			if ($null -ne $runInfo -and -not $bannerPrinted) {
				$runInfo.Manifest = Read-RunManifest -Directory $runInfo.Path
				if ($null -ne $runInfo.Manifest -and $runInfo.Manifest.state -eq "capturing") {
					[Console]::Out.WriteLine("")
					[Console]::Out.WriteLine("MONITORING ACTIVE")
					[Console]::Out.WriteLine("The VS Code window where this script was started is NOT monitored.")
					[Console]::Out.WriteLine("Start the ZooCode task only in the newly launched monitored window.")
					[Console]::Out.WriteLine(("Active run: {0}" -f $runInfo.Path))
					[Console]::Out.WriteLine("Stop: press Ctrl+C here, or run this script with -Action Stop in another terminal.")
					[Console]::Out.WriteLine("Status: run this script with -Action Status. Manual snapshot requires -Action Snapshot -AcknowledgeSnapshotPrivacyRisk.")
					$bannerPrinted = $true
				}
			}
			if (-not $bannerPrinted -and [datetime]::UtcNow -gt $deadline) { Throw-KitError "CAPTURE_START_TIMEOUT" "The collector did not reach active capture state in time." }
			Start-Sleep -Milliseconds 200
		}
		$collector.WaitForExit()
		$collectorReachedExit = $true
		$exitCode = $collector.ExitCode
		if ($null -ne $runInfo) {
			$terminal = Read-RunManifest -Directory $runInfo.Path
			[Console]::Out.WriteLine(("Capture ended. Run: {0}" -f $runInfo.Path))
			if ($null -ne $terminal -and $null -ne $terminal.PSObject.Properties["classification"] -and $null -ne $terminal.classification) {
				[Console]::Out.WriteLine(("Classification: {0}" -f $terminal.classification))
			}
		}
		return $exitCode
	} finally {
		$collectorStopped = $true
		if ($null -ne $collector -and -not $collectorReachedExit -and -not $collector.HasExited) {
			$collectorStopped = Stop-OwnedCollector -Collector $collector -RunInfo $runInfo -NodeExecutable $node.Path -CollectorPath $kit.CollectorPath
			if (-not $collectorStopped) { Write-Warning "The owned collector did not stop within the bounded cleanup interval; private state was retained for explicit Stop." }
		}
		if ($null -eq $collector -or $collectorReachedExit -or $collector.HasExited -or $collectorStopped) {
			Remove-Item -LiteralPath $statePaths.State -Force -ErrorAction SilentlyContinue
		}
		if ($null -ne $collector) { $collector.Dispose() }
		if ($null -ne $lock) { $lock.Dispose() }
		Remove-Item -LiteralPath $statePaths.Lock -Force -ErrorAction SilentlyContinue
	}
}

try {
	$exitCode = Invoke-PortableMain
	exit $exitCode
} catch {
	$code = if ($_.Exception.Data.Contains("ZooCodeErrorCode")) { [string]$_.Exception.Data["ZooCodeErrorCode"] } else { "PORTABLE_KIT_FAILED" }
	[Console]::Error.WriteLine(("ZooCode portable gray-screen kit failed ({0})." -f $code))
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}
