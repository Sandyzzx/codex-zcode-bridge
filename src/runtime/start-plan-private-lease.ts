/** One in-memory credential delivery. This is not an entitlement authority:
 * its caller must establish live entitlement before constructing the lease. */
export interface PrivateLeaseBinding {
  readonly account: string;
  readonly provider: string;
  readonly model: string;
  readonly task: string;
  readonly attempt: number;
  readonly operation: string;
  readonly generation: number;
  readonly claim: string;
  readonly session: string;
  readonly turn: string;
  readonly pid: number;
  readonly creation: string;
}

const textFields = ["account", "provider", "model", "task", "operation", "claim", "session", "turn", "creation"] as const;
const numberFields = ["attempt", "generation", "pid"] as const;
function validBinding(value: PrivateLeaseBinding): boolean {
  return !!value && textFields.every((key) => typeof value[key] === "string" && value[key].length > 0)
    && numberFields.every((key) => Number.isSafeInteger(value[key]) && value[key] > 0);
}
function sameBinding(left: PrivateLeaseBinding, right: PrivateLeaseBinding): boolean {
  return validBinding(left) && validBinding(right)
    && textFields.every((key) => left[key] === right[key])
    && numberFields.every((key) => left[key] === right[key]);
}

export class PrivateCredentialLease {
  readonly #binding: Readonly<PrivateLeaseBinding>;
  readonly #expiresAt: number;
  readonly #now: () => number;
  #credential: string | null;
  #state: "active" | "checking" | "delivering" | "consumed" | "revoked" = "active";

  constructor(binding: PrivateLeaseBinding, credential: string, expiresAt: number, now: () => number = Date.now) {
    const createdAt = now();
    if (!validBinding(binding) || typeof credential !== "string" || !credential
      || !Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || expiresAt <= createdAt || expiresAt - createdAt > 60_000) {
      throw new Error("credential_lease_invalid");
    }
    this.#binding = Object.freeze({ ...binding });
    this.#credential = credential;
    this.#expiresAt = expiresAt;
    this.#now = now;
  }

  revoke(): void { this.#state = "revoked"; this.#credential = null; }

  /** Synchronous claim check before redeem; an already-claimed lease belongs
   * to its in-flight delivery and must not be revoked by a competing call. */
  isActive(): boolean { return this.#state === "active"; }

  async redeem(
    requested: PrivateLeaseBinding,
    verifyWorker: (binding: Readonly<PrivateLeaseBinding>) => Promise<boolean>,
    deliver: (credential: string, expiresAt: number) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#state !== "active") throw new Error("credential_lease_unavailable");
    this.#state = "checking";
    try {
      if (signal.aborted || !Number.isFinite(this.#now()) || this.#now() >= this.#expiresAt
        || !sameBinding(this.#binding, requested)) throw new Error("credential_lease_rejected");
      if (!await verifyWorker(this.#binding)) throw new Error("credential_lease_rejected");
      if (this.#state !== "checking" || signal.aborted || !Number.isFinite(this.#now()) || this.#now() >= this.#expiresAt || !this.#credential) {
        throw new Error("credential_lease_rejected");
      }
      this.#state = "delivering";
      const credential = this.#credential;
      this.#credential = null;
      // Any delivery error, timeout or missing ACK is terminal and unknown.
      await deliver(credential, this.#expiresAt);
      if (signal.aborted || this.#state !== "delivering") throw new Error("credential_delivery_unknown");
      this.#state = "consumed";
    } catch {
      this.revoke();
      throw new Error("credential_lease_unavailable");
    }
  }
}
