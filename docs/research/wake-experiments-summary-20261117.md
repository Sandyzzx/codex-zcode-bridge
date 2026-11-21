# Wake Experiments Unified Research Summary

> Status: RESEARCH
> Last updated: 2026-11-17
> Last verified: 2026-11-17, 逐份核对三组实验的 `REPORT.md`、`DECISION.md`、`evidence.json` 与原始提交
> Verified against: `origin/preview@02cf2fa92c8235370fe7a883d4c5b30d93a8ab33`（三组实验均基于 `master@295727320cab86b071c23ddddd6e29306fa29e7f`）

## 结论边界

本文统一归档三组真实 Windows Host 研究，不把队列入队、Host 自动恢复、Master 实际执行混成同一状态：

- `MESSAGE_ENQUEUED`：消息或任务只完成了入队。
- `HOST_RESUMED`：Host 为目标 Thread 自动创建了新的 Turn。
- `MASTER_EXECUTED`：Master 实际消费消息、调用工具并产生可核对输出或结果。

三组实验分别验证了不同的 Host 路径，不能互相替代：

- Host Event Wake 验证普通 CLI Queue 与 active-turn MCP Attention。
- Native Agent Wake 验证 Codex 内部 Agent Message 与 `wake_on_agent_messages`。
- CLI Signal-only Wait 验证 active-turn 内阻塞 CLI Waiter，不是 Parent Final 后唤醒。

## 归档来源

| 实验 | Commit | Tree | 原分支 |
|---|---|---|---|
| Host Event Wake | `57624d17e57634ac612be27632caf0d2493db7ab` | `419418be720761408bc7a96c5349152da7593bd5` | `codex/host-event-wake-probe-20261116` |
| Native Agent Wake | `095c82adad9a19df028ac1a0cf0fe1122e02bf38` | `b82bdd278b8bdb4e6302317d63c68552a8cda963` | `codex/native-agent-wake-20261116` |
| CLI Signal-only Wait | `d0b1d2af31f75b091d8e0edbd1d345c57ca47a2f` | `f7b80dd2484896d0a56e554c0ebd40bc0f6898ae` | `codex/cli-signal-wait-20261116` |

共同环境基线：

- Codex CLI `0.169.0-alpha.11.1`
- Codex Desktop `26.1111.2228.0`
- Node `24.16.0`
- Bridge Preview `2.0.0-preview.8`
- 真实 Windows Host；CLI Signal-only 报告记录为 Windows 11 `10.0.26100`，另外两份报告只记录为 Windows local desktop

环境版本存在一项已明确的差异：原始任务资料曾写 Windows 10，而 CLI Signal-only 的实测报告为 Windows 11 `10.0.26100`。本总结不猜测其他实验的具体 Windows 版本；该差异不改变已观测的 Host 生命周期结论，但限制跨版本外推。

## 文件清单与 SHA-256

下列 SHA-256 均按原实验 Worktree 中已提交文件的实际字节计算，导入归档后必须保持一致。

### Host Event Wake

| 文件 | SHA-256 |
|---|---|
| `DECISION.md` | `E0BECEC33AFA1917D02A2FC3F93042687739F1D9EC2785F1B0B5B07CB969C052` |
| `evidence.json` | `76CD86DA000C134323969B184D2B1C16E01E6C9D4CFAB0752D2D1EB17A8405B3` |
| `extract-rollout-evidence.ps1` | `32316FB1E4B5CDA7D1D6BF169E714B5A404773A9FCA83923A00804103D762727` |
| `REPORT.md` | `6BBD7C17A642F8734EB895AFF436BDE822FB520009E39356CCB6DDADBE86CB57` |

### Native Agent Wake

| 文件 | SHA-256 |
|---|---|
| `DECISION.md` | `77A006590C736E9F83A286ED242DCF4A16B8D0D889F09FDB82189BA1F799E485` |
| `evidence.json` | `08E061384FF13FE67E6E63191B073A6FE0BBFDEC393F699F92FB11103CCBDE6B` |
| `extract-native-wake-evidence.ps1` | `F1B1217EA16972D10ED702967BFF07846738DD8450543312C8210617497375D3` |
| `REPORT.md` | `0A7D2BE6E959E9A09B5D603C5C8F260CD91248E29558F64CAD50A420CAA7C11F` |

### CLI Signal-only Wait

