# Preview 基线与完整增量审查

> Applicability (2026-11-12): HISTORICAL / SUPERSEDED FOR THE CURRENT TARGET. 独立 Companion 方向已由 [ADR-032](../../decisions/ADR-032-existing-worker-official-host-integration.md) 排除，当前源码候选改为在现有 Worker 内装配官方 Host。正文保留为冻结前研究；其中关于“尚未实现/未构建/未验证”的旧状态只适用于该研究时点，不能覆盖 [当前架构](../../ARCHITECTURE.md)、ADR-033/034 或本仓库的当前证据。

> Status: RESEARCH
> Date / Last verified: 2026-11-12（历史研究截止 2026-11-11）；只读 Git 对象、工作区源码和历史材料核对，未运行产品测试。
> 固定本轮基线：`0b70edbbfb1888666d8d3b97f891a0f943fa3a9e`，tree `1976267addff37bbec61d6a94120a61f8996906b`。
> 旧基线：`52015d12f37011f4d389e07941c31491457611ef`，tree `6a6d8db0731f21817996f3078910ed96091e2d6b`。

## 1. 基线核实

项目根为 `D:/codex-zcode-bridge`。采用 `git rev-parse`、`for-each-ref`、`merge-base`、`rev-list`、`log`、`show`、`diff` 和 `ls-remote --heads origin preview`。没有 fetch、checkout、reset、rebase、stash 或新增工作区。

| 对象 | 实际核实结果 |
|---|---|
| 当前工作区 / master | `aabbb0a959ee234508c62731ed5122f28dfcf5b0`；既有 WIP 保留 |
| 本地 preview HEAD | `372e90622772b070357a278f1da3dea58fa42dee`，所在工作区 `.run/preview-integration`，状态干净 |
| 本地 origin/preview | `372e90622772b070357a278f1da3dea58fa42dee` |
| 远端 preview，只读实时查询 | `372e90622772b070357a278f1da3dea58fa42dee refs/heads/preview` |
| 本轮指定审查基线 | **仍为 `0b70edbb`，未静默替换** |
| 旧→指定基线 | 旧基线是祖先，左右独有数 `0 / 8`，包括三个 Merge commit |
| master→指定基线 | master 是祖先，左右独有数 `0 / 23` |
| 指定基线→本次远端 HEAD | 两个提交；只修改 AGENTS.md，见第 4 节 |
| 官方源码工作区 | `b95ebaffeab641907b38652f45c1502bd762972d` / tree `d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`，干净 |

本轮主要从指定 commit 的 Git blob 阅读。引用 `.run/preview-integration` 的生产源文件时，已核对指定基线与其 HEAD 的源码内容相同；两者差异仅为 AGENTS.md。旧 `.run/companion-runtime-validation-20261111/bridge-source` 仍固定在旧基线，没有移动。

## 2. 八个提交逐项审查

以下列出区间中全部八个提交；平行分支上的非合并提交不应误读为一条线上的执行顺序。Merge 行以第一父提交为参照解释贡献。

