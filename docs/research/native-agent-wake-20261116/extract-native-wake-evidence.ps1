param(
    [string]$SessionRoot = (Join-Path $env:USERPROFILE '.codex\sessions'),
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$cases = [ordered]@{
    'A_FEATURE_OFF' = [ordered]@{
        parent = '01a1e4bd-0694-7c32-b9e1-9ee5cc884de0'
        child = '01a1e4bd-7f09-7152-8648-6b0155f42dad'
    }
    'B_FEATURE_ON' = [ordered]@{
        parent = '01a1e4c1-0dac-7c20-8d0d-00d556d93c39'
        child = '01a1e4c1-352a-7250-b30f-43eb48bcf8c7'
    }
    'LONG_IDLE' = [ordered]@{
        parent = '01a1e4d2-4574-7202-8ecc-9818db713f37'
        child = '01a1e4d2-e3a7-7c32-be62-25eb30a67bfc'
    }
    'DESKTOP_ORDINARY_DEFAULT' = [ordered]@{
        parent = '01a1e4c7-7b2c-73c2-a8cc-ea2010f0f752'
        child = '01a1e4c7-acb0-7002-a830-4e74a282e54c'
    }
    'DESKTOP_GOAL_DEFAULT' = [ordered]@{
        parent = '01a1e4d4-9b8c-7941-9d01-a8aa6d3ac4ad'
        child = '01a1e4d4-d7a2-7161-a2b1-a59abed22544'
    }
}

function Find-Rollout {
    param([string]$ThreadId)

    $matches = Get-ChildItem -LiteralPath $SessionRoot -Recurse -File -Filter "*$ThreadId.jsonl"
    if ($matches.Count -ne 1) {
        throw "Expected exactly one rollout for $ThreadId, found $($matches.Count)"
    }
    return $matches[0].FullName
}

function Get-AllowedEvents {
    param(
        [string]$Path,
        [string]$ThreadId,
        [string]$Role
    )

    $events = [System.Collections.Generic.List[object]]::new()
    $lineNumber = 0

    foreach ($line in Get-Content -LiteralPath $Path) {
        $lineNumber++
        $record = $line | ConvertFrom-Json -Depth 50
        $payload = $record.payload

        if ($record.type -eq 'session_meta') {
            $events.Add([ordered]@{
                line = $lineNumber
                event = 'session_meta'
                timestamp_utc = $record.timestamp
                thread_id = $payload.id
                parent_thread_id = $payload.parent_thread_id
                originator = $payload.originator
                cli_version = $payload.cli_version
            })
            continue
        }

        if ($record.type -eq 'event_msg' -and $payload.type -eq 'task_started') {
            $events.Add([ordered]@{
                line = $lineNumber
                event = 'task_started'
                timestamp_utc = $record.timestamp
                thread_role = $Role
                thread_id = $ThreadId
                turn_id = $payload.turn_id
                root_turn_id = $payload.root_turn_id
                turn_trigger = $payload.turn_attribution.turn_trigger
                mode = $payload.collaboration_mode_kind
            })
            continue
        }

        if ($record.type -eq 'event_msg' -and $payload.type -eq 'task_complete') {
            $events.Add([ordered]@{
                line = $lineNumber
                event = 'task_complete'
                timestamp_utc = $record.timestamp
                thread_role = $Role
                thread_id = $ThreadId
                turn_id = $payload.turn_id
                last_agent_message = $payload.last_agent_message
                duration_ms = $payload.duration_ms
            })
            continue
        }

        if ($record.type -eq 'inter_agent_communication_metadata') {
            $events.Add([ordered]@{
                line = $lineNumber
                event = 'inter_agent_communication_metadata'
                timestamp_utc = $record.timestamp
                thread_role = $Role
                thread_id = $ThreadId
                trigger_turn = $payload.trigger_turn
            })
            continue
        }

        if ($record.type -eq 'response_item' -and $payload.type -eq 'agent_message') {
            $text = ($payload.content |
                Where-Object { $_.type -eq 'input_text' } |
                ForEach-Object { $_.text }) -join "`n"
            if ($text -match 'NATIVE_WAKE|GOAL_PARENT_FINAL|PARENT_FINAL') {
                $events.Add([ordered]@{
                    line = $lineNumber
                    event = 'agent_message'
                    timestamp_utc = $record.timestamp
                    thread_role = $Role
                    thread_id = $ThreadId
                    author = $payload.author
                    recipient = $payload.recipient
                    text = $text
                })
            }
            continue
        }

        if ($record.type -eq 'response_item' -and $payload.type -eq 'message' -and $payload.role -eq 'assistant') {
            $text = ($payload.content |
                Where-Object { $_.type -eq 'output_text' } |
                ForEach-Object { $_.text }) -join "`n"
            if ($text -match 'NATIVE_WAKE|GOAL_PARENT_FINAL|PARENT_FINAL') {
                $events.Add([ordered]@{
                    line = $lineNumber
                    event = 'assistant_message'
                    timestamp_utc = $record.timestamp
                    thread_role = $Role
                    thread_id = $ThreadId
                    turn_id = $payload.internal_chat_message_metadata_passthrough.turn_id
                    text = $text
                })
            }
            continue
        }

        if ($record.type -eq 'response_item' -and $payload.type -eq 'function_call') {
            if ($payload.name -in @('sleep', 'js', 'spawn_agent', 'create_goal', 'update_goal')) {
                $events.Add([ordered]@{
                    line = $lineNumber
                    event = 'function_call'
                    timestamp_utc = $record.timestamp
                    thread_role = $Role
                    thread_id = $ThreadId
                    name = $payload.name
                    call_id = $payload.call_id
                })
            }
            continue
        }

        if ($record.type -eq 'response_item' -and $payload.type -eq 'function_call_output') {
            if ([string]$payload.output -match '"threadId"') {
                try {
                    $goal = ($payload.output | ConvertFrom-Json -Depth 20).goal
                    if ($null -ne $goal) {
                        $events.Add([ordered]@{
                            line = $lineNumber
                            event = 'goal_tool_result'
                            timestamp_utc = $record.timestamp
                            thread_role = $Role
                            thread_id = $ThreadId
                            call_id = $payload.call_id
                            goal_thread_id = $goal.threadId
                            status = $goal.status
                            tokens_used = $goal.tokensUsed
                            time_used_seconds = $goal.timeUsedSeconds
                        })
                    }
                } catch {
                    # The output may contain non-goal JSON; skip it rather than copying it.
                }
            }
            continue
        }

        if ($record.type -eq 'token_usage_record') {
            $events.Add([ordered]@{
                line = $lineNumber
                event = 'turn_token_usage'
                timestamp_utc = $record.timestamp
                thread_role = $Role
                thread_id = $ThreadId
                turn_id = $payload.turn_id
                usage = [ordered]@{
                    input_tokens = $payload.turn_token_usage.input_tokens
                    cached_input_tokens = $payload.turn_token_usage.cached_input_tokens
                    cache_write_input_tokens = $payload.turn_token_usage.cache_write_input_tokens
                    output_tokens = $payload.turn_token_usage.output_tokens
                    reasoning_output_tokens = $payload.turn_token_usage.reasoning_output_tokens
                    total_tokens = $payload.turn_token_usage.total_tokens
                }
            })
        }
    }

    return $events
}

$result = [ordered]@{
    schema = 'codex-zcode-bridge/native-agent-wake-rollout-extract-v1'
    generated_at_utc = [DateTime]::UtcNow.ToString('o')
    source_root = $SessionRoot
    cases = [ordered]@{}
}

foreach ($case in $cases.GetEnumerator()) {
    $parentPath = Find-Rollout -ThreadId $case.Value.parent
    $childPath = Find-Rollout -ThreadId $case.Value.child
    $result.cases[$case.Key] = [ordered]@{
        parent_thread_id = $case.Value.parent
        child_thread_id = $case.Value.child
        parent_rollout = Split-Path -Leaf $parentPath
        child_rollout = Split-Path -Leaf $childPath
        parent_events = @(Get-AllowedEvents -Path $parentPath -ThreadId $case.Value.parent -Role 'parent')
        child_events = @(Get-AllowedEvents -Path $childPath -ThreadId $case.Value.child -Role 'child')
    }
}

$json = $result | ConvertTo-Json -Depth 30
if ($OutputPath) {
    [IO.File]::WriteAllText($OutputPath, $json + "`n", [Text.UTF8Encoding]::new($false))
} else {
    $json
}
