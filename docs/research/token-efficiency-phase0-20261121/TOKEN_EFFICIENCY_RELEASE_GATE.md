# Token Efficiency 发布门禁

> Status: RESEARCH
> Last updated: 2026-11-21
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `1c1704aa35470b4555a727ef2ce0d071fef61576`
> Run: `token-efficiency-20261121-offline-ab`

| 决策 | 状态 | 依据 |
|---|---|---|
| 成本目标 | `INSUFFICIENT_EVIDENCE` | 真实任务结算、Usage、缓存与成功率尚未测量 |
| 真实配对试点 | `BLOCKED` | 预检四项未达标。试点模型请求 0，账单请求 0，新增试点 Provider 支出 0 |
| Preview Ready | `NO` | 候选 Windows/Ubuntu 托管 CI 待执行。真实 Host、调用行为和缓存待测 |
| Stable Ready | `NO` | 需完成 Preview、受支持真实 Host E2E、计费实验、生命周期回归和发布审批 |

本地候选回归：Windows `test:full` 965 PASS、0 FAIL、2 SKIP；SQLite v14
`test:stress` 4/4 PASS；Cost Lab 86/86 PASS；正式 MCP/SQLite Attempt 归属测试
4/4 PASS。提交后 T0 将在最终报告中记录。托管候选 CI、Ubuntu 候选 CI、真实 Host
E2E 与缓存性能仍为 `NOT_RUN`。

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

## 复核与发布

兼容性、独立审查和本地验证见 [审查报告](TOKEN_EFFICIENCY_REVIEW.md)。
GitHub CI `44866949503` 对应冻结 A0，Windows、Ubuntu、两平台 SQLite 压力矩阵
与 Cost Lab 均成功。候选保留为本地分支。候选的托管 CI 状态为 `NOT_RUN`。

2026-11-21 重新核对的 `origin/preview` 为 `a03ace1ca17e43c64256d8739220366f22eb4df6`。
相对 A0 只有 ADR-045 和 Async Executor 架构文档差异。A/B 继续使用冻结的 A0。
Preview 验收需在实际集成 SHA 上完成 Windows、Ubuntu、SQLite 压力矩阵、
真实 Host 和缓存检查，经用户审批后合并。Stable、Tag 和 Release 需要单独授权。

## 回滚

- 撤回 MCP 摘要、Event 归属、描述和对应监控规则时，在回滚分支上依次
  `git revert 1c1704aa35470b4555a727ef2ce0d071fef61576` 和
  `git revert a4219860f98fc54b1e64f9199391a6f03c6caa5f`。首个提交包含生成插件。
- 工件引用指引可单独通过 `git revert 3cefeb9a9` 撤回。
- 以 `npm.cmd run test:affected -- --base <回滚前提交> --t0-only` 检查生成物，
  再按 impact map 完成 MCP/SQLite 和恢复回归。使用原 `zcode_result({task_id})`、
  Attention/Events 和 SQLite v14 证据核对回滚。回滚适用原 v14 数据。
- SQLite 不一致、结果归属错误、证据丢失、重复 Spawn、MCP 兼容退化及明确成本或
  缓存负收益均触发回滚审查。本报告记录回滚方案，尚未执行回滚。