| 完整 Commit / 父关系 | 内容与相关文件 | 语义及合同影响 | 对 Astra 推荐的影响 |
|---|---|---|---|
| `d17d2cd819af63190b62e78e44d859352b141f4e`；parent `52015d12` | 归档四份 rc release notes；更新 ARCHITECTURE、SHARED_CORE、ZCODE_RUNTIME、ADR-001/030/索引及历史报告链接 | release notes 为 R100，保留原正文；文档由旧候选口径校正到 Preview.3。补记真实 Desktop surface/build 身份、任务级 Billing verdict 等已在旧基线代码实现的行为；不产生新运行代码 | 拓扑建议不变；必须修正认证和制品迁移前提 |
| `f0ac5f64fe56d390033933581740f48daaa1e36d`；parent `52015d12` | 删除 `src/runtime/durable-file-system.ts`，201 行 | 已读完整删除内容：Windows MoveFileEx/FlushFileBuffers 与 POSIX rename/fsync 的退役 cutover helper。指定基线 src/test/scripts/package 无该符号或路径消费者；当前 Worker Claim/Result/Cleanup 未引用它 | 不影响 Worker Host 组合；不得误判成删除现行 SQLite 持久性/进程清理机制 |
| `ba9bddcffc5f1bb7e3bad67718e1e1152c6191eb`；parent `f0ac5f64` | `test/test-impact-map.json` 删除上述 helper 的一条路径 | 不删除测试、不改断言/预算/执行入口；只是移除失效影响映射。测试选择完整性不因此自动获证 | 不影响推荐；新集成仍需补相应影响映射及实际回归 |
| `12714763d40ef16a07b2dc3b0df8583173659c57`；parent `52015d12` | Skill、delegation-policy、monitoring-and-approval | `auto` 限定已授权只读代码任务；交互从 SQLite `details.params`/raw events 读取，删除旧 JSON full_request 指导，保留授权与未完整读取不得放行边界 | 不改 Adapter 协议；新 binding 必须送入现有 SQLite 交互链，不能恢复旧 JSON 通道 |
| `fda1b9d379043cdf64175dd624256976aabd4aba`；parent `d17d2cd8` | LEGACY_DEAD_CODE_AUDIT_V1、418 行资产清单、静态证据/链接检查；进一步修订架构、Core、ADR-030/031；历史 headless 报告归档标记 | 明确 Preview 2.x 与 Stable 1.x 分离；旧“仅 Coding Plan”不再为当前合同；ADR-030 顶部适用说明优先于历史第 5 条。审计报告同时保留 test-impact 漏选与依赖 advisory 的未关闭项 | Astra 的“第二次新鲜 Billing”表述应纠正；保留 fail-closed、绑定、不跨任务缓存，不能用重构取消权益门槛 |
| `0bf4f098aa59ca8f901c92c3fb527184652666a8`；parents `52015d12`, `ba9bddcf` | Merge PR #74 | 引入 f0ac/ba9 的 helper 与映射删除；没有附加 Worker/Adapter 改写 | 无架构修订 |
| `46f6f26d86f7ad5d82910f2c73b30257ddc760c9`；parents `0bf4f098`, `12714763` | Merge PR #75 | 引入 Skill/交互指导修订；没有修改交互实现或 MCP schema | 采用当前 SQLite 交互指导 |
| `0b70edbbfb1888666d8d3b97f891a0f943fa3a9e`；parents `46f6f26d`, `fda1b9d3` | Merge PR #76 | 合入文档归档、适用性说明与审计材料，完成指定基线 | 推荐拓扑不变，事实/合同口径需更新 |

净差异是 25 个路径、864 行增加/227 行删除（Git diff --stat 口径，含静态清单和归档）；这些数字仅帮助界定范围，以上结论来自实际 diff、符号消费者和调用链审查。

## 3. 最新源码对关键合同的核对

### 3.1 Worker、Manager 与恢复

`src/manager/spawn-worker.ts:49` 用 `process.execPath`、`detached: true` 创建 Worker。`src/store/lifecycle-gate.ts:2025` 起在 workspace use 校验后记录 Launch Intent；重复 Intent 不允许再次 Spawn；随后进行独立 OS launch identity、Receipt 和 Claim 校验，Claim 前不能执行任务。

同文件 `:1949` 的 close 仅 destroy 宿主流、unref Worker 并关闭观察，明确不是 Cleanup evidence。Manager 启动的 alive/exited/unknown 观察不能授权重派或释放；Result 缺失不等于未执行。已有显式 cancel/Recovery 使用持久身份、Claim、recorded tree、交互事实和 CAS。

