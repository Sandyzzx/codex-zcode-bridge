# Project State

> Status: AUTHORITATIVE
> Last updated: 2026-11-25（Preview.17 候选：ADR-060 Executor 恢复、ADR-061 Master 自治返工、ADR-062 单页 Task Console、ADR-063 Original E 素材）
> Last verified: 2026-11-25，核对四条 Preview.17 工作线的代码集成、真实 Store Continue、真实 Executor 崩溃/恢复与 Worker 保护、Master 确定性策略夹具、真实 SQLite Authority + IPC + HTTP + Chromium 单页 Console（内部标识与缺失字段隐藏、单次未观测汇总、Execution completed 与 Master accepted 分离、Result 合并、单行计数筛选、最多三行任务列表、详情四段、品牌图标字节、动作前置与证据折叠），以及正确图标 blob/validator。Preview.17 完整回归、Windows/Ubuntu CI、安装后图标刷新和真实 Host E2E 在集成阶段记录；严格 C/D、Desktop fully exited、notLoaded、Windows 重启与真实 Queue Wake 仍为 `NOT_RUN`。
> Verified against: `471b1f35`（Preview.17 集成快照；最终候选提交与 CI 结果由交付报告记录）。

当前发布状态：

- Stable `v1.7.2`：Tag `codex-zcode-bridge-v1.7.2`。
- 已发布 Preview `2.0.0-preview.5`：Tag `codex-zcode-bridge-preview-v2.0.0-preview.5`；追加 Official Host、R7 Runtime Events/Usage、v14 兼容迁移与 Administrative Recovery 修复。
- Preview `2.0.0-preview.6`：Owner 已批准发布。支持声明限定为 Windows x64、Node.js `24.16.0` 与已安装的官方 ZCode Desktop `3.18.2.10443`。
- Preview `2.0.0-preview.7`：在 Preview.6 上应用 ADR-038 整改，并修复 CI dispatch 边界与 Events summary 分页。
- Preview `2.0.0-preview.8`：包含 ADR-039 Host 授权取消与新鲜 Cleanup Proof 绑定；支持范围限定为 Windows x64、Node.js `24.16.0` 与已安装的官方 ZCode Desktop `3.18.2.10443`。
- Preview `2.0.0-preview.9`：在 Preview.8 基线上增加 ADR-040 安装版 AppServer、ADR-041 Thin Official Host 收敛、Cost Lab Web、Start Plan 离线审计和正式证据。
- 已发布 Preview `2.0.0-preview.10`：集成 SQLite v13 退役、旧 JSON Authority 提示退役、无引用 ZCode 3.18.0 Patch 清理、历史研究归档、CI 去重/Impact 精化与 Windows 两路分片。SQLite v14 是唯一当前 Schema；Stable 不受影响。
- 已发布 Preview `2.0.0-preview.11`：基于 `origin/preview@f549373404ac137600e89991b99114a4802133f2`，保留默认完整 Result，提供显式 `zcode_result(view="summary")`、默认 32 KiB Event 页（ADR-048）、`zcode_events(include_attempt=true)` 与 `zcode_result(expected_attempt)` 的既有 SQLite 事实归属核对。
- Preview.11 同时包含更严格的 ADR-039 行政释放保护：带 Launch Receipt/Identity 的 pre-Claim 不得释放；`cleanup_unverified` 仅在原 Result 已 `cancelled`、exact identity `exited`、recorded root 已观察、tree scan clean 且 Adapter closure 缺失时行政释放；活动 Worker、live descendant、终止失败与 probe failure 保持占用。`zcode_status`/`zcode_cancel` 以可选字段加性报告 `dispatch_blocker`。
- 已发布 Preview `2.0.0-preview.13`：Tag `codex-zcode-bridge-preview-v2.0.0-preview.13`，发布提交 `8ee7ec93a82c2093dce74707a9d1937c1c567887`。
- Preview.12 对超过 8 条历史 Hold 的 Cleanup/Cancel 消解使用完整事件集合的 count/root 承诺，旧 digest 数组继续可校验；既有 v14 的精确旧 Trigger 可只读打开，并在可写打开时事务内精确升级，`user_version` 仍为 14。隔离 Task89 快照已验证第 9 次观察和重复去重，生产 Task89 未取消、未写入。
- Preview.13 通过 PR #129 移除 AgentReport 的 400,000 字符固定前缀扫描上限，改用有界内存覆盖完整已捕获响应；通过 PR #130 把 ADR-039 行政释放的终态 Result 范围扩展到 `completed`/`failed`/`waiting_for_master`/`cancelled`，并统一使用一个 `zcode_cancel` 用户流程。新释放证据统一绑定原 Result digest/commit、Claim、Worker identity 与 Recovery evidence；旧 `cancelled` 取消证明只作历史读取兼容。
- ZCode Desktop `3.19.0.10774`：仅通过 ADR-042 的 `OFFICIAL_RUNTIME_EXPERIMENTAL` 精确指纹授权完成兼容性探测；不是 Preview.14 的发布支持版本，Coding Plan 倍率仍 `INCONCLUSIVE`，Start Plan 因无 active plan 为 `BLOCKED`。
- 已发布 Preview `2.0.0-preview.14`：Tag `codex-zcode-bridge-preview-v2.0.0-preview.14`，Release commit `8d58e9e377a0c47d2523cd179e9c814139308e4e`，GitHub Prerelease `draft=false` / `prerelease=true`，Latest 仍为 Stable `v1.7.2`。PR #131 的代码基线 `c7bfc28b1112dead95ae4179a00962de76051920` 已合入；Release Prep PR #133 合并后 Preview push CI `45130689135` 的 Windows、Ubuntu、SQLite 资源矩阵和 Cost Lab 均通过。该版本包含独立 Executor、Lifetime Lease、Named Pipe IPC、Thin MCP、Task CLI、Operations Console 与 trusted-local Wake。真实 loaded/idle trusted-local 自动 Wake、Native MCP Result readback、Master 生命周期独立验收和 Desktop visible 为 `PASS — REAL`；严格 C/D、Desktop fully exited、Official Runtime provenance 与非空工程交付验收为 `NOT_RUN`。
- ADR-058（2026-11-24）：套餐折扣/权益验证结果与生产执行资格彻底解耦——Admission/Routing/Selection/Spawn 不再因折扣记录阻断；官方拒绝即真实错误并走正常 Cleanup/Release；Cost Lab 不再默认 0.67 倍率，仅按实测 `effective_extra_ratio` 记录，折扣期望需显式提供。Start Plan/Coding Plan 实现与官方认证全部保留。
- 已发布 Preview `2.0.0-preview.15`：PR #135 的 Whole Task/Staged 派发与 Prompt 合同（ADR-055）、ZCode Desktop 4.0.0 适配与 ADR-054 授权机制退役、P1 可靠性整改（Turn 事实边界、Lease Spawn Fence、Release→Wake 恢复、ADR-056 Result 回读合同）、P2 精简（死代码删除、Status updated_at 修正、Prompt 容量合同、实验 workflow 退役）。
- 已发布 Preview `2.0.0-preview.16`：Tag `codex-zcode-bridge-preview-v2.0.0-preview.16`，Release commit `406c56b848f41823c68a9013f81b645b6b19e0be`，GitHub Prerelease `draft=false` / `prerelease=true`，Latest 仍为 Stable `v1.7.2`；ZIP `4453614` bytes，SHA-256 `bf9dd728ef4e9fdb7f7a1576cbfc90839808f8c555f05148dce2b044afaa0ccf`（回下载一致）。PR #140 的 release-candidate 完整门禁 `45442818848` 与合并后 push 完整门禁 `45444768094` 均 `SUCCESS`。ADR-059：Owner Thread 只取 `ctx.mcpReq._meta.threadId`，Task/首个 Attempt/Binding 同事务持久化；移除 `wake-policy.json` 与所有 Wake 专用授权门禁；Auto Wake 默认开启并可在 WebUI Settings 关闭；Queue ACK、`turn_started`、`web_notify` 与 Master Accepted 分离；历史未投递 Operation 只能走独立 Late Wake Compensation；MCP receipt 增加验证过的 `console_link`。真实 Host 非空工程 E2E：released 后 1 次 Intent → 1 次官方 Queue（message `01a20e01-492d-7381-8027-09e5e076922d`）→ 原 Thread 新 Turn，Master 在新 Turn 内用原生 MCP 回读同一 Attempt 并独立验收。见 [发布记录](reports/preview16-release-20261124.md)。
- Preview `2.0.0-preview.17` 候选（未创建 Tag，未创建 GitHub Release）：ADR-060 增加 Host 请求触发的 Executor Lease 恢复与 Release 事实驱动的 Continue；ADR-061 让 Master 对最终目标独立验收并在普通工程缺陷后自动 Continue/关联返工；ADR-062 把 Console 收敛为单页 Tasks，并将 Runtime/Cost Lab 移入 Diagnostics；ADR-063 恢复 Owner 确认的 Original E 图标母版，并规定 WebUI 顶栏消费同一份 `icon.png` 字节。四条工作线来自独立 Worktree，最终只允许一个集成候选。完整回归、Windows/Ubuntu CI 和合并后 Preview HEAD 由 PR/交付报告记录，不把定向测试、合并成功或 CI 排队写成 Release。
- ZCode Desktop `4.0.0.10870`（build `3bc8a247`）：`OFFICIAL_INSTALLATION_SAFE`，零模型 Protocol Smoke `PASS`；随包制品真实任务 E2E `PASS — REAL`（真实 Coding Plan/GLM-5.3 回合、Result/Cleanup/Release 闭环、工程产物逐字节核对）。Manifest 诊断位为 UNVERIFIED（ADR-054 下不阻断）。见 [verification](reports/preview15-final-integration-verification-20261124.md)。
- Preview.17 的单页 Task Workspace 只保留 Tasks 主导航。Running / Needs attention / Execution completed 使用一行可点击计数；任务列表最多三行并把 Attention 与 execution-completed-not-accepted 前置，不显示内部 Task/工作流标识、完整路径、Usage 或缺失字段。同页详情压缩为 Task header、Problem and actions、Work history、Execution 与默认折叠的 Technical details；Task header 只保留 Attempt、Workspace 简称与 Updated，完整路径按需展开；Attempt 与 Result 合并且不重复标题/编号/状态。Wake / Cleanup / Release / Events 不再占据首屏。顶栏使用发布 `icon.png` 的原始字节，不再使用 `B/` 文字占位。Runtime/成本证据不再占主导航，但底层入口保留在 Diagnostics。Provider settlement 未观测时不创建金额字段，只在 Execution 的未观测汇总中出现一次；不推定为零或预计值。Plan、Discount、Model 与 Effort 独立显示，Master/Worker Usage 在已观测时分栏，不根据模型名或 Start Plan 用量换算。当前 Authority 不提供 Master acceptance 字段；页面不把 execution completed 推断为 accepted。Cost Lab Runner 仍使用隔离 Authority Root 和独立 Executor 进程；通过的是 synthetic Worker/合成账单边界，不提升为真实 Provider、真实 Desktop 关闭或最终发布结论。

