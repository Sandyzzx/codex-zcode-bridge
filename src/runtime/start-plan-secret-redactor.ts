import { createHash } from "node:crypto";

/** In-memory fingerprint permits output redaction after the credential lease
 * has been revoked without retaining the complete credential string. It does
 * not promise physical erasure; streaming uses a bounded prefix overlap so a
 * credential split across frames is never emitted in pieces. */
export class StartPlanSecretRedactor {
  #length = 0;
  #prefix = "";
  #digest = "";
  #streamPending = "";

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

  /**
   * Redact content delivered in consecutive stream fragments. A bounded suffix
   * is retained so a credential split across fragments is never emitted as
   * two individually harmless prefixes. Call with final=true at a public-event
   * boundary to release the retained suffix.
   */
  streamText(input: string, { final = false }: { readonly final?: boolean } = {}): string {
    if (typeof input !== "string" || typeof final !== "boolean") throw new Error("private_auth_stream_invalid");
    if (!this.#length) return input;
    this.#streamPending += input;
    if (!this.#streamPending) return "";
    const retainedCharacters = final ? 0 : Math.max(0, this.#length - 1);
    let visibleLength = Math.max(0, this.#streamPending.length - retainedCharacters);
    if (!final && visibleLength > 0) {
      for (let index = this.#streamPending.indexOf(this.#prefix); index >= 0 && index < visibleLength;
        index = this.#streamPending.indexOf(this.#prefix, index + 1)) {
        if (index + this.#length > visibleLength) {
          visibleLength = index;
          break;
        }
      }
      const maximumOverlap = Math.min(this.#prefix.length - 1, visibleLength);
      for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
        if (this.#streamPending.slice(visibleLength - overlap, visibleLength)
          === this.#prefix.slice(0, overlap)) {
          visibleLength -= overlap;
          break;
        }
      }
    }
    if (visibleLength === 0) return "";
    const visible = this.#streamPending.slice(0, visibleLength);
    this.#streamPending = this.#streamPending.slice(visibleLength);
    return this.text(visible);
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.text(key), this.value(item)]));
    }
    return value;
  }

  close(): void { this.#length = 0; this.#prefix = ""; this.#digest = ""; this.#streamPending = ""; }
}