| 文件 | SHA-256 |
|---|---|
| `DECISION.md` | `01BA8E01B2D6CBE17C6B24546F8D62FDA865A14BD3E970F3C15D7D19A77D00F1` |
| `evidence.json` | `CE886FF0028FC234B0003355E3D5B355A038A0CE11A2A1B4CF016632A118951B` |
| `isolated-bridge-broker.mjs` | `63C3DFCC096F61A42FB8049239ACFAAF8D22DE70000D6BDEED605CAF1FBD2F58` |
| `isolated-bridge-client.mjs` | `F525036793DA02B2B33AE2CB6896BB8072193D45E375FF7A1AEEEC60BE10DD37` |
| `isolated-bridge-lab.mjs` | `56E5774E8EBA96855A38ABE905AC2B2FD9F195A69E03171CEE0C99016D9E1452` |
| `REPORT.md` | `930AE70CC88CD69F1FCF57BEFF162860534DCF41BE0B0285C0CD4F7D90A2314D` |
| `signal-only-wait.mjs` | `3F60F91D0D6FC8FD28EF0B8A9BE9C1A8DA4F0FC33C7B915A4381B01EEDB0643D` |

Native Agent Wake 原 Worktree 另有未跟踪的 `.native-wake-workspace/`。其中约 133 MB 的官方源码 checkout、空实验 profile 目录和运行缓存不进入归档；`extracted-native-wake-evidence.json` 是由已提交提取脚本和私有 rollout 生成的派生脱敏结果，其事实已汇总到已提交的 `evidence.json`，因此不作为独立必要证据复制。原始 rollout 未被复制。

## 已验证

### Host Event Wake

- `QUEUE_WAKES_TUI = YES`，但只限于已载入且空闲的 TUI。A1 自动产生新 Turn 和唯一 assistant ACK；A2 的未载入 `--resume` 只完成入队并出现 warning；A3 的中断后空闲线程只观察到入队，约 289 秒内没有新 Turn。
- `QUEUE_WAKES_DESKTOP_GOAL = YES`，但只限于已载入且目标已完成的 Desktop `/goal` Thread。外部 `codex queue` 后出现可见新 Turn 和唯一 ACK。
- `MCP_WAIT_RETURNS = YES`。真实 `zcode_events(wait_for="attention")` 在同一 Master Turn 中等待并在 terminal 变化时返回，随后同一 Turn 继续执行。
- Thin Waiter 是只读 SQLite Attention 观察器：C2 实测 terminal/exit `0`，C3 实测 timeout/exit `3`。Waiter 本身不通知 Host；C2 的 Host 恢复仍依赖普通 CLI Queue。
- `TOKEN_SAVINGS_MEASURABLE = NO`。只有不同上下文下的 idle wake 样本，没有同任务、同上下文、同口径的 matched trials。

### Native Agent Wake

- CLI 识别 `wake_on_agent_messages`，默认关闭，可通过进程级 `--enable wake_on_agent_messages` 临时启用；`multi_agent_v2` 不是本机原生 `spawn_agent` 的前置条件。
- Feature OFF 对照中，Parent 先 Final，Child 约 30 秒后完成并发送原生 Agent Message，但没有新 Parent Turn。
- Feature ON 后，Parent 先 Final；Child 完成后发送原生 `FINAL_ANSWER`，Parent 自动创建新 Turn 并输出正确 ACK。没有人工新消息或外部 `codex queue`。
- Parent Final 后，真实原生 Child 在约 30 秒和 120 秒实验中继续运行。长等待实验在 Parent 空闲约 `122.8 s` 后由 Child 原生消息唤醒 Parent。
- 默认 Desktop 普通 Thread 与已完成 `/goal` 均未观察到 Native Wake；启用 Feature 的 Desktop 变体因隔离约束需要全局配置，记录为 `DESKTOP_CONFIG_BLOCKED`。
- 公开 AppServer 未发现 Agent Mailbox 注入入口；`thread/inject_items` 不启动 Turn。外部 ZCode/Bridge Worker 不能直接写 Native Agent Mail。

### CLI Signal-only Wait

