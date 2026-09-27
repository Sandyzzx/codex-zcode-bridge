# Codex → ZCode Bridge：V0.1 冻结接口

**状态：V0.1 实现范围已冻结**

版本：0.1.0
日期：2026-09-26

所有 MCP 参数名均使用 `snake_case`。未知参数一律拒绝。实现可以增加内部字段，但 V0.1 不得修改工具名称、必填字段、状态名称或结果语义。

## 共享类型

```ts
export type TaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "waiting_for_master";

export interface TaskPackage {
  task_id: string;
  workspace: string; // 已存在目录的绝对路径
  objective: string;
  requirements: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  test_commands: string[];
  context?: string;
}

export interface TestReport {
  command: string;
  status: "passed" | "failed" | "not_run";
  details?: string;
}

export interface TaskResult {
  task_id: string;
  status: "completed" | "failed" | "cancelled" | "waiting_for_master";
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
  zcode_output: string;
  exit_code: number | null;
  session_id: string | null;
  attempt: number;
  started_at: string | null; // RFC 3339 UTC
  finished_at: string | null; // RFC 3339 UTC
  error_code?: string;
}
```

`TaskResult.status` 只描述 Bridge/ZCode 执行结果。`completed` 不等于 Codex 判定 PASS。`files_changed`、测试和决定字段是从下属 Agent 报告中规范化得到的声明，Codex 必须独立核实。

## MCP 工具

### `zcode_task`

输入必须严格符合 `TaskPackage`。`task_id` 必须匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`，且尚未使用。数组可以为空，但字段必须存在；`workspace` 必填并会被规范化。

返回：

```ts
interface TaskReceipt {
  task_id: string;
  status: "queued" | "running";
  created_at: string;
}
```

Server 会在返回前持久化任务包。如果校验或启动 worker 失败，且已分配任务记录，则返回 MCP 错误并持久化失败详情。

### `zcode_status`

输入：`{ task_id: string }`。

返回：

```ts
interface TaskStatusRecord {
  task_id: string;
  status: TaskStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_pid: number | null;
  zcode_session_id: string | null;
  exit_code: number | null;
  error_code?: string;
  error?: string;
}
```

此工具只报告执行状态，不包含 PASS/FAIL 代码审查结论。

### `zcode_result`

输入：`{ task_id: string }`。终态时返回持久化的 `TaskResult`。尚未进入终态时返回 MCP 错误 `TASK_NOT_FINISHED`；未知 ID 返回 `TASK_NOT_FOUND`。

### `zcode_continue`

输入：

```ts
interface ContinueTaskInput {
  task_id: string;
  feedback: string;
  additional_requirements?: string[];
}
```

只允许从 `completed`、`failed` 或 `waiting_for_master` 状态续作。复用 task ID 和 workspace，增加 `attempt`，并保留之前的结果，返回 `TaskReceipt`。新 prompt 会包含原任务、之前的规范化结果、反馈和附加要求。ZCode 标记的决定不会由 Bridge 自动批准；Codex 必须提供后续指令。

### `zcode_cancel`

输入：`{ task_id: string }`。仅允许在 `queued` 或 `running` 状态调用。返回更新后的 `TaskStatusRecord`。运行中取消只有在确认整个进程树已终止后才返回；若无法确认，任务保持非终态并记录取消错误。

## 编码 Agent 适配器契约

```ts
export interface WorkspaceRef {
  readonly requestedPath: string;
  readonly canonicalPath: string;
  readonly mode: "direct";
}

export interface AgentHandle {
  readonly taskId: string;
  readonly attempt: number;
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly startedAt: string;
}

export interface AgentRunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly sessionId: string | null;
  readonly response: string | null;
  readonly usage: Record<string, unknown> | null;
  readonly timedOut: boolean;
}

export interface AgentProcessStatus {
  readonly state: "starting" | "running" | "exited" | "unknown";
  readonly workerPid: number;
  readonly zcodePid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface CodingAgentAdapter {
  startTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
  }): Promise<AgentHandle>;
  continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle>;
  getStatus(handle: AgentHandle): Promise<AgentProcessStatus>;
  getResult(handle: AgentHandle): Promise<AgentRunOutcome>;
  cancelTask(handle: AgentHandle): Promise<void>;
}
```

Bridge 的 `TaskManager` 负责公开状态和持久化；adapter 的状态/结果是 runtime 证据，不能决定代码是否正确。`WorkspaceProvider` 提供 `resolve(workspacePath): Promise<WorkspaceRef>` 和 `release(ref): Promise<void>`；Direct V0.1 的 release 是空操作。

```ts
export interface TaskManager {
  createTask(task: TaskPackage): Promise<TaskReceipt>;
  getStatus(taskId: string): Promise<TaskStatusRecord>;
  getResult(taskId: string): Promise<TaskResult>;
  continueTask(input: ContinueTaskInput): Promise<TaskReceipt>;
  cancelTask(taskId: string): Promise<TaskStatusRecord>;
}

export interface WorkspaceProvider {
  resolve(workspacePath: string): Promise<WorkspaceRef>;
  release(workspace: WorkspaceRef): Promise<void>;
}

export interface RuntimeResolver {
  resolve(): Promise<ZCodeRuntimeConfig>;
}

export interface ZCodeRuntimeConfig {
  readonly nodeExecutable: string;
  readonly zcodeEntrypoint: string;
  readonly providerBuiltinConfigFile: string;
  readonly providerPersonalConfigFile: string;
  readonly dataRoot: string;
}
```

`RuntimeResolver` 将 `ZCODE_BRIDGE_NODE`、`ZCODE_BRIDGE_ZCODE_CJS` 和 `ZCODE_BRIDGE_DATA_DIR` 作为可选 Bridge 覆盖项。Provider 配置从成对继承的官方环境变量获取，或从 ZCode 安装位置及 `ZCODE_DATA_BASE_DIR` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 解析。解析器会验证路径，但不会暴露文件内容。Worker 获得解析后的路径，并只向 ZCode 子进程注入两个官方 provider 环境变量。

## 下属 Agent 结构化报告

Prompt 要求 ZCode 在 `response` 中返回一个 JSON 对象：

```ts
interface AgentReport {
  summary: string;
  files_changed: string[];
  tests: TestReport[];
  issues: string[];
  needs_master_decision: boolean;
}
```

Adapter 先解析 CLI JSON envelope，再将 `response` 解析并校验为 `AgentReport`。如果 response 无效，则保留原始输出、设置 `invalid_agent_report`，并将运行标记为需要审查的失败。缺少数据时绝不能合成 `needs_master_decision: false`。

## 持久化契约

```text
<bridge-data-root>/.tasks/<task_id>/
  task.json
  status.json
  stdout.log
  stderr.log
  result.json       # 仅在任务进入终态后写入
  attempts/         # 每次 attempt 的不可变 prompt/result 元数据
```

Store 对 JSON 记录执行原子写入。日志采用 UTF-8、有字节上限并分开保存。不得持久化密钥或完整环境变量。
