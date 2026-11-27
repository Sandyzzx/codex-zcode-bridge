export interface ExecutorStatusSnapshot {
  readonly state: "active" | "shutdown_pending" | "lease_unknown" | "closed";
  readonly lease_id: string;
  readonly idle: boolean;
  readonly blockers: readonly string[];
}

export interface ExecutorShutdownDecision {
  readonly status: "accepted" | "not_idle" | "release_unknown";
  readonly blockers: readonly string[];
}
