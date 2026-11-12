const EMPTY_INTERACTION = Object.freeze({ state: "not_observed", kind: null });

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function safeRuntimeText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return text ? text.slice(0, 160) : null;
}

function safeToolName(value) {
  if (typeof value !== "string") return "tool";
  const name = value.replace(/[^A-Za-z0-9_.-]/gu, "").slice(0, 80);
  return name || "tool";
}

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
  return finish - start;
}

/**
 * Builds the frozen v0.1 projection from Bridge status, normalized runtime
 * events, and a final TaskResult. Events must be limited to the current
 * attempt by the caller. Only report_ready events authorize result claims.
 */
export function buildTaskFeedbackSnapshotV01(input) {
  let model = null;
  let activity = null;
  let agentReportReady = false;

  for (const event of input.events) {
    const details = record(event.details);
    if (event.type === "model_selected" && details) {
      const providerId = safeRuntimeText(details.provider_id);
      const modelId = safeRuntimeText(details.model_id);
      if (providerId && modelId) {
        model = {
          provider_id: providerId,
          model_id: modelId,
          reasoning_level: details.reasoning_level_source === "runtime"
            ? safeRuntimeText(details.reasoning_level)
            : null,
          source: "runtime",
        };
      }
    } else if (event.type === "model_tool_call" && details) {
      activity = {
        kind: "tool_call",
        summary: `Tool request · ${safeToolName(details.tool_name)}`,
        observed_at: event.at,
        currentness: "last_observed",
      };
    } else if (event.type === "tool_status" && details) {
      activity = {
        kind: "tool_update",
        summary: `Tool update · ${safeToolName(details.tool_name)}`,
        observed_at: event.at,
        currentness: "last_observed",
      };
    } else if (event.type === "report_ready") {
      agentReportReady = true;
    }
  }

  const finalResult = input.result;
  const result = agentReportReady && finalResult && finalResult.attempt === input.status.attempt
    && finalResult.status === input.status.status
    && (finalResult.status === "completed" || finalResult.status === "waiting_for_master")
    ? {
        source: "agent_report",
        summary: finalResult.summary,
        issues: [...finalResult.issues],
        files_changed: [...finalResult.files_changed],
        tests: finalResult.tests.map((test) => ({ ...test })),
        started_at: input.status.started_at,
        finished_at: input.status.finished_at,
        duration_ms: durationMs(input.status.started_at, input.status.finished_at),
      }
    : null;

  return {
    schema_version: "0.1",
    task_id: input.status.task_id,
    attempt: input.status.attempt,
    status: input.status.status,
    model,
    phase: null,
    progress: null,
    activity,
    interaction: { ...EMPTY_INTERACTION },
    result,
  };
}
