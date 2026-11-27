# ZCode 运行配置边界

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable 2.0.0 的运行期 Registry 路径选择与回退、AppServer env/Account Overlay 同源、Endpoint 环境转发、`configure-runtime.ps1` 静态路径清除、Typecheck、Build、Plugin Validation 与现有定向测试；未执行新的真实模型任务。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`（`codex-zcode-bridge-v2.0.0`）

当前生产路径是 `node <installed-runtime>/resources/glm/zcode.cjs app-server --stdio --surface desktop`，不是历史 CLI `--prompt --json`。任务 Adapter 与模型目录探测共用 `createInstalledOfficialHostSessionFactory` 的同一启动合同；安装版兼容性由 `OfficialAppServerRuntimeResolver` 检查，配置项与用户设置方法见仓库 README。

Task 受理时 MCP 会按需自动启动 loopback Task Console，并把验证过的 Deep Link 放进 receipt。`ZCODE_BRIDGE_TASK_CONSOLE`（环境变量或同一 `runtime-config.json` 设置键）取 `off`/`0`/`false` 时关闭自动启动（默认 `auto`）；此时 receipt 的 `console_link` 为 `available: false` / `WEB_CONSOLE_DISABLED`，已受理的 Task 不受影响。Cost Lab 隔离验证使用该开关，避免留下常驻 Console 进程；关闭自动启动不改变 Console 自身的独立生命周期。

## Executor 自动恢复

Thin MCP 在首次建立或重新建立 Executor 控制通道时，如果本机 Named Pipe 不可用，会调用一次自动恢复协调器；默认开启，不做持续轮询。协调器先探测健康 Executor，随后使用 `<settingsDirectory>/executor-recovery.lock` 获取跨进程独占。该临时锁不写入 SQLite Authority 根，因此 Fresh root 的允许条目与原子 Bootstrap 合同不变。

旧 Lease 只有在 Owner 的 PID、启动指纹、平台与身份版本共同证明已退出时才可归档。归档前会只读打开同一 `bridge.sqlite`，检查活动 `launch_intent` / Claim / Worker identity：Worker 仍存活、身份未知或 Launch outcome 未知时 fail closed。安全归档后使用与 `zcode-bridge executor start` 相同的 Spawn 实现启动 Executor，并等待 `executorStatus` 返回健康 Lease。两个并发请求最多产生一个恢复 Spawn。

`ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER=0|false|off` 仅用于确定性传输诊断或隔离测试，显式关闭自动启动；默认、缺失或非法值均为开启。该开关不改变已有 Executor 连接、Lease 所有权、Worker Safety、Cleanup、Release 或 SQLite 数据。

## 官方 Runtime 与安装安全

生产 Adapter 在构造前只接受 Windows x64 的 `official_host`；Linux、macOS、Windows 非 x64 与未知架构返回 `unsupported_worker_platform`。direct Adapter 只用于隔离测试注入，不是其他平台的生产回退。

所有 Provider 统一使用用户已安装的官方 AppServer Bundle、同根 builtin Provider 配置和 runtime host。Resolver 从现有路径发现同一安装根下的 `resources/glm/zcode.cjs`、`resources/config/provider/zcode-builtin.json` 与 `resources/tools/runtime-host/zcode-runtime-host.exe`。支持构建基线为 Desktop `3.18.2.10443`、Windows x64 和 Node `>=24.16.0 <25`；README 另行记录已验证的 Desktop 版本范围。安装安全是唯一执行门禁，Manifest 匹配和静态 capability 只作诊断；不安全安装、无效签名、非 x64、混合根和不受支持 Node 仍 hard block。未验证版本不阻断调用，但也不被提升为已验证兼容。任何状态都不会静默使用打包 Runtime，也不会由安装校验自动产生 Provider 或折扣声明。

Resolver 的基础安全检查包括：Windows x64、支持的 Node、绝对 canonical 安装根、同根普通文件、无 symlink escape、`ZCode.exe` 与 runtime-host 的有效 Authenticode 和官方发行主体、x64 PE、Desktop/ASAR/AppServer identity 一致，以及 AppServer、builtin config、runtime-host、Desktop EXE 和 ASAR 的精确 bytes/SHA-256。安装安全检查是运行门禁；`OFFICIAL_INSTALLATION_SAFE` 之外的安装不启动。

编码/权益能力门禁仍分离。Coding Plan 折扣与 Start Plan 静态兼容作为诊断（`officialProviderCapabilityWarning`），不阻断执行；Live Entitlement、认证、账单与 Cleanup 门禁不变。Start Plan、Coding Plan 及账户可用性必须由用户实际环境决定，Bridge 不授予权益或保证折扣。

## 执行与清理期限

SQLite Manager 在派发每个 Attempt 前读取该 Host 的持久 runtime environment；`timeout_ms` 显式值优先，其次 `ZCODE_BRIDGE_TIMEOUT_MS`，无有效默认值时使用 3,600,000 ms。范围保持 60,000–14,400,000 ms。有效值只写私有 Task 副本，不改公开持久 Task。Worker Adapter 使用同一快照，不因环境变化重新选期限。

执行计时包含 runtime resolver、app-server 启动和 turn，到终结、错误或取消即停止。Adapter 清理总预算固定 300,000 ms；Windows helper/身份验证期限不放宽，不增加用户配置。Manager 的私有执行写入限 15,000 ms；Result 等待为 execution + 330,000 ms；提交后的 close 与 interaction drain 共用 15,000 ms，再用现有 5,000 ms 身份探针。Host shutdown 独立使用 60,000 ms 等待上限；不能证明原活跃任务 Cleanup/Release 时显式失败并保留所有权。JS 定时器是协作式期限，不是 OS 硬实时保证。

Cleanup 超时只发布 unverified；迟到确认不会自动改写 Result 或释放 Workspace。执行 timeout 可形成 failed/timeout Result；清理未证实则仍保留占用。Result 已提交时可显式调用 `zcode_cancel` 仅清理原世代；Result 未到的超时保留 running 和诊断，禁止假定未执行并重派。Manager 退出/重启不放宽这些证据要求。

## SQLite v14 ONLY

当前生产只支持 SQLite v14。Fresh root 走现有原子 Fresh Bootstrap；已有有效 v14 数据库直接打开。Store 在可写句柄创建前用只读 `PRAGMA user_version` 预检版本，Lifecycle Gate 对新装和既有 Authority 使用同一 Store 校验。

v13 数据库返回稳定错误码 `unsupported_sqlite_schema` 和 `SQLite v14 ONLY` 提示。拒绝不会创建或修改数据库、WAL、SHM；不提供自动升级、离线复制、升级恢复或回滚。发现 `*.v13-v14-pending.json` 时保留现场并明确拒绝，不删除、不重命名、不恢复。未知 Schema、损坏库、Writer 冲突和无法解释的现场继续 fail closed。

已有 v14 的 `migration_runs`、`authority_switch`、`json_artifacts`、`migrated_task_results`、`migrated_task_events`、`manager_admin_abandonments` 和 `runtime_task_events` 不在本次退役范围；历史 `interrupted_by_upgrade` 行仍可只读读取。旧 `authority: "json"` 配置仅继续作为安装提示并选择 SQLite，不恢复 JSON Authority。

## 路径发现合同

统一路径发现实现在 `src/runtime/paths.ts`；`configure-runtime.ps1` 使用相同规则，并有跨实现一致性测试。所有发现函数使用注入环境与注入文件读取，不依赖测试进程的真实用户数据，也不输出设置或凭据内容。

用户目录（Windows 采用 Magpie `internal/appdir/zcode.go` v0.1.2127 的判定原则，独立重新实现）：

1. `HOME` 仅在非空、绝对路径、且清理后与 `USERPROFILE` 相同（Windows 大小写不敏感、正反斜杠等价）时采用。
2. 否则回退 `USERPROFILE`；测试目录、WSL 目录等非当前 Windows 用户目录不得通过 `HOME` 覆盖。相对或空 `HOME` 视为未设置。
3. 非 Windows 平台 `HOME` 优先，缺失时回退。

数据目录：`<userHome>/.zcode/v2/setting.json` 的 `dataBaseDir` 只在非空且为完整绝对路径时生效；Windows 只接受盘符限定路径（如 `C:\foo`、`C:/foo`）和含 server/share 的 UNC 路径，`C:foo`、`C:`、`\foo` 都是相对或非完整形式。否则数据基础目录回退为用户目录。五个字段必须区分：`userHome`、`settingFile`、`dataBaseDir`、`zcodeDataDir`（`dataBaseDir/.zcode`）、`zcodeV2Dir`（`dataBaseDir/.zcode/v2`）。`setting.json` 缺失、损坏、`dataBaseDir` 相对路径或类型错误都安全回退并由 doctor 报告；Bridge 不创建、不迁移任何 ZCode 数据目录。

显式配置优先于自动发现，冲突显式报错：

1. `ZCODE_HOME` 指 `.zcode` 目录本身；`ZCODE_DATA_BASE_DIR` 指其父目录。二者语义与 Magpie 的 `ZCodeHome()`（返回用户目录）不同，不得互相套用。
2. 显式 `ZCODE_HOME` 与 `ZCODE_DATA_BASE_DIR` 同时存在且不满足 `ZCODE_HOME == <ZCODE_DATA_BASE_DIR>/.zcode` 时报 `provider_config_invalid`，不再静默择一。
3. 自动发现安装按固定优先级 `ZCODE_WINDOWS_APP_INSTALL_DIR` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode`，且 `resources/glm/zcode.cjs` 与 `resources/config/provider/zcode-builtin.json` 必须来自同一安装根，否则跳过该根（错误信息列出各根的存在性）。显式 `ZCODE_BRIDGE_ZCODE_CJS` 时 builtin 从该 runtime 所在安装派生；缺失报 `provider_config_missing`。Node 入口仍按 `ZCODE_BRIDGE_NODE`/PATH 既有合同。
4. personal provider 配置候选顺序：显式 `ZCODE_DATA_BASE_DIR` → `setting.json` 发现的 `dataBaseDir` → 用户目录。credentials 与 personal 配置在数据目录；builtin 配置在安装目录；CLI 配置、`AGENTS.md`、Skills 在用户目录——Desktop 数据迁移不迁移 CLI 用户配置。
5. `runtime-config.json` 仅持久化显式来源的 `ZCODE_HOME`/`ZCODE_DATA_BASE_DIR`；`setting.json` 的发现值不持久化，保证 Desktop 后续迁移可被跟随。

