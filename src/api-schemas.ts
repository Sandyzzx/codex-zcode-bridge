// Shared input contract for the public MCP tools, Task CLI and Executor IPC.
import * as z from "zod/v4";

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const taskIdSchema = z
  .string()
  .regex(TASK_ID_PATTERN, `task_id must match ${TASK_ID_PATTERN.source}`);

const stringArray = z.array(z.string());

export const zcodeTaskInputSchema = z
  .strictObject({
    task_id: taskIdSchema,
    workspace: z.string().min(1),
    worktree_path: z.string().min(1).optional(),
    model: z.strictObject({
      provider_id: z.string().trim().min(1).optional(),
      model_id: z.string().trim().min(1),
      reasoning_level: z.string().trim().min(1).optional(),
    }).optional(),
    timeout_ms: z.number().int().min(60_000).max(14_400_000).optional(),
    objective: z.string().min(1),
    requirements: stringArray,
    allowed_paths: stringArray,
    forbidden_paths: stringArray,
    acceptance_criteria: stringArray,
    test_commands: stringArray,
    context: z.string().optional(),
  })
  .describe("Full TaskPackage; workspace is the calling host project root. Optional worktree_path is an existing execution directory selected and prepared by the calling host; the Bridge never creates or selects worktrees. The five array fields must be present (empty allowed), context is optional.");

export const taskIdOnlyInputSchema = z.strictObject({
  task_id: z.string().min(1),
});

export const zcodeContinueInputSchema = z.strictObject({
  task_id: z.string().min(1),
  feedback: z.string().min(1),
  additional_requirements: z.array(z.string()).optional(),
  operation_id: z.string().trim().min(1).max(128).optional(),
});

export const zcodeEventsInputSchema = z.strictObject({
  task_id: taskIdSchema,
  after_seq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  wait_ms: z.number().int().min(0).max(25_000).optional(),
  view: z.enum(["raw", "summary"]).optional(),
  include_attempt: z.boolean().optional().describe("Include each event's persisted attempt number."),
  scan_cursor: z.string().max(2_048).optional(),
  max_bytes: z.number().int().min(1_024).max(33_554_432).optional(),
  wait_for: z.literal("attention").optional(),
});

export const zcodeInteractionReplyInputSchema = z.strictObject({
  task_id: taskIdSchema,
  request_id: z.string().trim().min(1).max(512),
  decision: z.enum(["allow", "deny", "accept", "decline"]),
  answers: z.record(z.string(), z.string()).optional(),
  reason: z.string().max(2_000).optional(),
});

export const zcodeModelCatalogInputSchema = z.strictObject({
  workspace: z.string().trim().min(1),
});

export const zcodeDefaultModelInputSchema = z.strictObject({
  provider_id: z.string().trim().min(1),
  model_id: z.string().trim().min(1),
  reasoning_level: z.string().trim().min(1).optional(),
});

export type ZcodeTaskInput = z.infer<typeof zcodeTaskInputSchema>;
