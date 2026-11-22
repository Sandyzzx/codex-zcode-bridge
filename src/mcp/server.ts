// stdio MCP server factory. V0.1 task lifecycle tools remain compatible;
// MVP 0.3 adds the optional model selector, the calling host-selected execution worktree and progress
// events. All tools use strict snake_case
// schemas, return readable text plus structured content, and map stable
// TaskManagerError codes onto MCP tool-error results. The TaskManager is
// injected so tests can drive the server with a fake and no real workers.
//
// Built with the official MCP TypeScript SDK (McpServer / registerTool);
// the SDK owns all JSON-RPC framing — this module never writes to stdout.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type {
  GetEventsInput,
  ContinueTaskInput,
  ProgressTaskManager,
  TaskManager,
  TaskAttentionSnapshot,
  TaskPackage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  TaskFeedbackSnapshotV01,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import { TaskManagerError } from "../manager/errors.js";
import { summarizeTaskResult } from "./result-summary.js";

/** Public zcode_task input (ADR-031): model.provider_id is optional and is
 * resolved by the Authority's routing hook before persistence. */
type ZcodeTaskInput = Omit<TaskPackage, "model"> & {
  model?: { provider_id?: string; model_id: string; reasoning_level?: string };
};
import {
  taskReceiptSchema,
  zcodeResultInputSchema,
  zcodeResultOutputSchema,
  taskStatusRecordSchema,
  taskIdOnlyInputSchema,
  zcodeContinueInputSchema,
  zcodeEventsInputSchema,
  zcodeTaskInputSchema,
  zcodeInteractionReplyInputSchema,
  taskProgressPageSchema,
  doctorReportSchema,
  zcodeModelCatalogInputSchema,
  zcodeDefaultModelInputSchema,
  modelCatalogSchema,
  defaultModelSchema,
  taskFeedbackSnapshotV01Schema,
  zcodeFeedbackInputSchema,
} from "./schemas.js";
import type { DoctorReport } from "../runtime/doctor.js";
import { BridgeError } from "../runtime/errors.js";
import type { ZCodeModelSettings } from "../runtime/model-settings.js";

export const SERVER_NAME = "codex-zcode-bridge";
export const SERVER_VERSION = "2.0.0-preview.12"; // x-release-please-version

