# ZCode Official Host Integration v1 研究变更记录

> Status: RESEARCH
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对实现提交、固定制品、完整回归与 Windows x64 证据
> Verified against: Bridge candidate `ba25f837`；upstream `b95ebaff` / ZCode 3.18.0

## 更新

- 从“生产未接线”的研究状态更新到 `2.0.0-preview.4` 源码候选状态。
- `OfficialHostAdapter`、官方 ProcessManager、exact runtime identity、Worker-tree cleanup proof 和 Release CAS 已进入现有 Worker 路径。
- 固定上游 patch 覆盖 16 MiB raw frame、OAuth refresh coordination 和 runtime-header coordination。
- Preview.4 的生产 Lifecycle Gate 自动执行 SQLite v13→v14 升级，并保留 occupied Attempt、Hold 和中断恢复语义。
- Windows x64 / Node 24.16.0 固定制品可以从固定官方源码重复构建。
- 六个 `@napi-rs/keyring` native closure、license 和 metadata 文件已经进入 Git，不再是未跟踪 WIP。
- 旧 Companion 研究和旧 `ASTRA_REVIEW.md` 已被标记为历史材料；当前候选使用新的独立审查记录。
- 当前候选已由新的独立 Astra review 判定 `APPROVED` / `PR_READY: YES`；旧审查结论没有被复用。

## 当前验证

- `npm run test:affected -- --base origin/preview`：最终候选 936 项，935 pass、0 fail、1 skip，结束标记为 `FULL_REGRESSION_PASS`。
- 较早的 `npm run test:full`：935 项，934 pass、0 fail、1 skip；该基线早于最后新增的 native/Host closure 测试。
- Adapter/Worker 当前定向集合：32/32 pass。
- 路由、SQLite 与完整影响选择定向集合：64/64 pass。
- SQLite real-adapter 重跑：47/47 pass。
- upstream frame：7/7 pass。
- upstream account：12/12 pass。
- SQLite stress：3/3 pass。
- 固定制品同源两次构建：byte-identical。
- 提交后 detached clean checkout：`npm ci`、typecheck、build、plugin validation、Host exports import、keyring native load 与四个原始字节 BOM 记录复验通过。
- Astra 复核实际 diff、BOM、原始 Git bytes、Host/native 加载和 936 项回归；P0/P1/P2 均为 0。
- Host module：1,821,168 bytes，`3F481AAE16EFF9912DAF17178B49491BD64E67C4419BFFDB59EB4B78E85EB537`。
- BOM：7,260 bytes，`B9A7104DAB3B10250CA93899324C0B33966E64C0BE02F279A1353BABBA8F129C`。

## 未改变

- ADR-030 的每任务一次权威 entitlement / Billing verdict。
- Private Lease、HANDLE、ACK、fail-closed 与真实账户请求边界。
- SQLite Task Authority、Claim、Hold、Recovery、Cleanup Digest 与 Release CAS。
- 公共 MCP 工具名与 schema。
- Worker 并发合同。

## 未验证

- 真实 OAuth、账户轮换、模型、Start Plan 和 Billing 请求。
- Official Host 升级到新的上游版本及生产回滚演练。
- 完整第三方资源与逐项再分发法律批准。
- 长时 soak、产品性能和跨平台矩阵。

SQLite v13→v14 自动升级测试只证明 Bridge Authority 的 schema 迁移，不能替代 Official Host 制品升级或回滚。