**收敛要求：**新增官方 Host 服务只能在 Worker Claim 获准、私有执行说明读入后装配。Worker/官方 Runtime 的关闭关系不得反向使主 Bridge 重启成为“任务从未执行”的证据。主 Bridge–Worker 观察断开不自动等于应该销毁所有已运行 Worker；现行 Start Plan 父端私有供给在断联时会失效，这一认证限制也不能被设计图中的 detached 一词抹去。

### 3.2 CodingAgentAdapter、Session 与交互

`src/interfaces.ts:181` 保留 startTask/continueTask/getStatus/getResult/cancelTask。`src/worker/worker-main.ts:445` 当前仍直接构造具体 `ZCodeAppServerAdapter`；`:529` 选择 start/continue，并从 previous result 取得 Session；`:515` 将交互转到持久请求/答复链。

可以沿用现有接口，在具体实现内部调用官方 Agent Service，通过 binding 映射 Session/turn/事件；**不是不改 Worker 就能替换**：当前构造器、具体 outcome/checkpoint、failure facts 和 Cleanup proof 都需接线。无需新 RuntimeAdapter 或新的 IPC。

每个 Activity 绑定 Task/Attempt/Operation、Session/turn、input/generation；`turn.completed` 的 resultType 仍决定 success/cancelled 等事实。Continuation 只能在前 Attempt 已 Release 后复用保存的 lineage 根，不给每 Attempt 新建空库冒充恢复。

### 3.3 Cleanup、Result 与 Release

`worker-main.ts:589` 目前构造三类实际执行证明：identity-bound tree receipt、verified recorded-tree scan，或 Start Plan preflight 在资源启动前拒绝的 adapter_not_started。测试 fake 是单独受控类型，不可用于生产。

`lifecycle-gate.ts:2892` 严格校验 Result 坐标和 exact-key proof union；`:2973` 限定生产 proof source/method。官方 Job 事实目前不在该 union，**不能直接提交**。

当前正常结果路径是：完整绑定 Result frame→校验/commitResult→读取确认持久 Result→等待 Worker close→独立 probe 精确 Worker 身份→recordCleanupEvidence→确认 cleanup_verified 持久化→releaseCapacity CAS。参考 `:2367`、`:2417`、`:2448`、`:2570`、`:2708`。正常路径要求 Worker exit code 0 与 execution proof；异常路径不因为 Runtime 已结束就绕开 Hold。

可选 managed Browser 清理由 Adapter 合并到证明。官方 Job 只覆盖它的成员；Worker 创建的 Browser、Host/native 后台资源不能自动算在 Job 内。官方 dispose、Job empty、Worker exit、Cleanup 和 Release 是五个不同层次。

### 3.4 SQLite Authority

Admission/Claim/Result/Cleanup/Release 仍由当前 SQLite 端口和 v14 数据合同承担。没有新增任务库的需求。官方 Session DB 与必要辅助库可保留，但不复制 Bridge Task/Attempt 状态。Proof 类型适配是否需要数据库 schema 迁移必须在实现前查证，本轮不预判“必然无需迁移”。

### 3.5 认证与启动身份：必须修正的前提

`start-plan-production-auth.ts:489` 的 authoritativeEntitlement 缓存 verdict，并校验 account/provider/model/device/credential digest/expiry；prepare 与 issue 在相同上下文复用它。`:543` 的 issue 仍重新读取身份并拒绝变化；一次性 HANDLE/ACK/交付期限和 Worker 使用期不应混为一谈。

因此 Astra 报告“当前 ADR 要求交付前第二次 Billing”的描述已不适合作为本轮合同；其引用了未附修订的历史正文。**本轮保留 Preview.3 的每 Issuer/Task 一次权威 verdict 语义**，不增加第二次查询，也不删除门槛。不把普通模型选路的非权威探测与授权 verdict 混称一次 HTTP。

现行 launch helper 还依赖 installed app.asar 的版本/build 元数据与 `--surface desktop`。固定源码制品必须使用自己的真实来源和官方配置，未来不能继续默读 Desktop 安装身份。该变化需要 Owner 合同批准并验证模型目录入口与执行入口一致，本轮不切换。

