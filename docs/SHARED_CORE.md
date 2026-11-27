# 共享核心与宿主适配

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable 2.0.0 的 `src/core.ts` 导出、Host/Worker 入口、共享 Official Host session factory、动态 Provider capability 检查、生产 Runtime Auth fail-closed、插件 BOM/生成物校验、Runtime Events 边界、Thin MCP、独立 Executor 与官方运行期 Registry；外部 fork 实际升级仍为 `NOT_RUN`。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`（`codex-zcode-bridge-v2.0.0`）

公共入口为 `codex-zcode-bridge/core`（`src/core.ts`），无服务器启动副作用，构建同时输出类型声明。项目为 private，尚未发布独立 npm 包；本地 npm pack/fork 消费仍是公共兼容边界。

## 当前入口

正常插件使用 `startBridge(profile, version)`。它只启动 Thin MCP：解析 Authority Root、创建 `ExecutorControlClient`、注册现有 MCP 工具并转发 Task/Doctor/model 操作。SQLite Manager、Fresh Bootstrap、Worker spawn、Official Runtime 和 Executor shutdown 由独立 Executor 持有；MCP stdio 断开只结束请求等待，不取消已受理 Task。Host profile 显式指定 `name`、`settingsDirectory`、`workerEntryPath` 和 `instructions`；所有路径必须为绝对路径。任务 prompt 与 MCP 工具不硬编码调用宿主。

```ts
import { startBridge } from "codex-zcode-bridge/core";
await startBridge({
  name: "calling-host",
  settingsDirectory: absoluteSettingsDirectory,
  workerEntryPath: absoluteBundledWorker,
  instructions: hostInstructions,
}, hostVersion);
```

嵌入式消费者仍可使用公开 `SqliteLifecycleMcpAuthority.create(options)` 创建兼容 Manager，再交给 `createBridgeServer({taskManager})`。创建需要现有受信任本地 Host context、合适的 SQLite 根、Worker/Bridge provenance 和 receipt；普通 MCP/TaskPackage 不能自行产生这些能力。该嵌入式入口不进入 shipped `bridge.mjs`，也不能成为第二个生产 Authority。准确参数类型由导出的 `SqliteAuthorityOptions` 提供。多数 fork 应启动或连接 Executor 并使用 `startBridge`。

Worker 必须打包 `src/worker/worker-main.ts`，保留同一 SQLite Bootstrap/Claim 私有管道协议。不能使用旧的 `dataRoot taskId attempt` 参数启动；不能从 prompt 或自定义 runner 绕过 Claim。Host manifest、安装 hook、版本、settings 和打包由 fork 独立维护。Worker 的模型执行入口是 `OfficialAppServerWorkerAdapter`；它和 Host 的模型目录共用 `createInstalledOfficialHostSessionFactory`，并以安装版官方 AppServer 作为唯一 Runtime。Adapter 在 `session/create` 后读取 Runtime 实际选择的 Provider/Model，结合官方 Provider registry 与当前账户配置执行 capability gate，然后才订阅或发送 Turn。

公共 Core 不导出 `renderTaskFeedback`、A4 `renderFeedback`/格式化函数、Codex Master/Rollout Token source 和 Ledger 类型/入口。`ZCodeAppServerAdapter` 也不再从 Core 导出；direct stdio 只保留内部 `ZCodeAppServerTestAdapter`，不能作为生产执行入口。生产 Official Host 的 Provider Runtime Auth 缺少 resolver 或 resolver 失败时 fail closed，不读取持久化 API Key 作为回退；旧静态凭据回包只存在于显式 Test Adapter。`buildTaskFeedbackSnapshotV01`、`normalizeUsage`、Host/Worker 启动入口、SQLite Manager、MCP server 与任务 Result/Observation 类型继续保留。仓库内调用者和生成的插件 bundle 已迁移；外部 fork 是否仍导入这些旧导出为 `NOT RUN`，升级前必须用自身构建与测试确认。

## 主版本兼容性

TaskStore、旧 BridgeTaskManager/TaskManagerOptions、`createWorkerSpawner`、`runWorkerTask`/`RunWorkerTaskOptions`、`buildTaskObservation` 已删除。旧 store/workspaceProvider/spawnWorker 构造参数、自定义 JSON Worker 与这些导出的消费者需要迁移；不存在保留旧运行时的兼容包装。`startBridge`、MCP 工具及 schema、TaskPackage/TaskResult、32 MiB/v14、纯 feedback/observation/usage 与进程身份导出继续保留。`DirectWorkspaceProvider` 是小型独立路径工具，保留其已公开入口；生产 Manager 直接使用 SQLite Admission 的路径验证。

Stable 2.0 已落地这一破坏性迁移。外部 fork 若仍消费旧 Core 导出，应锁定 1.x 制品，迁到 `startBridge` 或 `SqliteLifecycleMcpAuthority.create()` 后再升级 2.x。外部 dsh/fork 代码及部署没有在本轮修改或认证；它们可以锁定旧核心制品，准备好后迁移到 SQLite Host，不能宣称外部 API 已无消费者。

## 设置与打包

Codex 默认设置目录为 `~/.codex/codex-zcode-bridge`。`runtime-config` 优先于环境；显式 `legacySettingsDirectories` 仍支持模型设置升级，缺文件才回退，损坏文件报错，写入只发生在 canonical 目录并保留未知字段。这是用户安装兼容，不是旧 Task Authority。

标准插件自包含 Bridge、Worker、Thin Waiter、Schema、固定 Official Host 模块与安装版 runtime 校验。`worker/vendor/official-host/...` 不再包含 AppServer bundle 或 builtin Provider 配置；所有 Provider 从安装版官方路径读取 AppServer。浏览器 backend 位于 `worker/vendor/`，固定 `playwright-core` 1.64.0。`build:core` 不含浏览器 vendor，未重新打包的 fork 需要保留编译后的 browser runtime 与声明依赖；自定义打包必须保留等价的 Official Host 资源布局和 Worker-shaped URL 解析。

Core 无启动副作用、宿主 settings 隔离、MCP 身份/instructions、Worker 环境与无 production dist 的干净安装由现有回归覆盖。真实外部 Host、跨 Host 控制、真实 Provider 容量与 Desktop UI 仍须独立验收；不能由本文件的公开入口或离线测试推断。
