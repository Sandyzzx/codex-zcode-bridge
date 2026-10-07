# ZCode Desktop 任务列表刷新机制调查

> Status: RESEARCH
> Date: 2026-09-28
> 研究结论，不代表当前实现。观测版本 ZCode Desktop 3.14.3.7762 / CLI 0.16.9。

调查日期：2026-09-28
调查分支：`phase7-live-progress`（本文档为 Phase 6/7 前置研究交付物）

## 0. 证据等级与来源

| 等级 | 含义 |
|---|---|
| **VERIFIED_SOURCE** | 官方源码 `zai-org/ZCode`（克隆于 `D:\zcode-official-src`，`package.json` version **3.14.3**）中直接读到，含文件与符号名。 |
| **VERIFIED_RUNTIME** | 在本机（ZCode Desktop 3.14.3.7762 / CLI 0.16.9）只读检查实际数据文件或进程行为证实。 |
| **INFERRED** | 由 VERIFIED 事实按代码逻辑推导，未单独运行验证。 |
| **UNVERIFIED** | 有待验证的开放问题。 |

版本对齐说明：官方仓库 `package.json` version `3.14.3` 与本机安装的 Desktop `3.14.3.7762` 主版本一致（VERIFIED_RUNTIME），因此上游源码与本机分发实现高度对应；升级后需按第 7 节清单重新核验。

---

## 1. 官方架构（VERIFIED_SOURCE）

Desktop 是 Electron 应用，任务列表逻辑分三层：

- **Renderer**（`packages/ui`、`packages/desktop/src/renderer`）：React + 自研 zustand/module store（无 react-query/rtk-query）。
- **Host**（`packages/desktop/src/host`，Electron utilityProcess）：持有全部服务实现；Renderer 通过 Electron MessagePort RPC 调用（`InternalChannels.ServicePort = "zcode:service-port"`，`packages/shared/src/channels.ts`；`packages/rpc/src/proxy-channel.ts` 将 `onDynamic*` 方法自动识别为事件流）。
- **Agent runtime**：Host 按 workspace 以 stdio 子进程方式拉起 `zcode.cjs app-server --stdio`（`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:369`）。**仅 stdio，无外部可连接端口**；本 Bridge 的 app-server 与 Desktop 的 app-server 是两个独立进程。

两个关键服务：

- `IZCodeTaskService`（channel `"zcode-task"`，接口 `packages/services/src/session/zcodeTaskService.ts:199`，实现 `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`）——task 索引的读写面。
- `IWindowControllerService`（channel `"window-controller"`，实现 `packages/desktop/src/host/windowHostControllerService.ts`）——为 Renderer 聚合任务列表投影并推送帧。

## 2. 任务列表调用链（VERIFIED_SOURCE）

Renderer 侧有两条并行数据面（均在 `packages/ui/src/WorkspaceSidebar.tsx` 挂载）：

### 数据面 1：v4 Controller 投影（Timeline / Pinned / Archived 区块）

```text
WorkspaceTimelineTasksSection.tsx / WorkspacePinnedTasksSection.tsx / WorkspaceArchivedTasksFlatSection.tsx
  ↓ useGlobalTaskList()                       (packages/ui/src/hooks/useGlobalTaskList.ts)
  ↓ windowControllerTaskListRegistry          (packages/ui/src/v4/windowControllerTaskListRegistry.ts, useSyncExternalStore)
  ↓ IWindowControllerService.listTaskList / subscribeControllerV4 / onDynamicControllerFrame
  ↓ [MessagePort RPC]
  ↓ createWindowHostControllerRuntime         (packages/desktop/src/host/windowHostControllerService.ts:137)
      listTaskList → refreshSource → readSourceTaskIndex(:345)
        → zcodeTaskService.listTasks / listPinnedTasks / listArchivedTasks   ← 每次都直读 SQLite
      → windowHostControllerProjection        (packages/desktop/src/host/windowHostControllerProjection.ts:196)
        topics "controller/tasks-index"、"controller/workspaces"；delta: task.upserted / task.removed
```

