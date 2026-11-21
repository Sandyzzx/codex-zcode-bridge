# Token Efficiency 发布门禁

> Status: RESEARCH
> Last updated: 2026-11-22
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `6f814bf8736baa59295e686af8733c88d4202ca0`
> Runs: `token-efficiency-20261121-offline-ab` / `token-efficiency-preview-integration-20261121`
> Hosted CI: `44918089589` on runtime candidate `fafc3f397fced54cbc655a11b50e49b8ad51530e`
> Current Preview base: `450c18afc0c8af2700734399c5aebd87a36df795`

| 决策 | 状态 | 依据 |
|---|---|---|
| 成本目标 | `INSUFFICIENT_EVIDENCE` | 真实任务结算、Usage、缓存与成功率尚未测量 |
| 真实配对试点 | `BLOCKED` | 预检四项未达标。试点模型请求 0，账单请求 0，新增试点 Provider 支出 0 |
| PR #116 Preview | `MERGED` | `450c18afc0c8af2700734399c5aebd87a36df795`；opt-in Summary 与默认完整 Result 已合入，未发布 Stable/Tag/Release |
| Unified Preview Ready | `PENDING_FINAL_CI` | Track A 默认 Event 页与严格 Track E 行政释放保护仍需同一候选的 Windows/Ubuntu/SQLite/生命周期门禁 |
| Stable Ready | `NO` | 需完成 Preview、受支持真实 Host E2E、计费实验、生命周期回归和发布审批 |

集成候选基于 `origin/preview@a03ace1ca17e43c64256d8739220366f22eb4df6`。
Clean install 与 T0 通过，包含 typecheck、build、plugin validation、10 个生成物
freshness 与 diff check；Windows `test:full` 为 965 PASS、0 FAIL、2 SKIP、退出码 0；
SQLite 压力门 4/4 PASS；Cost Lab 86/86 PASS。日志位于
`D:\codex-zcode-bridge\.run\token-efficiency-integration-20261121`。

