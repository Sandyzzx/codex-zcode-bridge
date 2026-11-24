# Preview.15 发布记录（2026-11-24）

> Status: RESEARCH
> Date: 2026-11-24

```text
RELEASE_COMMIT:       81a1c0cab149493221798cca0122e6117d02145a (preview HEAD at tag)
TAG:                  codex-zcode-bridge-preview-v2.0.0-preview.15 (annotated; peeled = RELEASE_COMMIT)
GITHUB_RELEASE_ID:    456291880
RELEASE_URL:          https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.15
DRAFT:                false
PRERELEASE:           true
LATEST_RELEASE:       codex-zcode-bridge-v1.7.2 (Stable, unchanged)
ZIP_BYTES:            4457423
ZIP_SHA256:           8fec428f867a337810f148e5219fd79ab5a6a050ec48506fcaca6eebd44966d3
                      (本地构建、GitHub asset digest、回下载三方一致)
ASSET_SHA256_FILE:    codex-zcode-bridge-preview-v2.0.0-preview.15.zip.sha256
RELEASE_GATE:         run 45322329025, workflow_dispatch release_gate=true @ 81a1c0ca, SUCCESS
MERGE_PUSH_CI:        run 45319688693 (Windows shard 1/2 首跑因 runner 负载 cleanup 验证超时，
                      同提交同制品 rerun-failed-jobs SUCCESS；Cost Lab 在 91fb44970 同类偶发，
                      rerun SUCCESS)
```

## 制品验证

- ZIP 根目录为插件结构，56 个文件；`plugin.json` 与 `.codex-plugin/plugin.json`
  均为 `2.0.0-preview.15`。
- 解压后 `dist/bridge.mjs` SHA-256 `7494fc72bdb15238ad4029f75b99328ed4cd336ebf9c78d8fa77dd9f3db8516e`；
  `worker/worker-main.mjs` SHA-256 `22a00aa6b82b9db4853441d5859d171a5ea5dfe5a0066857186532061b6aabb8`。
- 隔离 stdio Smoke（`launch-node24.mjs`，`ZCODE_BRIDGE_PLUGIN_MODE=1`）：
  `initialize` 返回 `codex-zcode-bridge 2.0.0-preview.15`，`tools/list` 注册
  13 个工具（zcode_task/status/feedback/result/continue/cancel/events/
  interaction_reply/doctor/model_catalog/default_model 三件套）。
- ZIP 边界核查：无 `.run`、无本地数据库、无私钥材料、无个人绝对路径。

## CI 记录

- PR #137（send-ACK 门禁修正）：全部必需检查 SUCCESS。
- PR #138（权益说明 + ADR-058）：必需检查 SUCCESS；Integration gate 首跑
  两个 Start Plan preflight 测试因旧行为断言失败，已按新合同重写后
  2768dce55 全绿。
- Preview push run 45319688693：首跑 shard 1/2 在 `ADR-031 Gate E1` 的
  Windows cleanup 验证处超时（runner 负载敏感；本地同提交全绿）；rerun
  failed jobs SUCCESS。
- Release Gate run 45322329025（release_gate=true @ 81a1c0ca）：SUCCESS。

## 发布内容摘要

PR #135（ADR-055 派发/Prompt 合同）、ZCode 4.0.0 适配与 ADR-054 授权退役、
ADR-056 Result 回读合同、P1 生命周期整改（Turn 事实边界、Lease Spawn
Fence、Release→Wake 恢复）、P2 精简、ADR-058 套餐政策解耦（折扣/权益
验证不再阻断执行；Cost Lab 仅实测倍率）、套餐权益说明（双语 README）。
详见 [发布准备](preview15-release-20261124.md) 与
[集成验证](preview15-final-integration-verification-20261124.md)。
