param([Parameter(Mandatory=$true)][string]$Inventory,[Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$StopFile)
$ErrorActionPreference='Stop'
$clock=[Diagnostics.Stopwatch]::StartNew()
$owned=@{}
$metadata=$null
$writer=[IO.StreamWriter]::new($Output,$false,[Text.UTF8Encoding]::new($false))
try {
  while(-not (Test-Path -LiteralPath $StopFile)) {
    foreach($entry in @(Get-ChildItem -LiteralPath $Inventory -Filter '*.json')) {
      try {
        $info=[IO.File]::ReadAllText($entry.FullName)|ConvertFrom-Json
        $processKey=[string]$info.pid
        if($info.role -eq 'manager'){$metadata=$info}
        if(-not $owned.ContainsKey($processKey)) {
          $p=Get-Process -Id $info.pid -ErrorAction Stop
          $null=$p.Handle
          $owned[$processKey]=[pscustomobject]@{process=$p;role=$info.role;start_utc=$p.StartTime.ToUniversalTime().ToString('o')}
        }
      } catch { }
    }
    $items=@()
    foreach($binding in $owned.Values) {
      try {
        $p=$binding.process
        if($p.HasExited){continue}
        $p.Refresh()
        if($p.StartTime.ToUniversalTime().ToString('o') -ne $binding.start_utc){throw 'Process generation changed'}
        $items+=@{pid=$p.Id;role=$binding.role;start_utc=$binding.start_utc;working_set_bytes=$p.WorkingSet64;private_bytes=$p.PrivateMemorySize64}
      } catch { }
    }
    $disk=@{}
    if($metadata) {
      foreach($name in @('operations.sqlite3','operations.sqlite3-wal','operations.sqlite3-shm','operations.sqlite3-journal')) {
        $file=Join-Path $metadata.data_root $name
        $disk[$name]=if(Test-Path -LiteralPath $file){(Get-Item -LiteralPath $file).Length}else{0}
      }
    }
    $record=@{elapsed_ms=$clock.Elapsed.TotalMilliseconds;utc=[DateTime]::UtcNow.ToString('o');processes=$items;files=$disk}
    $writer.WriteLine(($record|ConvertTo-Json -Depth 5 -Compress));$writer.Flush()
    Start-Sleep -Milliseconds 500
  }
} finally {
  $writer.Dispose()
  foreach($binding in $owned.Values){$binding.process.Dispose()}
}
