import type { TaskFeedbackSnapshotV01 } from "../interfaces.js";

function displayText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, limit);
}

function oneLine(value: string, limit: number): string {
  return displayText(value.replace(/\s+/gu, " "), limit);
}

/** Render the v0.1 snapshot as concise native transcript text. */
export function renderTaskFeedback(snapshot: TaskFeedbackSnapshotV01): string {
  const terminalLabel = snapshot.status === "waiting_for_master"
    ? "WAITING_FOR_MASTER"
    : ["completed", "failed", "cancelled"].includes(snapshot.status)
      ? snapshot.status.toUpperCase()
      : null;
  const lines = [`▣ ZCode · ${snapshot.task_id}${terminalLabel ? ` · ${terminalLabel}` : ""}`];

  switch (snapshot.status) {
    case "queued":
      lines.push("○ Queued");
      break;
    case "running":
      lines.push("→ Running");
      if (snapshot.model) {
        const modelId = oneLine(snapshot.model.model_id ?? "", 160);
        const reasoning = snapshot.model.reasoning_level ? oneLine(snapshot.model.reasoning_level, 80) : "";
        if (modelId) lines.push(`Model: ${modelId}${reasoning ? ` · Reasoning: ${reasoning}` : ""}`);
      }
      if (snapshot.activity) lines.push("", `Last observed: ${oneLine(snapshot.activity.summary, 160)}`);
      break;
    case "completed":
      lines.push("✓ Bridge task completed");
      break;
    case "failed":
      lines.push("✗ Bridge task failed");
      break;
    case "cancelled":
      lines.push("Result: Task cancellation confirmed by Bridge");
      break;
    case "waiting_for_master":
      lines.push("Agent report requires a master decision.");
      break;
  }

  const result = snapshot.result;
  if (result) {
    lines.push("", "Agent report:");
    const summary = oneLine(result.summary, 800);
    if (summary) lines.push(summary);
    lines.push(`Changed: ${result.files_changed.length} files`);
    for (const test of result.tests.slice(0, 3)) {
      lines.push(`Tests: ${oneLine(test.command, 240)} · reported ${test.status}`);
    }
    if (result.tests.length > 3) lines.push(`Tests: ${result.tests.length - 3} more reported`);
    if (result.issues.length) lines.push(`Issues: ${result.issues.length} reported`);
    if (result.duration_ms !== null) lines.push(`Duration: ${formatDuration(result.duration_ms)}`);
  }

  return lines.join("\n");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}
