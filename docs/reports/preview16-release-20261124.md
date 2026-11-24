# Preview.16 发布记录（2026-11-24）

> Status: RESEARCH
> Date: 2026-11-24

```text
RELEASE_COMMIT:       406c56b848f41823c68a9013f81b645b6b19e0be (Preview HEAD at tag)
TAG:                  codex-zcode-bridge-preview-v2.0.0-preview.16 (annotated; peeled = RELEASE_COMMIT)
GITHUB_RELEASE_ID:    457092646
RELEASE_URL:          https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.16
DRAFT:                false
PRERELEASE:           true
LATEST_RELEASE:       codex-zcode-bridge-v1.7.2 (Stable, unchanged)
ZIP_BYTES:            4453614
ZIP_SHA256:           bf9dd728ef4e9fdb7f7a1576cbfc90839808f8c555f05148dce2b044afaa0ccf
                      (本地构建、GitHub asset digest、回下载三方一致)
ASSET_SHA256_FILE:    codex-zcode-bridge-preview-v2.0.0-preview.16.zip.sha256
RELEASE_GATE:         PR #140 run 45442818848 @ f07d57d81, SUCCESS
                      (release-candidate 标签：Ubuntu 完整 npm test、Windows 两路分片、
                       SQLite 资源矩阵、Cost Lab)
MERGE_PUSH_CI:        run 45444768094 @ 406c56b84, SUCCESS（完整门禁；Integration gate 按 Impact
                      选择为 skipped，完整套件已由 Ubuntu 与 Windows 分片承担）
```

## 集成内容

1. **ADR-059 Owner Binding**：MCP Host 只从 `ctx.mcpReq._meta.threadId` 获取原 Thread，
   `task_owner_bindings` 与 Task、首个 Attempt 在同一 SQLite 事务中提交，早于 Worker Spawn；
   `owner_thread_unavailable` 时仍可正常执行但明确报告无法自动 Wake。
2. **Wake 专用授权退役**：移除 `wake-policy.json`、Owner Grant、模型/Provider/Effort 匹配、
   Control Socket 与 loaded/idle 前置门禁；Release 后最多一次官方 `codex queue`，保留
   Intent、幂等与未知提交保护。
3. **事实分离**：`web_notify`（fallback observation）、Queue ACK、`turn_started`、
   Master Accepted 分别记录，互不替代。
4. **Late Wake Compensation**：独立可审计补偿事实，不改写历史、不重跑 Worker，仅限明确
   未提交 Queue 的 Operation。
5. **Console link 与 Auto Wake 设置**：receipt 返回验证过的 Task Console Deep Link；
   Auto Wake 默认开启，可在 WebUI Settings 关闭；无人值守验证可用
   `ZCODE_BRIDGE_TASK_CONSOLE=off` 关闭 Console 自动启动。
6. **Cost Lab 清理修复**：隔离验证不再拉起常驻 Console 进程（此前 Windows 收尾 EBUSY）；
   MCP 生命周期 fixture 同样显式关闭自动启动。

## 验证摘要

- 完整 `npm test`：`PASS`（1132 tests / 1130 pass / 2 platform skip / 0 fail）。
- Preview.15 数据库隔离副本无感升级：39 Tasks / 42 Attempts / 482 Operation Events /
  4341 Runtime Events 保留；Binding 回填 `legacy_unavailable`；连续 open 与并发写者下
  open 零写入。
- `check:generated`（14 文件）、typecheck、build、`validate:plugin` 均 `PASS`。
- 真实安装制品 + 真实 Codex Host + 真实 ZCode Runtime 的非空工程 Auto Wake E2E：
  `PASS — REAL`，详见 [preview16-real-host-e2e-20261124](preview16-real-host-e2e-20261124.md)。
- 环境性偶发：run `45437517317` 的 Cost Lab 在 Windows hosted runner 上
  `executor owner requires an exact process identity`（PowerShell 进程身份探针）；
  同代码 job 在 run `45436131632` 已 SUCCESS，rerun attempt 2 SUCCESS，最终提交全绿。

## 制品验证

- ZIP 根目录为插件结构，56 个文件；`plugin.json` 与 `.codex-plugin/plugin.json`
  均为 `2.0.0-preview.16`，entry 名统一使用 `/`。
- `dist/bridge.mjs` SHA-256 `983e3ae9b3c7b38eabe85b2f796eee502abaa1fd420c427dcc491e287875de71`；
  `worker/worker-main.mjs` SHA-256 `823b676811c9a09c721fba3a8ed6650f6c465ee66d75d265d9bc2a40fd26a53b`，
  与本地构建一致。
- 解压后隔离 stdio Smoke（`launch-node24.mjs`，`ZCODE_BRIDGE_PLUGIN_MODE=1`）：
  `initialize` 返回 `codex-zcode-bridge 2.0.0-preview.16`，`tools/list` 注册 13 个工具。
- ZIP 边界核查：无 `.run`、无本地数据库、无私钥材料、无个人绝对路径。

## 未验证边界

- Desktop fully exited、notLoaded、严格 Wake C/D、Official Runtime provenance、真实模型
  Skill 遵循率与付费 A/B 为 `NOT_RUN`。
- 真实 Host E2E 的隔离 `data_root` 未预建 `state` 子目录，使用了一次
  `task-cli executor start`；不属于 Wake 或人工 Composer 干预。
- 未对 R10 做补偿，未重新派发 R10。
