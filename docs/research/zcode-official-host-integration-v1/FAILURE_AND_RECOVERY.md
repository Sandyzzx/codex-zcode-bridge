# 失败、恢复与 SQLite 升级

> Status: RESEARCH — CANDIDATE FAILURE PATHS / SYNTHETIC EVIDENCE
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 Adapter close states、lifecycle hold、自动 v13→v14 与完整回归
> Verified against: Bridge candidate `8e8966d5` + documentation changes；upstream `b95ebaff` / 3.18.0

## 结论

Execution result、official close result、process exit、Cleanup 和 Release 分别记录。任一成功事实不能替代其他事实，迟到回调不会越过已持久化的失败或 unverified 状态。

## Adapter 与 turn 失败

- Unknown/missing terminal，foreign/duplicate terminal，generation change 和 strict resume mismatch fail closed。
- cancel/timeout 只 close 一次，不再发送 session/send。
- Start Plan entitlement/private-auth 失败在 AppServer 启动前可形成 `adapter_not_started`，原始拒绝原因保留。
- Provider failure 不自动重试或切换 Provider 来掩盖。失败 Result 可以提交，但清理证据仍独立裁决。
- 私有时效 credential 不通过 stderr、事件或诊断泄露；ACK loss/EOF 后不重传。

## 官方关闭失败

`OfficialHostAdapter.close()` 同时返回：

- official close diagnostic（resolved/rejected、stage、error name/code/message、manager residual count）
- runtime root exact identity
- optional recorded-tree scan evidence
- optional close error

Worker/lifecycle 把这些事实映射为现有 proof，同时保留 close failure。若原 Worker exact identity 已退出且 recorded tree/resource facts 完整，clean scan 可支持 verified Cleanup；missing/live/incomplete scan 保持 Hold。

## Manager 重启与崩溃

- 启动 Recovery 只读，不主动清理或 Release。
- running Operation 的 Claim、路径和 Capacity 保留。
- exact Worker exited + claimant scan clean + no unresolved interaction 才可走已有恢复/Release CAS。
- 身份未知、后代存活或树扫描失败保持 occupied。
- committed Result 不自动证明 Cleanup；late close/cleanup 不能改变已发布错误事实。

## SQLite v13→v14

Preview.4 生产 Lifecycle Gate 在 bootstrap lock 内调用 `autoUpgradeV13`：

1. 把 v13 级联复制到 stage。
2. 在 stage 上构造/验证 v14，保留行、event、digest、Hold 与 occupied Attempt。
3. 写入 pending marker。
4. 将原 v13 改为 tokenized backup。
5. 原子发布 v14。
6. 重读验证并清除 pending marker。

测试覆盖首次 rename 后中断、v14 已发布但 marker 未清理、重复调用 idempotent recovery、blocked Hold 拒绝升级且不修改源字节。

直接 Store 打开 v13 仍返回带 `upgrade-sqlite-v14` 指引的错误；自动升级只属于生产 Lifecycle 启动路径。未知 schema、损坏库、writer 活跃或未解释现场继续 fail closed。

## 未覆盖

- 真实生产数据升级演练
- 官方 Host 制品升级/回滚和活跃 Attempt canary
- 全 crash timing、磁盘满、权限错误与防病毒占用矩阵
- 真实账户/network timeout

## 验证

最终完整隔离回归为 936 项、935 pass、0 fail、1 skip；固定 account tests 12/12、frame tests 7/7、stress 3/3 通过。它们仍是合成证据，不代表真实生产恢复已经通过。
