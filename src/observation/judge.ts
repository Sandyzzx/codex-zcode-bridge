// A1 pure judger: one deterministic verdict for one persisted snapshot.
// Decision order per the plan: attempt/owner validity → committed result and
// checkpoint → interaction/turn/cleanup phases → identity probe + heartbeat.
// A committed result decides the business outcome; stale observations can
// never downgrade it. Unknown probe states never kill a task and a stall hint
// never triggers retry/cancel/failure.
import type { ActivityCode, CleanupState, ExecutorObservation, ExecutorState, JudgeInput, JudgeOptions, ResultPresence, TaskObservation } from "./types.js";
import { OBSERVATION_SCHEMA_VERSION, judgeOptionsWith } from "./types.js";

function ageMs(now: number, iso: string | null | undefined, guardMs: number): { value: number | null; skewed: boolean } {
  if (!iso) return { value: null, skewed: false };
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return { value: null, skewed: false };
  const age = now - parsed;
  // A timestamp in the future beyond the guard means the wall clock jumped
  // across a restart; time-based evidence degrades to unknown instead of
  // producing a negative (or fake zero) age.
  if (age < -guardMs) return { value: null, skewed: true };
  return { value: Math.max(0, age), skewed: false };
}

function clampReason(reason: string): string {
  return reason.slice(0, 80);
}

export function judgeTaskObservation(input: JudgeInput): TaskObservation {
  const options = judgeOptionsWith(input.options);
  const now = input.now_ms;
  const observedAt = new Date(now).toISOString();
  const status = input.status;
  const terminal = status.status === "completed" || status.status === "failed" || status.status === "cancelled" || status.status === "waiting_for_master";

  // 1. Attempt/owner validity: a heartbeat from another attempt or pid is not
  // evidence for this attempt at all.
  const heartbeat = input.heartbeat && input.heartbeat.attempt === status.attempt
    && (status.worker_pid === null || input.heartbeat.worker_pid === status.worker_pid)
    ? input.heartbeat
    : null;
  const heartbeatAge = ageMs(now, heartbeat?.heartbeat_at, options.clock_jump_guard_ms);
  const heartbeatFresh = heartbeat !== null && heartbeatAge.value !== null && heartbeatAge.value <= options.heartbeat_fresh_ms;

  // 2. Committed result and checkpoint. The committed current-attempt result
  // decides the business outcome; older observations cannot downgrade it.
  const committed = input.result !== null && input.result.attempt === status.attempt && terminal;
  const result: ResultPresence = committed ? "committed" : input.checkpoint ? "checkpointed" : "absent";

  // 3. Interaction / cleanup phases.
  const cleanup: CleanupState = status.cleanup_unverified === true
    ? "unverified"
    : committed
      ? "verified"
      : terminal || status.status === "running" ? "pending" : "not_started";

  // 4. Executor states. Probes (fresh recovery verdicts) win over heartbeat
  // evidence; without either, state stays unknown — never guessed dead.
  let worker: ExecutorObservation;
  if (input.probe_worker) {
    worker = { state: input.probe_worker.state, reason_code: clampReason(input.probe_worker.reason_code), observed_at: input.probe_worker.observed_at };
  } else if (heartbeatFresh && !heartbeatAge.skewed) {
    worker = { state: "alive", reason_code: "heartbeat_fresh", observed_at: observedAt };
  } else if (heartbeatAge.skewed) {
    worker = { state: "unknown", reason_code: "clock_skew", observed_at: observedAt };
  } else {
    worker = { state: "unknown", reason_code: heartbeat ? "heartbeat_stale" : "no_heartbeat_evidence", observed_at: observedAt };
  }

  let runtime: ExecutorObservation;
  const runtimePid = status.zcode_pid ?? null;
  if (input.probe_runtime) {
    runtime = { state: input.probe_runtime.state, reason_code: clampReason(input.probe_runtime.reason_code), observed_at: input.probe_runtime.observed_at };
  } else if (runtimePid === null) {
    runtime = { state: "unknown", reason_code: "runtime_pid_not_reported", observed_at: observedAt };
  } else {
    runtime = { state: "unknown", reason_code: "persisted_pid_no_probe", observed_at: observedAt };
  }

  // Activity: waiting states are explicit and never failures; stalled is an
  // advisory hint only (fresh heartbeat + long business-event silence).
  let activity: ActivityCode = "unknown";
  let activityReason = "no_activity_evidence";
  if (terminal || committed) {
    activity = "finalizing";
    activityReason = "task_terminal";
  } else if (status.status === "queued") {
    activity = "starting";
    activityReason = "queued_not_dispatched";
  } else if (input.pending_interaction) {
    activity = input.pending_interaction.method === "interaction/requestPermission" ? "waiting_for_permission" : "waiting_for_user";
    activityReason = "pending_interaction_request";
  } else {
    const startAge = ageMs(now, status.started_at, options.clock_jump_guard_ms).value;
    const eventAge = ageMs(now, input.last_business_event?.at, options.clock_jump_guard_ms).value;
    const withinStartGrace = startAge !== null && startAge < options.start_grace_ms;
    if (heartbeatFresh) {
      if (eventAge === null) {
        activity = withinStartGrace ? "starting" : "unknown";
        activityReason = "heartbeat_alive_no_business_event";
      } else if (eventAge > options.stall_hint_ms) {
        activity = "stalled";
        activityReason = "heartbeat_alive_business_events_stale";
      } else {
        activity = "executing";
        activityReason = "heartbeat_and_events_fresh";
      }
    } else if (withinStartGrace) {
      activity = "starting";
      activityReason = "within_worker_start_grace";
    } else if (worker.state === "unknown") {
      activity = "unknown";
      activityReason = worker.reason_code;
    } else {
      activity = "executing";
      activityReason = "executor_alive_no_fresh_heartbeat";
    }
  }

  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    worker,
    runtime,
    activity: { code: activity, reason_code: clampReason(activityReason), observed_at: observedAt },
    result,
    cleanup,
    stalled: activity === "stalled",
    evidence: {
      heartbeat_age_ms: heartbeatAge.skewed ? null : heartbeatAge.value,
      last_event_age_ms: input.last_business_event ? ageMs(now, input.last_business_event.at, options.clock_jump_guard_ms).value : null,
      last_event_seq: heartbeat?.last_event_seq ?? input.last_business_event?.seq ?? null,
      last_event_type: heartbeat?.last_event_type ?? input.last_business_event?.type ?? null,
      session_id: heartbeat?.session_id ?? status.zcode_session_id ?? null,
      turn_id: heartbeat?.turn_id ?? null,
      attempt: status.attempt,
      status_updated_at: status.updated_at ?? null,
    },
  };
}
