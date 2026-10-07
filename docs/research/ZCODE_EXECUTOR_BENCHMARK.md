# Executor Benchmark 与成本审计

## 范围与方法

用户授权使用 GLM-5.3-Flash。实际完成 5 类编码任务 × 2 Executor 的成功观察组；另尝试 10 次 Memory 对齐补充组，受网络故障全部没有成功执行终态。不是生产 Bridge 的修改验收，也不是统计显著的通用 Coding 排名。

fixture 为本次新建、可运行的独立 JS 仓库，代表 Bridge 常见逻辑；**不是宣称当前生产代码存在同样 bug**。包含真实 Read/Write/Bash、生成代码、执行测试、独立持有验收。中等功能实现仍只有几十行，不能外推大型真实工程。任务分别为：

| ID | 类型 | 验收 |
|---|---|---|
| T1 | timeout parser 小 bug fix | decimal-string / safe integer 边界；拒绝 hex、指数、符号、空值等 |
| T2 | 新增 path overlap 单测 | 至少 8 个命名单测；POSIX/Windows；额外 mutation 验证 prefix/case/equality 三类错误 |
| T3 | retry 功能 | attempts、backoff cap、不重试、原错误 identity、参数验证与 hooks |
| T4 | cancelled 多文件行为 | 5×5 transition 矩阵、unknown 状态拒绝、报表计数 |
| T5 | aggregation 重构 | 内部共享 helper；公共语义、空输入、缺 usage、冻结输入不变 |

相同 prompt、acceptance criteria、cwd、Git commit、Provider/Flash、low、yolo、OS、4 工具。每次从 fixture 基线 reset；交替执行器次序；禁止网络、安装、delegation、commit（模型 API 网络仍必需）。观察组基线 `30f3a1bee6018ee36aa1c344dea70c586cdf7699`。**未对齐项：Native Memory use 默认开、extraction 关；app-server Memory 整体关闭。** background/Workflow 工具已 deny，MCP/browser 无可用模型工具；标题生成请求在 app-server 编码组关闭。

低档位由会话 snapshot / configured selection 记录，并以专项请求 body 探针核验。观察组旧模型 I/O 受安装版日志轮转，未声称每个原始 request body 都被保存；保留 Provider runtime events 与完整 turn usage。每个 Agent turn 可能含多个 model requests，不能混用二者。

## 成功观察组结果

下表 `N=Native`，`A=app-server`。Token 为 Provider 报告 usage，不是币值；cached input 已包含在 input，不能再加一次。时长为 Runtime `turn.completed.duration`，单位秒。

| 任务 | N requests | A requests | N input / output / total | A input / output / total | N / A cached input | N / A turn 秒 | 验收 |
|---|---:|---:|---|---|---|---|---|
| T1 | 4 | 4 | 16,364 / 730 / 17,094 | 14,316 / 634 / 14,950 | 8,960 / 7,616 | 33.897 / 33.487 | 两边通过 |
| T2 | 4 | 4 | 17,332 / 845 / 18,177 | 15,331 / 844 / 16,175 | 11,648 / 11,392 | 34.783 / 32.461 | 两边 10 单测、3/3 mutants killed |
| T3 | 5 | 6 | 22,908 / 1,628 / 24,536 | 24,678 / 1,632 / 26,310 | 17,280 / 19,648 | 60.586 / 81.229 | 两边通过 |
| T4 | 4 | 4 | 17,328 / 1,005 / 18,333 | 15,382 / 1,008 / 16,390 | 12,352 / 8,512 | 37.008 / 28.230 | 两边通过 |
| T5 | 4 | 4 | 16,706 / 561 / 17,267 | 14,688 / 553 / 15,241 | 12,032 / 10,560 | 29.131 / 27.308 | 两边通过 |
| 合计 | 21 | 22 | **90,638 / 4,769 / 95,407** | **84,395 / 4,671 / 89,066** | **62,272 / 57,728** | **195.405 / 202.715** | 各 5/5 |

本样本 app-server 总 Token 少 6.65%；Native 累计 Runtime turn 秒少约 3.61%，主要来自 T3。样本量、缓存、时序、Memory 混杂使这些数字不支持普遍优劣，也不支持切换默认。

| Run | tool sequence | +行 / -行 | Reviewer quality |
|---|---|---|---:|
| T1-N / T1-A | Read → Write → Bash | 12/1；12/1 | 4 / 4 |
| T2-N / T2-A | Read → Write → Bash | 51/0；53/0 | 4 / 4 |
| T3-N | Read → Write → Bash → Bash | 35/1 | 4 |
| T3-A | Read → Write → Bash → Bash → Bash | 34/1 | 4 |
| T4-N / T4-A | Read → Read → Write → Write → Bash | 23/3；29/4 | 4 / 4 |
| T5-N / T5-A | Read → Write → Bash | 3/2；3/2 | 4 / 4 |

质量分为 Codex **非盲评**：4=good，完成要求、修改范围合理、独立验收通过。T1 两边验证方式不同但语义符合；T2 两边 tests 杀死三种缺陷；T3 都正确保持错误 identity 与 backoff；T4 都覆盖 transition；T5 都引入内部 helper、延续 fixture 紧凑风格。没有足够证据给一边更高分。没有把 worker 自报的测试当独立验收。

每 run 的 sessionId、traceId、promptHash、Git commit、原始 task prompt、mode、完整字段、候选 diff 和独立验证结果在 observed ledger（`benchmark-observed.json`）。该 ledger 与其余原始证据不进入仓库；归档位置和 SHA-256 见 [evidence manifest](evidence/manifest.json)。T1/T3/T4/T5 的 testsPassed=1 指一个独立复合断言检查脚本，不是只有一个断言；T2 是 TAP 单测数量。

