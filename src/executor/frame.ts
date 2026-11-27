import { Transform } from "node:stream";
import { EXECUTOR_CONTROL_FRAME_LIMIT_BYTES } from "./protocol.js";

export const EXECUTOR_FRAME_HEADER_BYTES = 4;

export function encodeExecutorFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > EXECUTOR_CONTROL_FRAME_LIMIT_BYTES) {
    throw new Error("EXECUTOR_CONTROL_FRAME_TOO_LARGE");
  }
  const frame = Buffer.alloc(EXECUTOR_FRAME_HEADER_BYTES + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, EXECUTOR_FRAME_HEADER_BYTES);
  return frame;
}

export function createExecutorFrameDecoder(limitBytes = EXECUTOR_CONTROL_FRAME_LIMIT_BYTES): Transform {
  let buffer: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= EXECUTOR_FRAME_HEADER_BYTES) {
        const bodyLength = buffer.readUInt32BE(0);
        if (bodyLength > limitBytes) {
          callback(new Error("EXECUTOR_CONTROL_FRAME_TOO_LARGE"));
          return;
        }
        if (buffer.byteLength < EXECUTOR_FRAME_HEADER_BYTES + bodyLength) break;
        const body = buffer.subarray(EXECUTOR_FRAME_HEADER_BYTES, EXECUTOR_FRAME_HEADER_BYTES + bodyLength);
        buffer = buffer.subarray(EXECUTOR_FRAME_HEADER_BYTES + bodyLength);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EXECUTOR_CONTROL_FRAME_MALFORMED");
        } catch (error) {
          callback(error instanceof Error ? error : new Error("EXECUTOR_CONTROL_FRAME_MALFORMED"));
          return;
        }
        this.push(JSON.stringify(parsed));
      }
      callback();
    },
  });
}
