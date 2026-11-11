# ZCode Official Host Integration v1 研究变更记录

> Status: RESEARCH
> Date: 2026-11-11
> Scope: 本目录研究文档与本地候选分支；不是根目录 release-please CHANGELOG。

## 新增

- 增加 ADR-032 目标架构核验和 POC 证据台账。
- 增加固定 ZCode `3.18.0` 源码、CLI/AppServer、自包含 Host module 与 Windows helper 的构建和 BOM 记录。
- 增加官方 ProcessManager/AppServer 的 localhost Mock 运行记录，包括官方 Read、双主 Turn 请求、same-session resume、cancel、usage 和目标 PID 清理。
- 增加 same-profile 双 Worker 合成账户竞争、rotation/CAS、失败隔离和 crash-lock release 记录。
- 增加 Bridge auth/lifecycle 定向回归、性能边界、升级/回滚和最终验收报告。
- 增加 raw-frame、Cleanup Proof、账户协调、Desktop 独立性、native/resource 和 redistribution 的未决项。

## 修正

- 区分 `dispose()` 成功、AppServer/helper 退出、Worker 退出、Bridge Cleanup 和 Release。
- 区分 loopback Mock 的 3 次 HTTP 记录、2 次主 Turn Provider 请求和 `220` Mock usage tokens。
- 保留 independent Companion、新 IPC/业务数据库、平行 RuntimeAdapter、Shared AppServer Pool 和第二套 Recovery 的排除。
- 保留 ADR-030 的 Task-scoped entitlement verdict 与 Private Lease/HANDLE/ACK。
- 账户和 Cleanup 两项草案继续保持 Proposed。

## 未改变

- 生产 Bridge Host/Core、Worker、Manager、SQLite Authority、插件 bundle 和运行配置。
- 公共 MCP 工具/schema。
- 现有 Capacity、Claim、Hold、Recovery、Cleanup 和 Release 合同。
- 官方源码工作区、Desktop 安装和真实生产数据。

## 验证

```text
SOURCE_BUILD: PASS
ISOLATED_PROCESS_MANAGER_R7_R8_R9: EACH_12_OF_12_PASS
BRIDGE_START_PLAN_PRIVATE_AUTH: 33_OF_33_PASS_HISTORICAL
BRIDGE_LIFECYCLE_CLEANUP: 139_OF_139_PASS_HISTORICAL
SAME_ACCOUNT_MULTIWORKER: FAIL
FULL_REGRESSION: NOT_RUN
REAL_MODEL_REQUESTS: 0
REAL_ACCOUNT_REQUESTS: 0
BILLING_REQUESTS: 0
```
