import { readFileSync } from "node:fs";
import { buildBridgeAgents } from "./bridge-sqlite.mjs";
import { cleanString, isRecord, normalizeTimestamp, nonNegativeSafeInteger } from "./util.mjs";

function normalizeRuntimeEvent(value, index) {
  if (!isRecord(value)) return null;
  const taskId = cleanString(value.task_id ?? value.taskId, 256);
  const attempt = nonNegativeSafeInteger(value.attempt) ?? 1;
  const eventType = cleanString(value.event_type ?? value.eventType ?? value.type, 128);
  if (!taskId || !eventType) return null;
  return {
    event_cursor: nonNegativeSafeInteger(value.event_cursor ?? value.eventCursor ?? value.cursor)
      ?? index + 1,
    task_id: taskId,
    attempt,
    event_type: eventType,
    at: normalizeTimestamp(value.at ?? value.timestamp),
    summary: cleanString(value.summary, 8192) ?? "",
    details_json: value.details_json ?? value.details ?? null,
  };
}

function extractHistory(root) {
  if (Array.isArray(root)) {
    if (root.every((entry) => isRecord(entry) && ("task_id" in entry || "taskId" in entry))) {
      const runtimeEvents = [];
      const tasks = [];
      const attempts = [];
      for (const entry of root) {
        const taskId = cleanString(entry.task_id ?? entry.taskId, 256);
        if (!taskId) continue;
        const attempt = nonNegativeSafeInteger(entry.attempt) ?? 1;
        tasks.push({
          task_id: taskId,
          status: cleanString(entry.status, 64) ?? "unknown",
          created_at: normalizeTimestamp(entry.created_at ?? entry.createdAt),
        });
        attempts.push({
          task_id: taskId,
          attempt,
          generation: nonNegativeSafeInteger(entry.generation),
          status: cleanString(entry.status, 64) ?? "unknown",
          created_at: normalizeTimestamp(entry.created_at ?? entry.createdAt),
        });
        const events = Array.isArray(entry.events)
          ? entry.events
          : Array.isArray(entry.runtime_events)
            ? entry.runtime_events
            : [];
        for (const event of events) {
          runtimeEvents.push(normalizeRuntimeEvent({
            task_id: taskId,
            attempt,
            ...event,
          }, runtimeEvents.length));
        }
      }
      return { tasks, attempts, runtimeEvents: runtimeEvents.filter(Boolean) };
    }
    return {
      tasks: [],
      attempts: [],
      runtimeEvents: root.map(normalizeRuntimeEvent).filter(Boolean),
    };
  }
  if (!isRecord(root)) return { tasks: [], attempts: [], runtimeEvents: [] };
  const runtimeEvents = Array.isArray(root.runtime_events)
    ? root.runtime_events.map(normalizeRuntimeEvent).filter(Boolean)
    : Array.isArray(root.events)
      ? root.events.map(normalizeRuntimeEvent).filter(Boolean)
      : [];
  return {
    tasks: Array.isArray(root.tasks) ? root.tasks : [],
    attempts: Array.isArray(root.attempts) ? root.attempts : [],
    operations: Array.isArray(root.operations) ? root.operations : [],
    operationEvents: Array.isArray(root.operation_events) ? root.operation_events : [],
    runtimeEvents,
  };
}

export function collectBridgeHistorySource(source) {
  try {
    const root = JSON.parse(readFileSync(source.path, "utf8"));
    const history = extractHistory(root);
    const built = buildBridgeAgents({
      sourceId: source.source_id,
      ...history,
    });
    return {
      ...built,
      compactions: [],
      warnings: [],
      scan: {
        next_event_cursor: built.closures.reduce(
          (maximum, closure) => Math.max(maximum, closure.latest_event_cursor ?? 0),
          0,
        ),
      },
    };
  } catch (error) {
    return {
      agents: [],
      responses: [],
      tools: [],
      context_items: [],
      compactions: [],
      bridge_tasks: [],
      usage_checkpoints: [],
      warnings: [{
        code: "bridge_history_read_failed",
        source_id: source.source_id,
        message: error instanceof Error ? error.name : "unknown_error",
      }],
      scan: { next_event_cursor: 0 },
    };
  }
}
