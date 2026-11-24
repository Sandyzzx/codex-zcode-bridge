# ZCode 运行配置边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-24（ADR-054 授权机制退役；Task Console 自动启动开关）
> Last verified: 2026-11-24，核对 v13 只读拒绝、未完成升级 Marker 保留、v14 Fresh/Existing 启动、v13 CLI/Schema 分发删除与 `ZCODE_BRIDGE_TASK_CONSOLE` 的持久配置路径（单测 + Cost Lab 全量 90/90）；真实模型、OAuth 与 Billing E2E 为 `NOT_RUN`。
> Verified against: `codex/preview16-async-handoff-20261124`（Preview.16 candidate；ADR-054 适配集成后核对 Resolver/factory/console/cost-lab 源码，并核对 Console 自动启动开关）

当前生产路径是 `node <installed-runtime>/resources/glm/zcode.cjs app-server --stdio --surface desktop`，不是历史 CLI `--prompt --json`。任务 Adapter 与模型目录探测共用 `createInstalledOfficialHostSessionFactory` 的同一启动合同；安装版兼容性由 `OfficialAppServerRuntimeResolver` 精确校验，配置项与用户设置方法见仓库 README。

Task 受理时 MCP 会按需自动启动 loopback Task Console 并把验证过的 Deep Link 放进 receipt；`ZCODE_BRIDGE_TASK_CONSOLE`（环境变量或同一 `runtime-config.json` 设置键）取 `off`/`0`/`false` 时关闭该自动启动（默认 `auto`），此时 receipt 的 `console_link` 为 `available: false` / `WEB_CONSOLE_DISABLED`，已受理的 Task 不受影响。Cost Lab 隔离验证使用该开关，避免留下常驻 Console 进程；关闭自动启动不改变 Console 自身的独立生命周期。

ADR-038 后，插件资源目录只保留固定 ZCode 3.18.2 Official Host；ZCode 3.18.0 的整套 Runtime 不再随新制品分发，Preview.5 回滚继续使用其历史发布包。生产 Adapter 选择在构造前只接受 Windows x64 的 `official_host`；Linux、macOS、Windows 非 x64 与未知架构返回 `unsupported_worker_platform`。direct Adapter 只用于隔离测试注入，不是其他平台的生产回退。

ADR-040/ADR-041 将安装版 Runtime 扩展为所有 Provider 的统一模型执行来源；Resolver 必须从现有路径发现取得同一安装根下的 `resources/glm/zcode.cjs`、`resources/config/provider/zcode-builtin.json` 与 `resources/tools/runtime-host/zcode-runtime-host.exe`。发布验证仍精确匹配 Desktop `3.18.2.10443`、文件大小、SHA-256、Windows x64 和 Node `>=24.16.0 <25`。ADR-042 曾把“安装安全”和“Manifest 生产兼容”分开并要求显式授权;ADR-054 已退役该授权机制：安全安装不再因版本、摘要、签名、指纹或授权缺失而阻断调用，静态 Manifest 匹配只作诊断。任何状态都不会静默使用打包 Runtime，也不会由安装校验自动产生 Provider 或折扣声明。

## 安装安全与静态诊断（ADR-040/042/054）

Resolver 的基础安全检查包括：Windows x64、支持的 Node、绝对 canonical 安装根、同根普通文件、无 symlink escape、`ZCode.exe` 与 runtime-host 的有效 Authenticode 和官方发行主体、x64 PE、Desktop/ASAR/AppServer identity 一致，以及 AppServer、builtin config、runtime-host、Desktop EXE 和 ASAR 的精确 bytes/SHA-256。

ADR-054 退役了 ADR-042 的版本授权机制（`ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE`、
authorize-official-runtime 工具、probe scopes 与 `RUNTIME_PROBE_AUTHORIZATION_REQUIRED` 均已删除）：