注意：Renderer 的 `list()` 只有在 version key（`taskListVersionSignature` / `workspaceSourceGenerationSignature` / `manualRefreshSerial`，`windowControllerTaskListRegistry.ts:56-65`）变化时才重新 RPC；纯 activity 帧复用缓存。

### 数据面 2：workspace 行列表（默认任务列表主视图）

```text
WorkspaceSidebar.tsx:630
  ↓ useWorkspaceTaskLists()                   (packages/ui/src/hooks/useWorkspaceTaskLists.ts:195)
  ├─ useWorkspaceSessionsIndexItems()         (packages/ui/src/v4/useWorkspaceSessionsIndexItems.ts)
  │    → agentService.subscribeSessionsIndexV4(topic "sessions-index/<workspaceKey>")
  │    → SessionsIndexStore → ZCodeTaskMeta[]（活动/detail 层）
  ├─ fetchTaskListMembershipSets              (packages/ui/src/lib/taskListMembershipSets.ts:211)
  │    → zcodeTaskService.listTasks / listPinnedTasks / listArchivedTasks  ← 直读 SQLite
  ├─ buildTaskListResult                      (packages/ui/src/v4/buildTaskListResultFromSessions.ts:170)
  │    “以 tasks-index 行为左表做字段级 join……session-only 冷摘要不会进入持久列表”(:77-78)
  ↓ taskQueryCacheStore (zustand) → TaskList.tsx 行渲染
  订阅：zcodeTaskService.onDynamicWorkspaceEvent → 事件 "workspace_task_list_changed"
```

### Host 侧事件源头（`workspace_task_list_changed`）

- 发射器：`emitWorkspaceTaskListChanged`（`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:460-499`）。
- 触发点只有两类（VERIFIED_SOURCE，全仓库枚举）：
  1. **Host 自身写入**：adapter 的 createTask/deleteTask/renameTask/pin/archive/终态迁移等（`zcodeTaskServiceAdapter.ts:1912,2128,2862,2974,…`）；
  2. **`ZCodeTaskIndexSyncer` 摄取本 workspace 自属 app-server 的 `sessions-index/<workspaceKey>` V4 topic**（`zcodeAgentService.ts:5494` 订阅；`zcodeTaskIndexSyncer.ts:1437`）。
- 跨窗口转发（`taskRealtimeBridge.ts`）只转发应用内产生的事件。

## 3. 持久化（VERIFIED_RUNTIME + VERIFIED_SOURCE）

### tasks-index.sqlite（Desktop 任务列表唯一真相源）

- 路径：`getAppConfigDir() = getZCodeDataRootDir()/v2`（`packages/services/src/paths.ts:53`）→ 本机 Desktop 实际为 **`D:\Program Files\.zcode\v2\tasks-index.sqlite`**（VERIFIED_RUNTIME：活动 WAL，159 行）。
- schema：`packages/services/src/session/tasksDatabase/schema-v1.ts` + 迁移 `0001`–`0003`（`migrations.ts`），`tasks` 表主键 `(workspace_key, task_id)`，列含 `workspace_path/workspace_identity/task_id/title/task_status/provider/mode/model/created_at/updated_at/unread_at/pinned/archived/deleted/title_overridden/meta_json/searchable_text/cron_automation_id/off_peak_task_id`。本机实际 schema 与源码完全一致（VERIFIED_RUNTIME，PRAGMA 只读比对）。
- **workspace_key**：`resolveWorkspaceKey = workspaceIdentity?.trim() || workspacePath`（`packages/shared/src/task-realtime-core.ts:78-83`）→ 本地为项目根路径原文。本机行证实：Bridge 注册的任务以 `D:\codex-zcode-bridge` 为 key 分组（VERIFIED_RUNTIME）。
- **provider 过滤**：Desktop 所有列表查询按 `provider = "glm"` 过滤（`ZCODE_AGENT_PROVIDER = "glm"`，`packages/shared/src/zcode-agent-policy.ts:5`；adapter 各 list 方法传 `GLM_PROVIDER`）。Bridge 已写 `provider: "glm"`，匹配。
- 读写实现：`TaskIndexRepo`（`taskIndexRepo.ts`）持有单条长连 `node:sqlite DatabaseSync`，**无结果缓存**，每次 `listTasks/listPinnedTasks/listArchivedTasks/queryTaskList` 都实时执行 SQL（VERIFIED_SOURCE）。