## 补充组：配置对齐但执行失败

新的 fixture 基线 `090b0afc708c6e40ba94b7cdd9f03f86406e1fc1`，增加 `.zcode/config.json`：`{"features":{"memory":false}}`。组内继续固定同 cwd / commit / prompt / selection / policy / tools。

两边 System body 哈希相同、4 工具 schema 相同、effort=low：可确认 Memory 是 System 差异来源之一。T1-N 首个 Provider input=3,333，system_prompt=6,910 字符；路径与观察组不同，不能直接逐字符比较到观察组。

之后遭遇 `ECONNRESET` / `ENOTFOUND open.bigmodel.cn`。N 的 T1 在 300 秒 supervisor deadline 强杀；其余返回 `turn.failed` 或非零进程退出。其他 run 的初始 request 多次重试到 attempt=11；没有成功的配对任务终态，完整 Token usage 缺失记 null。T1-N 留下的修改独立验收可通过，但执行没有完成，所以仍排除性能组；T5 未修改代码时基线语义测试能通过，这不满足“完成重构”的验收，已补上 artifact produced 检查。

**这组不合并到成功统计，不据此推断编码质量低、app-server 较贵或 Native 较慢。** 尚不确定断连来源是本机 DNS/proxy、网络还是远端；无需凭错误猜测服务故障。详见 controlled-failed ledger（`benchmark-controlled-failed.json`，位置同上 manifest）。

## Reasoning 配对探针

相同简单任务：求小于 30 的素数总和，禁止工具，两边输出 129。每 run 一个 model request。

| 档位 | N input / output / total | A input / output / total |
|---|---|---|
| low | 3,663 / 25 / 3,688 | 3,157 / 24 / 3,181 |
| high | 3,663 / 89 / 3,752 | 3,157 / 89 / 3,246 |
| max | 3,663 / 89 / 3,752 | 3,157 / 89 / 3,246 |

body 均为相同 Flash，`thinking={type:"enabled"}`；effort 对应档位。low/high/max 的 adapter 映射等价 **CONFIRMED — RUNTIME**。高档 output 在小探针增加，不证明大型编码质量收益。Provider reasoningTokens=0 不代表没有隐藏推理，可能只是未分列。目录默认 max、私有 configured default low、请求值、实际 body 值要分开。未指定 default 的真实用户会话行为 **UNKNOWN**。

## Permission / Memory / 成本拆分

| 成本分量 | 本次证据 |
|---|---|
| 初始化 context | 观察组 Native system 多 2,159 字符，首 request 多 504 input tokens；Memory 对齐可使 system 哈希相同 |
| model request 数 | T3-A 比 N 多一次 Bash 与一次模型请求，这一任务 A 更贵；其余任务相同请求数且 A 较少 Token |
| reasoning | 六次实际 body 映射相同；高档 tiny probe output 更多；编码主组 low |
| replanning / permissions | build CLI 拒绝 Write 后报告 DENIED；app-server 指定文件审批允许后 DONE；均两请求。没有证实必然额外 replanning |
| Workflow | 主组工具禁止；完整 Workflow settle 实验 NOT RUN，源码有生命周期差异 |
| Memory extraction | 主组 N extraction 关 / A Memory 关；开启 tiny probe各一 main request，无抽取记录；不能外推没有后台调用 |
| Subagents | 主组禁 Agent；A childSessionIds=[]；N 没有可查询实时子会话证据，不能填伪造 0 |
| retries | 成功组观测到的 request attempt>1 数为 0；失败组大量网络重试，足以淹没 executor 耗时差异 |
| session resume | A/B 证明有效恢复历史与指定选择；错误 Provider materialization 初始 smoke 确实阻止 CLI执行 |
| usage口径 | main turn、辅助请求、累计 context-cache、session/usage 产品计量不同；详见 Handoff 文档 |

“app-server 更贵”在本次观察组总体不成立。Native 可能在特定任务更省请求，或复用官方 Host 减少配置偏差，这是 **HYPOTHESIS**；更高代码质量仍 **UNKNOWN**。没有金额、CPU、RSS 数据，不能把 Token 总量说成全部资源成本。

## 完整性、修正与复核

所有运行均记录要求的指标字段。未取得的字段保持 null：CPU、峰值内存；N 子会话数量；workflowCount（没有通用可靠活动计数）。toolCallCount 按 toolCallId 去重，不计 streaming / updated 事件条数；retryCount 计已观测 attempt>1 的 request_started，不能等同业务重试 feature。主组 permission events=0、A interaction=0。finalStatus、executionCompleted、acceptancePassed 分开保存。

最初验收 harness 有两个输出解释错误：对 `git status` 使用 trim 导致首条路径截断；Node 24 默认非 TAP reporter 导致 test count 未解析。已改为 trimEnd 与显式 TAP，并从每个已保存 diff/untracked 重建候选、重新独立验收。初始结果只保留在 temp 原始 ledger；交付以复核结果为准。T5 后来增加“产生修改”条件，避免失败运行的基线测试被误当成功。

wallTime 不同口径：N 为 spawn→exit；A 为 session/send→terminal + 1.5 秒观察，不含预创建时间。两者不能直接比较；上述表用 Runtime duration。完整源研究 worker 的 102 个 model requests、6,178,317 tokens 另列为研究成本，不掺入 Benchmark。Codex 主会话 Token 未取得：当前宿主未提供本次调用统计。