## 当前生产架构

- 一个 SQLite Task Authority（Schema v14）、一个 Lifecycle Manager、一条 Worker → 官方 Host 生产链。
- Windows x64 生产 Worker 使用 `OfficialAppServerWorkerAdapter` 与共享 `createInstalledOfficialHostSessionFactory`。固定 Official Host module 提供只读 Start Plan 认证投影，官方 `ZCodeAgentProcessManager` 启动安装版 AppServer；模型目录和任务执行共用 Runtime Resolver、ProcessManager、ProtocolClient、认证回调和 Close 所有权。Bridge 不复制 AgentRuntime、Prompt、Tools 或 Provider。Resolver 先验证安装安全并计算精确指纹；ADR-054 后安装安全是唯一执行门禁，Manifest 匹配降为诊断，未验证版本不阻断调用（`officialProviderCapabilityWarning`），已验证版本由 README 声明。Linux、macOS 与 Windows 非 x64 在 Adapter 构造前以 `unsupported_worker_platform` fail closed；direct stdio 只保留 `ZCodeAppServerTestAdapter` 隔离测试入口。
- 旧 JSON TaskStore/Manager/Worker、CLI Adapter 和 GitWorktreeProvider 已从 Preview 生产执行链退役；ADR-038 进一步删除旧 JSON 导入 Writer、迁移 Result/Event Reader 与不完整迁移收据专用执行方法。旧 JSON 文件不由 Bridge 读取、导入或删除，旧迁移 Task 不再作为当前查询对象。
- Project Ledger、固定人类 Markdown 报告、每任务 Codex Rollout Token 采集和 Desktop task-index 私有写镜像已退役。用户已有 `.agent-ledger` 文件不由 Bridge 修改或删除；SQLite Task Authority 保持不变。
- Result、进程退出、Cleanup 与 Release 是不同事实。官方 close resolved 不能单独授权 Release；exact Worker identity、recorded-tree scan、resource facts、Cleanup Digest 和现有 CAS 仍然必需。
- Attention/Thin Waiter 读取同一 SQLite Authority；`zcode_doctor` 也绑定该 Authority。
- SQLite 支持统一为 `SQLite v14 ONLY`。生产 Lifecycle Gate 保留 Fresh v14、既有 v14、历史迁移记录、Recovery/Cleanup/Release；v13 数据库和未完成升级 Marker 以 `unsupported_sqlite_schema` 非破坏性拒绝。v13 自动/离线升级、冻结 Schema 和升级 CLI 已退役。
- Recovery Observation 不再有固定 8 条额度。相同材料事实的重复观察在 SQLite 事务内去重，材料事实变化仍追加不可覆盖 Event；超过 8 条 Cleanup/Cancel Hold 的消解使用完整事件集合的 count/root 承诺，旧 digest 数组继续可校验。既有 v14 的精确旧 Cleanup Trigger 可由只读 Recovery 读取，只在实际可写打开时事务升级，不提升 Schema Version。
- R7 在同一 v14 Authority 内使用 `runtime_task_events`。Worker 只通过一次性 fd14 提交 Runtime observation；Manager 从持久 Task/Attempt/Generation/Claim 派生绑定，SQLite 负责 sequence 幂等、stale-Attempt 拒绝和统一 public cursor。`zcode_events(view="summary")` 可合并相邻安全模型文本，`zcode_feedback` 只提供机器投影，缓存 Usage 与 Result 共用同一持久事实；Lifecycle Event 与 Runtime Event 仍分开。
- MCP Event 默认页预算为 32 KiB；预算只限制单页输出，不删除 SQLite 历史。消费者必须持续读取 `has_more`/`scan_incomplete`。默认模式允许单条超限 Event 推进 cursor，显式 `max_bytes` 仍为硬预算。已安装 Host 的 16 MiB MCP 行上限下，ADR-056 提供 `zcode_result` 的 `offset_bytes`/`max_bytes` 分页读取：按码点安全的 `next_offset` 翻页，拼接全部 data 的 SHA-256 等于 `result_digest`；大 Result 由此可完整恢复，`okResult` 文本通道超过 1 MiB 改为有界引用。

