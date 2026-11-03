param(
    [switch]$Execute,
    [string]$Confirmation = ''
)

# Prepared operator procedure only. Do not run from an active Codex session.
# The existing CLI rechecks boot, Host/writer absence, identity, Claimants and CAS.
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$cli = Join-Path $projectRoot 'dist/src/cli/admin-abandon-held-operation.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Build the reviewed candidate before running recovery.' }
$operationId = 'sqlite-676c38908c3289aa18a1ee323fbd73bd'
$recoveryArgs = @(
    $cli,
    '--data-root', 'C:\Users\Sandy\AppData\Local\CodexZCodeBridge\state',
    '--database', 'bridge.sqlite',
    '--operation-id', $operationId,
    '--task-id', 'LCAE-CAD-WORKER-REAL-ATLAS-RECOVERY-20261102-78',
    '--attempt', '1',
    '--generation', '4',
    '--revision', '121',
    '--claim-id', '06b68682-c9f4-47a1-a2e2-0dc0870a4a42',
    '--worker-identity-digest', '14330afa0c07740529b11d9632f794d91c28873e122011096ffb494257807346'
)
if ($Execute) {
    if ($Confirmation -cne "ADMIN-ABANDON:$operationId") { throw 'Explicit ADMIN-ABANDON confirmation is required for production execution.' }
    $recoveryArgs += @('--execute', '--confirmation', $Confirmation)
} else {
    $recoveryArgs += '--preflight'
}
& node @recoveryArgs
if ($LASTEXITCODE -ne 0) { throw "Recovery refused with exit $LASTEXITCODE; preserve the state and inspect the reported code." }