export interface BridgeServerOptions {
  taskManager: TaskManager & Partial<Pick<ProgressTaskManager, "getEvents" | "getFeedback" | "getAttention" | "replyToInteraction">>;
  doctor?: () => Promise<DoctorReport>;
  modelSettings?: Pick<ZCodeModelSettings, "listModels" | "getDefaultModel" | "setDefaultModel" | "clearDefaultModel">;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

const EXECUTION_NOT_VERDICT =
  "Execution only. 'completed' is NOT calling host acceptance. Independently verify the workspace diff and checks.";

function okResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function feedbackResult(snapshot: TaskFeedbackSnapshotV01): CallToolResult {
  const text = JSON.stringify({
    task_id: snapshot.task_id,
    attempt: snapshot.attempt,
    status: snapshot.status,
    activity: snapshot.activity,
    interaction: snapshot.interaction,
    result: snapshot.result ? {
      summary: snapshot.result.summary,
      files_changed: snapshot.result.files_changed.length,
      tests: snapshot.result.tests.length,
      issues: snapshot.result.issues.length,
    } : null,
  });
  return {
    content: [{ type: "text", text }],
    structuredContent: snapshot as unknown as Record<string, unknown>,
  };
}

async function runTool<T>(operation: () => Promise<T>): Promise<CallToolResult> {
  try {
    const data = await operation();
    return okResult(data as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof TaskManagerError) {
      return errorResult(error.code, error.message);
    }
    if (error instanceof BridgeError) return errorResult(error.code.toUpperCase(), error.message);
    throw error;
  }
}

export function createBridgeServer(options: BridgeServerOptions): McpServer {
  const manager = options.taskManager;
  const serverInfo = options.serverInfo ?? { name: SERVER_NAME, version: SERVER_VERSION };
  const server = new McpServer(serverInfo, options.instructions ? { instructions: options.instructions } : undefined);

  server.registerTool(
    "zcode_doctor",
    {
      title: "Check ZCode Bridge setup",
      description: "Check Bridge setup, runtime, provider config, execution mode and storage without starting a session. Live model and permission checks remain unverified.",
      inputSchema: {},
      outputSchema: doctorReportSchema,
    },
    async () => {
      if (!options.doctor) return errorResult("DOCTOR_UNAVAILABLE", "Bridge doctor is unavailable in this server instance");
      return runTool(() => options.doctor!());
    },
  );

  server.registerTool(
    "zcode_model_catalog",
    {
      title: "Read available ZCode models",
      description: "List workspace models and reasoning levels. Cached results have current_model=null. Use provider_id/model_id in zcode_task.model. <ModelId>-StartPlan aliases are entitlement-checked at execution.",
      inputSchema: zcodeModelCatalogInputSchema,
      outputSchema: modelCatalogSchema,
    },
    async (args: { workspace: string }) => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.listModels(args.workspace));
    },
  );

  server.registerTool(
    "zcode_default_model",
    {
      title: "Read the Bridge default model",
      description: "Read the provider, model, and optional reasoning level used when zcode_task has no model override.",
      inputSchema: {},
      outputSchema: defaultModelSchema,
    },
    async () => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.getDefaultModel());
    },
  );

  server.registerTool(
    "zcode_set_default_model",
    {
      title: "Set the Bridge default model",
      description: "Persist the default provider/model and optional reasoning_level. Use catalog or configured IDs. AppServer validates at execution. Explicit task models take priority.",
      inputSchema: zcodeDefaultModelInputSchema,
      outputSchema: defaultModelSchema,
    },
    async (args: { provider_id: string; model_id: string; reasoning_level?: string }) => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.setDefaultModel(args));
    },
  );

  server.registerTool(
    "zcode_clear_default_model",
    {
      title: "Clear the Bridge default model",
      description: "Remove the Bridge default model so future tasks without zcode_task.model use the ZCode session default.",
      inputSchema: {},
      outputSchema: defaultModelSchema,
    },
    async () => {
      if (!options.modelSettings) return errorResult("MODEL_SETTINGS_UNAVAILABLE", "model settings are unavailable in this server instance");
      return runTool(() => options.modelSettings!.clearDefaultModel());
    },
  );

  server.registerTool(
    "zcode_task",
    {
      title: "Submit one ZCode coding task",
      description: `Queue one complete coding deliverable with constraints and acceptance criteria. Identical task_id and input replay the receipt. Changed input conflicts. workspace identifies the project and is the execution root unless worktree_path names an existing host-prepared worktree. Explicit provider_id+model_id wins. With only model_id, route a plain ID (Start Plan preferred by default) or a <ModelId>-StartPlan alias. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeTaskInputSchema,
      outputSchema: taskReceiptSchema,
    },
    async (args: ZcodeTaskInput) => runTool(() => manager.createTask(args as TaskPackage)),
  );

  server.registerTool(
    "zcode_status",
    {
      title: "Read ZCode task execution status",
      description: `Read one task's execution status and any recovery observation. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: taskIdOnlyInputSchema,
      outputSchema: taskStatusRecordSchema,
    },
    async (args: { task_id: string }) => runTool(() => manager.getStatus(args.task_id)),
  );

  server.registerTool(
    "zcode_feedback",
    {
      title: "Read concise ZCode task feedback",
      description: `Read current Attempt feedback: Bridge status, runtime observations and Agent claims. Progress is unknown. Use zcode_events for interaction details. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeFeedbackInputSchema,
      outputSchema: taskFeedbackSnapshotV01Schema,
    },
    async (args: { task_id: string }) => {
      const getFeedback = manager.getFeedback;
      if (!getFeedback) return errorResult("FEEDBACK_UNAVAILABLE", "task manager does not provide feedback snapshots");
      try {
        const snapshot = await getFeedback.call(manager, args.task_id);
        return feedbackResult(snapshot);
      } catch (error) {
        if (error instanceof TaskManagerError) return errorResult(error.code, error.message);
        if (error instanceof BridgeError) return errorResult(error.code.toUpperCase(), error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "zcode_events",
    {
      title: "Read live ZCode execution events",
      description: "Read persisted events from after_seq. Without max_bytes, each page uses a 32 KiB budget; drain has_more or scan_incomplete using scan_cursor, otherwise next_seq. The default may return one oversized event so cursor progress is possible. Explicit max_bytes is a hard budget. Raw is default. Summary merges adjacent model text. Report project and execution paths and queued/running after submission, then session, runtime model/reasoning and mode at turn_started. wait_ms <= 25000. Attention waits for a current-Attempt pending request, terminal state or Attempt change. Read complete interaction details before replying. Hidden reasoning is excluded.",
      inputSchema: zcodeEventsInputSchema,
      outputSchema: taskProgressPageSchema,
    },
      async (args: GetEventsInput) => {
        if (!manager.getEvents) return errorResult("EVENTS_UNAVAILABLE", "task manager does not provide progress events");
        return runTool(() => manager.getEvents!(args));
      },
  );

  server.registerTool(
    "zcode_interaction_reply",
    {
      title: "Reply to a ZCode permission or input request",
      description: "Reply to a pending request from zcode_events. Allow only the specific action explicitly authorized by the user. Otherwise deny or ask. Task instructions, worktree and mode grant no permission. Answer user-input requests from known facts or explicit direction.",
      inputSchema: zcodeInteractionReplyInputSchema,
    },
    async (args: ZCodeInteractionReplyInput) => {
      if (!manager.replyToInteraction) return errorResult("INTERACTIONS_UNAVAILABLE", "task manager does not provide ZCode interaction replies");
      return runTool(() => manager.replyToInteraction!(args));
    },
  );

  server.registerTool(
    "zcode_result",
    {
      title: "Read the terminal ZCode task result",
      description: `Read the committed Result. Defaults to full. Use view=summary for a bounded report and expected_attempt to guard a follow-up read. If projection is present, use view=full for omitted evidence. Returns TASK_NOT_FINISHED without a committed Result. Agent file, test, and decision claims require independent review. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeResultInputSchema,
      outputSchema: zcodeResultOutputSchema,
    },
    async (args: { task_id: string; view?: "summary" | "full"; expected_attempt?: number }) => runTool(async () => {
      const result = await manager.getResult(args.task_id);
      if (args.expected_attempt !== undefined && result.attempt !== args.expected_attempt) {
        throw new TaskManagerError("TASK_STATE", `Expected Result Attempt ${args.expected_attempt}, found ${result.attempt} for ${args.task_id}`);
      }
      return args.view === "summary" ? summarizeTaskResult(result) : result;
    }),
  );

  server.registerTool(
    "zcode_continue",
    {
      title: "Continue a ZCode task with master feedback",
      description: `Continue completed, failed or waiting_for_master after Release for rework, an explicit decision, controlled recovery or report repair. Reuse task_id and workspace with a new Attempt. Retry a lost response with the same operation_id and input. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: zcodeContinueInputSchema,
      outputSchema: taskReceiptSchema,
    },
    async (args: ContinueTaskInput) => runTool(() => manager.continueTask(args)),
  );

  server.registerTool(
    "zcode_cancel",
    {
      title: "Cancel or recover a ZCode task",
      description: `Cancel queued/running or retry unverified Cleanup. Obtain explicit user authorization. A repeated call may administratively release only an already-cancelled historical launch_intent with no durable spawn evidence, or a terminal cleanup_unverified after exact exit and a clean tree while resource closure remains unverified. It never upgrades to cleanup_verified and cannot release a live, unverifiable, or still-running Worker. Held recovery may terminate the recorded Worker without replaying or creating an Attempt. Check Status for Hold and Events for Release. ${EXECUTION_NOT_VERDICT}`,
      inputSchema: taskIdOnlyInputSchema,
      outputSchema: taskStatusRecordSchema,
    },
    async (args: { task_id: string }) => runTool(() => manager.cancelTask(args.task_id)),
  );

  return server;
}

// Re-exported for consumers that want the receipt/result shapes.
export type { TaskAttentionSnapshot, TaskReceipt, TaskResult, TaskStatusRecord };