Preview.7 继承 Preview.6 固定的 ZCode `3.18.2`、commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`、tree `5e90fec80706b8381f94e4eef48cf821b9868916` 和 AppServer `0.17.1`。制品只在 Windows x64、Node `24.16.0` 上完成构建、签名、加载与本地 clean-install 验证；其他 Node 24 patch level 和跨机器复现仍是 `NOT_VERIFIED`。已发布 Preview.5 的 3.18.0 输入作为历史回滚基线保留。Preview.7 的运行时差异来自 ADR-038：删除旧 Runtime 分发资源、退役已退出外围功能、修复 Usage/Context/Events/Recovery 说明与实现、保留 v14 历史字节，并收紧 CI/生成物门禁。

## 套餐与认证

- **Z.ai Start Plan：** Preview.6 消费固定 Official Host 的窄认证投影，再执行实时模型权益检查，并通过单任务 Private Lease 向官方 Runtime 交付认证。Start Plan 与普通模型目录条目分离，使用 `<ModelId>-StartPlan` 别名。
- **Z.ai Coding Plan：** 保留官方 Coding Plan 账户/API Key 路径；Start Plan 预检不改变 Coding Plan 的既有注册和执行语义。所有 Provider 使用安装版官方 AppServer；生产发布仍只支持精确 Manifest 中的 3.18.2，未知安全版本只可按 ADR-042 授权用于实验探测，不声明优惠兼容。
- 所有 Provider 最终都由安装版官方 ZCode AppServer 执行；Bridge 不复制 AppServer 的 Provider 请求构造，也不携带第二套 AppServer Runtime。
- 账户 refresh 使用固定上游 patch 的 profile-scoped lock、lock-time reread、一次远端刷新和 CAS 发布。该协调已由合成竞争矩阵验证；真实 Coding Plan 与 Start Plan 任务已经通过官方认证路径执行。真实 OAuth refresh/账户轮换仍未单独验收；Preview 阶段接受该有限风险，失败路径不得损坏现有凭据或意外切换账户。
- [ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md) 已接受且 Preview.6 已实现：官方 Host 统一拥有凭据解密、keyring、OAuth、账户身份和请求认证，Bridge 只消费当前任务所需的认证投影。生产源码不再包含旧的 v1/v2 AES、Keyring、账户资料、JWT payload 或 telemetry device 解析。真实 Coding Plan 完整 E2E 与 Start Plan 核心功能路径已通过，但历史完整 E2E 因 Workspace 边界保持 `FAIL`；3.18.0/3.18.1 实机安装矩阵仍为 `NOT_VERIFIED`。

Preview.3 的 Start Plan 历史证据覆盖 Windows、官方 AppServer `0.17.1`、Provider `account:bigmodel-start-plan`、模型 `GLM-5.3-Flash`：3 次主 Turn 模型迭代均 HTTP `200`，Write/Read、有效 AgentReport、Result Commit/Cleanup/Release 和每任务 1 次 Billing GET 均被记录。ADR-037 候选在此后另通过了真实 Coding Plan 任务，以及一次真实 Start Plan 核心功能任务：官方 Auth、Billing 门禁、Private Lease、Session/Turn、真实模型、工具、AgentReport、R7 Usage、Result、Cleanup Verified 与 Release CAS 均成功。该 Start Plan 运行因 Workspace 内额外生成 PowerShell module-analysis cache 而保留 `HISTORICAL_FULL_E2E: FAIL`；Harness-only 修复和 Workspace/Cleanup 离线回归已通过，不能把历史 FAIL 改写为 PASS。

## 验证状态

| 能力 | 状态 | 当前证据边界 |
|---|---|---|
| 固定源码/制品构建 | `PASS — CANDIDATE` | ZCode 3.18.2、Windows x64、Node 24.16.0；有序 patch 可重放到实际源码树，构建输出与 BOM 哈希一致 |
| same-source-tree 制品重建 | `PASS` | byte-identical host module；不等于 clean-install 全链路可复现 |
| 16 MiB raw frame | `PASS` | 固定上游 7/7 合成测试，覆盖 exact/+1、partial、UTF-8 与 pending RPC |
| 账户 OAuth/Start auth 合成测试 | `PASS — CANDIDATE` | 固定上游认证套件 19/19；真实账户与网络轮换 `NOT_RUN` |
| `OfficialAppServerWorkerAdapter` 与共享 session factory | `PASS — CANDIDATE` | 固定 Host、Model Catalog、Provider 选择、Adapter、R7、Cleanup/Release 定向套件通过；完整结果见本次候选实现报告 |
| Runtime-selected Provider capability gate | `PASS — CANDIDATE` | 官方 Provider registry + 当前账户配置分类；隐式 Coding Plan、隐式 Start Plan、其他 Provider 与显式 Provider 定向测试通过；真实模型请求 `NOT_RUN` |
| 生产 Official Host Runtime Auth fail-closed | `PASS — CANDIDATE` | Resolver 缺失或拒绝时返回不可用，即使存在合成持久化 Key 也不回包；静态回包仅由 Test Adapter 覆盖 |
| R7 Runtime Events/Usage | `PASS` | fd14 单向通道、v14 additive schema、sequence/cursor、stale Attempt、Feedback/Result 合成与旧 v14 兼容测试通过 |
| SQLite v13 非破坏性拒绝 | `PASS` | 无句柄文件预检、Lifecycle Gate 稳定错误、DB/WAL/SHM 与旧 Marker 原字节保留；完整回归 952/950/2，v14 Fresh/Existing 继续覆盖 |
| 完整 Node/native/resource 闭包 | `PARTIAL` | 6 个 keyring 文件已在 clean checkout 解析、native load 并与 BOM bytes/hash 一致；完整动态资源闭包仍未认证 |
| 正常 cleanup 的 native/resource 闭包 | `PARTIAL` | exact identity、tree scan 与 CAS 有定向证据；一般外部资源和 crash 矩阵未完成 |
| 再分发/许可审查 | `PASS — OWNER_APPROVED_SCOPE` | 官方签名 runtime host 的再分发权利已由 Owner 确认；ZCode LICENSE/NOTICE 与 keyring license 文件进入 BOM；不是独立法律意见 |
| Official Host 制品升级/回滚演练 | `PASS — ISOLATED_WITH_DATA` | Preview.5 SQLite 预置 Task、Attempt、7 条 Operation Events、5 条 Runtime Events、Usage、Hold 与 Result；升级到 Preview.6 再回滚后逻辑行、状态、digest 与 Usage 完全一致，`integrity_check=ok`，外键违规 0 |
| Clean install / supported runtime closure | `PASS — LOCAL_WINDOWS` | 隔离 npm cache 的 clean install 完成 MCP 初始化、13 个工具与 SQLite 启动；BOM 文件与实际包一致；仍不声明跨机器或完整 ZCode 产品资源图 |
| 真实 Coding Plan + Official Host | `PASS` | 此前 R7 候选完成一次真实 Task：模型、工具、Events、Usage、Result、Cleanup、Release 均通过；不替代 Preview.5 安装后验收 |
| 真实 Coding Plan + 安装版 AppServer | `PASS — CANDIDATE` | 构建后 MCP/Worker/SQLite 完成一次真实 Task；22,735 Token、官方 1.7666 credits、正常预期 2.636755、有效额外倍率 0.6699901963。官方账单延迟结算后以同小时 fresh snapshot 对账，无第二次模型请求 |
| Preview.16 真实 Host Auto Wake E2E | `PASS — REAL` | 安装版候选插件 `2.0.0-preview.16` + 真实 Codex Host + 真实 ZCode Runtime，非空交付 `hello.txt`/`verify.mjs`。Owner Binding 为 `bound`/`mcp_meta` 且与 Task/首个 Attempt 同事务；Result→Cleanup→Release 后 1 次 Intent、1 次官方 Queue（message `01a20e01-492d-7381-8027-09e5e076922d`），原 Thread 新 Turn `01a20e01-495a-7d43-98cc-e9febbc75966` 以 Wake 消息起始；Master 在该 Turn 用原生 MCP 回读 digest `9035597…` 并复跑 `node verify.mjs` 退出码 0。Executor 首次启动使用一次 `executor start`（隔离 data_root 的 `state` 子目录未预建），不属于 Wake 或人工 Composer 干预 |
| 未知官方 3.19.0 安装安全检查与指纹授权 | `PASS — EXPERIMENTAL` | Desktop `3.19.0.10774`、Windows x64、Node 24.16.0；EXE/ASAR/Bundle/builtin/runtime-host 完整指纹，Authenticode 官方主体；无授权时 `OFFICIAL_RUNTIME_UNVERIFIED`，匹配授权后仅 `OFFICIAL_RUNTIME_EXPERIMENTAL` |
| ZCode 3.19.0 零模型协议 Smoke | `PASS` | 真实安装版 AppServer 启动，`runtime/capabilities` 成功，Session 未创建，模型请求 0，Cleanup PASS |
| ZCode 3.19.0 Coding Plan 真实执行 | `PASS — EXPERIMENTAL` | 1 次真实 Task completed，18,351 Token；证明该精确安装的模型执行路径可工作，不自动提升发布兼容或折扣 |
| ZCode 3.19.0 Coding Plan 倍率 | `INCONCLUSIVE` | 15:00 官方小时桶前后均零；quota unit 3/6 变化不是 Credits，不能判定 0.67 |
| ZCode 3.19.0 Start Plan | `BLOCKED — NO_ACTIVE_PLAN` | 3.18.2/3.19.0 两次官方 billing GET 均 HTTP 200 且 plans/balances 为空；未发模型请求，不声明兼容 |
| Desktop 3.18.2 兼容回归 | `PASS — SYNTHETIC / REAL E2E NOT_RUN` | 现有精确 Manifest 和 fail-closed 测试保留；本机当前安装为 3.19.0，未声称新鲜的 3.18.2 实机 E2E |
| Start Plan + 安装版 AppServer | `OFFLINE_VERIFIED / LIVE NOT_RUN` | 同一 Bundle 的 Provider、unsigned transport、Gateway 和 Runtime Headers 差异已审计；真实 Start Plan E2E、CAPTCHA、权益与优惠均未验证 |
| Cost Lab Web/API | `PASS — CANDIDATE` | 本地 loopback、显式真实请求确认、官方账单、同小时延迟结算重试、历史和脱敏导出通过 43/43 定向测试；真实请求 1 次 |
| Token Efficiency 离线候选 | `INSUFFICIENT_EVIDENCE` | 大型成功 Result 的 opt-in 摘要可显著降低 MCP 载荷；27.2% 代理降幅主要由单样本贡献，普通样本中位数未改善，失败取证略增。真实完整任务计费降幅、缓存费用与成功率非劣 `NOT_MEASURED` |
| Token Efficiency 真实 A/B | `BLOCKED` | 受支持 Runtime、专用账户/账单隔离、完整请求级 Usage 与逐请求硬预算未同时满足；授权预算下模型请求与新增支出均为 0 |
| 其他 Provider + 安装版 AppServer | `OFFLINE_ROUTED / LIVE NOT RUN` | Provider 选择统一为 `installed_runtime`，未知或无同一安装根资产 fail closed；真实其他 Provider 模型/认证 E2E 未运行 |
| 真实 Start Plan 核心功能 | `PASS — CORE FUNCTIONAL` | 官方 Auth、Billing 门禁、Lease、Session/Turn、模型、工具、AgentReport、R7 Usage、输出、Result、Cleanup/Release 通过 |
| 历史 Start Plan 完整 E2E | `FAIL — WORKSPACE BOUNDARY` | 测试 Workspace 额外出现 PowerShell module-analysis cache；历史结论保持不变，不重新消耗真实任务改写证据 |
| 官方 Start Plan 认证复用 | `PASS — PREVIEW.6` | v1、v2:env、v2:os 只读字节不变，BigModel/linked Z.AI/`zai_cn`、冷进程、Billing 单 verdict 与 Lease 合成测试通过；真实 Start Plan 核心功能路径通过；真实 OAuth refresh 未单独执行 |
| Desktop 3.18.0 / 3.18.1 / 3.18.2 兼容矩阵 | `NOT_VERIFIED / 3.18.2 PARTIAL` | 合成版本上下文覆盖三个版本；本机仅观察到 Desktop `3.18.2.10443`，3.18.0/3.18.1 未安装，不能由源码或合成用例推断实机 PASS |
| 一般 Desktop Main 独立性 | `NOT_RUN` | 合成路径不证明完整资源与身份闭包 |
| Preview.7 发布完整回归 | `PASS — CANDIDATE` | PR #96 Windows 完整回归 913 项：911 pass、0 fail、2 skip；Ubuntu 772 项：723 pass、0 fail、49 skip；Typecheck、Build、Plugin Validation、生成物 Freshness 与 `git diff --check` 通过。见 [CI 43720237853](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43720237853)。只覆盖 Windows x64、Node 24.16.0 |
| Async Executor PR 2–6 历史本地完整回归 | `PASS — HISTORICAL CANDIDATE` | 历史候选 `c75c3433`：1060 tests、1058 pass、0 fail、2 existing skips；注册压力 4/4；生成物 13/13 fresh，插件结构校验通过。见 [统一 RC 证据](reports/async-executor-release-candidate-20261122.md)。该结果不属于当前验收提交 `7f54531a`，也不替代真实 Desktop 关闭或真实 Official Runtime |
| Async Executor Web/real-process acceptance | `PASS — REAL PROCESS + SYNTHETIC WORKER` | PR #131 final integration candidate `7ab652ba`（Web implementation/evidence `02a9e811`，整合 `origin/preview@8ee7ec93`）：定向主集合 92/92 PASS；真实 MCP Host / Executor / Console / Chromium 进程与 synthetic Worker 完成 C1；Host 退出后 Executor/Console 仍 active，原 Attempt Result/Cleanup/Release 各一次、Spawn 一次、新 Host 读回同一 Result。后续 trusted-local loaded/idle Wake 另行通过真实 Queue/Turn/Native MCP readback；Desktop 全退、严格 C/D、Official Runtime provenance 和真实 Skill 遵循率仍 `NOT_RUN`。见 [Web real-process E2E](reports/async-executor-web-real-host-e2e-20261122.md) |
| Preview.14 trusted-local Wake | `PASS — REAL LOADED/IDLE` | 隔离 Host 真实完成一次 Queue、新 Turn、原生 MCP Result readback、Result digest、Cleanup/Release、Master 生命周期独立验收与 Desktop Visible；`wakefinal20261123f`/Attempt 1 各事实均只出现一次。严格 C/D、Desktop fully exited、Official Runtime provenance 和非空工程交付仍未验证。见 [evidence](reports/trusted-local-wake-20261123.md) |
| Preview.16 Owner Binding + Auto Wake | `PASS — REAL` | `_meta.threadId` 身份来源、Task/Attempt/Binding 同事务、A/B/C 并发隔离、Continue/重开保持归属、无授权文件的单次 Queue、ACK 与 Turn Started 分离、Late Wake 独立补偿和 receipt Console link 均有定向测试；安装版候选 + 真实 Codex Host + 真实 ZCode Runtime 的非空工程 Auto Wake 闭环已通过。严格 C/D、Desktop fully exited、notLoaded 与重启场景仍未验证。 |
| Operations Console + Web UI | `PASS — SYNTHETIC` | 真实 Chromium 加载统一 Console；Runtime 7/7、Web 10/10；Deep Link 选中/刷新保留、Result pending 独立显示、i18n/theme、loopback/Host/Origin/CSRF、动态端口发现与同 Root 复用均通过。Worker、Billing 与 Runtime Provider 边界为 synthetic/mock，不是真实模型证据。 |
| Cost Lab unified API + Runner | `PASS — SYNTHETIC` | Cost Lab 全量隔离套件 89/89；同时验证 same-origin 挂载、CSRF、历史/账单脱敏、并发刷新去重和显式真实确认。独立 Runner 使用真实 Executor/MCP 进程与 synthetic Worker，完成 Result、Cleanup、Release、Idle-only Shutdown 与 PID 退出。 |
| Runtime Auto-Learn | `PASS — CONTRACT` | 静态 fingerprint 证据、去重与历史比较、Provider/Billing scope 隔离、授权零模型协议探针和 Manifest 不变均有定向测试；真实 Provider E2E、真实 Billing 和真实版本兼容提升 `NOT_RUN / BLOCKED`。 |
| Preview.17 Task Workspace candidate | `PASS — REAL BROWSER + SYNTHETIC WORKER` | 真实 SQLite Authority、IPC、HTTP 与 Chromium；内部标识/缺失字段隐藏、单次未观测汇总、Attempt+Result 合并、Continue/Rework/Cleanup 能力门、双语、明暗主题、窄屏与 Deep Link PASS；不是真实 Desktop、真实模型或 Master acceptance 证据 |
| Official Host 启动版本上下文 | `PASS — CANDIDATE` | 有效 Desktop metadata 优先；独立 Host 使用校验后的 `3.18.2` 产品版本且不伪造 Build ID；模型请求仍使用 `--surface desktop`；受控 A/B 两边 `main_turn` 均获真实响应，A/B task contract 因测试 Prompt 保持 `FAIL`，后续正常 Prompt 核心路径通过 |
| Windows runtime-host helper | `PASS — OFFICIAL_SIGNED_3.18.2` | 从本机 ZCode Desktop `3.18.2.10443` 复制 `zcode-runtime-host.exe`：179,608 bytes、SHA-256 `C2C8FF5FF28CBDDC4F177C094AA67C322830889612251BD173BAAABC89379AB4`、PE `0x8664`、Authenticode Valid、签名主体北京智谱华章科技股份有限公司；现有 Official ProcessManager smoke 通过。Fresh Rebuild 不再是门槛；安装器 helper/fixture 不进入 Bridge BOM |
| 当前认证候选 CI | `PASS` | Draft PR #94 的 [run 43599440845](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/43599440845) 在 Ubuntu/Windows `Verify` 与 SQLite resource matrix 四项全部通过；不等同 Preview.6 发布验收 |
| 当前 Operations Console 候选 Release Gate | `PASS — LOCAL WINDOWS CANDIDATE` | Bridge `1a7fcd89f`：`npm run test:full` 为 1088 tests、1086 pass、0 fail、2 existing skips；Typecheck、Build、Plugin Validation 与 14 个生成物 freshness 通过。Cost Lab `63d58994`：Windows 8.3 canonicalization、bootstrap path budget 与 startup-child cleanup 修复后 89/89。GitHub Windows/Ubuntu 门禁 `NOT_RUN`，不能替代真实 Desktop、Queue/Master、Official Runtime 或 Provider/Billing |

## 明确边界

当前运行仍按受信任的单用户 Windows 本地部署设计。任务使用固定 `yolo` profile，以当前账户权限执行；路径声明、任务 Prompt 和 Worktree 不是 OS 安全沙箱。

真实 Start Plan 核心功能路径已经通过，但历史完整 E2E 仍因 Workspace 边界失败。其他 Start Plan 模型、CAPTCHA 自动处理、unusual-activity 处理、真实 OAuth refresh/账户轮换和跨平台生产认证没有被单一路径证明。Linux/macOS 仅有其他 Bridge 路径的合成或 CI 历史覆盖；固定官方 Host 制品在非 Windows x64 上 fail closed。

旧 3.18.0 Runtime 目录与打包 AppServer 已从当前候选删除；只有固定 Official Host 模块、官方签名 Helper、keyring closure、许可和 BOM 进入新制品，模型执行统一使用安装版 AppServer。Preview.5 的回滚继续使用其历史发布包。固定制品构建成功、same-source-tree repeatability 与 loopback Mock 通过不能升级为产品性能或完整运行等价。产品总体 Provider/缓存性能仍为 `UNKNOWN`。`@napi-rs/keyring` 的 6 个文件已通过 clean-checkout 打包闭包验证；完整动态资源与逐项再分发许可审查仍不能据此标为 `PASS`。

`npm audit --omit=dev` 仍报告 `@modelcontextprotocol/server@2.1.0` 与 `zod@4.6.5` 的既有 high advisories。依赖树与 `origin/preview` 相同，本候选没有引入或修复这些 advisory；它们必须由独立的安全发布流程处理。

Preview.7 的本机验证只覆盖 Windows x64、Node `24.16.0`。已安装 Desktop `3.18.2.10443` 的官方签名 helper 与固定 Host 通过进程管理 smoke；Desktop `3.18.0`、`3.18.1` 实机组合未验证，不能标记为不兼容。真实 OAuth refresh 与跨机器制品复现未执行，但属于 Owner 已接受的 Preview 阶段有限风险。PR #96 合并后的 preview push 首次 Windows run 观察到既有 `released` lifecycle observation timeout；Root cause 保持 `UNCONFIRMED`，未修改断言或超时，failed-job rerun 通过。

PR #131 已合入 Preview，合并后 CI `45124466655` 通过。Preview.14 的 trusted-local Wake 已在隔离 Host 中完成一次真实 loaded/idle Queue、Turn、原生 MCP Result readback、Cleanup/Release、Master 生命周期独立验收与 Desktop Visible；这不等同于真实 Codex Desktop fully exited、严格 Wake C/D 或 Official Runtime provenance。

Preview.16（ADR-059）进一步在真实 Codex Host 完成一次非空工程 Auto Wake E2E：安装版候选插件从 Host 的 `ctx.mcpReq._meta.threadId` 取得原 Thread，SQLite 在受理事务内持久化 Owner Binding；Executor 完成 Result、Cleanup、Release 后只提交一次官方 Codex Queue，原 Thread 随即出现由该消息触发的新 Turn，Master 在新 Turn 内用原生 MCP 回读同一 Attempt 的 Result 并独立复跑验收命令。没有人工 Composer Turn、重复 Worker 或重复 Queue。该证据不覆盖 Desktop fully exited、notLoaded 或严格 Wake C/D。

## 当前文档入口

产品入口与安装方法见 [README](../README.md) 和 [中文说明](../README.zh-CN.md)。运行配置见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)；生命周期、认证所有权与接口见 [ARCHITECTURE.md](ARCHITECTURE.md) 和 [INTERFACES.md](INTERFACES.md)。`research/zcode-official-host-integration-v1/` 的 Implementation Summary 与 Final Acceptance 只记录 Preview.4 的 3.18.0 历史证据；该固定输入后来继承到 Preview.5，但两份报告不能作为当前 3.18.2 认证候选的验收入口。
| Preview.17 candidate | `IMPLEMENTED — TARGETED / FULL GATE PENDING` | A：真实 Store Release 后 Wake、真实 Executor `SIGKILL`/正常退出恢复、Worker 存活 fail-closed；B：Master 策略夹具与 Skill Token 净减少；C：真实 Authority/IPC/HTTP/Chromium 单页 Console（搜索、共享 bucket、品牌图标字节、synthetic Worker）；D：Original E 固定 blob/尺寸/SHA validator。完整 `npm test`、Windows/Ubuntu CI、真实 Host E2E 与安装后 UI 图标刷新在集成阶段记录。 |
