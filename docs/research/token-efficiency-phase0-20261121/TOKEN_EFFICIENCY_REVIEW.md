# Token Efficiency 独立审查

> Status: RESEARCH
> Last updated: 2026-11-22
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `6f814bf8736baa59295e686af8733c88d4202ca0`
> Runs: `token-efficiency-20261121-offline-ab` / `token-efficiency-preview-integration-20261121`
> Historical PR #116 CI: `44918089589` on `fafc3f397fced54cbc655a11b50e49b8ad51530e`
> Unified runtime candidate: `fbc1676c`; hosted CI `PENDING`

## 审查轮次

早期 Dalton、Leibniz 审查发现并修订了 Attempt 归属、旧新 MCP 协议协商和监控指引：

| 审查事项 | 处置 |
|---|---|
| Release 需绑定受审查 Attempt | ADR-047 增加显式 `include_attempt`，从 SQLite 行读取既有归属；Skill 筛选当前 Attempt 并匹配 `result_commit_ref`，归属未知时保留占用边界 |
| 全量取证可能失败或读到另一 Attempt | Skill 需要原文时选 `full`，已知 Attempt 时传 `expected_attempt`；读取失败保留验收未决 |
| SDK 默认协商不足以证明两种协议 | 分别固定 `2025-11-25` 和 `2025-06-18`，验证协商版本、对象根、文本、结构化内容、错误和投影 |
| 精简 `zcode_cancel` 指引 | 保留显式授权及原 Worker 终止语义；Status 核对 Hold，Events 核对 Release |

集成分支另做了两路独立只读审查：

| 角色 | 重点 | 结论 |
|---|---|---|
| 架构/兼容审查 | Diff、MCP 合同、SQLite Authority、Attempt、取消、Hold、Cleanup、证据 | 未发现 P0 运行缺陷；回滚 SHA 漂移和 16 MiB 全量回读边界需修正/明确 |
| 成本/实验审查 | 代理 Token、Host 注入、CostLab、Usage、缓存与账单声明 | 27.2% 不是完整任务账单收益；真实 ≥25% 目标仍为 `INSUFFICIENT_EVIDENCE`，付费试点保持 `BLOCKED` |

## 集成审查结论

- A/B 的 27.2% 是双通道 Envelope 加目录代理值，不是实际模型 Token 或账单。安装版
  Codex Host 零成本探针确认：MCP Result 对宿主保留 text 与 `structuredContent`，
  但下一模型请求只含 `structuredContent` 和短包装。结构化通道加目录的代理降幅为
  25.75%，仍主要来自一个大型成功 Result。
- 大代码成功样本减少 25,195 proxy tokens，大于总体净减少 24,651，解释了 102.2%
  的净收益。固定样本中位数仍为 710 → 710；大日志失败增加 522 tokens 和一次完整
  取证读取。没有证据支持普通任务、失败恢复或完整任务账单普遍降本。
- 安装版 AppServer 的 MCP 行上限为 16,777,216 bytes。32 MiB Result 直读被 transport
  丢弃并超时，`host_line_limit_discard` 已记录；SQLite 原证据未丢失，但当前
  MCP-only `view="full"` 无法完成超过该上限的完整回读。摘要作为默认建议不能掩盖
  这一已知限制，必要验收证据缺失时必须保持未决。
- `zcode_result` 的公共 output schema 现在允许 `zcode_output` 或 `projection`。
  默认运行时响应仍是完整 Result，SDK 两种协议均通过；但把 `zcode_output` 视为静态
  必填字段的生成消费者属于源级变化，需在 Preview 说明中明确。
- 真实 CostLab 仍不能覆盖 Codex Master、所有辅助/失败/重试请求、请求级 Usage 和
  可执行的逐请求硬预算，也不能证明专用账户/账单隔离。因此本轮没有发起付费 A/B，
  试点 Provider 支出保持 0。

## 影响范围

- PR #116 的 Manager 变化限于读取时投影既有 Event Attempt，并把可选字段计入
  Summary 合并与页预算。统一候选另按 ADR-039 修改既有 Manager、Lifecycle Gate
  与 SQLite candidate Store 的行政释放资格/证据绑定，并按 ADR-048 约束默认 Event
  页；未新增数据库、Schema 版本或第二状态机。Worker、Adapter、Claim/Cleanup
  正常路径与 v14 表形状未改。
- Result 摘要读取同一已提交 Result。2 KiB 以内返回原对象；较大成功结果可显式请求
  bounded projection；默认 `zcode_result({task_id})` 仍返回完整原对象。
