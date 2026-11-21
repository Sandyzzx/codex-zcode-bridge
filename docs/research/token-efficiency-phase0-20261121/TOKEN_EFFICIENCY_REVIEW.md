# Token Efficiency 独立审查

> Status: RESEARCH
> Last updated: 2026-11-21
> A0: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Implementation: `1c1704aa35470b4555a727ef2ce0d071fef61576`
> Run: `token-efficiency-20261121-offline-ab`

## 独立反馈与修订

Dalton 独立检查候选 Diff、MCP 客户端、持久 Result、生命周期映射及 Cost Lab 预检。

| 审查事项 | 候选处置 |
|---|---|
| Release 需绑定受审查 Attempt | Leibniz 复核发现 Attention 与同页历史 Event 可能属于不同 Attempt。ADR-047 加入显式 `include_attempt`，从 SQLite 行读取既有归属。Skill 筛选当前 Attempt 的事件后匹配 `result_commit_ref`。归属未知时保留占用边界 |
| 全量取证可能失败或读到另一 Attempt | Skill 在已知需要原文时直接选 `full`。已知 Attempt 时传 `expected_attempt`。旧调用格式仍可用，读取失败保留验收未决 |
| SDK 默认协商不足以证明两种协议 | 回归分别将客户端支持版本固定为 `2025-11-25` 和 `2025-06-18`，断言实际协商版本，再验证对象根、原响应、错误和投影 |
| 精简 `zcode_cancel` 的监控指引 | 保留显式授权及终止原 Worker 的提示。通过 Status 核对 Hold，通过 Events 核对 Release |

Leibniz 也复核了回放计量。固定 Attention 调度、一次失败取证补读及 B3 额外原文读取假设均已列入报告。真实宿主的启动、终态补读及模型轮次待测。

## 影响范围

- Manager 的变更限于读取时投影既有 Event Attempt，并将可选字段计入合并及页预算。SQLite v14、存储写入与 CAS、Worker Prompt、Provider 路由及 Host 生命周期执行代码沿用 A0。
- 摘要只读取同一持久 Result。短结果仍传回原对象。大型结果列出省略字段和全部测试声明计数。测试使用当前与旧 MCP 协议并验证完整读取。
- Authority/task 绑定不明时 Skill 使用现有 MCP Attention。薄等待器读取 SQLite，Skill 保留已消费游标并检查当前 Attempt。真实宿主唤醒和调用频率待测。
- 12 个原有 `outputSchema` 均保留。ADR-047 记录 Result Schema 分支和可选 Event 归属。固定目录顺序可复验，Provider 缓存收益待测。

## 验证证据

日志位于候选工作树 `.run/token-efficiency-20261121/`。使用 Windows x64、Node `24.16.0`、npm `11.13.0`。

| 命令 | 证据 | 结果 |
|---|---|---|
| `npm.cmd run test:full`，早期候选 | `test-full-final-windows.log` | `L3b2` 耗尽 40 秒超时，缺少套件退出状态 |
| `node scripts/test-isolated.mjs '--test-name-pattern=^L3b2:' dist-test/test/failure-facts-integration.test.js` | `l3b2-a0.log`、`l3b2-candidate.log`、`windows-attempt-qualified-status.txt` | A0 1/1 PASS，候选 1/1 PASS，未复现超时 |
| `npm.cmd run test:full`，含 Event Attempt 归属 | `test-full-attempt-qualified-windows.log`、`windows-attempt-qualified-status.txt` | 965 PASS，0 FAIL，2 SKIP，退出码 0；Plugin Validation PASS |
| `npm.cmd run test:stress` | `test-stress-attempt-qualified-windows.log`、`windows-attempt-qualified-status.txt` | SQLite v14 WAL/历史、Result CAS、Admission 4/4 PASS；退出码 0。其他压力域不在该 SQLite 门内 |
| 冻结 A0 默认回放两次 | A0 审计工作树 `.run/phase0-20261121-a0/replay-a0-restored-default*.json` | 均匹配冻结 SHA-256 `3f17abf008c5093913282409101577b5adaa9d79c4a0f52326b6386c8f94cff9` |
| `npm.cmd run cost-lab:test` | `cost-lab-test.log` | 86/86 PASS |
| `npm.cmd run build:test` 与 MCP/SQLite 定向测试 | `qualified-build-test.log`、`qualified-mcp-sqlite.log`、`qualified-attempt-events.log`、`qualified-test-status.txt` | MCP 与相关 SQLite 48/48 PASS，正式 SQLite MCP 定向 4/4 PASS |
| 两次 `replay-ab.mjs` | `replay-ab-attempt-qualified-v2.json`、`replay-ab-attempt-qualified-v2-repeat.json` | SHA-256 相同，逐样本数据见 [A/B 报告](TOKEN_EFFICIENCY_AB_REPORT.md) |

`L3b2` 使用本机合成 AppServer 验证 HTTP 429 的有界重试。A0 与候选保持同一断言和
40 秒超时。首次超时根因不确定。独立审查提出的 Event 归属修订由正式 MCP/SQLite
回归验证，包含 Attempt 2 仍在排队以及已提交 Result 但仍由 Hold 保持占用两种时点。
本地 `test:full` 不是托管 Linux/Windows CI。Cost Lab 86/86，正式 MCP/SQLite 定向
测试 4/4。两个 MCP protocol 版本均验证默认调用，目录根维持 object，12 个原
`outputSchema` 全保留。implementation commit 为 `1c1704aa35470b4555a727ef2ce0d071fef61576`。

## 待验证门槛

- 32 MiB Result 可通过配置扩大接收缓冲区的 SDK 客户端回读。实际 Codex Host 能否接收同等原文待验证。
- 如果当前 Attempt 已推进，`expected_attempt` 可阻止误归属。公开 Result 接口按当前 Attempt 读取。验收所需的历史 Attempt 证据应在续作前取得。
- 固定目录哈希的消费者和根据目录生成的客户端类型需要兼容性关注。默认全量载荷已经过新旧两种协议的测试。
- 真实任务的额外模型轮次、恢复率、成功率、缓存和结算仍缺证据。试点使用的 Runtime、账户、Usage 与预算门禁见 [发布门禁](TOKEN_EFFICIENCY_RELEASE_GATE.md)。