- 安装安全检查仍然存在且是唯一执行门禁；`OFFICIAL_INSTALLATION_SAFE` 之外的安装不启动；
- 未验证版本不阻断调用：`OFFICIAL_RUNTIME_UNVERIFIED` 只表示 Manifest 无记录，`resolve()` 照常返回；
- 已验证版本由 README 声明（当前 3.18.2.10443、3.19.0.10774、4.0.0.10870 均通过安全检查，
  其中 4.0.0 完成零模型 Protocol Smoke 与真实任务 E2E 的验证见发布报告）；
- Runtime 失败通过真实错误和诊断信息反馈，安装指纹仍是兼容性证据的绑定键。

实验状态与历史结论：3.19.0.10774 通过零模型协议 Smoke 并完成过一次 Coding Plan 真实执行；其官方小时桶未完成请求级 Token/Credits 对账，倍率保持 `INCONCLUSIVE`。Start Plan 因账户无 active plan 而保持 `BLOCKED / NO_ACTIVE_PLAN`。

编码/权益能力门禁仍分离：Coding Plan 折扣与 Start Plan 静态兼容现在是诊断（`officialProviderCapabilityWarning`），不再阻断执行；Live Entitlement、认证、账单与 Cleanup 门禁不变。

## 执行与清理期限（ADR-027）

SQLite Manager 在派发每个 Attempt 前读取该 Host 的持久 runtime environment；`timeout_ms` 显式值优先，其次 `ZCODE_BRIDGE_TIMEOUT_MS`，无有效默认值时用 3,600,000 ms。范围保持 60,000–14,400,000 ms。有效值只写私有 Task 副本，不改公开持久 Task。Worker Adapter 使用同一快照，不因环境变化重新选期限。

执行计时包含 runtime resolver、app-server 启动和 turn，到终结/错误/取消即停止。Adapter 清理总预算固定 300,000 ms；已有 Windows helper/身份验证期限不放宽，不增加用户配置。Manager 的私有执行写入限 15,000 ms；Result 等待为 execution + 330,000 ms；提交后的 close 与 interaction drain 共用 15,000 ms，再用现有 5,000 ms 身份探针。Host shutdown 继续独立使用原 60,000 ms 等待上限；不能证明原活跃任务 Cleanup/Release 时显式失败并保留所有权，不将它复用为任务执行期限。JS 定时器是协作式期限，不是 OS 硬实时保证。

Cleanup 超时只发布 unverified；迟到确认不会自动改写 Result 或释放 Workspace。执行 timeout 可形成 failed/timeout Result；清理未证实则仍保留占用。Result 已提交时可显式调用 zcode_cancel 仅清理原世代；Result 未到的超时保留 running 和诊断，禁止假定未执行并重派。Manager 退出/重启不放宽这些证据要求。R2 的 32 MiB/v14 不变，Host 大 Result 读取限制按 Owner 决定延后。

## SQLite v14 ONLY（ADR-043）

当前生产只支持 SQLite v14。Fresh root 走现有原子 Fresh Bootstrap；已有有效 v14 数据库直接打开。Store 在可写句柄创建前用只读 `PRAGMA user_version` 预检版本，Lifecycle Gate 对新装和既有 Authority 使用同一 Store 校验。

v13 数据库返回稳定错误码 `unsupported_sqlite_schema` 和 `SQLite v14 ONLY` 提示。拒绝不会创建或修改数据库、WAL、SHM；不提供自动升级、离线复制、升级恢复或回滚。发现 `*.v13-v14-pending.json` 时保留现场并明确拒绝，不删除、不重命名、不恢复。未知 Schema、损坏库、Writer 冲突和无法解释的现场继续 fail closed。

已有 v14 的 `migration_runs`、`authority_switch`、`json_artifacts`、`migrated_task_results`、`migrated_task_events`、`manager_admin_abandonments` 和 `runtime_task_events` 不在本次退役范围；历史 `interrupted_by_upgrade` 行仍可作为只读历史读取。旧 `authority: "json"` 配置仅继续作为安装提示并选择 SQLite，不恢复 JSON Authority。

## 路径发现合同（ADR-021）

