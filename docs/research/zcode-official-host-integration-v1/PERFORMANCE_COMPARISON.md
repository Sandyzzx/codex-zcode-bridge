> Status: RESEARCH
> Date: 2026-11-11
> Bridge baseline: `9710303397fe2d544c75698f783a8174404b2d51` / tree `a9ec733ac02a22b6d27b7cb150abeaae3020569c`
> Observed upstream: ZCode `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` / `3.18.0`
> Evidence scope: 本文只记录已有隔离运行的实测值、制品大小和请求大小。没有执行 Legacy 与 Official Host 的同条件对比 benchmark。

# G6：性能与资源观测

## 1. 结论

目前没有可支持性能结论的新旧执行链对比：

```text
PERFORMANCE_VERDICT: UNKNOWN
LEGACY_VS_OFFICIAL_STARTUP_LATENCY: NOT_RUN
LEGACY_VS_OFFICIAL_TASK_LATENCY: NOT_RUN
P50_P95_COMPARISON: NOT_RUN
RSS_CPU_COMPARISON: NOT_RUN
THROUGHPUT_CONCURRENCY_COMPARISON: NOT_RUN
TOKEN_OR_COST_SAVINGS: NOT_RUN
FRAME_LIMIT_STRESS_COMPARISON: NOT_RUN
BROWSER_MCP_RESOURCE_FOOTPRINT: NOT_RUN
```

现有数据是隔离组件运行时间和文件/请求体积，不是端到端产品性能。它们不能用于证明官方 Host 更快、更省内存、更省 token 或支持更高并发。

## 2. 观测环境

| 项 | 值 |
|---|---|
| Operating system | Windows x64 |
| Actual build Node | `v24.16.0` |
| Official pinned Node | `24.14.0` |
| pnpm | `10.33.2` |
| Provider | loopback Mock |
| Real model requests | `0` |
| Real account requests | `0` |
| Official source commit | `b95ebaffeab641907b38652f45c1502bd762972d` |
| Official source tree | `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d` |

运行路径没有固定 GPU、系统负载、磁盘 cache、security software 或电源计划。即使同一机器的耗时也只能视为单次 acceptance observation。

## 3. Windows runtime-host acceptance

`.run/official-host-poc/runs/runtime-host-acceptance-r1/acceptance.log` 记录：

| 场景 | elapsed | 解释 |
|---|---:|---|
| graceful | 1500 ms | graceful close acceptance |
| tree | 1921 ms | tree shutdown acceptance |
| root-exit | 31 ms | root exit observation |
| control-loss | 78 ms | control loss acceptance |
| helper-loss | 16 ms | helper loss observation |
| cancel | 156 ms | helper acceptance cancel path |

这些值属于 helper acceptance harness 的场景计时，不是：

- AppServer 冷启动时间；
- 用户 Prompt 首 token 延迟；
- Task 端到端 latency；
- Bridge cancellation 总耗时；
- 生产 shutdown SLO；
- 新旧实现的对比值。

因此不计算平均值、p50 或 p95，也不从单次场景值推导性能回归。

## 4. G2 ProcessManager r7/r9

### 4.1 生命周期 wall time

r7 结构化结果记录：

```text
startedAt: 2026-11-11T11:29:52.830Z
finishedAt: 2026-11-11T11:30:07.255Z
derived wall time: 14.425 s
```

这 14.425 秒覆盖 probe 的 setup、两代 ProcessManager、模型 Mock、官方 `Read`、session resume、cancel 和 final close。它是整个 Mock lifecycle 的观测窗口，不是某一次任务或某个 RPC 的 latency。

### 4.2 进程数量

| 时点 | 观察 |
|---|---|
| generation 1 active | 1 AppServer root + 1 Windows runtime-host helper |
| generation 1 close | managed processes `[]`，目标 PID 集合 `[]` |
| generation 2 active | 1 AppServer root + 1 helper，AppServer PID 已变化 |
| final close | managed processes `[]`，四个已记录目标 PID 均为空 |
| lifecycle counters | spawn `2`，expected exit `2` |

这证明该次运行中正常路径没有留下已记录的 AppServer/helper PID。它不测量峰值进程数、稳态 CPU/RSS，也不证明异常路径、Browser 后代或 MCP 资源没有残留。

### 4.3 Mock 请求体积

`.run/official-host-poc/runs/process-manager-r7/evidence/process-manager-result.json` 记录三个 loopback HTTP 请求：

| 请求 | 用途 | Bytes | 说明 |
|---:|---|---:|---|
| 1 | 首轮 model completion | 44,578 | 向 loopback Provider 发起 |
| 2 | 含官方 `Read` 结果的 continuation | 45,109 | `sawReadToolResult=true` |
| 3 | 标题等辅助请求 | 1,216 | 不是第二个 Agent tool roundtrip |

第二轮比首轮多 531 bytes，这与加入 assistant/tool 消息相关，但不能作为 token 效率或 cache 收益结论。Provider usage 的总 token 为 `220`，也不过是 Mock 固定返回的测试值。

### 4.4 运行时行为观测

r7 观察：

- 21 个连续 replay events；
- 2 个 Provider model requests；
- 220 total tokens；
- 一次官方 `Read` 和第二次模型请求；
- normal close 后 generation 2 使用新 AppServer PID；
- cancel ACK 和 cancelled terminal；
- final close 后目标 PID 为空。

