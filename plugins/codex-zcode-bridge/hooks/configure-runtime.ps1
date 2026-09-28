[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$NodeExecutablePath,
    [string]$ZCodeRuntimePath,
    [string]$BuiltinProviderConfigPath,
    [string]$PersonalProviderConfigPath,
    [string]$ZCodeHome,
    [string]$DefaultProviderId,
    [string]$DefaultModelId,
    [string]$DefaultReasoningLevel,
    [ValidateSet("plan", "build", "edit", "yolo")][string]$Mode,
    [ValidateRange(1, 8)][int]$MaxConcurrentWorkers
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-ExistingFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "$Label must be an absolute path." }
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "$Label file does not exist: $resolved" }
    return $resolved
}

function Get-ConfiguredEnvironmentValue {
    param([Parameter(Mandatory)][string]$Name)
    $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ($processValue -and $processValue.Trim()) { return $processValue.Trim() }
    $userValue = [Environment]::GetEnvironmentVariable($Name, "User")
    if ($userValue -and $userValue.Trim()) { return $userValue.Trim() }
    return $null
}

function Read-JsonObject {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $configuredNode = Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_NODE"
    $nodeExecutable = if ($configuredNode) {
        Resolve-ExistingFile $configuredNode "ZCODE_BRIDGE_NODE"
    } else {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw "Node.js is required to validate $Label." }
        $nodeCommand.Source
    }
    $validator = @'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const object = value !== null && typeof value === 'object' && !Array.isArray(value);
const config = object && value.config && typeof value.config === 'object' && !Array.isArray(value.config);
const rules = config && value.config.providerConfigRules && value.config.providerConfigRules.providerRules;
const count = Array.isArray(rules) ? rules.length : (rules && typeof rules === 'object' ? Object.keys(rules).length : 0);
process.stdout.write(JSON.stringify({ isObject: object, configObject: !!config, providerRuleCount: count }));
'@
    $summaryJson = & $nodeExecutable -e $validator $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $summaryJson) { throw "$Label could not be parsed as JSON: $Path" }
    try { $summary = $summaryJson | ConvertFrom-Json }
    catch { throw "$Label JSON validation returned an invalid summary: $Path" }
    if (-not $summary.isObject) { throw "$Label must contain a JSON object: $Path" }
    return $summary
}

function Test-ProviderConfig {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][ValidateSet("Builtin", "Personal")][string]$Kind)
    $json = Read-JsonObject -Path $Path -Label "$Kind provider config"
    if (-not $json.configObject) { throw "$Kind provider config has no config object: $Path" }
    if ($Kind -eq "Personal") {
        if ($json.providerRuleCount -lt 1) { throw "Personal provider config contains no provider rules (it may be a CLI-created stub): $Path" }
    }
}

function Read-DesktopDataBaseDir {
    param([Parameter(Mandatory)][string]$Path)
    $configuredNode = Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_NODE"
    $nodeExecutable = if ($configuredNode) { $configuredNode }
        else { (Get-Command node -ErrorAction Stop).Source }
    $reader = @'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
if (value && typeof value.dataBaseDir === 'string') process.stdout.write(value.dataBaseDir);
'@
    $result = & $nodeExecutable -e $reader $Path 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not parse Desktop settings: $Path" }
    return ([string]$result).Trim()
}

function Find-DefaultRuntime {
    $roots = @(Get-ConfiguredEnvironmentValue "ZCODE_WINDOWS_APP_INSTALL_DIR")
    if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA "Programs\ZCode") }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles "ZCode") }
    foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidate = Join-Path $root "resources\glm\zcode.cjs"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Set-UserEnvironmentPath {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    $currentUserValue = [Environment]::GetEnvironmentVariable($Name, "User")
    $currentProcessValue = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ($currentUserValue -ieq $Value -and $currentProcessValue -ieq $Value) {
        Write-Host "Already configured: $Name"
        return
    }
    if ($PSCmdlet.ShouldProcess("Current user environment", "Set $Name")) {
        [Environment]::SetEnvironmentVariable($Name, $Value, "User")
        [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
        Write-Host "Configured user environment variable: $Name"
    }
}

function Write-BridgeRuntimeSettings {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][hashtable]$Settings)
    $settingsPath = Join-Path $Directory "runtime-config.json"
    $temporaryPath = "$settingsPath.$([guid]::NewGuid().ToString('N')).tmp"
    if (-not $PSCmdlet.ShouldProcess($settingsPath, "Write discovered Bridge runtime settings")) { return }
    try {
        $json = $Settings | ConvertTo-Json -Depth 5
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            $existing = [IO.File]::ReadAllText($settingsPath)
            if ($existing.Trim() -ceq $json.Trim()) {
                Write-Host "Runtime settings file is current: $settingsPath"
                return
            }
        }
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $settingsPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
    Write-Host "Updated Bridge runtime settings file: $settingsPath"
}

