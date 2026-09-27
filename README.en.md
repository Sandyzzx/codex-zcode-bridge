# Codex → ZCode Bridge

A local Codex plugin and MCP server for delegating bounded development tasks to the ZCode Agent installed on your machine. Codex can follow task status, inspect progress events and reports, and review the actual changes in the Codex-selected execution directory.

> **Execution permissions:** The Bridge creates ZCode app-server sessions in `yolo` mode by default, and ZCode runs with the current user's permissions. `workspace` is always the Codex project root and ZCode Desktop project identity. Codex decides whether to create a worktree and passes its path as optional `worktree_path`; without it, ZCode runs directly in the project root. The Bridge never creates, selects, or removes worktrees. A worktree is not an operating-system sandbox: `allowed_paths` / `forbidden_paths` do not enforce process access boundaries. A per-action approval flow back to Codex has not been verified. At task startup, the Bridge reports project and execution paths, ZCode session, runtime-reported model, and execution mode.

## Features

- Submit, inspect, continue, and cancel tasks through a local stdio MCP server.
- Select a ZCode provider/model per task and optionally pass a runtime-supported reasoning level. Without a task override, the Bridge uses the user default model and then the ZCode session default.
- Best-effort register app-server-created sessions in the ZCode Desktop task index and mirror coarse status; cancellation clears the active status. Tasks are grouped under the project root while retaining the actual execution path. A successful index write does not guarantee the current Desktop sidebar has refreshed; index failures never stop task execution.
- Uses the native ZCode app-server and exposes visible text, model selection, tool lifecycle, usage, and task events when provided by the installed runtime.
- Runs in the Codex-provided project directory or worktree and stores task state, logs, events, and results under `~/.codex/codex-zcode-bridge/` (on Windows, `%USERPROFILE%\.codex\codex-zcode-bridge\`).
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
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref master
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

At startup, Codex reports the project path, execution path, session, model, and execution mode. If the runtime does not report its selected model, the Bridge fails before sending the task prompt. Per-action permission forwarding through app-server remains unverified; behavior of permission interactions in `build`/`edit`/`plan` modes must be confirmed against the local ZCode version.

The Bridge discovers common ZCode install and provider locations by default, including Windows `Program Files`, `LOCALAPPDATA`, and the ZCode data directory. Environment variables store paths only; never put provider contents or API credentials in marketplace files.

The plugin includes bundled Bridge MCP server and worker files; users do not need to clone the repository, run `npm install`, or generate `.mcp.json` manually. A marketplace distributes and installs the plugin, but does not install Node.js or ZCode. See the [official Codex plugin documentation](https://developers.openai.com/plugins/build/plugins) for Git marketplace commands and local plugin details.

The repository also includes TypeScript source and build configuration for review and self-builds; internal tests and development docs are not part of the release. To build it yourself, run `npm ci` followed by `npm run build`.

## Task workflow

1. Codex calls `zcode_task` with an objective, requirements, workspace, and acceptance criteria. It can specify a model when needed.
2. The Bridge uses `workspace` as project identity. Codex may prepare a worktree and pass it as `worktree_path`; the Bridge only validates and uses the supplied path.
3. Codex follows progress through status and event tools, then reads the result and inspects the actual execution directory diff.
4. Codex runs acceptance checks independently and can continue the task in the same session and execution directory if revisions are needed.
5. Codex reviews the changes and decides how to receive them. The Bridge does not apply, merge, or remove worktrees.

## Delegation prompt contract

- The first line is `TASK ID: <task_id>`, which ZCode uses as input when generating a session title. The Bridge does not issue a separate rename command; the final title may not exactly equal the task ID.
- The fixed prompt defines the bounded worker role, objective, paths, acceptance criteria, and JSON report. ZCode does not automatically receive the Codex conversation.
- Pass concise context only when needed, organized as `PROJECT DECISIONS`, `CONSTRAINTS`, `RELEVANT FILES`, and `OPEN DECISIONS — DO NOT CHOOSE`. Do not paste the full conversation.
- ZCode must not decide unresolved items in `OPEN DECISIONS`. It must also escalate requirement conflicts or missing decisions that would materially change external behavior, even if Codex did not list them. Independent work may continue. For low-impact implementation choices, choose the simplest consistent option and report the assumption.

## Find tasks in ZCode Desktop

The ZCode session's `workspaceKey` is the Codex project root; its `workspacePath` is the actual execution path. Without `worktree_path`, both resolve to the project root; with it, `workspacePath` points to the Codex-provided worktree. Bridge progress events use `project_path` and `execution_path` respectively. The Desktop index groups the task under the project root while retaining the worktree path.

In ZCode's left task sidebar, switch the view to **Workspace** and look under the project; you can also use **Timeline** and sort by update time. ZCode's documentation describes these Desktop task views and sort options, but does not document a dedicated refresh button for the Desktop sidebar. The documented **Refresh** action is in the mobile Remote Control Task home, not a Desktop button. See the [ZCode task management documentation](https://zcode.z.ai/en/docs/task-management) and [Remote Control documentation](https://zcode.z.ai/en/docs/remote-control).

The `desktop_task_registered` event means the Bridge wrote the session to ZCode Desktop's task index; it does not guarantee that the current UI has rendered the row. Check the requested project in Workspace or Timeline.

### Known issues

- **ZCode titles come from the first prompt.** The Bridge puts `TASK ID` first and does not use a rename command. In the 2026-09-28 E2E, app-server reported `titleSource: first_input`; the title started with the task ID and appended truncated prompt text, so it was not an exact task-ID title.
- **GLM-5.3-Flash completed a real E2E with the current local provider configuration.** On 2026-09-28, the runtime listed and selected `account:bigmodel-individual-coding-plan/GLM-5.3-Flash` and completed two real turns. Earlier model-discovery failures remain unexplained; other machines should rely on the runtime-reported model.
- **Project/worktree Desktop association was verified in a real E2E.** The ZCode session and Desktop index used the Codex project root as `workspaceKey` and the Codex-prepared worktree as `workspacePath`; the task row was indexed under the project root. Whether Desktop immediately refreshes the current sidebar remains dependent on its refresh behavior.

## Security and privacy

- Provider configuration contents are not copied into the repository. ZCode child processes receive only required OS variables, provider config paths, and explicit Bridge settings; arbitrary parent environment variables are not inherited.
- The Bridge does not create Git snapshots or copy/filter project files. Codex prepares a worktree when needed; inspect files visible to the task before delegating.
- `~/.codex/codex-zcode-bridge/` persistently stores prompts, status, logs, visible model output, events, and results. POSIX systems use `0700` directories and `0600` files; on Windows, access depends on the parent directory ACL. Apply appropriate local access controls and retention policies.
- Whether to use a Git worktree is decided by Codex. A worktree provides file-directory isolation, not a security sandbox. ZCode retains access to files and programs available to the current user. When running directly in the project root, changes are written there. Do not delegate untrusted instructions or keep credentials in the workspace.
## Acknowledgements

Part of the process-tree handling code is adapted from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex). The ZCode Desktop task-index integration is adapted from [zcode-acp's `src/tasks-index.ts`](https://github.com/william0wang/zcode-acp/blob/main/src/tasks-index.ts), modified for Bridge task correlation, `ZCODE_HOME` path resolution, schema checks, and status synchronization. Both projects use Apache-2.0; see [NOTICE](NOTICE) for source, modifications, and copyright notices. Thanks to the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project for their open-source tools and runtime. Codex, ZCode, and related marks belong to their respective owners. This project is not affiliated with or endorsed by OpenAI, Z.ai, or their affiliates.

## License

This project is licensed under the [Apache License 2.0](LICENSE). Third-party code and dependencies remain subject to their own licenses; see [NOTICE](NOTICE).
