# Preview.15 最终集成验证记录（2026-11-24）

> Status: RESEARCH（验证证据记录）
> Date: 2026-11-24
> Candidate: `codex/final-integration-20261124`（本文写作时的候选 HEAD 见下）
> 环境: Windows 11 x64、Node `24.16.0`、官方 ZCode Desktop `4.0.0.10870`（build `3bc8a247`）、真实登录 Coding Plan 账户

## 一、零模型 Protocol Smoke（REAL / PROTOCOL_PASS）

入口：`tools/cost-lab/official-app-server-protocol-smoke.mjs`（随包 Official Host 模块 + 安装版 Runtime）。

| 事实 | 值 |
|---|---|
| installation_safety | `OFFICIAL_INSTALLATION_SAFE` |
| runtime_status | `OFFICIAL_RUNTIME_UNVERIFIED`（Manifest 诊断位；ADR-054 下不阻断） |
| desktop_version / build | `4.0.0.10870` / `3bc8a247` |
| installation_fingerprint | `1493db78e05a3bf53b98aaf8319b0f7a95ab8664a6b5bf5b7477f0f39ffad38a` |
| bundle_sha256 | `0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19` |
| 结果 | `PASS`：协议初始化、`runtime/capabilities`、真实进程启动与受控退出（code 0，terminationKind=expected），model_requests=0 |

证据文件：`.run/verification/protocol-smoke-4.0.0.json`（会话内产物，未入库）。

## 二、真实任务 E2E（REAL）

入口：随包制品 `plugins/codex-zcode-bridge/dist/executor.mjs`（真实部署形态）→ 真实 Worker（随包 bundle）→ Official Adapter → 安装版 4.0.0 AppServer → 真实模型回合。无合成 Adapter。

- 任务：在空白工作区写入含指定唯一行的 `e2e-marker.txt`；不运行测试。
- Provider/Model：`account:bigmodel-individual-coding-plan` / `GLM-5.3`（账户 entitled，runtime-auth 头真实注入，executor 日志留痕）。
- 生命周期事件序列（SQLite 持久）：reserved → launch_intent → launch_receipt → claim_committed → model_selected → session_ready → **turn_started（原生事件）** → model_tool_call ×2 → tool_status ×8 → model_output ×3 → turn_completed → report_ready → result_committed → cleanup_pending → cleanup_verified → released → observation_recorded。
- Result：`completed`，summary 如实描述文件内容与字节数；`files_changed=[e2e-marker.txt]`；session `sess_14b476f2-…`（真实官方会话）。
- 工程产物：`e2e-marker.txt` 内容与要求逐字节一致（marker_matches=true）。
- Wake：该 Authority Root 无 Owner 授权的 wake policy，Release 通知按合同落 Web Notify 回退路径。
- 收尾：Executor 空闲关停 `{"status":"accepted","blockers":[]}`（租约正常释放）。

判定：**REAL PASS**（Result/Cleanup/Release/工程产物全链路）。

已知边界：脚本末尾 `client.close()` 的 harness 笔误不影响任何验收判据（判据全绿后抛出）；Turn-level 会话订阅与目录读取在真实回合内完成（session_ready/model_selected 持久化即证据），未单独断言反向请求能力清单（以 4.0.0 官方协议 Smoke 与真实回合为覆盖）。

## 三、定向测试验证（开发期门禁）

- PR #135 树：121 项受影响测试 PASS；`check:generated`/`validate:plugin`/typecheck PASS。
- 合并候选受影响集（批次 3）：419 PASS；2 项失败均已归因并修复后复验：
  1. `formal MCP lifecycle…`（断言依赖已被退役的 ACK 伪造 `turn_started`；fixture 补发原生 `turn.started` 后按真实合同复验）。
  2. `Task CLI keeps full Results off stdout…`（测试桩未镜像 Executor 侧摘要投影；更新桩后 10/10 PASS）。
- 新增故障注入套件全绿：`turn-lifecycle-truthfulness`（8）、`executor-lease-spawn-fence`（4）、`release-wake-recovery`（6）、`result-readback-integrity`（4）、`status-updated-at`（1）、`task-prompt`（17）、`mcp-server`（29，含 ADR-056 分页与有界文本通道）。
- 完整矩阵（Windows 双分片、Ubuntu、SQLite 矩阵、压力）由 Release Gate CI 承担，见发布记录。

## 四、修复过程中发现并处理的额外缺陷

1. **会话环境泄漏**：在 ZCode Desktop 代理 Shell 内运行真实 Worker 测试时，继承的 `ZCODE_DATA_BASE_DIR`/`ZCODE_WINDOWS_APP_INSTALL_DIR` 与 fixture `ZCODE_HOME` 冲突（CI 无此环境故未暴露）。已让相关 fixture 显式剥离。
2. **fixture 描述符不完整**：loopback 安装描述符缺 `installation_safety`，命中 ADR-054 工厂门禁的 undefined≠SAFE 分支。已补全。
3. **turn_accepted 持久化越界**：将 `turn_accepted` 加入 Worker 运行时事件白名单会越过 `runtime_task_events` 的冻结 SQL CHECK；已回退为仅内存事实（受理时间由 Result 的 `rpc_accepted_at` 承载），不改 SQLite schema。

## 五、NOT_RUN / 未测量

- 真实模型 Skill 遵循率、Provider Prompt Cache 收益、真实付费 A/B：**未测量**。
- 严格 Wake C/D（not-loaded）、Desktop 完全退出恢复：**NOT_RUN**（沿用 Preview.14 边界）。
- 跨机器制品复现：**NOT_VERIFIED**。