- 首次隔离 harness 的 `csow-iso-b1-20261117-a1` 是一次基础设施负结果：真实 attempt 因 `session/setModel` 返回 `-32603` 而 failed，Wrapper 在 terminal 后立即返回，未执行 60 秒等待。这次失败不是成功 B1，也不能归因于 Signal-only 机制或 Host 超时。
- 后续有效 V2 B1 使用独立 profile、SQLite Authority 和真实 ZCode Worker。Task `csow-iso-b1-20261117-b1` 真实等待 `60.744 s`，返回唯一一行 `status=completed reason=terminal`，exit `0`；Result、信号文件和 SQLite 生命周期一致。
- B1 返回后，Master 在同一活跃 Turn 继续调用 `zcode_result`。这是同 Turn 阻塞等待后的继续执行，不是 Parent Final 后的救活。
- 当前实验使用的 `mcp__node_repl__js` 调用在请求 `930000 ms` 时，于 `300014 ms` 以 `timed out awaiting tools/call after 300s` 被 Host 取消。Host 取消后，隔离 Worker 继续运行并最终完成，但 Wrapper 没有再自然返回，Master 只能处理超时错误。
- CLI Signal-only B1、MCP 内部 Attention loop 和 B2 等待窗口内均未观察到额外 Master 模型请求。该观察只说明等待窗口中没有新增 sampling，不等于零计费成本。
- MCP 对照的 3 次 Attention 调用串行嵌套在同一个 `mcp__node_repl__js` Host 调用内，是 signal/timing 对照，不是三次 Master 直接 MCP 调用的 billing A/B。
- B1 与 MCP 对照的可见 Turn token 总量约差 1%，但上下文、缓存、工具数量和诊断步骤不匹配，结论为 `COST_INCONCLUSIVE`。

## 未验证

- Desktop Feature ON 下的 Native Agent Wake 和 Desktop Goal Native Wake。
- Native Subagent Wrapper 接入真实 ZCode Whole Task，包括结果 schema、取消、重复、迟到消息和 Parent re-finalization。
- 1～4 小时原生 Child 生命周期、Agent 并发槽占用和长期恢复。
- 三组方案的真实计费成本差异。
- CLI Signal-only 相比 Master 直接 MCP 轮询的可归因 Token 节省。
- Interrupt 和 Plan Mode 对 Native Wake 的运行时抑制；目前只有源码 `DOCUMENTED` 证据。

## 决策

| 路线 | 决定 | 理由 |
|---|---|---|
| MCP Attention | **KEEP** | 有界 active-turn 等待已通过真实 Host E2E，返回后同 Turn 可继续；它不是 idle wake。 |
| CLI Signal-only 长等待 | **NO-GO** | 当前 `mcp__node_repl__js` 约 300 秒生命周期不能覆盖 Whole Task。 |
| CLI Signal-only 短任务路径 | **不进入生产，保留研究** | 60 秒成功只证明短等待可行；必须保留超时检测、MCP 回退和 SQLite Result 核对。 |
| Thin Waiter + Queue | **NO-GO** | Queue 注入为 `role=user`，resume 可能 exit `0` 但不恢复，interrupted 状态只入队，且没有重复/取消/迟到安全合同。 |
| Native Subagent + Wake | **RESEARCH CANDIDATE** | CLI Native Wake 语义最接近长期候选，但必须包装真实 ZCode Worker，增加 Child 模型调用、Token 和 Agent 槽；Desktop 启用态与长期生命周期未验证。 |

当前主要阻断是 **Host 生命周期与可靠恢复**，不是 SQLite 轮询的计算成本。减少进程内轮询不能消除 Parent Final 后的恢复问题，也不能把 300 秒级工具调用扩展成 1 小时 Whole Task。

## 四方案问题

| 判定 | 结果 |
|---|---|
| `QUEUE_WAKES_TUI` | `YES`，仅 loaded idle；unloaded/interrupted 不成立 |
| `QUEUE_WAKES_DESKTOP_GOAL` | `YES`，仅 loaded completed-goal idle |
| `MCP_WAIT_RETURNS` | `YES`，active Master Turn |
| `TOKEN_SAVINGS_MEASURABLE` | `NO / NOT ESTABLISHED` |

## Thin Waiter `--notify-codex` 建议

**NO-GO。** 本轮不实现。只有未来同时具备受支持的 Host 生命周期或 handoff、可靠恢复合同、非 user-intent 的安全通知语义、完整重复/取消/迟到处理，以及可归因成本实验后，才应重新评审。

本轮归档和研究脚本仅用于可复现研究，不接入生产执行入口，不修改 Bridge 生产代码、SQLite Authority、MCP schema、Worker 或 Codex 安装。
