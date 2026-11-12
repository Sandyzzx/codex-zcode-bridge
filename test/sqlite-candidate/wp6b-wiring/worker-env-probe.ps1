param([Parameter(Mandatory=$true)][int]$TargetPid, [Parameter(Mandatory=$true)][string]$ExpectedTicks)
$ErrorActionPreference = 'Stop'
# Diagnostic only: inspect one owned 64-bit test Worker through an identity-
# checked handle. Never return environment content, names, or exception text.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Gate2EnvProbe {
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2; public IntPtr Reserved3; public IntPtr Pid; public IntPtr Reserved4; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsWow64Process2(IntPtr h, out ushort processMachine, out ushort nativeMachine);
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, out PBI pbi, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr address, byte[] buffer, int size, out IntPtr read);
  public static byte[] Read(IntPtr h, long address, int size) { byte[] b = new byte[size]; IntPtr n; if (!ReadProcessMemory(h, new IntPtr(address), b, size, out n) || n.ToInt64() != size) throw new Exception("read_failed"); return b; }
}
'@
  if ([IntPtr]::Size -ne 8) { throw 'unsupported_architecture' }
  $handle = [Gate2EnvProbe]::OpenProcess(0x1410, $false, $TargetPid)
  if ($handle -eq [IntPtr]::Zero) { throw 'open_failed' }
  try {
    [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0
    if (-not [Gate2EnvProbe]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) { throw 'identity_failed' }
    if ([DateTime]::FromFileTimeUtc($created).ToLocalTime().Ticks.ToString() -ne $ExpectedTicks -or $exited -ne 0) { throw 'identity_mismatch' }
    [uint16]$processMachine = 0; [uint16]$nativeMachine = 0
    if (-not [Gate2EnvProbe]::IsWow64Process2($handle, [ref]$processMachine, [ref]$nativeMachine) -or $processMachine -ne 0 -or $nativeMachine -ne 0x8664) { throw 'unsupported_target_architecture' }
    $pbi = New-Object Gate2EnvProbe+PBI; [int]$returned = 0
    if ([Gate2EnvProbe]::NtQueryInformationProcess($handle, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$returned) -ne 0) { throw 'query_failed' }
    $params = [BitConverter]::ToInt64([Gate2EnvProbe]::Read($handle, $pbi.Peb.ToInt64() + 0x20, 8), 0)
    $envPtr = [BitConverter]::ToInt64([Gate2EnvProbe]::Read($handle, $params + 0x80, 8), 0)
    $bytes = New-Object System.Collections.Generic.List[byte]
    $done = $false
    for ($offset = 0; $offset -lt 131072 -and -not $done; $offset += 2) {
      $pair = [Gate2EnvProbe]::Read($handle, $envPtr + $offset, 2)
      $bytes.AddRange([byte[]]$pair)
      if ($bytes.Count -ge 4 -and $bytes[$bytes.Count-1] -eq 0 -and $bytes[$bytes.Count-2] -eq 0 -and $bytes[$bytes.Count-3] -eq 0 -and $bytes[$bytes.Count-4] -eq 0) { $done = $true }
    }
    if (-not $done) { throw 'unterminated' }
    $environment = [Text.Encoding]::Unicode.GetString($bytes.ToArray())
    $found = $environment.Contains('SYNTHETIC_GATE2_SECRET_93d9422b')
    $controlFound = $environment.Contains('GATE2_ENV_CONTROL_PLAINTEXT_SENTINEL')
    $systemRootFound = $environment.IndexOf('SystemRoot=', [StringComparison]::OrdinalIgnoreCase) -ge 0
    $environment = $null; $bytes.Clear()
    @{ identity_verified = $true; marker_found = $found; control_found = $controlFound; system_root_found = $systemRootFound; bounded = $true } | ConvertTo-Json -Compress
  } finally { [void][Gate2EnvProbe]::CloseHandle($handle) }
} catch {
  '{"identity_verified":false,"probe_failed":true}'
  exit 1
}
