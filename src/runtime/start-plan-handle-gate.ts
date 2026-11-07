import { openPowerShellTreeTransaction, type WindowsTreeTransactionLike } from "../adapters/windows-process-cleanup.js";

export type HandleGateErrorCode =
  | "handle_gate_platform_unsupported"
  | "handle_gate_hold_rejected"
  | "handle_gate_identity_mismatch"
  | "handle_gate_not_alive"
  | "handle_gate_identity_changed"
  | "handle_gate_unsupported_transaction"
  | "handle_gate_transport_failed";

export class HandleGateError extends Error {
  readonly code: HandleGateErrorCode;
  readonly detail?: string;
  constructor(code: HandleGateErrorCode, detail?: string) {
    super(`start_plan_${code}${detail ? `: ${detail}` : ""}`);
    this.name = "HandleGateError";
    this.code = code;
    this.detail = detail;
  }
}

/** Production Worker identity gate (Start Plan P0-C). A held kernel handle
 * pins the exact Worker process: the PID cannot be reused while the handle
 * stays open, and every later liveness answer is read from that same handle
 * through GetProcessTimes. An independent PID/StartTime snapshot alone is
 * never accepted as delivery evidence. Unknown identity states reject
 * credential delivery instead of guessing. */
export class WorkerHandleGate {
  readonly #transaction: WindowsTreeTransactionLike;
  readonly #pid: number;
  readonly #creationFileTime: string;
  #closed = false;

  private constructor(transaction: WindowsTreeTransactionLike, pid: number, creationFileTime: string) {
    this.#transaction = transaction;
    this.#pid = pid;
    this.#creationFileTime = creationFileTime;
  }

  static platformSupported(): boolean {
    return process.platform === "win32";
  }

  /** Holds one kernel handle on `pid` and verifies its exact creation time
   * against the launch receipt fingerprint (StartTime.Ticks read at spawn). */
  static async open(options: {
    pid: number;
    expectedCreationTicks: string;
    transaction?: WindowsTreeTransactionLike;
  }): Promise<WorkerHandleGate> {
    if (!WorkerHandleGate.platformSupported() && !options.transaction) {
      throw new HandleGateError("handle_gate_platform_unsupported");
    }
    const owned = !options.transaction;
    let transaction: WindowsTreeTransactionLike | undefined = options.transaction;
    try {
      transaction ??= await openPowerShellTreeTransaction();
      const [hold] = await transaction.hold([options.pid]);
      if (!hold || hold.status !== "ok" || !hold.creationFileTime || !hold.creationTicks) {
        throw new HandleGateError("handle_gate_hold_rejected", hold ? `${hold.status}${hold.error ? ` win32=${String(hold.error)}` : ""}` : "no outcome");
      }
      if (hold.creationTicks !== options.expectedCreationTicks) {
        throw new HandleGateError("handle_gate_identity_mismatch", `held=${hold.creationTicks} expected=${options.expectedCreationTicks}`);
      }
      return new WorkerHandleGate(transaction, options.pid, hold.creationFileTime);
    } catch (error) {
      if (owned && transaction) await transaction.close().catch(() => undefined);
      throw error;
    }
  }

  /** Non-destructive liveness read on the held handle. exited / not_held /
   * transport failure are all terminal rejections; nothing is inferred. */
  async assertAlive(): Promise<void> {
    if (this.#closed) throw new HandleGateError("handle_gate_not_alive", "gate closed");
    if (!this.#transaction.alive) throw new HandleGateError("handle_gate_unsupported_transaction");
    let outcome;
    try {
      outcome = await this.#transaction.alive(this.#pid);
    } catch (error) {
      throw new HandleGateError("handle_gate_transport_failed", error instanceof Error ? error.message : String(error));
    }
    if (outcome.status !== "alive") {
      throw new HandleGateError("handle_gate_not_alive", `${outcome.status}${outcome.error ? ` win32=${String(outcome.error)}` : ""}`);
    }
    if (outcome.creationFileTime !== this.#creationFileTime) {
      throw new HandleGateError("handle_gate_identity_changed", `now=${outcome.creationFileTime} expected=${this.#creationFileTime}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transaction.close();
  }
}
