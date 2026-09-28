# Codex → ZCode Bridge

A Codex plugin and local MCP server for delegating authorized development tasks to the ZCode Agent on your machine. Codex can follow progress, select a model, review changes, and decide whether to accept them.

## Features

- Submit, follow, continue, and cancel ZCode tasks from Codex.
- Optionally run multiple ZCode workers: separate projects can run concurrently; tasks sharing an execution directory are serialized, while separate Codex-provided worktrees can host multiple sessions.
- Select a ZCode provider/model per task or configure a user default.
- At startup, report the project directory, execution directory, ZCode session, runtime-reported model, and execution mode.
- Group ZCode Desktop tasks under the Codex project directory; index sync failures do not stop task execution.

## Install

Requires Node.js 22.18+, Git, ZCode installed and signed in, and the Codex desktop app or CLI with marketplace support. Real ZCode E2E has only been completed on Windows; macOS and Linux have not been verified.

### Install with Codex CLI

Add the GitHub marketplace and install the plugin:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref master
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Install in the Codex desktop app

First run the marketplace-add command above to register the GitHub marketplace. Then open Codex's **Plugins Directory**, choose that marketplace, and install **Codex ZCode Bridge**.

### First run

Start a new conversation, then review and trust the plugin's `SessionStart` hook. On Windows, it discovers and validates Node.js, the ZCode installation directory and runtime, builtin/personal provider configuration, the ZCode data root, and the Bridge data directory. It writes the resolved paths and current settings to user environment variables and a local `runtime-config.json`. Provider credentials are not copied. Standard installs do not require cloning the repository or running `npm install`. The marketplace does not install Node.js or ZCode for you.

The plugin's first-run hook discovers and saves common ZCode runtime and provider locations. To override custom paths, set a default model, or configure parallel workers, run `install.ps1` from a repository checkout. Running it without options scans, validates, and saves the discovered setup; this optional configuration step requires a repository copy, while plugin installation itself does not:

Replace the sample paths and `your-provider-id` / `your-model-id` with values from your local setup. The default provider and model must be supplied together.

```powershell
git clone --branch master --single-branch https://github.com/Sandyzzx/codex-zcode-bridge.git
Set-Location codex-zcode-bridge
.\install.ps1 `
  -ZCodeRuntimePath "C:\path\to\zcode.cjs" `
  -BuiltinProviderConfigPath "C:\path\to\zcode-builtin.json" `
  -PersonalProviderConfigPath "D:\ZCodeData\.zcode\v2\provider_config.json" `
  -ZCodeHome "D:\ZCodeData\.zcode" `
  -DefaultProviderId "your-provider-id" `
  -DefaultModelId "your-model-id" `
  -Mode "yolo"
```

Omit options you do not need to override. `ZCodeHome` must be the actual `.zcode` directory, and the personal provider file must be at `v2\provider_config.json` inside it. The script discovers and validates the required directories and current settings, then records the runtime, installation root, provider files, ZCode data root, Bridge data directory, mode, worker limit, and any configured default model in the Windows user environment and `runtime-config.json`. It saves a default model only when you already configured or explicitly supplied one; it will not guess which model to use. Add `-WhatIf` to preview changes without writing them.

See the [official OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and plugin details.

### Optional: parallel workers

The Bridge runs one ZCode task at a time by default. After confirming that local resources and ZCode provider configuration can handle concurrency, set the worker limit to 2–8; for example, run `./install.ps1 -MaxConcurrentWorkers 2` from a repository checkout in PowerShell, then restart Codex. You can also set the user environment variable `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS`. Different project directories can run concurrently; identical or nested execution directories are queued. To run multiple tasks in one project at once, Codex must prepare a truly independent Git worktree for each task and pass each path. The Bridge serializes by path only; it does not verify that supplied directories are independent Git worktrees, create them, or choose them.

The limit applies to one Bridge MCP process and defaults to 1. Cross-process scheduling between multiple Bridge processes sharing a data directory is not implemented; do not increase concurrency by launching multiple Bridge processes.

## Use

Describe the development task and its acceptance criteria. Codex decides whether to prepare a worktree, then delegates the task to ZCode. ZCode runs in that worktree when provided, or directly in the project directory otherwise. ZCode does not automatically receive the full Codex conversation, so Codex must include any required project decisions and constraints with the task.

ZCode generates the session title from the first task prompt. The Bridge puts `TASK ID` on the first line, but the displayed title may also include following prompt text.

After execution, Codex should inspect the actual diff and run acceptance checks independently. `completed` means ZCode reported the task finished; it does not mean Codex approved the changes. If an unresolved decision could materially affect behavior, ZCode asks Codex for direction before proceeding on that point.

In ZCode Desktop, find tasks in the Workspace view under the Codex project directory. Task-index synchronization is best-effort, so the sidebar may not refresh immediately.

## Security and limitations

- The default execution mode is `yolo`. Set `ZCODE_BRIDGE_MODE` to `plan`, `build`, or `edit` to change it. ZCode runs with the current operating-system user's permissions.
- A Git worktree isolates the working directory; it is not an operating-system sandbox. `allowed_paths` and `forbidden_paths` describe task constraints but cannot prevent the process from accessing other files or running commands.
- Codex decides whether to create a worktree. The Bridge uses the supplied project directory and optional worktree path; it does not create or remove worktrees.
- Parallel execution starts multiple ZCode app-server workers and increases local resource use and provider concurrency. A live E2E verified parallel sessions using the same Coding Plan model and Desktop task-index registration; concurrent switching between providers/models and Desktop UI refresh remain unverified. Use the default single worker for predictable operation.
- The Bridge stores prompts, status, logs, visible model output, events, and results locally in `~/.codex/codex-zcode-bridge/` (on Windows: `%USERPROFILE%\.codex\codex-zcode-bridge\`). Do not include credentials or data in tasks or workspaces if they should not be sent to the selected model service.
- The Bridge uses the local ZCode app-server. Permission interactions and available events depend on the installed ZCode version. Forwarding per-action approval requests back to Codex has not been verified.

## Build from source

The repository includes TypeScript source for review and self-builds. With Node.js 22.18+:

```sh
npm ci
npm run build
```

## Acknowledgements and license

Process handling is adapted in part from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex); ZCode Desktop task-index integration is adapted in part from [zcode-acp](https://github.com/william0wang/zcode-acp). Thanks to the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project. See [NOTICE](NOTICE) for source and copyright details.

This project is licensed under [Apache License 2.0](LICENSE). Third-party components remain subject to their respective licenses.
