# Phase 1 Research: Codex → ZCode Bridge

Research date: 2026-09-26 (Asia/Shanghai)

## Scope and evidence

Reviewed the current `main` checkouts of:

- [hex1n/cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex)
- [alexeygrigorev/codex-zcode](https://github.com/alexeygrigorev/codex-zcode)
- [zai-org/ZCode](https://github.com/zai-org/ZCode), including CLI argument parsing, prompt result formatting, and provider runtime initialization.

The first project was inspected through its MCP server, service, process, job lifecycle, isolated workspace, and task prompt sources. The second was inspected through `ABOUT.md` and `codex-rs/ext/zcode/src/lib.rs`. Local ZCode checks and their limits are recorded in [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md).

At the first inspection, the working directory contained no project files and had no `.git` directory. It now contains the Phase 1 docs, but still has no `.git`; no commit has been created. The intended GitHub remote is `https://github.com/Sandyzzx/codex-zcode-bridge.git`, but the current local directory is not attached to it.

## Reference A: reusable patterns

`cc-plugin-codex` is a typed stdio MCP with a small protocol layer that validates tool arguments and delegates work to service functions. The protocol handler does not own task execution logic. This separation is useful here: MCP schemas/handlers should call a task manager, which calls a workspace provider and the coding-agent adapter.

Its job lifecycle persists state outside process memory, records subprocess identity and logs, and reconciles stale `starting`/`running` jobs after restart. Timeouts and cancellation terminate process trees on Windows with `taskkill /T /F`. This is a useful basis for Bridge restart recovery and cancellation; a single JSON record per task is enough for V0.1.

Its write workflow uses a standalone clone and an explicit apply step. That is stronger isolation than this Bridge's requested V0.1 direct-workspace mode, so it is a future option, not a requirement to copy now. The main lesson is to keep workspace creation/cleanup behind a `WorkspaceProvider` boundary.

Its prompts spell out task scope and capability boundaries, and its result tools expose persisted structured job state. Its completion state is a report, not proof that the task is correct. Codex must still inspect the diff, rerun relevant checks, compare results with acceptance criteria, and decide whether to continue or pass.

## Reference B: reusable adapter patterns

`codex-zcode` is a Codex CLI fork, not a standalone MCP task manager. Its ZCode integration is nevertheless a focused subprocess adapter: it resolves the `zcode.cjs` runtime, invokes Node with `--prompt`, `--json`, `--mode`, and `--cwd`, optionally passes `--resume`, captures stdout/stderr, applies a hard timeout, parses JSON, and requires a `sessionId` before treating the response as a valid result.

The Rust adapter passes a temporary prompt-file path through a short Node loader instead of putting a potentially large prompt directly into the OS command line. It sets the child working directory explicitly, uses no shell, and kills the child when its future is dropped. Those are useful Windows-safe adapter practices. The Bridge should still own durable task state and normalized task results; the ZCode process should remain behind `CodingAgentAdapter`.

The reference's Linux instructions document a provider configuration lookup mismatch and suggest copying the packaged config. The official ZCode repository shows a better Bridge integration point: `prepareCliProviderRuntimeEnv` accepts `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` together and then skips entrypoint-relative discovery. The official README lists the built-in config environment variable, and the runtime-path implementation requires the built-in and personal config variables as a pair. The Bridge should set these only in the child process environment, after validating both files; it should not copy into or edit the desktop installation.

The official CLI source also confirms that `--prompt`, `--json`, `--cwd`, `--mode`, and `--resume` are parsed by the Agent CLI. The `--json` prompt result observed in the local runtime includes `sessionId`, `traceId`, `turnId`, `response`, `usage`, `eventCount`, and `projection`; this shape is verified only for CLI 0.16.9 on this machine, not a stable cross-version contract. The current CLI argument parser does not define `--max-turns`, so the Bridge must not send that flag to this installation. See [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) for the local run evidence and remaining unknowns.

## V0.1 architecture recommendation

Use these boundaries:

1. **stdio MCP server** — expose the requested task, status, result, continue, and cancel tools with strict input schemas; keep protocol code thin.
2. **Task manager and file store** — validate task IDs and canonical paths, persist the original task package, status timestamps, process metadata, stdout/stderr, and normalized result under `.tasks/<task_id>/`. Write status/result files atomically so a restart cannot leave partially written JSON.
3. **WorkspaceProvider** — begin with `DirectWorkspaceProvider`; pass its canonical directory to the adapter. Keep workspace preparation independent so a future worktree provider does not change MCP tool contracts.
4. **CodingAgentAdapter / ZCode adapter** — discover/validate Node and `zcode.cjs`, build an argument array (never a shell command string), start and monitor the child, parse output, and normalize it. The adapter should report startup/configuration errors distinctly from model/task failures.
5. **Prompt builder** — render the structured package and master feedback into a subordinate-agent prompt. Make task boundaries explicit, but treat `allowed_paths` and `forbidden_paths` in direct mode as agent instructions and post-run checks, not an OS-enforced sandbox.

Data flow: Codex calls `zcode_task` → validate and persist package → select workspace → build prompt → spawn ZCode → update persisted state/logs → normalize result → Codex calls status/result and independently reviews the working-tree diff and tests → Codex either accepts or calls `zcode_continue` with precise feedback. `zcode_cancel` requests termination and records a terminal state only after process termination is confirmed.

Suggested state transitions are `queued → running → completed | failed | cancelled | waiting_for_master`; a restarted server reconciles a recorded live PID and marks an exited child without a result as failed. Continuation should prefer `--resume <sessionId>` only after real session reuse is verified; otherwise start a fresh invocation whose prompt includes the task/result/feedback summary. Avoid claiming the parent session was reused unless the returned session ID confirms it.

Failure handling should preserve raw stdout and stderr, exit code, start/finish timestamps, timeout/cancel cause, parse errors, and the normalized result. A successful process exit with malformed or missing JSON is a failed Bridge task, not a completed coding task. Bound log/result sizes and make cleanup explicit.

## Security boundaries and known risk

Direct workspace mode gives ZCode write access in the selected workspace according to its own permission mode and tools. A prompt cannot technically prevent writes outside an allowlist, and post-run detection cannot undo them. V0.1 should canonicalize the workspace, reject invalid/outside paths, record the requested path rules, and report out-of-scope changes to Codex; stronger containment requires a separate workspace/sandbox implementation.

Never invoke `zcode.cjs` through `exec` or a shell string. Do not put secrets in task prompts or persisted logs. MCP cancellation must address the full Windows process tree. ZCode's own “completed” response is subordinate evidence; only Codex can issue the final PASS.

## Phase 1 conclusion

- The proposed separation and task lifecycle are implementable without adopting either reference wholesale.
- ZCode Desktop 3.14.3 / CLI 0.16.9 headless execution, JSON output, `--cwd` file placement, and `--resume` session continuation have now passed a real local smoke test. Resume returned the same session ID and modified the same isolated workspace.
- The original provider lookup failure is reproducible in a bare environment. Setting both provider config variables in the child environment fixes it without modifying the ZCode installation. The personal config path must resolve to a working existing config; the small auto-created stub did not work.
- A transient “Bundled 与 Active ZCode Built-in Release 均不可用” failure appeared across different environment configurations and later stopped. Its cause is unknown; the Bridge should preserve the diagnostic and apply bounded retry behavior only after distinguishing this transient from configuration/model errors.
- Next: specify the Bridge's provider-config discovery and preflight behavior in the architecture, then implement the adapter. On this host the personal config must be discovered from the active ZCode data directory (or `ZCODE_DATA_BASE_DIR`), not assumed to live under the Windows user's home directory.

## Sources

- [cc-plugin-codex README](https://github.com/hex1n/cc-plugin-codex)
- [cc-plugin-codex MCP server](https://github.com/hex1n/cc-plugin-codex/blob/main/mcp/server.mjs)
- [codex-zcode ABOUT.md](https://github.com/alexeygrigorev/codex-zcode/blob/main/ABOUT.md)
- [codex-zcode ZCode adapter source](https://github.com/alexeygrigorev/codex-zcode/blob/main/codex-rs/ext/zcode/src/lib.rs)
- [ZCode CLI argument parser](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/arguments.ts)
- [ZCode CLI provider runtime environment](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/provider-runtime-env.ts)
- [ZCode provider runtime path variables](https://github.com/zai-org/ZCode/blob/main/packages/provider-node/src/runtime-paths.ts)
- [ZCode headless prompt result formatting](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/prompt-command.ts)
