# Preview 2.0 SQLite-only + Start Plan 集成验证

> Status: RESEARCH（本地未提交合并候选证据）
> Date: 2026-11-08
> Verified against: HEAD `4051aa7b4970ac01941ceeb8297b38bf678e9fce` + MERGE_HEAD `190737e14551ae823c77400c694693ab3d863237`
> Result: PASS — 最终索引与受测工作区一致；Windows 全量与 SQLite Stress 通过。历史 R5 失败未复现，根因保持 UNCONFIRMED，按 Owner 决定接受残余风险。

## 合并身份与裁决

- Worktree：`D:\codex-zcode-bridge\.run\preview2-sqlite-only-integration-20261107`
- Branch：`codex/preview2-sqlite-only-integration-20261107`
- HEAD 与 MERGE_HEAD 保持原值；没有 Merge Commit、Push、PR 或 Release。
- 接续时 Git 索引尚有 2 个未合并路径：Bridge 与 Worker 生成 Bundle。两者已由集成源码重新构建并加入暂存索引；最终 unmerged path 数为 0。此前任务描述的 13 个冲突路径均已由现有合并现场解决。
- `bridge.mjs` 与 `worker-main.mjs` 的 Git path-normalized 工作区 hash 与暂存 blob 一致；`upgrade-sqlite-v14.mjs`、`wait-task.mjs` 也在最终 build 后重新暂存。
- 运行架构按 SQLite-only 候选及 ADR-029：单一 SQLite Authority/Lifecycle Manager 和 SQLite Worker→AppServer；未恢复 JSON TaskStore、JSON Manager 或旧 CLI execution chain。
- Start Plan 能力按 Preview 侧集成：加密官方凭据读取、已有身份校验、模型级实时 Billing gate、Provider readiness 预检、私有凭据 Lease、HANDLE 身份门禁、取消/EOF/失败处理。其边界由 ADR-030 记录。
- Gate 2 与既有 R1–R5 生命周期语义和历史证据保留。退休候选报告中的历史测试结果仅作为历史证据，不等同本次集成通过。

## Provider readiness 核验

对照已有修复提交 `d31de9e8528690a8c4a8ef1bc55d3f16e02a07f4` 检查最终 `ZCodeAppServerAdapter`：Start Plan 必须具备实时 entitlement；模型必须存在于官方 Provider registry；构造的 Provider snapshot 必须证明目标 Provider 为 entitled/current。准备失败在启动 AppServer 前返回失败结果。`provider/updateAccountConfig` 拒绝时，Start Plan 在 `session/start`、`session/resume` 和 `session/send` 前终止；运行时凭据回调只允许匹配当前 session/turn/provider/model 的请求。

焦点回归验证了注册失败零 Session/Send、无凭据不落任务/不发 Provider 请求、Billing 拒绝不启动 AppServer/不交付 Lease，以及 Coding Plan 在同样注册拒绝时继续走既有行为。该结论是受控 fake transport 的合成验证，不是真实 Billing 或模型 E2E。

## 新执行验证

环境为 Windows、Node 24.16.0。测试通过隔离执行器使用临时 Home、SQLite、Workspace 与受控 fake AppServer/transport；本次没有读取或修改生产 SQLite、账户凭据、Device ID，也没有发出 OAuth、Billing、Claim、CAPTCHA 或模型请求。

| 门禁 | 结果 | 说明 |
|---|---|---|
| Typecheck | PASS | `npm run typecheck`；全量门禁再次执行 |
| Build / Bundle | PASS | 从集成源码构建 Core、Bridge、Worker、离线升级与 Thin Waiter Bundle；未手改生成文件 |
| Plugin validation | PASS | 结构校验通过 |
| Test Impact selection | FULL_SUITE | `npm run test:affected -- --dry-run` 命中 FULL_SUITE、独立 `SEPARATE_STRESS_GATE`；因此没有再执行 test:affected 的第二套 full suite |
| Start Plan + SQLite focused integration | PASS | 124 tests，124 PASS、0 SKIP、0 FAIL；5 selected test files，隔离串行，528.095s |
| SQLite protocol / Admission / Result / Recovery / v14 upgrade focused | PASS | 138 tests，138 PASS、0 SKIP、0 FAIL；8 test files，74.940s |
| `npm run test:full` / Windows（本轮重跑） | PASS | Node test runner 833 tests：832 PASS、1 SKIP、0 FAIL；Node 测试总时长 1064.475s（17m44.475s）。typecheck、build、Plugin Validation 均 PASS |
| SQLite stress（本轮执行） | PASS | `npm run test:stress`：3/3 PASS；历史增长/WAL checkpoint、Result CAS 竞争、8 路 Admission；8.750s |
| Native Ubuntu / Ubuntu CI | NOT RUN | 当前 WSL 未安装 Ubuntu；本机与远程 CI 均未执行 |
| 真实 Provider / Start Plan E2E | NOT RUN | 未发送真实网络请求 |

## 唯一全量失败：R5 取消后的进程树核验

失败用例为 `R5 explicit cancel closes claimed Result-absent Workers after Manager hard exit and restart`（`test/sqlite-candidate/wp6b-wiring/composition.test.ts`）。MCP 返回 `CANCEL_FAILED: SQLite Worker cancellation could not be verified: cancellation_tree_not_clean`，所以测试未能证明预期的取消、Cleanup 与 Release 闭环。

