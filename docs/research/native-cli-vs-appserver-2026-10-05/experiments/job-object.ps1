# Research-only Windows process-tree containment probe, using owned helper processes.
$ErrorActionPreference = 'Stop'
$auditBase = 'C:\Users\Sandy\.codex\tmp\zcode-executor-audit-20261005'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AuditJob {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended data,uint length);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$helper = Join-Path $auditBase 'job-parent.cjs'
$permit = Join-Path $auditBase 'job-permit.txt'
$pidFile = Join-Path $auditBase 'job-child-pid.txt'
foreach ($f in @($permit,$pidFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f } }
@'
const fs=require('node:fs'),cp=require('node:child_process');
const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.argv[3],String(child.pid));}},50);
setInterval(()=>{},1000);
'@ | Set-Content -LiteralPath $helper -Encoding utf8
$job = [AuditJob]::CreateJobObject([IntPtr]::Zero,$null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
$limits = New-Object AuditJob+Extended
$basicLimits = New-Object AuditJob+Basic
$basicLimits.LimitFlags = 0x2000 # KILL_ON_JOB_CLOSE
$limits.BasicLimitInformation = $basicLimits
$size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
if (-not [AuditJob]::SetInformationJobObject($job,9,[ref]$limits,$size)) { throw 'SetInformationJobObject failed' }
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = 'C:\Program Files\nodejs\node.exe'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.ArgumentList.Add($helper); $psi.ArgumentList.Add($permit); $psi.ArgumentList.Add($pidFile)
$parent = [Diagnostics.Process]::Start($psi)
$result = @{ killOnJobClose = $true; parentPid = $parent.Id; scope = 'owned Node helper tree, not actual ZCode Job integration' }
try {
 $result.assigned = [AuditJob]::AssignProcessToJobObject($job,$parent.Handle)
 if (-not $result.assigned) { throw 'AssignProcessToJobObject failed' }
 'go' | Set-Content -LiteralPath $permit
 $sw=[Diagnostics.Stopwatch]::StartNew()
 while (-not (Test-Path -LiteralPath $pidFile) -and $sw.ElapsedMilliseconds -lt 5000) { [Threading.Thread]::Sleep(50) }
 if (-not (Test-Path -LiteralPath $pidFile)) { throw 'helper child not started' }
 $ownedChildId=[int](Get-Content -LiteralPath $pidFile)
 $result.childPid=$ownedChildId
 $result.childAliveBefore=[bool](Get-Process -Id $ownedChildId -ErrorAction SilentlyContinue)
 [void][AuditJob]::CloseHandle($job); $job=[IntPtr]::Zero
 [void]$parent.WaitForExit(5000)
 $result.parentExited=$parent.HasExited
 $result.childAliveAfter=[bool](Get-Process -Id $ownedChildId -ErrorAction SilentlyContinue)
 $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $auditBase 'job-object.json') -Encoding utf8
 $result | ConvertTo-Json
} finally {
 if($job -ne [IntPtr]::Zero){[void][AuditJob]::CloseHandle($job)}
 if(-not $parent.HasExited){$parent.Kill($true)}
 $parent.Dispose()
}