PR [#116](https://github.com/Sandyzzx/codex-zcode-bridge/pull/116) 以 Draft 创建，
随后仅为满足工作流 `draft == false` 的完整门禁条件而转为 Ready；未合并、未打 Tag、
未发布 Release。它已按 Preview 授权合入为 `450c18afc0c8af2700734399c5aebd87a36df795`。
候选运行 `44918089589` 在 `fafc3f397` 上成功：

| 托管任务 | Job ID | 状态 |
|---|---:|---|
| Verify (ubuntu-latest) | `136887979690` | PASS |
| Windows Verify shard 1/2 | `136887979687` | PASS |
| Windows Verify shard 2/2 | `136887979653` | PASS |
| Verify (windows-2022) aggregate | `136890418225` | PASS |
| SQLite resource matrix (ubuntu-latest) | `136887979695` | PASS |
| SQLite resource matrix (windows-2022) | `136887979678` | PASS |
| Cost Lab tests | `136887980954` | SKIPPED — impact selector did not select hosted Cost Lab |

`full_required=true` 使 Fast PR gate 与 Integration gate 被完整门禁替代，二者跳过不是
失败或通过。Cost Lab 的托管 job 同样未由 impact selector 选中；不得写成托管 PASS。
现有 Cost Lab 的 `86/86 PASS` 来自同一候选的本地运行。发布门禁接受该状态，是因为
候选没有改动 Cost Lab 直接影响面，且本地定向套件完整通过。

本文件中记录的托管 run 绑定 PR #116 的运行时与测试候选 `fafc3f397`。随后只允许仅
文档的 clearance 提交；PR HEAD `5c10c5ba15905ef66dd3a562d48b41a35376410d`
在合并前核对了 CI 和目标分支无漂移。统一候选还必须重新运行 CI，不能沿用该 PR 的
通过结果证明 ADR-039/048 的集成。

## 安装版 Host 观察

- Codex Desktop `26.1117.4957.0` / CLI `0.171.0-alpha.13` 的零成本回环探针确认：
  MCP Result 对宿主同时含 text 与 `structuredContent`，但下一模型
  `function_call_output` 只含 `structuredContent` 和短 wall-time 包装。双通道
  Envelope 不能直接当成实际模型输入。
- 32 MiB Result 经 installed AppServer 直读时，在 16,777,216 bytes MCP 行上限处被
  discard；SQLite 原证据仍在，但 MCP-only 完整原文回读不可用。该限制必须在
  Preview 说明中保留，且不得用于 Stable 的“完整证据可回读”声明。
- 探针未发起 Provider 或计费请求。真实 Provider 缓存读取/写入和费用仍为
  `NOT_MEASURED`。

## 真实请求预检

| 条件 | 独立核验 |
|---|---|
| 受支持 Runtime | 当前仅观察到 `3.19.0.10774`。五个已安装资产的哈希与实验 Manifest 匹配。发布支持要求 `3.18.2.10443` |
| 账户与账单隔离 | Cost Lab 隔离本机 workspace、SQLite 和进程目录，同时复用发现的用户账户。专用 Coding Plan 账户及无干扰之计费周期尚未核实 |
| 请求级归因 | runner 消费 Runtime 转报的 Result/Events Usage，账单按小时桶归集。`model_http_requests` 为 `null`。失败、重试、辅助请求、Codex Master 和晚到结算覆盖不足 |
| 硬预算 | `production-verification-runner.mjs` 与 `web-server.mjs` 在真实派发前没有按请求保留费用的门禁。缺少可核实的独立账户费用上限或能拦截每次请求的等价控制。实验超时和账单对账在请求之后生效 |

试点需要受支持 Runtime、隔离且可归因的模型账户和可执行的 $10 USD 等值上限。
开始试点的技术条件是能在发出每个请求前拒绝可能超预算的使用，或由已隔离的
Provider 账户提供覆盖相同费用的硬上限。上限需计入失败、重试、辅助模型和待结算费用。
预检通过后先执行一对 A0 / B-All，分别记录 Worker、Codex Master 及其他模型。

2026-11-22 只读复核仍为 `BLOCKED`：

| 硬门槛 | 当前事实 |
|---|---|
| Runtime | 本机安装 `3.19.0.10774`；生产 Manifest 支持 `3.18.2.10443`。实验指纹授权不等于受支持发布 Runtime |
| Usage 归因 | Cost Lab 选择单份 Task/Result aggregate Usage，`model_http_requests=null`；辅助、失败和未知请求不能逐请求归属，Codex Master 未接入 |
| 账户/账单隔离 | 执行目录与 OS env 隔离，但复用当前已登录 ZCode 账户、凭据路径和账单身份；没有专用账户与请求身份绑定 |
| Cache | 可记录 cached input，但没有受控冷/热序列、cache namespace、cache write 对账或 Master cache receipt |
| 硬预算 | 没有 USD reservation、持久 spend ceiling、retry reserve 或派发前费用 admission；历史记录存在 `MODEL_REQUESTED` 与结算未知 |

在专用 Provider 硬上限或等价的请求前拒绝机制就绪前不得发起真实 A/B。现有历史也能
证明“先派发、后对账”不能作为 $10 上限：失败、重试、辅助请求和晚到结算都可能留下
未知暴露。预算、未知 Usage 和未结算金额不得归零。

## 复核与发布

兼容性、独立审查和本地验证见 [审查报告](TOKEN_EFFICIENCY_REVIEW.md)。
GitHub CI `44866949503` 对应冻结 A0。集成候选的托管 Windows、Ubuntu、generated
artifacts 与两平台 SQLite 压力矩阵在 `44918089589` 上通过；Cost Lab 使用同候选
本地 `86/86 PASS`。大型 Result 分层仅以显式 `view="summary"` 进入 Preview，
默认 `zcode_result({task_id})` 仍返回完整 Result。

2026-11-22 重新核对的 `origin/preview` 为
`450c18afc0c8af2700734399c5aebd87a36df795`。相对 A0 除 ADR-045、Async Executor
文档外，还包含 PR #116 的 Result/Event 读取投影。统一候选新增默认 Event 页和
Track E，必须重新走独立审查、受影响回归与托管 CI。Preview 合并需当次授权；
Stable、Tag 和 Release 需要单独授权。

## 回滚

- 撤回 MCP 摘要、Event 归属、描述和对应监控规则时，在回滚分支上依次
  `git revert 6f814bf8736baa59295e686af8733c88d4202ca0` 和
  `git revert db1d60431`。首个提交包含生成插件和 ADR 实现部分。
- 工件引用指引可单独通过 `git revert 18e6efd80` 撤回；离线报告和回放脚本可保留，
  不属于运行时面。
- 以 `npm.cmd run test:affected -- --base <回滚前提交> --t0-only` 检查生成物，
  再按 impact map 完成 MCP/SQLite 和恢复回归。使用原 `zcode_result({task_id})`、
  Attention/Events 和 SQLite v14 证据核对回滚。回滚适用原 v14 数据。
- SQLite 不一致、结果归属错误、证据丢失、重复 Spawn、MCP 兼容退化及明确成本或
  缓存负收益均触发回滚审查。本报告记录回滚方案，尚未执行回滚。