统一路径发现实现在 `src/runtime/paths.ts`；`configure-runtime.ps1` 使用相同规则，并有跨实现一致性测试。所有发现函数使用注入环境与注入文件读取，不依赖测试进程的真实用户数据，也不输出设置或凭据内容。

用户目录（Windows 采用 Magpie `internal/appdir/zcode.go` v0.1.2127 的判定原则，独立重新实现）：

1. `HOME` 仅在非空、绝对路径、且清理后与 `USERPROFILE` 相同（Windows 大小写不敏感、正反斜杠等价）时采用。
2. 否则回退 `USERPROFILE`；测试目录、WSL 目录等非当前 Windows 用户目录不得通过 `HOME` 覆盖。相对或空 `HOME` 视为未设置。
3. 非 Windows 平台 `HOME` 优先，缺失时回退。

数据目录：`<userHome>/.zcode/v2/setting.json` 的 `dataBaseDir` 只在非空且为完整绝对路径时生效；Windows 只接受盘符限定路径（如 `C:\foo`、`C:/foo`）和含 server/share 的 UNC 路径，`C:foo`、`C:`、`\foo` 都是相对或非完整形式。否则数据基础目录回退为用户目录。五个字段必须区分：`userHome`、`settingFile`、`dataBaseDir`、`zcodeDataDir`（`dataBaseDir/.zcode`）、`zcodeV2Dir`（`dataBaseDir/.zcode/v2`）。setting.json 缺失、损坏、`dataBaseDir` 相对路径或类型错误都安全回退并由 doctor 报告；Bridge 不创建、不迁移任何 ZCode 数据目录。

显式配置优先于自动发现，冲突显式报错：