### CLI session store（所有 app-server 进程共享）

- 路径硬编码 `os.homedir()/.zcode/cli/db/db.sqlite`（`apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts:6-8`），**不受 ZCODE_HOME/ZCODE_DATA_BASE_DIR 影响** → Desktop 与 Bridge 的 app-server 进程写同一个库（本机：`C:\Users\Sandy\.zcode\cli\db\db.sqlite`）。
- `session` 表含 `id/project_id/workspace_id/directory/title/task_type/taskTypes…`；行落库时机：首条输入 / 外部活动 / 启动轮 / 冷恢复（`apps/zcode-cli/packages/core/src/runtime/methods/events.ts:583-600`）。

### “sessions-index” 不是文件

全仓库不存在 `sessions-index.sqlite`。它是 **V4 协议 topic** `sessions-index/<workspaceId>`（`packages/shared/src/zcode-protocol-v4/sessions-index.ts:76-78`）+ 每个 app-server 进程内的内存投影（`SessionsIndexPublisher`，`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-publisher.ts`），冷种子读共享 session store。

## 4. 刷新机制（核心问题的答案）

### 4.1 不存在的机制（均 VERIFIED_SOURCE，全仓库枚举为负）

- ❌ **无文件监听**：`fs.watch` 仅用于 renderer 的文件树/工作流目录/PPTX 监视；没有任何代码 watch `~/.zcode` 数据目录或 tasks-index.sqlite；无 chokidar。
- ❌ **无 tasks 表轮询**：唯一 20s 轮询器是 cron 调度 utilityProcess（`packages/desktop/src/scheduler/index.ts:33`），只读 `automations/automation_runs/off_peak_tasks`，不读 `tasks`，也不驱动列表。
- ❌ **无窗口 focus/visibilitychange 刷新**。
- ❌ **无跨进程推送**：sessions-index 只在单进程内 fanout（`v4-gateway.ts` `flushIndex`）；`ensureIndexPublisher` 缓存 publisher，进程存活期间**不重读共享 store**（`v4-gateway.ts:1206-1209`）。

### 4.2 存在的刷新触发器（Renderer 侧实测路径，VERIFIED_SOURCE）

| 触发器 | 路径 | 对外部写入行有效？ |
|---|---|---|
| 挂载/查询变化/workspace 切换 | `useGlobalTaskList`、`useWorkspaceTaskLists` 重新 load | ✅（listTasks 实时读 SQLite） |
| `workspace_task_list_changed` 事件（reason ∈ task_created / task_archived / task_unarchived / task_pinned / task_unpinned / task_meta_changed / task_deleted；**显式排除 task_status_changed、task_model_changed**，`packages/ui/src/lib/taskListRefreshPolicy.ts:35-48`） | `useWorkspaceTaskLists.ts:676-713` bump membershipVersion + markStale → refresh | ✅（但事件只能由 Host 自身写入产生） |
| **sessions-index 内容变化**（本 workspace 任意原生 session 的 prompt 开始/标题更新/turn 完成/终态，ModelStreaming 被跳过，`v4-gateway.ts:1080-1089`） | `useWorkspaceTaskLists.ts:622-676` diff 变化 workspace → `markTaskQueryCacheScopesStale` → refresh → **listTasks 实时重读 SQLite** | ✅ **这是活动 workspace 上外部写入行的自然可见通道**（INFERRED：链路各环节均 VERIFIED_SOURCE，端到端未单独实测） |
| Host 侧 workspace 事件 | `windowHostControllerService.ts:318-335` → refreshSource(force) → 投影帧 | ✅ |
| 手动 `refresh()` / 删除归档后回调 | `useGlobalTaskList.ts:183-191` | ✅ |

