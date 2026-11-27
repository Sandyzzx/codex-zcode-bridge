# 官方源码制品、运行时与升级边界

> Applicability (2026-11-12): HISTORICAL / SUPERSEDED FOR THE CURRENT TARGET. 独立 Companion 方向已由 [ADR-032](../../decisions/ADR-032-existing-worker-official-host-integration.md) 排除，当前源码候选改为在现有 Worker 内装配官方 Host。正文保留为冻结前研究；其中关于“尚未实现/未构建/未验证”的旧状态只适用于该研究时点，不能覆盖 [当前架构](../../ARCHITECTURE.md)、ADR-033/034 或本仓库的当前证据。

> Status: RESEARCH — 候选设计，未构建、未下载、未再分发。
> Last verified: 2026-11-12（历史研究截止 2026-11-11），Bridge `0b70edbb`；Observed ZCode `b95ebaffe` / 3.18.0。
> 官方 source tree：`d7ebeb994cb8f46b16761fc9c550ae3f6e039c3d`；Bridge tree：`1976267addff37bbec61d6a94120a61f8996906b`。

## 1. 推荐制品边界

固定官方 commit/lockfile，构建一个与 Bridge Worker 配套的执行制品。它包含内部 binding、选定官方 Host 服务、匹配 AppServer、native helper/模块和声明能力所需资源。**独立版本制品不要求独立 Companion 服务进程。** Binding 不单独发布 package，也不让 Core 依赖 ZCode workspace 包。

```text
Bridge release
  Bridge Host/Core + 原有 SQLite / Manager / Worker 执行壳
  runtime manifest（指定唯一配套执行制品）
  execution artifact
    binding + official Host build（在现有 Worker 中加载）
    matching zcode.cjs（官方 AppServer）
    win32-x64 runtime-host helper
    外置 native modules / 动态依赖 / 同版本配置与资源
    LICENSE / NOTICE / BOM / hashes
```

不捆绑整个 Electron App，不依赖 Desktop app.asar，不复制真实账户/设备数据，不搬入 Server HTTP/supervisor/自动更新平台。官方 Session/必要辅助库在可写数据根，绝不写进不可变制品目录。

## 2. Node/ABI：实际有四种不同版本依据

| 依据 | 源码/证据事实 | 含义 |
|---|---|---|
| Bridge package.json | engines `>=22.18` | 宽泛产品声明，不能替代 SQLite 实际 gate |
| Bridge `src/runtime/node-runtime.ts` | **`>=24.16.0 <25`**；Worker 用 `process.execPath` 启动 | 当前 SQLite Authority/Worker 的实际支持约束 |
| 官方源码 mise.toml | Node **24.14.0** / pnpm **10.33.2** | 官方 monorepo 开发/构建工具链 pin，不是所有运行形态唯一 Node 版本的证明 |
| 官方 Server staging contracts.ts | `SERVER_RUNTIME_NODE_VERSION = "22.16.0"` | 官方 Server 发行配方的独立运行时默认；不能原样当作 Bridge Worker Node |
| 历史安装引擎实验 | Node **24.16.0** / pnpm **11.25.0** | 只证明 0.17.1 限定实验，未完成 3.18.0 Host 构建或 ABI 验证 |

证据：[Bridge Node gate](D:/codex-zcode-bridge/.run/preview-integration/src/runtime/node-runtime.ts:1)、[Worker spawn](D:/codex-zcode-bridge/.run/preview-integration/src/manager/spawn-worker.ts:49)、[官方 mise](D:/codex-zcode-bridge/.run/companion-runtime-validation-20261111/source/mise.toml:1)、[Server Node 常量](D:/codex-zcode-bridge/.run/companion-runtime-validation-20261111/source/packages/zcode-server-cli/src/contracts.ts:7)。

