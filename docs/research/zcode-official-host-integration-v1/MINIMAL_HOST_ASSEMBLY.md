# G2：最小官方 Host 装配

> Status: RESEARCH — FIXED HOST ASSEMBLY IMPLEMENTED / MOCK SCOPE
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 fixed host entry、官方 ProcessManager wrapper、资产验证、当前测试和完整回归
> Verified against: Bridge candidate `ba25f837` + documentation changes；upstream `b95ebaff` / 3.18.0

## 结论

候选 Worker 已能加载固定 `official-host-runtime.mjs`，通过官方 `ZCodeAgentProcessManager` 启动 AppServer 0.17.1 与 Windows runtime-host helper，并把 create、subscribe/send、Read roundtrip、resume、cancel、close 和进程清理映射到现有 Adapter。

早期隔离 POC 的 12 项结构化 loopback Mock 断言仍是基础证据；当前源码候选进一步加入 shipped asset verification、exact runtime identity、close failure retention、Worker-tree proof 与 Preview.4 自动 SQLite 升级。所有 Provider 都指向 loopback Mock，没有真实账户或模型请求。

## 固定组合

```text
existing Worker
  -> OfficialHostAdapter (extends ZCodeAppServerAdapter)
    -> official-host-runtime.mjs
      -> ZCodeAgentProcessManager
        -> fixed AppServer 0.17.1
        -> zcode-runtime-host.exe
```

- Artifact scope: Windows x64 / Node 24.16.0
- Host entry: `win32-x64-node24.16.0-zcode3.18.0-b95ebaff`
- AppServer、provider、NOTICE、helper 和 BOM 都有 bytes/hash
- `useSharedTaskRuntime: false`
- `maxFrameBytes: 16 MiB`
- 无独立 Companion、额外 IPC、task DB 或 shared AppServer pool

## 已覆盖行为

- Runtime create 与 session create
- subscribe before one send
- streamed events、usage、model 和 reasoning mapping
- Read tool 二次 provider request
- same-session resume 与 strict session mismatch
- cancel 与 timeout
- unknown/duplicate/foreign terminal fail closed
- process root + helper 观测
- normal close 后 retained tree clean 与 managed process count 0

## 身份与关闭

Adapter 从 official manager 读取 runtime PID/generation/identity，再从 Bridge process probe 获取 exact fingerprint，并二次核对 official identity。close 后 Bridge 独立执行 recorded-tree scan；official close failure 作为独立诊断保留。

## 证据

- `official-host-adapter-current-20261112.log`：32/32 PASS
- `focused-contract-rerun-20261112.log`：64/64 PASS
- `test-affected-final-candidate-20261112.log`：936 tests、935 pass、0 fail、1 skip、`FULL_REGRESSION_PASS`
- performance Mock 的每个 official run 观察到 2 个进程，shutdown 后 0
- fixed build 1/2 与 host module repeatability PASS（1,821,168 bytes，SHA-256 `3F481AAE...537`）

## 未证明

- 一般 Desktop Main 独立性
- 完整 native/resource/tool/plugin/MCP 闭包
- 真实 Provider、OAuth、Account、Start Plan、Billing 或模型
- 跨平台
- 长时间 soak
- Official Host 制品升级/回滚

## 边界

`G2_MOCK_ASSEMBLY_AS_PRODUCTION_E2E: NO`。这不再是“未实现”，也不是“真实生产官方账户已通过”；当前准确状态是候选实现有定向合成证据，发布验收未完成。

当前候选已通过最终完整回归、detached clean checkout 和独立 Astra review。上述边界仍是发布或后续版本门禁，不改变本次固定 Windows x64 工程候选的 PR-ready 结论。
