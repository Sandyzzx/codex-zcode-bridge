# Codex → ZCode Bridge

A local Codex plugin and MCP server for delegating bounded development tasks to the ZCode Agent installed on your machine. Codex can follow task status, inspect progress events and reports, and review the actual changes in an isolated Git worktree.

> **Execution permissions:** The Bridge creates ZCode app-server sessions in `yolo` mode by default, and ZCode runs with the current user's permissions. This is not an operating-system sandbox: Git worktrees and `allowed_paths` / `forbidden_paths` do not enforce process access boundaries. A per-action approval flow back to Codex has not been verified. At task startup, the Bridge reports the source project, isolated worktree, ZCode session, runtime-reported model, and execution mode.

## Features

- Submit, inspect, continue, and cancel tasks through a local stdio MCP server.
- Select a ZCode provider/model per task and optionally pass a runtime-supported reasoning level. Without a task override, the Bridge uses the user default model and then the ZCode session default.
- Best-effort register app-server-created sessions in the ZCode Desktop task index and mirror coarse status; cancellation clears the active status. Tasks are associated with their isolated worktree workspace. A successful index write does not guarantee the current Desktop sidebar has refreshed; index failures never stop task execution.
- Uses the native ZCode app-server and exposes visible text, model selection, tool lifecycle, usage, and task events when provided by the installed runtime.
- Runs in an isolated Git worktree and stores task state, logs, events, and results under `~/.codex/codex-zcode-bridge/` (on Windows, `%USERPROFILE%\.codex\codex-zcode-bridge\`).
- `completed` means ZCode reported the run as finished; it does not mean Codex accepted the changes. Codex should inspect the diff and run acceptance checks independently.

## Requirements

- Windows, macOS, or Linux. Windows is the primary verified environment; real ZCode E2E on other platforms has not been completed, so compatibility is uncertain.
- Node.js 22.18 or later and Git.
- ZCode installed and signed in locally, with an accessible runtime and valid provider configuration.
- Codex desktop app or a Codex CLI version that supports local plugin marketplaces.

## Install

1. Install Node.js 22.18+, Git, and ZCode locally, and sign in to ZCode.
2. Manually add the GitHub marketplace in Codex and install **Codex ZCode Bridge**. You can also use the Codex CLI:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref phase7-live-progress
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

3. On the first new conversation, review and trust the **Codex ZCode Bridge** `SessionStart` hook. It then reads and validates Node.js, Git, the ZCode runtime, and provider configs, and reports discovered paths or configuration problems. Default paths are not written to user environment variables. In Codex CLI, use `/hooks` to inspect hook status. The plugin and MCP are installed once.

If ZCode is installed in a nonstandard location, uses a custom data directory, or needs default model/mode settings, run the Windows configuration script from a repository copy:

```powershell
.\install.ps1 `
  -ZCodeRuntimePath "C:\path\to\zcode\runtime.cjs" `
  -BuiltinProviderConfigPath "C:\path\to\builtin-provider.json" `
  -ZCodeHome "D:\ZCodeData\.zcode" `
  -DefaultProviderId "account:bigmodel-individual-coding-plan" `
  -DefaultModelId "GLM-5.3-Flash" `
  -Mode "yolo"
```

Each parameter is optional. `ZCODE_HOME` must point to the actual `.zcode` data directory and contain `v2\provider_config.json`; the script discovers and validates it along with the runtime/provider JSON (the personal config must contain non-empty provider rules). Default provider and model must be supplied as a pair; task-level model selection overrides them. Modes are `plan`, `build`, `edit`, or `yolo` (default: `yolo`). After validation, the script writes only the Windows user environment variables for parameters explicitly supplied. Omitted parameters are discovered/read without persisting defaults. Restart Codex after configuring paths or defaults. The script does not add a marketplace, install the plugin, edit ZCode config contents, or change ACLs.

At startup, Codex reports the ZCode project, worktree, session, model, and execution mode. If the runtime does not report its selected model, the Bridge fails before sending the task prompt. Per-action permission forwarding through app-server remains unverified; behavior of permission interactions in `build`/`edit`/`plan` modes must be confirmed against the local ZCode version.

The Bridge discovers common ZCode install and provider locations by default, including Windows `Program Files`, `LOCALAPPDATA`, and the ZCode data directory. Environment variables store paths only; never put provider contents or API credentials in marketplace files.

The plugin includes bundled Bridge MCP server and worker files; users do not need to clone the repository, run `npm install`, or generate `.mcp.json` manually. A marketplace distributes and installs the plugin, but does not install Node.js or ZCode. See the [official Codex plugin documentation](https://developers.openai.com/plugins/build/plugins) for Git marketplace commands and local plugin details.

The repository also includes TypeScript source and build configuration for review and self-builds; internal tests and development docs are not part of the release. To build it yourself, run `npm ci` followed by `npm run build`.

## Task workflow

1. Codex calls `zcode_task` with an objective, requirements, workspace, and acceptance criteria. It can specify a model when needed.
2. The Bridge validates and stores the task, then starts ZCode in a Git worktree.
3. Codex follows progress through status and event tools, then reads the result and inspects the worktree diff.
4. Codex runs acceptance checks independently and can continue the task in the same session/worktree if revisions are needed.
5. Only changes accepted after Codex review should be applied to the user's workspace.

## Find tasks in ZCode Desktop

The Bridge creates a separate Git worktree for each task and associates the ZCode session with that worktree path, not the source project directory. By default, the path is `<Bridge data directory>/.tasks/workspaces/<task_id>`. If you only inspect the source project's workspace, you may not find the delegated task.

In ZCode's left task sidebar, switch the view to **Workspace** and look under the corresponding isolated worktree; you can also use **Timeline** and sort by update time. ZCode's documentation describes these Desktop task views and sort options, but does not document a dedicated refresh button for the Desktop sidebar. The documented **Refresh** action is in the mobile Remote Control Task home, not a Desktop button. See the [ZCode task management documentation](https://zcode.z.ai/en/docs/task-management) and [Remote Control documentation](https://zcode.z.ai/en/docs/remote-control).

The `desktop_task_registered` event means the Bridge wrote the session to ZCode Desktop's task index; it does not guarantee that the current UI has rendered the row. If the task is still missing, first check the isolated worktree workspace rather than only the source project workspace.

### Known issues

- **Desktop may not show a worktree that is not open or registered in the current window.** Comparing local index records, the session the user could see belonged to a project workspace already open in Desktop. The Bridge test session was also written to the index and completed, but belonged to a separately created temporary worktree. Neither row was archived or deleted. The likely explanation is that the temporary worktree was not loaded in the current Desktop window; to verify, open the task's worktree directory in ZCode and check Workspace or Timeline. The official Remote Control documentation says it can access only workspaces already open or registered in the current Desktop window. No manual refresh action for the Desktop sidebar is documented. Mobile Remote Control's Refresh pulls the latest state from Desktop, but remains scoped to workspaces in the current window.
- **Start Plan availability for GLM-5.3-Flash is not yet consistently verified.** The local Bridge startup path has failed to discover or report the selected model in some attempts; another test completed successfully and the ZCode index recorded `account:bigmodel-individual-coding-plan/GLM-5.3-Flash`. A plan entitlement or a model visible in the ZCode UI therefore does not by itself confirm that the current Bridge/runtime/provider combination can use it. Check the provider and model reported by the startup event before relying on a run. If the runtime does not report a model, the Bridge fails before sending the task prompt. The specific cause remains under investigation.

## Security and privacy

- Provider configuration contents are not copied into the repository. ZCode child processes receive only required OS variables, provider config paths, and explicit Bridge settings; arbitrary parent environment variables are not inherited.
- Common `.env` files, private keys/certificates, `.npmrc`, and cloud credential directories are excluded from Git task snapshots. This heuristic is not a complete secret scanner; inspect the repository before delegating. Git custom clean filters may still run during `git add`.
- `~/.codex/codex-zcode-bridge/` persistently stores prompts, status, logs, visible model output, events, and results. POSIX systems use `0700` directories and `0600` files; on Windows, access depends on the parent directory ACL. Apply appropriate local access controls and retention policies.
- Git worktrees provide version isolation, not a security sandbox. ZCode retains access to files and programs available to the current user. Do not delegate untrusted instructions or keep credentials in the workspace.
## Acknowledgements

Part of the process-tree handling code is adapted from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex). The ZCode Desktop task-index integration is adapted from [zcode-acp's `src/tasks-index.ts`](https://github.com/william0wang/zcode-acp/blob/main/src/tasks-index.ts), modified for Bridge task correlation, `ZCODE_HOME` path resolution, schema checks, and status synchronization. Both projects use Apache-2.0; see [NOTICE](NOTICE) for source, modifications, and copyright notices. Thanks to the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project for their open-source tools and runtime. Codex, ZCode, and related marks belong to their respective owners. This project is not affiliated with or endorsed by OpenAI, Z.ai, or their affiliates.

## License

This project is licensed under the [Apache License 2.0](LICENSE). Third-party code and dependencies remain subject to their own licenses; see [NOTICE](NOTICE).