### 4.3 官方外部触发器（second-instance，VERIFIED_SOURCE）

`packages/desktop/src/main/desktopSecondInstanceDeepLink.ts` + `desktopOAuthDeepLink.ts:188`：

- 运行中的 Desktop 收到第二实例启动时（Electron `requestSingleInstanceLock`，`main/index.ts:1886-1899`）：
  - **argv 形式**：`ZCode.exe --open-workspace "<绝对路径>"` → `handleOpenWorkspacePath` → 校验目录存在 → `webContents.send(PlatformChannels.OpenWorkspacePath, path)` → Renderer 打开/切换该 workspace（**无确认对话框**）；
  - **deep link 形式**：`zcode://workspace/open?path=<编码路径>` → `handleDeepLink`（带信任确认对话框）→ 同上。
- 打开/切换 workspace 必然重挂载任务列表 → 两条数据面重新 `listTasks` → SQLite 中的外部行立即可见。
- 若 Desktop 未运行，同一命令会正常启动它（第二实例语义不成立）——调用方需自行判断（INFERRED）。

### 4.4 结论（对第三阶段选项的裁决）

**对“外部进程直写 tasks-index.sqlite”这一事件源，当前版本是 F（无任何官方监听/轮询/推送）**；但 Desktop 的自然活动（同 workspace 任意原生 session 的 turn 边界、workspace 切换/重开）会周期性触发对 SQLite 的实时重读，外部行随之出现（4.2 表第 3 行）。**存在一个官方、无重启、非 UI 自动化的确定性触发器：`--open-workspace` second-instance argv（4.3）。**

## 5. 外部 session 与 Desktop session 的差异（Phase 4/5）

Desktop 原生路径（`createTask`，VERIFIED_SOURCE）：

```text
renderer/automation 发起
  → zcodeTaskServiceAdapter.createTask (:1775)
      → v4 createSession / zcodeAgentService.createSession（本 workspace 的 app-server）
      → syncTaskIndexMeta (:1893) → taskIndexRepo.initializeGroupedTaskAtTop (:1899)
      → emitWorkspaceTaskListChanged(…, "task_created") (:1912)
  → Renderer 立即刷新（数据面 2 事件 + 数据面 1 refreshSource）
```

Bridge 外部路径：session 经**自己的** app-server 进程创建：

1. session 行落共享 `~/.zcode/cli/db/db.sqlite`（首条输入即落；legacy `session/create` 传 `persistence:"immediate"` 更早；V4 `persistence:"deferred"` 首条 prompt 才落）。
2. Desktop 的 app-server **存活期间不重读该 store** → 不会出现在其 sessions-index → `ZCodeTaskIndexSyncer` 不会写入/发事件 → 列表不更新。
3. 只有当 Desktop 侧该 workspace 的 runtime **重启/重建**（进程回收、`restartWorkspaceProcess`、workspace 重开、Desktop 重启）时，sessions-index 冷种子 `getStoredSessionSummaries`（`v4-bridge.ts:1352-1428`：按 `directory = workspacePath`、`taskTypes ∈ {interactive, fork, workflow_parent}`、未归档、limit 200）才会看到 Bridge session → `seedMissingRowsFromInitialSnapshot`（`zcodeTaskIndexSyncer.ts:1015-1020`）补写 tasks-index → 发 `task_created` → 列表刷新。
4. 因此 **V4 conversation 创建本身不会让运行中的 Desktop 发现外部任务**；V4 与 legacy 最终写同一 store，差别只在落库时机。这是“Bridge 建的 session 不自动出现”的根本原因。

## 6. 推荐集成（按侵入度排序）