**推荐 A：Worker 与加载到其中的官方 Host 使用同一个已固定、已验证的 Node，首个候选取 24.16.0。** 该候选满足 Bridge gate；官方 Host/native 在该版本的完整兼容性仍 UNVERIFIED。AppServer 可先使用同一个明确路径的 Node，通过官方 commandResolver 指定随配套制品的 zcode.cjs。无需为了版本号不同立即加服务。

构建工具与运行时分开记录：可先按官方 mise 的 Node/pnpm 构建，再针对实际运行 Node staging/rebuild native；不能让“build under 24.14”自动宣称“run under 24.16”。若调整官方构建 Node 到 24.16，记录为本产品构建配方变体并验收，不能宣称原官方配置原样通过。

| 选择 | 判断 |
|---|---|
| A 共同 Node | 首选；运行时内 Host 不能同时加载第二个 Node；需完整 Host import、SQLite/native 加载和进程测试 |
| B 随包独立 Node | 可以把同版本 Node 作为安装依赖，但当前 `spawnClaimOnlyWorker` 使用 process.execPath，不能写个 manifest 就宣称已选中它。若让 Worker 用另一个 Node，需修改并重新验证 launch/provenance/Claim；不得退到不满足 SQLite gate 的版本 |
| C 只给 AppServer 独立 Node | commandResolver 已允许 command/args；不新增服务拓扑。若冲突仅在 AppServer 与 Worker 的版本要求，这比加 Companion 更简单 |
| Host 原生依赖只能在不兼容 Node 加载 | 才有理由重新评估独立 Host/Companion。需要具体 ABI/模块/行为反例；目前未发现已实证的强制冲突 |

不同 Node minor 不必然意味着 native ABI 不兼容；Node-API、V8 ABI、平台 DLL 和实际模块构建目标要分别查。pnpm 是构建工具，版本不同本身不构成新增进程理由。**本轮未执行任何加载试验，不能给 ABI PASS。**

## 3. 最小服务组合与副作用边界

以下均为 Observed 3.18.0。分类是“是否装配”和“能否在受限 POC 替换端口”，不是已运行能力声明。

| 官方模块 | 是否需要 | 原因 | 副作用 | 证据 |
|---|---|---|---|---|
| Agent Service `createZCodeAgentService` | REQUIRED；后端端口 MOCKABLE | 复用官方 Session/交互/协议处理 | 创建三类 ProcessManager 对象及惰性 Automation/TaskIndex Repo；选用 API 可能触发 IO | node.ts:180；zcodeAgentService.ts:1401/1423 |
| ProcessManager | REQUIRED，通常由 Agent Service 内建 | 唯一正常 AppServer owner | 解析命令/env，spawn native helper/AppServer，等待/清理，失败时可惰性重建 | node.ts:188；zcodeAgentProcessManager.ts:1051/1275/1768 |
| Account Provider / request auth | 账户 Provider REQUIRED；Mock Provider 可不装 | snapshot、plan/project/revision 与请求材料语义 | 可发权益/项目 token 请求；部分 cache/队列进程内 | node.ts:238/284/286；accountProviderConnectionResolver.ts:305 |
| Credential Service / cipher / OAuthRepo | 账户型 REQUIRED；POC MOCKABLE | 独立 profile 与系统凭据后端 | keyring/credential 文件、锁、恢复及迁移；不能只 Mock cipher 后仍读取真实路径 | node.ts:178/225/227；credentialService.ts:143 |
| Provider Registry / config runtime | REQUIRED；来源 MOCKABLE | 匹配 builtin/personal/account 配置 | 文件读取/监听，刷新；account overlay 要对齐配置 revision | node.ts:258；providerRuntime.ts |
| Session/Event | REQUIRED | 使用官方 Agent 会话/事件 API 和 AppServer 持久化 | 创建/读取 Session DB，订阅、回放；V4/旧事件语义留在 binding | zcodeAgentService.ts:4491；AppServer server-operations.ts |
| Project/Task 高层服务 | 本产品不装；附带 Repo UNKNOWN | Bridge 自己拥有 Task/Workspace | 完整 Host 会接 TaskIndex 预留、Project、worktree 管理；最小必经路径待证明 | node.ts:2395；Agent Service 内部 Repo |
| Terminal 高层服务 | OPTIONAL，初始不装 | 与 Agent 自带 Shell 工具区分 | Host 终端会创建独立进程/PTTY；Agent 工具执行仍复用引擎 | createLocalServices 的组合/释放链 |
| Browser | OPTIONAL；Desktop executor DESKTOP_ONLY；端口 MOCKABLE | 独立 backend 未验证；不能默认借 Desktop Main | 浏览器/profile/native 子进程及额外清理 | AgentService options.browserControlExecutor |
| MCP Status lane | OPTIONAL，初始不调用 | 状态探测不是基础工具执行必须的外部 API | 独立 manager 可启动额外 AppServer；创建对象不等于启动 | zcodeAgentService.ts:1435/4304 |
| `createServerHostServices` 完整工厂 | 初始不调用 | 服务过宽 | credential initialize、device identity、全应用迁移、workspace alias | node.ts:3575–3631 |
| `createLocalServices` 完整工厂 | 初始不调用 | 非最小 headless 组合 | 进程环境、CA、Task/Project/Terminal 等接线 | node.ts:1256/1400/1413/2395 |

