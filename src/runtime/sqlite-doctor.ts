import type { DoctorCheck } from "./doctor.js";

/** Format only the bound Authority's consistent read; never open another store or probe a PID. */
export function buildSqliteDoctorChecks(value: unknown, managerFence: string | null): DoctorCheck[] {
  const snapshot = record(value);
  if (snapshot.root_status !== "consistent_read_only"
    || snapshot.verified_event_projection_consistency !== true
    || snapshot.writes_allowed !== false || snapshot.cleanup_performed !== false
    || snapshot.claim_release_performed !== false || snapshot.operation_release_performed !== false
    || !Array.isArray(snapshot.operations) || !Array.isArray(snapshot.task_projections)) {
    return [
      { name: "active_tasks", status: "unknown", summary: "SQLite lifecycle snapshot is unavailable or inconsistent; task occupancy is unknown" },
      { name: "recovery_lock", status: "error", summary: bounded(`SQLite Recovery snapshot is not verified: ${String(snapshot.root_status ?? "unavailable")}; ${Array.isArray(snapshot.root_blockers) ? snapshot.root_blockers.join(", ") : "snapshot_invalid"}`) },
    ];
  }
  const operations = snapshot.operations.map(record);
  const tasks = snapshot.task_projections.map(record);
  const occupied = operations.filter((operation) => operation.capacity_occupied === true);
  const durableHolds = occupied.filter((operation) => operation.recovery_classification === "hold"
    || operation.recovery_classification === "quarantine");
  const queued = tasks.filter((task) => task.status === "queued");
  const running = tasks.filter((task) => task.status === "running");
  const cleanupPending = occupied.filter((operation) => operation.phase !== "running" && operation.phase !== "reserved");
  const occupiedTaskIds = new Set(occupied.map((operation) => operation.task_id));
  const byAttempt = new Map(operations.map((operation) => [`${operation.task_id}#${operation.attempt}`, operation]));
  const active = tasks.filter((task) => task.status === "queued" || task.status === "running"
    || occupiedTaskIds.has(task.task_id));
  // Put blockers first so truncating task details cannot hide the reason dispatch is fenced.
  const holdDetails = durableHolds.slice(0, 8).map((operation) => `${operation.operation_id}: ${operation.recovery_classification}`).join("; ");
  const recovery: DoctorCheck = durableHolds.length > 0
    ? { name: "recovery_lock", status: "error", summary: bounded(`SQLite persisted Recovery Hold/Quarantine: ${holdDetails}. Existing evidence-bound recovery is required; no automatic unlock`) }
    : managerFence
      ? { name: "recovery_lock", status: "warning", summary: bounded(`SQLite Manager is read-only/fenced: ${managerFence}`) }
      : { name: "recovery_lock", status: "ok", summary: "SQLite snapshot has no persisted Recovery Hold/Quarantine; this Manager has no recovery fence" };
  const details = active.slice(0, 32).map((task) => {
    const operation = byAttempt.get(`${task.task_id}#${task.current_attempt}`);
    return `${task.task_id}#${task.current_attempt}: ${task.status}${operation
      ? ` (operation ${operation.operation_id}, phase ${operation.phase}, result ${operation.result_digest ? "committed" : "absent"}, cleanup ${operation.cleanup_state}, recovery ${operation.recovery_classification ?? "none"})`
      : " (no Operation)"}`;
  }).join("; ");
  return [
    { name: "active_tasks", status: durableHolds.length > 0 || managerFence || queued.length > 0 || cleanupPending.length > 0 ? "warning" : "ok",
      summary: bounded(`SQLite: ${running.length} running, ${queued.length} queued, ${occupied.length} occupied, ${cleanupPending.length} cleanup-pending, ${durableHolds.length} recovery-held. ${details}`) },
    recovery,
  ];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SQLite diagnostic record is invalid");
  return value as Record<string, unknown>;
}

function bounded(value: string): string { return value.replace(/[\r\n\0]/gu, " ").slice(0, 1_200); }