function Resolve-ZCodeHome {
    param([Parameter(Mandatory)][string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "ZCODE_HOME must be an absolute path." }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetFileName($resolved).ToLowerInvariant() -ne ".zcode") {
        throw "ZCODE_HOME must point to the .zcode directory, not its parent."
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw "ZCODE_HOME directory does not exist: $resolved" }
    return $resolved
}

if ($env:OS -ne "Windows_NT") { throw "This configuration script is for Windows PowerShell." }

# Discover and validate first; the resolved runtime paths are then persisted so
# the Bridge and detached workers use the same installation on later launches.
$configuredNode = if ($NodeExecutablePath) { $NodeExecutablePath } else { Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_NODE" }
$effectiveNode = if ($configuredNode) { Resolve-ExistingFile $configuredNode "Node.js executable" }
    else {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCommand) { Resolve-ExistingFile $nodeCommand.Source "Node.js executable" } else { $null }
    }
if (-not $effectiveNode) { throw "Node.js was not found. Install Node.js 22.18+ or pass -NodeExecutablePath." }
$env:ZCODE_BRIDGE_NODE = $effectiveNode
$nodeVersionText = (& $effectiveNode --version 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { throw "Could not determine the Node.js version from $effectiveNode." }
$nodeMajor = [int]$Matches[1]; $nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 18)) { throw "Node.js 22.18+ is required; found $nodeVersionText." }

$effectiveRuntime = if ($ZCodeRuntimePath) { Resolve-ExistingFile $ZCodeRuntimePath "ZCode runtime" }
    elseif ((Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_ZCODE_CJS")) { Resolve-ExistingFile (Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_ZCODE_CJS") "ZCODE_BRIDGE_ZCODE_CJS" }
    else { Find-DefaultRuntime }
if (-not $effectiveRuntime) { throw "Could not discover ZCode runtime. Pass -ZCodeRuntimePath with the absolute path to resources\glm\zcode.cjs." }

$effectiveBuiltin = if ($BuiltinProviderConfigPath) { Resolve-ExistingFile $BuiltinProviderConfigPath "Builtin provider config" }
    elseif ((Get-ConfiguredEnvironmentValue "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE")) { Resolve-ExistingFile (Get-ConfiguredEnvironmentValue "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE") "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" }
    else { Join-Path (Split-Path (Split-Path $effectiveRuntime -Parent) -Parent) "config\provider\zcode-builtin.json" }
$effectiveBuiltin = Resolve-ExistingFile $effectiveBuiltin "Builtin provider config"
Test-ProviderConfig -Path $effectiveBuiltin -Kind Builtin

$configuredZCodeHome = if ($ZCodeHome) { Resolve-ZCodeHome $ZCodeHome }
    elseif ((Get-ConfiguredEnvironmentValue "ZCODE_HOME")) { Resolve-ZCodeHome (Get-ConfiguredEnvironmentValue "ZCODE_HOME") }
    else { $null }

$effectivePersonal = if ($PersonalProviderConfigPath) { Resolve-ExistingFile $PersonalProviderConfigPath "Personal provider config" }
    elseif ((Get-ConfiguredEnvironmentValue "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")) { Resolve-ExistingFile (Get-ConfiguredEnvironmentValue "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE") "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" }
    elseif ($configuredZCodeHome) { Join-Path $configuredZCodeHome "v2\provider_config.json" }
    else {
        $desktopDataBase = $null
        $settingsPath = Join-Path $HOME ".zcode\v2\setting.json"
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            try { $desktopDataBase = Read-DesktopDataBaseDir $settingsPath }
            catch { Write-Warning "Could not read ZCode Desktop dataBaseDir from settings.json." }
        }
        $bases = @((Get-ConfiguredEnvironmentValue "ZCODE_DATA_BASE_DIR"), $desktopDataBase, $HOME) | Where-Object { $_ }
        $found = $null
        foreach ($base in ($bases | Select-Object -Unique)) {
            $candidate = Join-Path $base ".zcode\v2\provider_config.json"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                try { Test-ProviderConfig -Path $candidate -Kind Personal; $found = [IO.Path]::GetFullPath($candidate); break }
                catch { Write-Warning $_.Exception.Message }
            }
        }
        $found
    }
