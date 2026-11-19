import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createZstdDecompress } from "node:zlib";
import { DEFAULT_READ_CHUNK_BYTES } from "./constants.mjs";

/**
 * Reads newline-delimited records without loading the complete file into memory.
 * The returned offset only advances past complete lines. A partial tail is
 * deliberately left for the next scan so a growing rollout cannot be split.
 */
export async function readJsonLinesFromOffset(filePath, options = {}) {
  const chunkBytes = Number.isSafeInteger(options.chunkBytes) && options.chunkBytes > 0
    ? options.chunkBytes
    : DEFAULT_READ_CHUNK_BYTES;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : null;
  const info = await stat(filePath);
  const requestedOffset = Number.isSafeInteger(options.startOffset) && options.startOffset > 0
    ? options.startOffset
    : 0;
  const reset = requestedOffset > info.size;
  let absolutePosition = reset ? 0 : requestedOffset;
  let committedOffset = absolutePosition;
  let pending = Buffer.alloc(0);
  let bytesRead = 0;
  let invalidJsonLines = 0;
  const records = [];
  let skippedLines = 0;
  const handle = await open(filePath, "r");

  try {
    while (absolutePosition < info.size) {
      if (maxBytes !== null && bytesRead >= maxBytes) break;
      const requested = maxBytes === null
        ? chunkBytes
        : Math.min(chunkBytes, maxBytes - bytesRead);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead: readNow } = await handle.read(
        buffer,
        0,
        requested,
        absolutePosition,
      );
      if (readNow === 0) break;
      bytesRead += readNow;
      const chunk = buffer.subarray(0, readNow);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newlineIndex = pending.indexOf(0x0a);

      while (newlineIndex >= 0) {
        const rawLine = pending.subarray(0, newlineIndex);
        const lineStart = committedOffset;
        const lineEnd = lineStart + newlineIndex + 1;
        const text = rawLine.toString("utf8").replace(/\r$/u, "");
        if (text.trim()) {
          if (options.skipLine?.(text)) {
            skippedLines += 1;
          } else {
            try {
              const value = JSON.parse(text);
              if (options.skipValue?.(value)) {
                skippedLines += 1;
              } else {
                records.push({
                  value,
                  line_start: lineStart,
                  line_end: lineEnd,
                });
              }
            } catch {
              invalidJsonLines += 1;
            }
          }
        }
        committedOffset = lineEnd;
        pending = pending.subarray(newlineIndex + 1);
        newlineIndex = pending.indexOf(0x0a);
      }
      absolutePosition += readNow;
      if (maxBytes !== null && bytesRead >= maxBytes) break;
    }
  } finally {
    await handle.close();
  }

  return {
    records,
    start_offset: reset ? 0 : requestedOffset,
    next_offset: committedOffset,
    bytes_read: bytesRead,
    file_size: info.size,
    invalid_json_lines: invalidJsonLines,
    skipped_lines: skippedLines,
    partial_tail_bytes: pending.length,
    reset_from_truncated_source: reset,
  };
}

/**
 * Decodes a bounded zstd-compressed JSONL stream without materializing the
 * complete uncompressed history. The optional codec makes unsupported
 * runtimes testable and keeps the caller on the UNKNOWN path.
 */
export async function readZstdJsonLines(filePath, options = {}) {
  const info = await stat(filePath);
  const chunkBytes = Number.isSafeInteger(options.chunkBytes) && options.chunkBytes > 0
    ? options.chunkBytes
    : DEFAULT_READ_CHUNK_BYTES;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : null;
  const createDecompress = Object.hasOwn(options, "createDecompress")
    ? options.createDecompress
    : createZstdDecompress;
  if (typeof createDecompress !== "function") {
    const error = new Error("zstd_unavailable");
    error.code = "zstd_unavailable";
    throw error;
  }
  const input = createReadStream(filePath, { highWaterMark: chunkBytes });
  const decoder = createDecompress();
  input.on("error", (error) => decoder.destroy(error));
  input.pipe(decoder);
  let pending = Buffer.alloc(0);
  let committedOffset = 0;
  let bytesRead = 0;
  let invalidJsonLines = 0;
  let skippedLines = 0;
  const records = [];

  try {
    for await (const rawChunk of decoder) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let newlineIndex = pending.indexOf(0x0a);
      while (newlineIndex >= 0) {
        const rawLine = pending.subarray(0, newlineIndex);
        const lineStart = committedOffset;
        const lineEnd = lineStart + newlineIndex + 1;
        const text = rawLine.toString("utf8").replace(/\r$/u, "");
        if (text.trim()) {
          if (options.skipLine?.(text)) {
            skippedLines += 1;
          } else {
            try {
              const value = JSON.parse(text);
              if (options.skipValue?.(value)) {
                skippedLines += 1;
              } else {
                records.push({
                  value,
                  line_start: lineStart,
                  line_end: lineEnd,
                });
              }
            } catch {
              invalidJsonLines += 1;
            }
          }
        }
        committedOffset = lineEnd;
        pending = pending.subarray(newlineIndex + 1);
        newlineIndex = pending.indexOf(0x0a);
      }
      bytesRead += chunk.length;
      if (maxBytes !== null && bytesRead >= maxBytes) {
        input.destroy();
        decoder.destroy();
        break;
      }
    }
  } finally {
    input.destroy();
    decoder.destroy();
  }

  return {
    records,
    start_offset: 0,
    next_offset: committedOffset,
    bytes_read: bytesRead,
    file_size: info.size,
    decompressed_size: committedOffset + pending.length,
    invalid_json_lines: invalidJsonLines,
    skipped_lines: skippedLines,
    partial_tail_bytes: pending.length,
    reset_from_truncated_source: false,
    compression: "zstd",
  };
}