- 工具名、注册顺序和 12 个既有 `outputSchema` 均保留。ADR-039 为
  `zcode_status` 与 `zcode_cancel` 增加可选 `dispatch_blocker`，目录代理为
  7,747 → 7,729（−0.23%）；此前无 Track E 的 B5 单独描述缩减为 6.1%；
  此前 71.1% 分支主要靠删除 `outputSchema`，未计入本候选。
- B1 没有新增独立成本收益；B3 依赖后续文件读取，短结果不应强制写文件；B4 本轮是
  缓存稳定性对照而非已实现收益。保留这些改动只因合同、取证或可读性价值，不把它们
  计入 25% 目标。

## 验证证据

当前统一集成工作树为
`D:\codex-zcode-bridge\.run\bridge-2.0.0-consolidation-20261122`，Windows x64、
Node `24.16.0`、npm `11.13.0`。回放证据根目录为
`D:\codex-zcode-bridge\.run\bridge-2.0.0-consolidation-20261122-offline-ab`；
安装版 Host 通道与 16 MiB 探针保留在旧集成工作树的 `.run/host-probe/`。

| 命令或探针 | 证据 | 结果 |
|---|---|---|
| `npm.cmd run test:affected -- --base origin/preview --dry-run` | 当前工作树 | 选中 `FULL_SUITE`；随后以 `test:full` 覆盖，typecheck、build、plugin validation、10 个生成物与 diff check PASS |
| `npm.cmd run test:full` | 2026-11-22 当前工作树运行 | 981 PASS、0 FAIL、2 SKIP、退出码 0；Plugin Validation PASS |
| `npm.cmd run test:stress` | 2026-11-22 当前工作树运行 | SQLite/Worker stream 4/4 PASS、0 FAIL、0 SKIP、退出码 0；32,000 events、3,796,910 bytes、`max_writable_length=0` |
| `npm.cmd run cost-lab:test` | `cost-lab-test-integration.log` | 86/86 PASS、退出码 0 |
| 冻结 A0 默认回放两次 | A0 审计工作树 `.run/phase0-20261121-a0/replay-a0-restored-default*.json` | 均匹配 SHA-256 `3f17abf008c5093913282409101577b5adaa9d79c4a0f52326b6386c8f94cff9` |
| 两次 `replay-ab.mjs` | `.run/bridge-2.0.0-consolidation-20261122-offline-ab/replay-ab-integration*.json` | SHA-256 均为 `5e25e373802daec8b019a15403e8819fd5bdc9f037a0257bf97b637f61cdaf99` |
| 安装版 Host 通道探针 | 集成分支 `.run/host-probe/evidence.json`、`requests.jsonl` | 2 个本机回环请求、0 付费请求；模型输入只含 structured marker |
| 安装版 Host 32 MiB 直读 | 集成分支 `.run/host-probe/app-server-large-result.json` | `host_line_limit_discard`，max line 16,777,216 bytes，进程树 cleanup verified |
| 托管 PR CI `44918089589` | PR #116 checks | Ubuntu、Windows 两个 shard 与 aggregate、两平台 SQLite PASS；Cost Lab 未被 impact selector 选中 |

托管 Windows/Ubuntu CI 仅在 PR #116 的旧候选 `fafc3f397` 上执行。Cost Lab
托管 job `136887980954` 为 `SKIPPED`，不能写成托管 PASS；同候选本地 86/86 只证明
现有测量工具行为，不证明真实任务成本、成功率或缓存。统一候选 `fbc1676c` 的托管
CI 仍为 `PENDING`。

## 剩余门槛

- 16 MiB 以上 Result 的 MCP-only 完整证据回读没有可用方案；Preview 必须将其记录为
  已知限制，Stable 不得宣称支持。
- 静态 Schema 消费者需要兼容性接受或迁移说明。
- Master、Worker 与辅助模型的 request 级 Usage、缓存读写、价格、失败/重试和墙钟
  仍为 `NOT_MEASURED`。
- 真实 A/B 需要受支持 Runtime、可靠账户/账单隔离、完整请求归因和可执行的逐请求预算
  上限；当前条件不满足，预算支出保持 `$0`。

结论：当前统一候选的本地全量、压力、Cost Lab 与聚焦实现回归通过；旧 PR #116
托管门禁不能替代本候选 CI。大型 Result 分层以显式 opt-in 进入 Preview；
不得以离线 27.2% 宣称真实成本目标达标。托管 CI 完成前 Preview 建议保持
`PENDING_FINAL_CI`（含 16 MiB 回读与静态 Schema 兼容性限制），Stable Ready 为 `NO`。