if (-not $effectivePersonal) { throw "Could not find a valid personal provider config. Pass -PersonalProviderConfigPath with an existing ZCode provider config containing provider rules." }
$effectivePersonal = Resolve-ExistingFile $effectivePersonal "Personal provider config"
Test-ProviderConfig -Path $effectivePersonal -Kind Personal
$personalConfigDirectory = Split-Path $effectivePersonal -Parent
$personalHomeCandidate = Split-Path $personalConfigDirectory -Parent
if ((Split-Path $personalConfigDirectory -Leaf) -ieq "v2" -and (Split-Path $personalHomeCandidate -Leaf) -ieq ".zcode") {
    $derivedZCodeHome = Resolve-ZCodeHome $personalHomeCandidate
    if ($configuredZCodeHome -and [IO.Path]::GetFullPath($configuredZCodeHome) -ine [IO.Path]::GetFullPath($derivedZCodeHome)) {
        throw "The detected personal provider config belongs to a different ZCODE_HOME: $derivedZCodeHome"
    }
    if (-not $configuredZCodeHome) { $configuredZCodeHome = $derivedZCodeHome }
} else {
    throw "Personal provider config must be located at <ZCODE_HOME>\v2\provider_config.json so ZCode and the Bridge use the same data root: $effectivePersonal"
}
if ($configuredZCodeHome) {
    $expectedPersonal = [IO.Path]::GetFullPath((Join-Path $configuredZCodeHome "v2\provider_config.json"))
    if ([IO.Path]::GetFullPath($effectivePersonal) -ne $expectedPersonal) {
        throw "The personal provider config must be inside ZCODE_HOME: $expectedPersonal"
    }
}
$effectiveDataBaseDir = if ($configuredZCodeHome) { Split-Path $configuredZCodeHome -Parent }
    elseif ((Get-ConfiguredEnvironmentValue "ZCODE_DATA_BASE_DIR")) { Get-ConfiguredEnvironmentValue "ZCODE_DATA_BASE_DIR" }
    else { $null }
if ($effectiveDataBaseDir) {
    if (-not [IO.Path]::IsPathRooted($effectiveDataBaseDir)) { throw "ZCODE_DATA_BASE_DIR must be an absolute path: $effectiveDataBaseDir" }
    $effectiveDataBaseDir = [IO.Path]::GetFullPath($effectiveDataBaseDir)
    if (-not (Test-Path -LiteralPath $effectiveDataBaseDir -PathType Container)) { throw "ZCODE_DATA_BASE_DIR does not exist: $effectiveDataBaseDir" }
}
$effectiveInstallDir = Split-Path (Split-Path (Split-Path $effectiveRuntime -Parent) -Parent) -Parent
if (-not (Test-Path -LiteralPath $effectiveInstallDir -PathType Container)) { throw "Could not determine the ZCode installation directory from runtime path: $effectiveRuntime" }