初次全量结束后按测试名隔离复跑，该单一用例通过（1/1，18.470s）。本轮增加了测试侧的条件失败诊断：仅取消返回错误时输出 scenario、Task/Operation correlation、Worker PID/StartTime fingerprint、取消耗时、Worker 身份 probe、额外 claimant scan 和 SQLite phase/result/capacity/recovery classification。该日志不含凭据或用户资料；没有修改生命周期合同或断言。

本轮复现结果：R5 单例 1/1 通过（约 17.3s），隔离连续重复 3 次均通过（约 17.2–17.6s）；整个 composition 文件 37/37 通过（138.880s）；本轮权威 Windows `test:full` 833 项，832 PASS、1 SKIP、0 FAIL，且 R5 全量串行场景通过（约 19.0s）。因此诊断分支没有触发，当前无法取得原失败场景、失败时 claimant/live PID、helper PID/StartTime 或 helper close receipt。cleanup helper 当前不向调用方暴露自身 PID/StartTime/receipt；失败时附加 scan 只能提供事后观察，不能重建原扫描快照。

结论仍是 `R5_ROOT_CAUSE=UNCONFIRMED` / `R5_CLASSIFICATION=UNKNOWN`。现有证据只说明失败没有在本轮复现；不足以把它归因于产品、fixture、测试环境或 Windows 瞬时观察竞态，也没有依据实施产品修复。没有通过延时、超时、重试或放宽断言消除失败。Owner 已批准停止为追求根因进行无限重复，并以 `R5_ACCEPTED_RESIDUAL_RISK` 接受该未复现风险；这不表示 `R5_FIXED` 或根因已确认。

结束后的只读进程快照没有发现命令行指向本 Worktree 的残留 Node 进程。隔离 R5 测试在 `dist-test/src/sqlite-candidate/wp6b2b1/.wp6i` 留下 UUID fixture 目录和受控 Worker Bundle；没有尝试删除或强制终止进程。该观察不证明失败发生时的树状态。

## SQLite R1–R5 与 Start Plan 状态

- 本轮全量及 R1–R5 SQLite 生命周期测试均 PASS；历史那次全量 R5 失败仍未解释，因此不将其改写为已修复或已证伪。
- 焦点集成覆盖 SQLite composition、真实 Adapter + controlled fake AppServer、Result/Recovery、private auth ACK/EOF/cancellation、Billing/Provider preflight 和 SQLite v14 upgrade。
- 本轮 SQLite stress 3/3 PASS；原生 Ubuntu 及远程 CI 未运行，不能报告跨平台 PASS。
- 所有来源、验证和未运行边界均限于本地未提交合并候选。

## Git 与现场

- 当前 `HEAD`：`4051aa7b4970ac01941ceeb8297b38bf678e9fce`
- 当前 `MERGE_HEAD`：`190737e14551ae823c77400c694693ab3d863237`
- Unresolved conflicts：0。
- 逐项核对 15 个未暂存路径后，按明确 allowlist 暂存集成所需的源码、测试、测试映射、inventory、文档索引与 R5 失败诊断；没有发现需要保护的独立业务 WIP，未使用 `git add -A`。
- 另外 4 个 Windows 过滤器状态项经 path-normalized 工作区 hash 与索引 blob 比对后确认内容未变，仅刷新其 stat-only 状态，没有产生内容修订。
- 重新执行 `node scripts/generate-test-inventory.mjs`，生成 86 个映射文件、778 个声明；随后完成 Typecheck、Build、Plugin Validation。
- Bridge、Worker、SQLite v14 Upgrade 与 Thin Waiter 的 Git path-normalized 工作区 hash 均与暂存 blob 一致；重新构建没有产生额外 Bundle 差异。
- 最终工作区与该轮 Windows 全量所测试的工作区内容一致；暂存这些文件没有改写受测文件，因此复用 833 项全量证据。
- `git diff` 为空，unmerged path 数为 0，`git diff --check` 通过；最终集成报告也纳入暂存索引。
- 没有执行 `git merge --continue`，没有创建 Merge Commit。
- 主工作区及生产 SQLite、凭据、Device ID、Hold 均未触碰。

## 最终裁决

- R5 原有取消、Cleanup、Release 断言未弱化；新增测试差异只在失败路径记录诊断。
- SQLite Cancel / Cleanup / Release 合同保持有效；最新 Windows 全量与 SQLite Stress 通过。
- 当前只读进程检查除查询命令自身外，没有发现命令行指向本 Worktree 的残留 Worker。
- 历史 `cancellation_tree_not_clean` 失败与根因未知继续保留；裁决为 `R5_ACCEPTED_RESIDUAL_RISK`，不是 `R5_FIXED`，也不是 `R5_ROOT_CAUSE_CONFIRMED`。
- `STAGED_WORKTREE_CONSISTENCY=PASS`；可在 Owner 最终确认后创建 Merge Commit。



**PASS；READY_FOR_MERGE_COMMIT=YES。** 最终暂存索引与 Windows 全量受测工作区一致，R5 历史失败未复现但按 Owner 决定以 `R5_ACCEPTED_RESIDUAL_RISK` 接受；根因保持 UNCONFIRMED。SQLite Stress 与 Start Plan 合成回归通过，原生 Ubuntu 仍为 NOT_RUN。没有创建 Merge Commit、Push、PR、Tag 或 Release，也没有发出真实 Billing 或模型请求。