## 官方运行期 Built-in Registry

Bridge 与当前安装版 ZCode Desktop 使用同源的官方运行期 Built-in Registry。路径规则镜像已观测的官方行为（Desktop 4.0.0.10870、`zcode.cjs` 0.18.0），不是官方合同：

```text
<dataBaseDir>/.zcode/v2/runtime/provider/<platform>/<appVersion>/endpoint-<hash>/zcode-builtin.json
```

- `<dataBaseDir>` 是 personal provider 配置所在的 `<base>/.zcode/v2` 的 `<base>`，即已校验的 `ZCODE_DATA_BASE_DIR`；`ZCODE_HOME` 已包含 `.zcode` 时取其父目录，不重复拼接。
- `<platform>` 沿用官方命名（Windows 为 `windows`，架构 `x86_64` / `aarch64`）；`<appVersion>` 来自安装版 `out/metadata/build-meta.json`；`<hash>` 是当前 Endpoint origin 的 SHA-256 前 32 位。
- Endpoint origin 优先级：`ZCODE_BASE_URL` → `ZCODE_ENDPOINT_ORIGIN` → 测试/生产 `ZCODE_TEST_BASE_URL` / `ZCODE_PRODUCTION_BASE_URL` → 官方默认值；按 `new URL(...).origin` 规范化。
- 只定位上述唯一路径，不跨 Endpoint、Desktop 版本或数据根搜索“最新”Registry。有效的运行期文件始终优先，不比较 revision；只有文件缺失、非普通文件、非法 JSON 或 schema 不合法时，才回退同一安装目录的 `resources/config/provider/zcode-builtin.json`。
- 每次解析运行时配置（即每次新 AppServer 启动）都重新选择，不缓存、不下载、不更新、不改写官方文件；官方 Registry 更新后无需修改 Bridge 或重装插件。

