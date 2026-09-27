# Codex → ZCode Bridge

A local Codex plugin and MCP server for delegating bounded development tasks to the ZCode Agent installed on your machine. Codex can follow task status, inspect progress events and reports, and review the actual changes in an isolated Git worktree.

> **Execution permissions:** The Bridge currently creates ZCode app-server sessions in `yolo` mode. This is not an operating-system sandbox: ZCode runs with the current user's permissions. By default, the Bridge rejects tasks before starting the model. It runs only if you choose to set `ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION=1`. This opt-in allows the Agent to use your current user permissions; installing the plugin does not require or set it. If you do not accept this permission scope, leave the default unchanged and the Bridge will not execute tasks. `allowed_paths` and `forbidden_paths` are agent instructions, not enforced access controls. The Bridge does not yet provide a verified per-action approval flow back to Codex.

## Features

- Submit, inspect, continue, and cancel tasks through a local stdio MCP server.
- Select a ZCode provider/model per task and optionally pass a runtime-supported reasoning level. Omitting the model keeps the ZCode session default.
- Uses the native ZCode app-server and exposes visible text, model selection, tool lifecycle, usage, and task events when provided by the installed runtime.
- Runs in an isolated Git worktree and stores task state, logs, events, and results under `~/.codex/codex-zcode-bridge/` (on Windows, `%USERPROFILE%\.codex\codex-zcode-bridge\`).
- `completed` means ZCode reported the run as finished; it does not mean Codex accepted the changes. Codex should inspect the diff and run acceptance checks independently.

## Requirements

- Windows, macOS, or Linux. Windows is the primary verified environment; real ZCode E2E on other platforms has not been completed, so compatibility is uncertain.
- Node.js 22.18 or later and Git.
- ZCode installed and signed in locally, with an accessible runtime and valid provider configuration.
- Codex desktop app or a Codex CLI version that supports local plugin marketplaces.

## Install from the GitHub marketplace

1. Install Node.js 22.18+, Git, and ZCode locally, and sign in to ZCode.
2. Add the GitHub marketplace to Codex. The current published branch is `phase7-live-progress`:

   ```sh
   codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref phase7-live-progress
   ```

3. Restart Codex, open the plugin directory, find **Codex ZCode Bridge**, and select Install. Start a new conversation to use its MCP tools.

Tasks remain blocked by the execution guard after installation. Only set the environment variable above and restart Codex if you understand and accept that ZCode runs with your user permissions. Do not set it just to complete installation. The app-server integration has not yet verified a per-action approval flow, so the project does not claim to offer a narrower working permission mode.

The Bridge discovers common ZCode install and provider locations by default. If your ZCode uses custom paths, set `ZCODE_BRIDGE_ZCODE_CJS`, `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` in your operating system user environment, then restart Codex. These variables contain paths only; never put provider contents or API credentials in the marketplace files.

The plugin includes bundled Bridge MCP server and worker files; users do not need to clone the repository, run `npm install`, or generate `.mcp.json` manually. A marketplace distributes and installs the plugin, but does not install Node.js or ZCode, or grant execution permission. See the [official Codex plugin documentation](https://developers.openai.com/plugins/build/plugins) for Git marketplace commands and local plugin details.

## Task workflow

1. Codex calls `zcode_task` with an objective, requirements, workspace, and acceptance criteria. It can specify a model when needed.
2. The Bridge validates and stores the task, then starts ZCode in a Git worktree.
3. Codex follows progress through status and event tools, then reads the result and inspects the worktree diff.
4. Codex runs acceptance checks independently and can continue the task in the same session/worktree if revisions are needed.
5. Only changes accepted after Codex review should be applied to the user's workspace.

## Security and privacy

- Provider configuration contents are not copied into the repository. ZCode child processes receive only required OS variables, provider config paths, and explicit Bridge settings; arbitrary parent environment variables are not inherited.
- Common `.env` files, private keys/certificates, `.npmrc`, and cloud credential directories are excluded from Git task snapshots. This heuristic is not a complete secret scanner; inspect the repository before delegating. Git custom clean filters may still run during `git add`.
- `~/.codex/codex-zcode-bridge/` persistently stores prompts, status, logs, visible model output, events, and results. POSIX systems use `0700` directories and `0600` files; on Windows, access depends on the parent directory ACL. Apply appropriate local access controls and retention policies.
- Git worktrees provide version isolation, not a security sandbox. ZCode retains access to files and programs available to the current user. Do not delegate untrusted instructions or keep credentials in the workspace.
## Acknowledgements

Part of the process-tree handling code is adapted from [cc-plugin-codex](https://github.com/hex1n/cc-plugin-codex); see [NOTICE](NOTICE) for attribution and modification details. Thanks to the [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Zod](https://github.com/colinhacks/zod), and the ZCode project for their open-source tools and runtime. Codex, ZCode, and related marks belong to their respective owners. This project is not affiliated with or endorsed by OpenAI, Z.ai, or their affiliates.

## License

This project is licensed under the [Apache License 2.0](LICENSE). Third-party code and dependencies remain subject to their own licenses; see [NOTICE](NOTICE).