| # | 机制 | 侵入度 | 证据 | 采纳 |
|---|---|---|---|---|
| 1 | **保持现状：按官方 schema 直写 tasks-index**（workspace_key=项目根、provider=`glm`、title/task_status/meta_json 与 Desktop 写法一致） | 低（已实现并已在生产 DB 验证） | VERIFIED_RUNTIME（DB 中已有 PROMPT_DECISION_E2E_* 等行） | ✅ 保留 |
| 2 | **官方确定性触发器：`--open-workspace` second-instance**（Desktop 在运行时转发给运行实例打开/切换 workspace → 立即重读列表；未运行时等同启动 Desktop，需自行守卫） | 低（官方入口，非 UI 自动化、无重启、无注入） | VERIFIED_SOURCE；runtime 冒烟见第 8 节 | ✅ 新增 `ZCodeDesktopIntegration`/`DesktopTaskRefresh` 组件封装 |
| 3 | **依赖 Desktop 自身 seed**（runtime 重启/重开 workspace 时从共享 db.sqlite 自动收养 Bridge session） | 零（纯官方行为，无需 Bridge 动作） | VERIFIED_SOURCE | ✅ 作为 #1/#2 的自然兜底；两者行身份一致（task_id=sess_*），`seedTaskMetaIfMissing` 不会重复建行 |
| 4 | 注入 Electron / 补丁 Desktop / 重启 / 模拟按键 | 高 | — | ❌ 禁止 |

架构落点（遵守冻结契约）：SQLite 写入继续留在 `ZCodeAdapter` → `task-index-sync.ts`（MCP 面五工具不变）；新增触发逻辑独立成 `ZCodeDesktopIntegration`（或 `DesktopTaskRefresh`），通过 `zcode_events` 暴露 `desktop_refresh_triggered` 事件，不新增 ZCode 私有协议到 MCP API。

约束提示：#1 属于“直写 ZCode SQLite”类别，按 Decision Gate 在此显式报告——它是本仓库既有、已交付的能力（commit 5aeb2cb），非本次新增；本次新增的只有 #2 官方触发器。多控制器安全：Desktop 仅作 Viewer；点击列表中的 Bridge 任务会在 Desktop 侧 resume 该 session，需用户自行避免双写（第 7 节风险）。

## 7. 兼容性风险

- app-server 协议与 tasks-index schema 均为**版本相关私有接口**（官方源码将打包 app-server 定位为 Desktop host 内部协议）。本结论绑定 3.14.3；升级后必须重验：schema 列集（`requireTaskTable` 已守护）、provider 过滤值、`resolveWorkspaceKey` 语义、sessions-index topic/seed 行为、`--open-workspace` argv 与 deep link 格式。
- `task_status_changed` 被排除在列表刷新原因之外（`taskListRefreshPolicy.ts`）：Bridge 后续的纯状态更新不会触发刷新——由 #2 触发器或用户自然活动覆盖。
- sessions-index 冷种子按 `directory` 精确匹配 workspacePath 且 limit 200：依赖 #3 时，Bridge session 的 cwd 必须与 Desktop 打开的目录逐字一致（大小写/分隔符）。
- 点击列表行会让 Desktop resume 该 session（Viewer 变 Controller 风险）：本文档不建立多控制器安全，仍按“Session Ownership”约束禁止从 Desktop 发 prompt。
- `--open-workspace` 依赖 Electron 单实例锁语义；Desktop 未运行时该命令会冷启动 Desktop（INFERRED，未实测冷启动分支）。

## 8. 冒烟记录：TASK_DESKTOP_REFRESH_SMOKE（2026-09-28）

### 8.1 执行方式

- 通过生产入口驱动真实 Bridge 流程：`node plugins/codex-zcode-bridge/server/bridge.mjs`（stdio MCP，`ZCODE_BRIDGE_PLUGIN_MODE=1`，data root `C:\Users\Sandy\.codex\codex-zcode-bridge`），由驱动脚本以官方 MCP SDK v2 Client 调用 `zcode_task` → `zcode_events`（长轮询）→ `zcode_status` → `zcode_result`，与 Codex 调用方式一致。
- 执行目录（`worktree_path`）为一次性隔离仓库 `C:\Users\Sandy\AppData\Local\Temp\zcode-desktop-refresh-smoke\repo`（git init + 1 commit）；用户源码仓库零写入（clone/读操作除外）。objective 为只读任务（git log + 禁止改文件）。
- 排障记录：首次尝试误用 dist 构建 + `ZCODE_BRIDGE_PLUGIN_MODE=1` 组合，`spawn-worker.ts` 的 `workerEntryPath()` 在 plugin 模式下解析到 `dist/src/worker/worker-main.mjs`（不存在）→ worker 秒退 → `worker_lost`。该组合无效，插件模式必须配 bundled `server/bridge.mjs`。

