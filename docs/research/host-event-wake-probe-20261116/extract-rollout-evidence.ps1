param(
  [Parameter(Mandatory = $true)]
  [string[]] $Rollout,

  [string] $ExpectedThreadId = ""
)

$safeMessagePattern = '^(TUI_BASELINE_|GOAL_BASELINE_|WAKE_ACK_|NOTIFY_ACK_|HOST_WAKE_PROBE )'

function Get-MessageText {
  param($Payload)

  if ($Payload.content) {
    return (($Payload.content | ForEach-Object { $_.text }) -join "`n")
  }
  if ($Payload.message) {
    return [string]$Payload.message
  }
  return ""
}

$records = [System.Collections.Generic.List[object]]::new()

foreach ($path in $Rollout) {
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $path) {
    $lineNumber += 1
    try {
      $record = $line | ConvertFrom-Json -Depth 50
    } catch {
      continue
    }

    if ($record.type -eq "event_msg" -and $record.payload.type -in @("task_started", "task_complete", "turn_aborted")) {
      $records.Add([ordered]@{
        source = [System.IO.Path]::GetFileName($path)
        line = $lineNumber
        at = [string]$record.timestamp
        type = [string]$record.payload.type
        turn_id = [string]$record.payload.turn_id
      })
      continue
    }

    if ($record.type -eq "response_item" -and $record.payload.type -eq "message") {
      $text = Get-MessageText $record.payload
      if ($text -match $safeMessagePattern) {
        $records.Add([ordered]@{
          source = [System.IO.Path]::GetFileName($path)
          line = $lineNumber
          at = [string]$record.timestamp
          type = "message"
          role = [string]$record.payload.role
          text = $text
        })
      }
      continue
    }

    if ($record.type -eq "token_usage_record") {
      $threadId = [string]$record.payload.thread_id
      if (-not $ExpectedThreadId -or $threadId -eq $ExpectedThreadId) {
        $records.Add([ordered]@{
          source = [System.IO.Path]::GetFileName($path)
          line = $lineNumber
          at = [string]$record.timestamp
          type = "token_usage_record"
          thread_id = $threadId
          turn_id = [string]$record.payload.turn_id
          turn_usage = $record.payload.turn_token_usage
        })
      }
    }
  }
}

[ordered]@{
  schema = "codex-zcode-bridge/host-event-wake-rollout-extract-v1"
  generated_at = [DateTimeOffset]::UtcNow.ToString("o")
  expected_thread_id = if ($ExpectedThreadId) { $ExpectedThreadId } else { $null }
  redaction = "Only lifecycle events, probe ACKs, and token usage are included. Raw messages and hidden reasoning are omitted."
  records = $records
} | ConvertTo-Json -Depth 12
