import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

/** Private, one-frame channel. The sender must half-close after writing; a
 * receiver cannot accept a frame until EOF proves there are no trailing bytes.
 * Exceptions deliberately contain no input data. */
export async function readPrivateFrame(stream: Readable, maximum: number, signal: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || signal.aborted) throw new Error("private_frame_unavailable");
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = (): void => { stream.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error("private_frame_cancelled");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > maximum + 4) throw new Error("private_frame_too_large");
      chunks.push(bytes);
      if (total >= 4) {
        const prefix = Buffer.concat(chunks, total).readUInt32BE(0);
        if (prefix < 1 || prefix > maximum) throw new Error("private_frame_size_invalid");
        if (total > prefix + 4) throw new Error("private_frame_extra_data");
      }
    }
    if (signal.aborted || total < 4) throw new Error("private_frame_incomplete");
    const bytes = Buffer.concat(chunks, total);
    const length = bytes.readUInt32BE(0);
    if (length < 1 || length > maximum || total !== length + 4) throw new Error("private_frame_incomplete");
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4))) as unknown; }
    catch { throw new Error("private_frame_invalid"); }
    return value;
  } catch (error) {
    // Never propagate an arbitrary transport error that could contain data.
    if (signal.aborted) throw new Error("private_frame_cancelled");
    if (error instanceof Error && /^private_frame_[a-z_]+$/u.test(error.message)) throw error;
    throw new Error("private_frame_transport_failed");
  } finally {
    signal.removeEventListener("abort", abort);
    chunks.length = 0;
  }
}

/** Once write starts, its outcome is uncertain on error or cancellation. The
 * caller must revoke and never resend the same credential. */
export async function writePrivateFrame(stream: Writable, value: unknown, maximum: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("private_frame_cancelled");
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("private_frame_invalid");
  const body = Buffer.from(json, "utf8");
  if (!Number.isSafeInteger(maximum) || maximum < 1 || body.length < 1 || body.length > maximum) throw new Error("private_frame_size_invalid");
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(body.length);
  const frame = Buffer.concat([prefix, body]);
  const abort = (): void => { stream.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => { cleanup(); reject(new Error("private_frame_delivery_unknown")); };
      const onClose = (): void => { cleanup(); reject(new Error("private_frame_delivery_unknown")); };
      const onFinish = (): void => { cleanup(); resolve(); };
      const cleanup = (): void => { stream.removeListener("error", onError); stream.removeListener("close", onClose); stream.removeListener("finish", onFinish); };
      stream.once("error", onError); stream.once("close", onClose); stream.once("finish", onFinish);
      if (signal.aborted) { cleanup(); reject(new Error("private_frame_delivery_unknown")); return; }
      stream.end(frame);
    });
    if (signal.aborted) throw new Error("private_frame_delivery_unknown");
  } finally {
    signal.removeEventListener("abort", abort);
    // `finish` does not mean a peer has consumed an asynchronously queued
    // Buffer. Mutating frame here can corrupt the delivery. Drop references;
    // neither this nor Buffer zeroing promises physical memory erasure.
  }
}