### 3.6 逐文件 blob 核对

下列文件在 `52015d12`、`0b70edbb`、`372e9062` 的 Git blob 均完全相同：

| 文件 | blob at `0b70edbb` |
|---|---|
| src/interfaces.ts | `ed233b1a1ce8c8f0deff4c79bed9e1a87b8c1287` |
| src/worker/worker-main.ts | `dbcf17f8b46fc8ebe570129547c9ef41ee6fc872` |
| src/store/lifecycle-gate.ts | `3e0638f9f472180e1d60a24812561f93d6cf3e53` |
| src/adapters/zcode-app-server-adapter.ts | `abe57bddc325afd4cff5b16b8b6e75d89b5d4ce9` |
| src/sqlite-candidate/wp6c/fake-result-adapter.ts | `25276be58d5111b4bd77927b2ceb547a027d6784` |
| src/runtime/start-plan-production-auth.ts | `e17d73be21647dea3058e6a5d6bde0ca0f8bc706` |
| src/core.ts | `4232d9fd979551c49716155c5b5629c2bab05301` |
| plugins/codex-zcode-bridge/worker/worker-main.mjs | `b2d7629127de35056c99a4773f60088edb6eee64` |
| plugins/codex-zcode-bridge/dist/bridge.mjs | `43e8c6a3a45a91b0047cf9ad857fede82aa9be82` |

这支持“增量未改变这些实现”，不支持“新架构已经跑通”。还核对了 helper 无当前消费者，避免仅用文件未变化代替语义判断。

## 4. 指定基线之后的两个提交

| Commit | 内容 | 增量结论 |
|---|---|---|
| `b3a3bf42a436e074d82e9e5c975a21c352e32dc3`，parent `0b70edbb` | docs: codify preview integration branch workflow；AGENTS.md +8 行 | 规定 master/preview 两长期分支、功能从最新 origin/preview 独立 worktree/临时 codex 分支、PR base preview、验收后稳定线合并和同步 |
| `372e90622772b070357a278f1da3dea58fa42dee`，parents `0b70edbb`, `b3a3bf42` | Merge PR #77 | 仅引入上述工作流，没有运行代码变化 |

这两个提交已做限定增量审查；不要求因此重跑 Worker 架构分析。未来实施须遵守该工作流，并重新查询届时 HEAD；任何再新增代码提交需要增量审查。本轮只写用户指定研究报告，不创建功能分支、工作区或 PR。

## 5. 对上一轮结论的裁决

推荐拓扑无需改动：现有 Worker 内薄官方 Host 是唯一首选候选。需修订的三处是：

1. 认证基线使用修订后的 ADR-030，一次任务 verdict；没有第二次 Billing 的迁移前提。
2. 不能承诺“直接装配即完成”：具体 Worker 构造、交互、proof union 和官方辅助服务仍需实现验证。
3. 共同 Node 需满足实际 SQLite gate `>=24.16.0 <25`；官方源码工具链 24.14.0 不自动满足。详见 [制品边界](D:/codex-zcode-bridge/docs/research/zcode-companion-owner-architecture-convergence-2026-11-11/SOURCE_ARTIFACT_BOUNDARY.md)。

```text
PREVIEW_BASELINE_VERIFIED: PASS
PREVIEW_DELTA_REVIEW: PASS
RECOMMENDED_TOPOLOGY_REVISION_REQUIRED: NO
AUTH_BASELINE_WORDING_CORRECTION_REQUIRED: YES
POST_BASELINE_DELTA: REVIEWED — AGENTS.md only, 2 commits
```

PASS 指只读基线和增量审查完成。历史报告中的测试计数未作为本轮新测试结果；本轮 test/build/Runtime/SQLite/账户请求均 NOT_RUN。
