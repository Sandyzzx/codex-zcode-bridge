# Codex ZCode Bridge

[简体中文](README.zh-CN.md) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

Codex ZCode Bridge connects Codex with the official ZCode Agent Runtime on your PC. Delegate a development task to ZCode, follow its progress across interruptions, and have Codex review the result before accepting it.

## Why use Bridge?

- **Persistent task delegation.** Send a whole task with its scope and acceptance checks. Bridge saves progress and results so Codex can follow up or recover interrupted work.
- **Official ZCode Runtime.** ZCode uses its own AppServer to run the model and tools. Codex defines the task and reviews the result.
- **Coding Plan and Start Plan.** Use your Z.ai Coding Plan account or select Start Plan, which uses its own official authentication, model entitlement checks, and task-scoped credentials.
- **Verified Coding Plan credit advantage.** The tested setup consumed about `0.67×` the normal credits for the same model usage, giving roughly `1.5×` the usage per credit.
- **Cost Lab billing verification.** Check your installed runtime and reconcile model usage against the official credit ledger from a local web page.

## Plans in Preview

| Plan | Verification |
| --- | --- |
| **Z.ai Coding Plan** | Real Windows end-to-end execution with the installed official AppServer and an official bill confirming the extra `0.67×` multiplier for `GLM-5.3-Flash`. |
| **Z.ai Start Plan** | Historical real Windows end-to-end evidence. Compatibility with Desktop `3.18.2.10443` AppServer was checked offline. Live E2E on that AppServer remains unverified. |

Verified ZCode Desktop installs: `3.18.2.10443` (full historical verification), `3.19.0.10774` (protocol smoke + one real Coding Plan execution), and `4.0.0.10870` (protocol smoke + a full real-task E2E through the shipped plugin artifacts on 2026-11-24). Other safe installs run without a version gate; their compatibility stays unverified until listed here.

The Coding Plan result applies to the tested account, model, and runtime. The `1.5×` figure describes credit efficiency. Plan allowances are separate, and no discount is claimed for Start Plan.

## Install

For Preview, use **Windows x64** and **Node.js `24.16.0`**. Any safe official ZCode Desktop installation runs (ADR-054); versions with completed real verification are listed below. Sign in to ZCode with access to your chosen plan and model. You also need Git and Codex with plugin support. Install Node.js and ZCode separately.

Use one marketplace channel per Codex installation. Preview `2.0.0-preview.14` contains the installed Runtime integration, Cost Lab, SQLite v14-only runtime, bounded Event monitoring, opt-in Result summaries, the independent Executor with Thin MCP, Task CLI and Web Console, trusted-local loaded/idle Queue Wake, and Async Master handoff. Stable remains at `v1.7.2`.

Automatic Wake is verified only for an isolated loaded/idle Thread using explicit trusted-local authorization. Strict not-loaded Wake, Desktop fully exited recovery, Official Runtime provenance and a non-empty real engineering delivery remain unverified.

### Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

To update the Preview marketplace:

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

### Stable

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.2
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

Start a new Codex conversation after installation and review the plugin's `SessionStart` hook. If setup fails, ask Codex to run `zcode_doctor`.

## Delegate your first task

1. Open the project in Codex and explicitly ask to use ZCode Bridge. Specify your plan and model if you have a preference.
2. Give Codex the goal, the files it may change, and the tests or checks you expect.
3. Ask for progress when needed. Codex can use `zcode_status`, `zcode_feedback`, or `zcode_events` to follow the task.
4. Ask Codex to review the workspace diff, test evidence, and `zcode_result` before accepting the work.

> Use ZCode Bridge with Coding Plan GLM-5.3-Flash. Fix the failing parser test, limit edits to the parser and its tests, run the focused test, and have Codex review the result. Do not commit or push.

Run Bridge in a trusted single-user environment. A Git worktree helps organize edits. Filesystem permissions still belong to your OS account.

## Check your credits with Cost Lab

Open [Cost Lab — Local Billing Verification](tools/cost-lab/README.md) for setup and usage. From a Preview source checkout:

```powershell
npm ci
npm run build
npm run cost-lab:web
```

Open the local address printed by the command. The page shows runtime checks, model tokens, official credits, and verification history. Loading it uses no model quota. A real Coding Plan verification requires your explicit confirmation. Cost Lab offers offline checks for Start Plan.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Official Coding Plan billing evidence](docs/evidence/coding-plan-official-discount-verification-20261118.md)
- [Start Plan compatibility](docs/research/start-plan-official-appserver-compatibility-20261118.md)
- [Troubleshooting, runtime, and upgrades](docs/ZCODE_RUNTIME.md)
- [Plugin safety](plugins/codex-zcode-bridge/SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