这些行为说明官方路径具备较完整的 Mock lifecycle。它们不是吞吐、延迟或资源效率数据。

当前最新的 r9 在自包含 host module artifact 上重现同样两次主 Turn 请求、一次标题等辅助请求、220 usage tokens 和两代精确 PID 清理；它没有新增可用于产品 latency、RSS 或 CPU 的计时分段。

## 5. 制品体积

两次 clean-build 的 `zcode.cjs` 和 source map 大小不同：

| Artifact | First build | Clean-install rebuild | Delta |
|---|---:|---:|---:|
| `zcode.cjs` | 30,999,438 bytes | 30,998,734 bytes | -704 bytes |
| `zcode.cjs.map` | 57,001,458 bytes | 57,001,106 bytes | -352 bytes |

首个制品：

```text
zcode.cjs SHA256
DF4637F2E31AEDE37DB15B3E4E8D8BE35F59BF756E4EECFFC0A6A6B1EEDB4F2E

zcode.cjs.map SHA256
205404F621D86A0D2B5A30C0A8F1392C4679133917CFC907F9D17D3F627FE29B
```

clean-install rebuild：

```text
zcode.cjs SHA256
5EEEB739E646952D3DD2F1109006C7C0BA56CF2E406B5B8012686C5D1EA3140B

zcode.cjs.map SHA256
91EB5C8F90E46E1B452DCA32120C849B649633EF3672E538FC33CA51347DFF9A
```

体积差很小，但字节身份失败。性能文档不能用体积接近替代构建可复现性，也不能把单文件体积当作运行时 RSS。完整安装目录、共享依赖、副本、source map、notices 和 helper 的磁盘占用尚未形成可比 closure measurement。

固定 runtime-host artifact 的独立观测为：

| Artifact | Bytes | SHA256 |
|---|---:|---|
| `zcode-runtime-host.exe` | 167,424 | `04E1794F8325B3C46D4159420CDD04041E9AFC58516E03FC3DC8E78576EEFC24` |
| `zcode-runtime-host-acceptance.exe` | 190,976 | `33E70B20A430393081920225E6A2848A2F28CB68881B03E97EBF88ADEB8E70A3` |

acceptance binary 不属于生产运行 closure，不应计入产品启动资源。

## 6. 新旧执行链对比状态

| 指标 | Legacy direct app-server | Official Host POC | 对比状态 |
|---|---|---|---|
| Worker startup | 未按同一方法测量 | 未按同一方法测量 | `NOT_RUN` |
| AppServer cold start | 未测 | 只有 lifecycle wall time | `NOT_RUN` |
| Session initialization | 未测 | 未分段测量 | `NOT_RUN` |
| First prompt preparation | 未测 | 未测 | `NOT_RUN` |
| Tool roundtrip | 未测 | 只有 Mock 行为断言 | `NOT_RUN` |
| Cancel latency | 未测 | 只有 helper acceptance cancel | `NOT_RUN` |
| Normal close | 未测 | helper acceptance elapsed | `NOT_RUN` |
| Peak RSS | 未测 | 未测 | `NOT_RUN` |
| CPU utilization | 未测 | 未测 | `NOT_RUN` |
| Concurrent throughput | 未测 | 单 activity POC | `NOT_RUN` |
| Token efficiency | 未测 | Mock 固定 220 tokens | `NOT_RUN` |
| Provider cost | 未测 | 无真实 Provider | `NOT_RUN` |

当前没有可比较的两种生产路径。G5 `OfficialHostAdapter` 尚未存在，不能以 r7 probe 代替同一个 `CodingAgentAdapter` 调用路径。

## 7. 不得从现有数据推导的结论

现有证据不能支持：

- 官方 Host 启动更快或更慢；
- 新路径节省内存；
- 新路径减少进程；
- 新路径提高并发；
- G2 的 14.425 秒是用户任务 latency；
- helper acceptance 的 1500 ms 或 1921 ms 是生产 shutdown SLO；
- 两个 `zcode.cjs` 体积接近代表可复现；
- 220 Mock tokens 代表真实 Provider token 或成本；
- Shared AppServer Pool 会改善性能；
- 增加 cache、Prompt 改写或 headers 优化会降低费用。

## 8. 后续有效比较门槛

进入性能比较前，应先完成 G5 生产候选和必要的 contract tests。有效比较至少固定：

- 同一机器、同一电源计划、同一磁盘与杀毒软件状态；
- 同一 Node 和同一 pnpm pin；
- 同一工作区、同一 Provider Mock、同一 fixture；
- Legacy 与 Official Host 都通过同一个 `CodingAgentAdapter` 和 Worker 外壳；
- 冷启动与 warm path 分开；
- 每场景足够样本数，报告中给出原始 sample、p50、p95 和失败样本；
- AppServer、helper、Browser、MCP 和 Worker 的资源归属分开；
- 超时、cancel、normal close、crash cleanup 分别计时；
- token/cost 只使用真实 Provider usage 时报告；
- 16 MiB raw frame 的超限、接近上限和正常大小分别压测；
- 性能优化不得改变 Prompt、cache、headers 或架构合同。

在这些条件满足前，可提交组件观测数据，但整体性能状态必须保持 `UNKNOWN`。
