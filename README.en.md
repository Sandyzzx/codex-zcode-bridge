# Codex → ZCode Bridge

A Codex plugin and local MCP server for delegating authorized development tasks to the ZCode Agent on your machine. Codex can follow progress, select a model, review changes, and decide whether to accept them.

## Features

- Submit, follow, continue, and cancel ZCode tasks from Codex.
- Run tasks across multiple projects concurrently; tasks sharing an execution directory are queued.
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

After installing, start a new conversation and review and trust the plugin's `SessionStart` hook. On Windows, it discovers and validates Node.js, the ZCode runtime, provider configuration, and data directories, then saves settings to `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`. It does not write Windows user environment variables or copy provider credentials. Standard installs do not require cloning the repository or running `npm install`. The marketplace does not install Node.js or ZCode for you.

To customize settings, edit `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json` directly. On macOS/Linux, use `~/.codex/codex-zcode-bridge/runtime-config.json`. The Windows first-run hook creates this file; on other platforms, create it if needed. Keep the discovered path fields and change only the values you need:

- `ZCODE_BRIDGE_NODE`: absolute path to Node.js (only needed when `node` is not on PATH).
- `ZCODE_BRIDGE_ZCODE_CJS`: absolute path to the ZCode runtime.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`: absolute paths to the builtin and personal provider config files.
- `ZCODE_HOME`: absolute path to the actual `.zcode` data directory.
- `ZCODE_BRIDGE_DATA_DIR`: absolute path to the Bridge task data directory.
- `ZCODE_BRIDGE_DEFAULT_PROVIDER_ID` and `ZCODE_BRIDGE_DEFAULT_MODEL_ID`: default provider and model IDs; set both.
- `ZCODE_BRIDGE_MODE`: initial execution mode: `plan`, `build`, `edit`, or `yolo`; defaults to `yolo`. `yolo` allows ordinary tool operations with the current operating-system account's permissions. Set it to `build` to use ZCode's approval rules.
- `ZCODE_BRIDGE_TIMEOUT_MS`: default wall-clock limit for one task attempt when `timeout_ms` is omitted; 60,000–14,400,000 milliseconds, default 3,600,000 (60 minutes).
- `ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS`: parallel task limit.

Save valid JSON; a newly started Bridge reads the config file, which takes precedence over legacy environment variables. `ZCODE_HOME` must point to the `.zcode` directory, and the personal provider config must be at `v2/provider_config.json` inside it. Copy provider/model IDs from your ZCode configuration, and do not edit ZCode's provider files.

See the [official OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins) for marketplace and plugin details.

## Use

Describe the development task and its acceptance criteria. Codex decides whether to prepare a worktree, then delegates the task to ZCode. ZCode runs in that worktree when provided, or directly in the project directory otherwise. ZCode does not automatically receive the full Codex conversation, so Codex must include any required project decisions and constraints with the task.

ZCode generates the session title from the first task prompt. The Bridge puts `TASK ID` on the first line, but the displayed title may also include following prompt text.

After execution, Codex should inspect the actual diff and run acceptance checks independently. `completed` means ZCode reported the task finished; it does not mean Codex approved the changes. If an unresolved decision could materially affect behavior, ZCode asks Codex for direction before proceeding on that point.

In ZCode Desktop, find tasks in the Workspace view under the Codex project directory.

For installation or startup problems, call the `zcode_doctor` MCP tool for read-only diagnostics. It does not start a ZCode session; app-server model availability and a real permission-approval roundtrip still require verification through an actual task.

## Known issues

- The ZCode Desktop sidebar may not immediately show a new session. The Bridge best-effort syncs the local task index; Desktop controls when the list refreshes.
- ZCode Start Plan is currently unavailable through the Bridge.

## Security and limitations

- The default execution mode is `yolo`. It allows ordinary tool operations with the current operating-system account's permissions; a worktree is not a sandbox. Set `ZCODE_BRIDGE_MODE` to `build` to use ZCode's approval rules. The Bridge has protocol tests for permission forwarding, but a real ZCode permission-approval roundtrip has not been verified.
- A Git worktree isolates the working directory; it is not an operating-system sandbox. `allowed_paths` and `forbidden_paths` describe task constraints but cannot prevent the process from accessing other files or running commands.
- Codex decides whether to create a worktree. The Bridge uses the supplied project directory and optional worktree path; it does not create or remove worktrees.
- Parallel tasks use more local resources and provider capacity.
- The Bridge stores prompts, status, logs, visible model output, events, and results locally in `~/.codex/codex-zcode-bridge/` (on Windows: `%USERPROFILE%\.codex\codex-zcode-bridge\`). Do not include credentials or data in tasks or workspaces if they should not be sent to the selected model service.
- The Bridge uses the local ZCode app-server. Interactions and available events depend on the installed ZCode version. For AskUserQuestion replies, key `answers` by each full `questions[].question` text and use the selected or explicit answer as its value; do not use the header or option label as the key. A real ZCode user-input roundtrip has been verified; a real permission-approval roundtrip has not. Only allow permission requests when the user explicitly authorizes the action.

## Build from source

The repository includes TypeScript source for review and self-builds. With Node.js 22.18+:

```sh
npm ci
npm run build
```

## Acknowledgements and license

Process handling is adapted in part from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex); ZCode Desktop task-index integration is adapted in part from [zcode-acp](https://github.com/william0wang/zcode-acp). Thanks to the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project. See [NOTICE](NOTICE) for source and copyright details.

This project is licensed under [Apache License 2.0](LICENSE). Third-party components remain subject to their respective licenses.