### 8.2 结果

| 记录项 | 值 |
|---|---|
| Bridge task ID | `TASK_DESKTOP_REFRESH_SMOKE` |
| ZCode session ID | `sess_bc486102-1b74-4db9-85d4-ad571a850582` |
| 模型 | `account:bigmodel-individual-coding-plan/GLM-5.3`（session snapshot 报告） |
| workspace（分组键） | `D:\codex-zcode-bridge`（= `workspace_key`，项目根） |
| 执行目录 | `C:\Users\Sandy\AppData\Local\Temp\zcode-desktop-refresh-smoke\repo`（= `workspace_path`） |
| 注册事件 | `desktop_task_registered`（events seq 8），task-index 写入成功 |
| task-index 记录 | `tasks` 表新行：provider `glm`、mode `yolo`、task_status `completed`、archived/deleted 0（VERIFIED_RUNTIME，只读查询） |
| 共享 session store | `C:\Users\Sandy\.zcode\cli\db\db.sqlite` `session` 行：`directory`=执行目录、`task_type=interactive`（第 6 节 #3 兜底前提成立） |
| 任务结果 | completed；报告确认未改动任何文件；`needs_master_decision=false` |

**附注（副作用披露）**：tasks-index 中另有一行 `sess_a283caef-…`（同名、16:54:10 创建、completed）——源于排障时手工执行 `node dist/src/worker/worker-main.js <dataRoot> TASK_DESKTOP_REFRESH_SMOKE`：TS 版 run-task **不拒绝已终态任务**，把失败任务重跑了一次（同样只读、同样在隔离目录完成）。这是一个值得记录的 Bridge 健壮性缺口：终态任务缺少重入守卫。

### 8.3 运行中的 Desktop 观察结果（VERIFIED_RUNTIME）

- Desktop 全程保持运行（未重启）。Host 日志 `D:\Program Files\.zcode\v2\logs\2026-09-28.log`：
  - 行插入（00:55:25 本地时间）之后、外部触发之前，`window-controller.listTaskList OK` 被自然调用 **47 次**（00:55:25–00:58:10，同 workspace 原生 session 活动驱动）——每次调用按源码语义实时重读 tasks-index（`readSourceTaskIndex` → `listTasks` 等直读 SQLite）。
  - 外部触发后 2 秒内再次出现成簇 `listTaskList` 调用。
- 官方触发器验证：`ZCode.exe --open-workspace "D:\codex-zcode-bridge"` → 运行实例日志 `[deep-link] 工作区打开请求路由成功 {"windowId":1,"path":"D:\\codex-zcode-bridge"}`，随后 listTaskList 重读；第二实例自行退出（单实例锁）。无对话框、无重启、无 UI 自动化。
- **UI 呈现（INFERRED→待用户确认）**：源码保证每次 listTaskList 读出的行进入侧栏投影（数据面 1 快照帧 + 数据面 2 查询缓存）；两条 `TASK_DESKTOP_REFRESH_SMOKE` 任务应已出现在 `codex-zcode-bridge` 工作区任务列表中。请用户目视确认作为最终闭环。

## 9. 运行记录

见第 8 节。核心结论一句话回答：**在 3.14.3 架构下，外部进程没有任何受支持的“推送刷新”通道；最干净的机制是——按官方 schema 直写 tasks-index（现状），运行中的 Desktop 会在同 workspace 原生 session 的每个 turn 边界自然重读该库（活动工作区近似实时）；需要确定性即时可见时，使用官方 second-instance 入口 `ZCode.exe --open-workspace <workspace>` 让运行中的 Desktop 重新打开该工作区。**