$effectiveDefaultProvider = if ($DefaultProviderId) { $DefaultProviderId.Trim() } else { Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID" }
$effectiveDefaultModel = if ($DefaultModelId) { $DefaultModelId.Trim() } else { Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_DEFAULT_MODEL_ID" }
$effectiveReasoning = if ($DefaultReasoningLevel) { $DefaultReasoningLevel.Trim() } else { Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL" }
if ([bool]$effectiveDefaultProvider -ne [bool]$effectiveDefaultModel) {
    throw "Default provider and model must be configured together (ZCODE_BRIDGE_DEFAULT_PROVIDER_ID and ZCODE_BRIDGE_DEFAULT_MODEL_ID)."
}
$effectiveMode = if ($Mode) { $Mode } elseif ((Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_MODE")) { Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_MODE" } else { "yolo" }
if ($effectiveMode -notin @("plan", "build", "edit", "yolo")) {
    throw "ZCODE_BRIDGE_MODE must be one of: plan, build, edit, yolo."
}
$effectiveMaxWorkers = 1
if ($PSBoundParameters.ContainsKey("MaxConcurrentWorkers")) {
    $effectiveMaxWorkers = $MaxConcurrentWorkers
} elseif ((Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS")) {
    $parsedMaxWorkers = 0
    $configuredMaxWorkers = Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"
    if (-not [int]::TryParse($configuredMaxWorkers, [ref]$parsedMaxWorkers) -or $parsedMaxWorkers -lt 1 -or $parsedMaxWorkers -gt 8) {
        throw "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS must be an integer from 1 to 8."
    }
    $effectiveMaxWorkers = $parsedMaxWorkers
}
$effectiveDataDir = Get-ConfiguredEnvironmentValue "ZCODE_BRIDGE_DATA_DIR"
if (-not $effectiveDataDir) { $effectiveDataDir = Join-Path $HOME ".codex\codex-zcode-bridge" }
if (-not [IO.Path]::IsPathRooted($effectiveDataDir)) { throw "ZCODE_BRIDGE_DATA_DIR must be an absolute path: $effectiveDataDir" }
$effectiveDataDir = [IO.Path]::GetFullPath($effectiveDataDir)

Write-Host "ZCode runtime and provider configuration were found and validated."
Write-Host "Runtime: $effectiveRuntime"
Write-Host "Node.js: $effectiveNode ($nodeVersionText)"
Write-Host "Builtin provider config: $effectiveBuiltin"
Write-Host "Personal provider config: $effectivePersonal"
if ($configuredZCodeHome) { Write-Host "ZCode home: $configuredZCodeHome" }
Write-Host "ZCode installation directory: $effectiveInstallDir"
if ($effectiveDataBaseDir) { Write-Host "ZCode data base directory: $effectiveDataBaseDir" }
Write-Host "Bridge data directory: $effectiveDataDir"
if ($effectiveDefaultProvider) { Write-Host "Default model: $effectiveDefaultProvider/$effectiveDefaultModel" }
Write-Host "Default execution mode: $effectiveMode"
Write-Host "Maximum concurrent ZCode workers: $effectiveMaxWorkers"

$bridgeRuntimeSettings = [ordered]@{
    ZCODE_BRIDGE_NODE = $effectiveNode
    ZCODE_BRIDGE_ZCODE_CJS = $effectiveRuntime
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = $effectiveBuiltin
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = $effectivePersonal
    ZCODE_WINDOWS_APP_INSTALL_DIR = $effectiveInstallDir
    ZCODE_DATA_BASE_DIR = $effectiveDataBaseDir
    ZCODE_HOME = $configuredZCodeHome
    ZCODE_BRIDGE_DATA_DIR = $effectiveDataDir
    ZCODE_BRIDGE_MODE = $effectiveMode
    ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS = [string]$effectiveMaxWorkers
}
if ($effectiveDefaultProvider) { $bridgeRuntimeSettings["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"] = $effectiveDefaultProvider }
if ($effectiveDefaultModel) { $bridgeRuntimeSettings["ZCODE_BRIDGE_DEFAULT_MODEL_ID"] = $effectiveDefaultModel }
if ($effectiveReasoning) { $bridgeRuntimeSettings["ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL"] = $effectiveReasoning }

Set-UserEnvironmentPath "ZCODE_BRIDGE_NODE" $effectiveNode
Set-UserEnvironmentPath "ZCODE_BRIDGE_ZCODE_CJS" $effectiveRuntime
Set-UserEnvironmentPath "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" $effectiveBuiltin
Set-UserEnvironmentPath "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE" $effectivePersonal
Set-UserEnvironmentPath "ZCODE_WINDOWS_APP_INSTALL_DIR" $effectiveInstallDir
if ($effectiveDataBaseDir) { Set-UserEnvironmentPath "ZCODE_DATA_BASE_DIR" $effectiveDataBaseDir }
Set-UserEnvironmentPath "ZCODE_HOME" $configuredZCodeHome
Set-UserEnvironmentPath "ZCODE_BRIDGE_DATA_DIR" $effectiveDataDir
Set-UserEnvironmentPath "ZCODE_BRIDGE_MODE" $effectiveMode
Set-UserEnvironmentPath "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS" ([string]$effectiveMaxWorkers)
if ($effectiveDefaultProvider) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID" $effectiveDefaultProvider }
if ($effectiveDefaultModel) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_MODEL_ID" $effectiveDefaultModel }
if ($effectiveReasoning) { Set-UserEnvironmentPath "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL" $effectiveReasoning }
Write-BridgeRuntimeSettings -Directory $effectiveDataDir -Settings $bridgeRuntimeSettings

if ($WhatIfPreference) {
    Write-Host "Preview complete; no environment variables or settings files were changed."
} else {
    Write-Host "All discovered Bridge runtime paths and effective settings are configured. Restart Codex so its MCP process receives the environment changes."
}