官方类型和私有 RPC 只存在于执行制品/binding。Core 只接触 Bridge 自有 TaskPackage、WorkspaceRef、handle/outcome、受控事件及 Cleanup 证据合同。账号秘密不进入这些公共结构。

Worker 初始化顺序候选：验证现有 provenance/bootstrap/Claim→读取本次授权执行说明→固定制品与 profile/lineage 路径→构造配置/账户服务→注入请求鉴权与 verification 配置→创建 Agent Service→以官方 commandResolver 启动匹配引擎→Session/事件/Prompt。关闭反向停止 admission、收敛交互、停止并清理 Runtime、释放官方服务/仓库和额外资源，再提交绑定 Result/证明并退出。

这只是设计顺序，不是已经可调用的一段现成工厂。官方 `@zcode/services`/bootstrap 均 private；跨版本 SDK 稳定性没有保证。不得为了减少其内部对象而复制/删改官方服务。

## 4. 分发闭包与实际 BOM

| 部分 | 制品处理 | 验证要求 |
|---|---|---|
| 第一方源码 | pin 完整 commit/tree、lockfile hash；小型外部装配入口 | 不维护完整 fork；出现大段核心补丁即重新审查 |
| Host/binding/AppServer | 同一已验证版本组，独立 manifest | 私有 API 编译/运行和事件契约测试；不能 Host 新版配安装旧引擎 |
| Node/pnpm | 构建与执行版本分别固定 | Bridge 实际 gate、ABI/native 验证；不要只看 package.json |
| Native | keyring/koffi、Windows runtime-host、实际能力涉及 PTY 等 | 平台/arch、ABI/Node-API、DLL、来源及 hash；未用模块是否可剔除要靠真实闭包 |
| 动态依赖 | 官方 CLI 外置 playwright-core、koffi、keyring、TUI 等 | 构建 metafile 不足以发现全部动态资源；必要 package assets/解析路径必须 staging |
| builtin/provider/resources | 随同版本配置和资源；运行期物化另放数据根 | 不读取 installed app.asar 补身份；不能用合成目录宣称真实模型目录可用 |
| 插件/工具 | 明确能力列表，逐项纳入 | Memory/MCP/Subagent/Browser 等未测不标 supported；不把全部 glm 目录当最小闭包 |
| 系统权限/环境 | allowlist 与显式路径；保留产品允许的工作区指令来源 | 不透传任意 auth/代理/真实 home；无必要 CA/device 初始化不能偷偷发生 |

源码官方 CLI build.mjs 和 Server stageCli.ts 有可复用构建/staging逻辑；不是已经存在的 Bridge 执行制品。尤其官方 Server 默认 Node 22.16.0 与本产品 SQLite gate 不同，不能照搬最终 staging。