AppServer 子进程环境、Account Overlay 与模型目录使用同一个已解析文件。Overlay 不复制 `builtinModelIds`，Coding Plan 与 Start Plan 的模型成员由官方 Registry 决定；`access`、`states` 与 `basedOnZCodeBuiltinRevision` 不变。Adapter 在 AppServer 启动后、注册 Overlay 前复核 Registry 身份（路径、revision、SHA-256），与 Overlay 依据不一致时以 `provider_config_invalid` 失败且不重试。Detached Worker 只转发 Endpoint 相关非秘密环境键，保证与 Executor 定位同一 Registry。

`configure-runtime.ps1` 仅在 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 显式指向同安装 Built-in 之外的文件时持久化该键；默认派生路径写入 `null`，清除旧安装器留下的静态路径。安装目录 Built-in 仍是运行期 Registry 不可用时的回退，因此脚本继续校验其存在性。

Windows 子进程环境：`createMinimalOsEnv`/`createWorkerEnv` 把 `HOME` 归一为 Bridge 解析出的用户目录（`USERPROFILE` 原样保留），使 Worker 与 ZCode 子进程使用与主进程相同的数据目录；不透传任意父进程环境变量或凭据。Windows 进程身份探针从 `SystemRoot` 绝对路径启动系统 Windows PowerShell，通过 .NET `Process.GetProcessById().StartTime.Ticks` 读取创建指纹；它不依赖父进程的 `PSModulePath`，查询失败仍为 unknown。

