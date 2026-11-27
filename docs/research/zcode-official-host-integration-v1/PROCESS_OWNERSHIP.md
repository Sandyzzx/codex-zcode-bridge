# G3：进程所有权

> Status: RESEARCH — OFFICIAL PROCESS MANAGER OWNERSHIP IMPLEMENTED / RESOURCE CLOSURE PARTIAL
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 `OfficialHostAdapter`、ProcessManager wrapper、Worker cleanup、完整回归和性能证据
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream `b95ebaff` / 3.18.0

## 所有权表

| 进程/资源 | 正常所有者 | Bridge 独立验证 |
|---|---|---|
| Worker | Bridge Manager spawn/claim/lifecycle | exact OS identity、exit、recorded tree |
| Official Host module | Worker 内普通模块 | bundle/entrypoint/BOM verification |
| AppServer root | official `ZCodeAgentProcessManager` | runtime root PID/fingerprint，close 后 claimant scan |
| Windows runtime-host helper | official ProcessManager | helper path 与 Worker-tree scan |
| 工具后代 | AppServer/官方 runtime | exact Worker-root recorded-tree / resource facts |
| Browser/MCP 等外部资源 | 各自 Bridge/official service | 现有 resource facts |
| Task/Claim/Result/Hold/Release | Bridge SQLite Authority | 与进程管理分离 |

## 正常生命周期

`OfficialHostAdapter` 使用固定 `official-host-runtime.mjs` 构造官方 `ZCodeAgentProcessManager`。Manager 用匹配 Node 启动固定 AppServer，helper 路径通过受控环境传入。`useSharedTaskRuntime` 固定为 false；一个 Worker 的执行 Runtime 不与无关 Task 共享。

Adapter 在启动后读取 official runtime identity，并用 Bridge process probe 获取 exact fingerprint；再次读取 official identity 确认 PID/identity 未变后才登记为 runtime root。普通请求、close 和 Cancel 都由同一 client/manager handle 执行。

## 关闭

正常 close 顺序由官方 ProcessManager 处理 workspace 与全部 managed processes。Bridge 随后：

1. 检查 manager residual process count；
2. 使用登记的 root PID/fingerprint 扫描 recorded tree；
3. 要求 scan clean、无 live PID，且观测集合包含原 root；
4. 生成 scan evidence digest；
5. 交给现有 Worker/lifecycle Cleanup 与 Release CAS。

官方 close error 不被吞掉；`close` diagnostic 同时保留 stage、错误码、manager residual count 和 tree-scan status。

## 异常边界

- Root 已退出不代表后代已清理；仍执行 claimant scan。
- 树中有 live claimant、scan timeout 或 evidence incomplete 时保持 Hold。
- PID reuse 由 fingerprint/creation identity 阻挡。
- 未知 Hold 不因 adapter 对象消失、Manager 重启或新对象重建而自动解除。
- 需要终止 live tree 时继续使用 ADR-009 identity-bound Windows cleanup。

## 验证

- loopback Mock 性能路径每个 official run 都观察到 root + helper，shutdown 后为 0。
- official focused suite 覆盖 exact root capture、foreign entrypoint rejection、clean/live/incomplete scan、close failure retention 和 adapter-not-started proof。
- current official-host/plugin/platform suite 32/32 与 focused contract 64/64 通过；最终完整隔离回归 936 项无失败。

## 缺口

完整 Windows Job/native helper、工具后代、Browser、可选 MCP/插件、异常终止 timing 与长时间资源泄漏矩阵仍为 `PARTIAL`。一般 Desktop Main 独立性为 `NOT_RUN`。真实任务资源行为未执行。