1. `ZCODE_HOME` 指 `.zcode` 目录本身；`ZCODE_DATA_BASE_DIR` 指其父目录。二者语义与 Magpie 的 `ZCodeHome()`（返回用户目录）不同，不得互相套用。
2. 显式 `ZCODE_HOME` 与 `ZCODE_DATA_BASE_DIR` 同时存在且不满足 `ZCODE_HOME == <ZCODE_DATA_BASE_DIR>/.zcode` 时报 `provider_config_invalid`，不再静默择一。
3. 自动发现安装按固定优先级 `ZCODE_WINDOWS_APP_INSTALL_DIR` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode`，且 `resources/glm/zcode.cjs` 与 `resources/config/provider/zcode-builtin.json` 必须来自同一安装根，否则跳过该根（错误信息列出各根的存在性）。显式 `ZCODE_BRIDGE_ZCODE_CJS` 时 builtin 从该 runtime 所在安装派生；缺失报 `provider_config_missing`。Node 入口仍按 `ZCODE_BRIDGE_NODE`/PATH 既有合同。
4. personal provider 配置候选顺序：显式 `ZCODE_DATA_BASE_DIR` → `setting.json` 发现的 `dataBaseDir` → 用户目录。credentials 与 personal 配置在数据目录；builtin 配置在安装目录；CLI 配置、AGENTS.md、Skills 在用户目录——Desktop 数据迁移不迁移 CLI 用户配置。
5. runtime-config.json 仅持久化显式来源的 `ZCODE_HOME`/`ZCODE_DATA_BASE_DIR`；`setting.json` 的发现值不持久化，保证 Desktop 后续迁移可被跟随。

Windows 子进程环境：`createMinimalOsEnv`/`createWorkerEnv` 把 `HOME` 归一为 Bridge 解析出的用户目录（`USERPROFILE` 原样保留），使 Worker 与 ZCode 子进程使用与主进程相同的数据目录；不透传任意父进程环境变量或凭据。Windows 进程身份探针从 `SystemRoot` 绝对路径启动系统 Windows PowerShell，通过 .NET `Process.GetProcessById().StartTime.Ticks` 读取创建指纹；它不依赖父进程的 `PSModulePath`，查询失败仍为 unknown。

Bridge 只读取官方 builtin/personal provider 配置，不复制、不改写内容，也不将环境或凭据写入任务 metadata。personal 配置的 `config.providerConfigRules.providerRules` 必须为非空数组或对象；已知空 stub 被拒绝。结构验证不能证明 provider 可用或账号有权限。

请求模型时优先保留 catalog 中的精确 provider/model。无前缀旧 provider 只有在 catalog 存在同 model 的 account 前缀项，或官方规则确立了对应 account 映射时才解析；不按模型显示名切换其他 provider，catalog 缺席仍由 session/setModel 验证配置标识与模型。account: 标识不重复加前缀。请求值与 runtime 确认值分别保留，不持久化为工作区默认。见 ADR-005。

persisted runtime-config 中已知字段只能是字符串或 null；缺文件允许环境/发现回退，存在但损坏、非 object 或超过 64 KiB 会报配置错误。当前生产 Bridge 使用 SQLite 唯一 Authority，不保留 JSON 生产路径或故障回退。不能把坏配置当成首次未设置而回退到默认模式。ADR-019 后，单用户本机 SQLite 的固定受信任档案使用 `yolo`，policy revision 为 `single-user-local-v3`；兼容身份 `local-build-v1` 保留为持久化 profile ID，不再表示强制 `build`。该模式使用当前 Windows 用户权限，workspace/worktree 和路径清单不是 OS 沙箱。

浏览器宿主配置（ADR-007）：`ZCODE_BRIDGE_BROWSER_USE` 取 `off`（默认，含空值/未设置/非法值回退为 off）或 `headless`；`ZCODE_BRIDGE_BROWSER_EXECUTABLE` 可选，须为已存在文件的绝对路径，缺省按官方实现解析已安装 Chromium/Edge（不下载浏览器）。两项均为普通字符串配置键，遵循配置优先于环境变量的既有规则；非法 USE 值不阻断任务，仅保持关闭并由 doctor 给出 warning。detached worker 进程按显式键清单转发这两项非秘密设置（2026-10-16 修复：此前 env-only 配置在真实 spawn 边界丢失），其余任意父进程环境与秘密仍不透传。Windows worker 环境保留 `ProgramFiles` / `ProgramFiles(x86)`（接受常见大小写）等非敏感系统目录变量供自动发现使用，发现解析同样不区分大小写键；显式 `ZCODE_BRIDGE_BROWSER_EXECUTABLE` 优先级不变。不向 app-server 传递任何 headless CLI 参数；浏览器由 worker 内的 managed CDP runtime 以独立临时 profile 启动，生命周期见 ARCHITECTURE.md。

执行和模型目录共享同一个 Official Host session factory 及其 ProcessManager/ProtocolClient；模型目录不再自行 spawn AppServer、实现 JSON-RPC framing 或返回持久化 Coding Plan API Key。当前假运行时和合成 Host 测试覆盖调用选择、事件、交互、Cache/alias 和清理；真实协议随安装版本变化，不能把这次收敛扩展为全协议或其他版本认证。

stdout 协议帧与审批持久化边界（ADR-008）：换行分隔的完整 JSON-RPC 帧单帧上限 16 MiB 原始未 trim UTF-8 字节，帧顶层必须是对象，致命帧错误锁存原因并终止当次 attempt 的协议流；turn 可见文本另有 2,000,000 字符捕获上限。SQLite request 与私有交互帧使用现有 1 MiB 边界；旧 JSON 事件文件与 full_request 文件引用已随 ADR-029 退役。这些上限是 Bridge 侧守卫，不依赖也不约束 app-server 的内部实现；真实 resume 帧（观测 2,139,927 UTF-8 bytes）在限内正常通过。

2026-10-14 独立验证补充：已用本机 ZCode Desktop 3.15.1.8093 / Agent 0.16.9、GLM-5.3 / max、build 模式完成原生 browser-client 单次提交与截图、关闭验收。这次小范围 smoke 不等于全协议或跨版本认证。详情见 [独立验收](reports/2026-10-15-browser-and-transport-fixes.md)。