Bridge 只读取官方 builtin/personal provider 配置，不复制、不改写内容，也不将环境或凭据写入任务 metadata。personal 配置的 `config.providerConfigRules.providerRules` 必须为非空数组或对象；已知空 stub 被拒绝。结构验证不能证明 provider 可用或账号有权限。

请求模型时优先保留 catalog 中的精确 provider/model。无前缀旧 provider 只有在 catalog 存在同 model 的 account 前缀项，或官方规则确立了对应 account 映射时才解析；不按模型显示名切换其他 provider，catalog 缺席仍由 `session/setModel` 验证配置标识与模型。`account:` 标识不重复加前缀。请求值与 runtime 确认值分别保留，不持久化为工作区默认。

persisted `runtime-config` 中已知字段只能是字符串或 `null`；缺文件允许环境/发现回退，存在但损坏、非 object 或超过 64 KiB 会报配置错误。当前生产 Bridge 使用 SQLite 唯一 Authority，不保留 JSON 生产路径或故障回退。不能把坏配置当成首次未设置而回退到默认模式。单用户本机 SQLite 的固定受信任档案使用 `yolo`，policy revision 为 `single-user-local-v3`；兼容身份 `local-build-v1` 保留为持久化 profile ID，不再表示强制 `build`。该模式使用当前 Windows 用户权限，workspace/worktree 和路径清单不是 OS 沙箱。

浏览器宿主配置：`ZCODE_BRIDGE_BROWSER_USE` 取 `off`（默认，含空值/未设置/非法值回退为 off）或 `headless`；`ZCODE_BRIDGE_BROWSER_EXECUTABLE` 可选，须为已存在文件的绝对路径，缺省按官方实现解析已安装 Chromium/Edge（不下载浏览器）。两项均为普通字符串配置键，遵循配置优先于环境变量的既有规则；非法 USE 值不阻断任务，仅保持关闭并由 doctor 给出 warning。Detached worker 按显式键清单转发这两项非秘密设置，其余任意父进程环境与秘密仍不透传。Windows worker 环境保留 `ProgramFiles` / `ProgramFiles(x86)` 等非敏感系统目录变量供自动发现使用，发现解析不区分大小写键；显式 `ZCODE_BRIDGE_BROWSER_EXECUTABLE` 优先级不变。不向 app-server 传递任何 headless CLI 参数；浏览器由 worker 内的 managed CDP runtime 以独立临时 profile 启动，生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md)。

执行和模型目录共享同一个 Official Host session factory 及其 ProcessManager/ProtocolClient；模型目录不自行 spawn AppServer、实现 JSON-RPC framing 或返回持久化 Coding Plan API Key。假运行时和合成 Host 测试覆盖调用选择、事件、交互、Cache/alias 和清理；真实协议随安装版本变化，不能把离线收敛扩展为全协议或其他版本认证。

stdout 协议帧与审批持久化边界：换行分隔的完整 JSON-RPC 帧单帧上限 16 MiB 原始未 trim UTF-8 字节，帧顶层必须是对象，致命帧错误锁存原因并终止当次 attempt 的协议流；turn 可见文本另有 2,000,000 字符捕获上限。SQLite request 与私有交互帧使用现有 1 MiB 边界；旧 JSON 事件文件与 `full_request` 文件引用已退役。这些上限是 Bridge 侧守卫，不依赖也不约束 app-server 的内部实现；真实 resume 帧（观测 2,139,927 UTF-8 bytes）在限内正常通过。

真实 Start Plan 权益、真实 Continue、Desktop 完全退出恢复、notLoaded Host Wake、Windows 重启恢复、真实 OAuth refresh/账户轮换和跨机器制品复现的当前状态以 [PROJECT_STATE.md](PROJECT_STATE.md) 为准。