manifest 至少记录 artifact ID/hash、Bridge binding 接口版本、官方 commit/tree、build tools/lockfile、Node/platform/arch/native 清单、能力、配置资源及数据 schema/credential backend 兼容性、BOM/notices。初始只允许一个活动配套版本，保留一个已验证旧版本供回滚；不建任意兼容矩阵或在线协商框架。

## 5. License / Notices

根 LICENSE 为 Apache-2.0；第一方源码复用/构建/再分发有依据。保留适用版权、许可、NOTICE，并明确实际修改；没有获得商标/官方背书权利，也不能从源码许可推导访问所有付费 API 的授权。

官方 `THIRD-PARTY-NOTICES.md` 是跨发行形态保守并集，实际产品 BOM 仍须由最终打包集合生成和核验。对 Node/native 模块、插件、复制资源、字体/WASM/工具二进制逐项保留来源与适用条款。MIT/BSD/Apache、CC-BY、EPL/GPL 双许可等须按所含组件处理；出现 GPL 字符串既不是整个制品都受 GPL 的证明，也不是可忽略该组件条款的理由。

本轮只读检查许可入口、notices 和已有构建 staging；未生成实际制品 BOM，未验收每项原生/资源再分发条件。因此 **REDISTRIBUTION_REVIEW: PARTIAL**。不再分发安装版整包，不下载依赖/二进制来填补本轮缺口。

公开源码 request verification 为不可用/空实现，CUA 为 unavailable 占位；固定源码产品只能声明其实际能力。不能据此绕过验证或宣称 Desktop 全功能等价。

## 6. 升级、回滚与上游变化范围

| 变化 | 通常影响 |
|---|---|
| 官方 RPC/Agent API/事件类型 | binding 与官方版本组，重建及语义回归 |
| Host account/配置/副作用 | composition、账户 Mock、profile 与数据兼容 |
| native/Node/资源 | 构建/staging/manifest、平台加载与进程清理 |
| Bridge Outcome/授权/Proof | Worker/Manager 验证器与 ADR；不能藏在内部升级里 |
| 仅官方内部实现优化 | 可能无需 binding 源码修改，但仍需制品回归 |

不能承诺每次只改一个文件。目标是把大多数变化限制在一个执行制品和普通内部 binding，Core 不理解官方 RPC。

候选升级在离线/隔离环境构建验证后，停派并收束活动或未知执行，再切新任务版本；不覆盖正在运行的文件。旧 Session 必须核对 schema 和原制品 identity；不兼容时明确阻止 continuation，不自动用别的引擎重试。

二进制回滚不等于数据回滚。迁移后的 Session/辅助 DB、profile credential backend 与 revision 都要兼容证明；不能用旧快照覆盖新执行事实或恢复已失效凭据。当前 SQLite Authority/v14 升级合同继续生效。

## 7. 尚未验证与下一步门槛

1. 官方 Host 在 Bridge 支持的 Node 24.16.0 上完整装载及运行；Node-API/native 兼容未知。
2. 最小 Agent Service 组合是否能避开不需要的应用存储/副作用，且正常释放所有惰性资源。
3. Session 根与共享 profile 的路径能否在官方现有导出内准确分离；`createCredentialService` 没有任意 filePath 参数，不能凭空设计可注入路径。
4. Job/资源观测端口和 Bridge 证明合同的接线；公开 API 缺口见 ADR 草案。
5. 实际能力闭包、BOM/notices、干净机器运行、旧数据与回滚矩阵。

```text
OFFICIAL_SOURCE_ARTIFACT_BOUNDARY: PARTIAL
REDISTRIBUTION_REVIEW: PARTIAL
COMMON_NODE_CANDIDATE: 24.16.0 — UNVERIFIED_FOR_FULL_OFFICIAL_HOST
SEPARATE_COMPANION_REQUIRED_BY_ABI: NOT_PROVEN
OFFICIAL_3_18_BUILD: NOT_RUN
DOWNLOADS_OR_REDISTRIBUTION: NONE
```
