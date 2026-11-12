import { createHash } from "node:crypto";

/** In-memory fingerprint permits output redaction after the credential lease
 * has been revoked without retaining the complete credential string. It does
 * not promise physical erasure, and only recognizes the complete credential. */
export class StartPlanSecretRedactor {
  #length = 0;
  #prefix = "";
  #digest = "";

  register(secret: string): void {
    if (typeof secret !== "string" || secret.length < 2) throw new Error("private_auth_invalid");
    this.#length = secret.length;
    this.#prefix = secret.slice(0, Math.min(8, secret.length - 1));
    this.#digest = createHash("sha256").update(secret, "utf8").digest("hex");
  }

  text(input: string): string {
    if (!this.#length || input.length < this.#length) return input;
    let cursor = 0, checked = 0, out = "";
    for (;;) {
      const index = input.indexOf(this.#prefix, cursor);
      if (index < 0 || index + this.#length > input.length) return out + input.slice(cursor);
      if (++checked > 128) return "[REDACTED]";
      const candidate = input.slice(index, index + this.#length);
      if (createHash("sha256").update(candidate, "utf8").digest("hex") === this.#digest) {
        out += input.slice(cursor, index) + "[REDACTED]";
        cursor = index + this.#length;
      } else {
        out += input.slice(cursor, index + 1);
        cursor = index + 1;
      }
    }
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), this.value(item)]));
    }
    return value;
  }

  close(): void { this.#length = 0; this.#prefix = ""; this.#digest = ""; }
}
