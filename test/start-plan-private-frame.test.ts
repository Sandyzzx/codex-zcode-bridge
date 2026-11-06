import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { readPrivateFrame, writePrivateFrame } from "../src/runtime/start-plan-private-frame.js";

function wire(body: Buffer): Buffer { const n = Buffer.alloc(4); n.writeUInt32BE(body.length); return Buffer.concat([n, body]); }
const signal = (): AbortSignal => new AbortController().signal;

test("private frame accepts fragmented multibyte data only after EOF", async () => {
  const input = new PassThrough();
  let settled = false;
  const result = readPrivateFrame(input, 1024, signal()).then((value) => { settled = true; return value; });
  const frame = wire(Buffer.from(JSON.stringify({ label: "模型" })));
  for (const byte of frame) input.write(Buffer.from([byte]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  input.end();
  assert.deepEqual(await result, { label: "模型" });
});

test("private frame rejects malformed UTF-8, extra frames, oversized and truncated data", async () => {
  const good = wire(Buffer.from("{}"));
  for (const input of [wire(Buffer.from([0xff])), Buffer.concat([good, good]), Buffer.from([0, 0, 0, 20, 123]), Buffer.from([0, 0, 16, 0])]) {
    await assert.rejects(readPrivateFrame(Readable.from([input]), 64, signal()), /private_frame_/);
  }
});

test("private frame cancellation interrupts a pending read without echoing content", async () => {
  const controller = new AbortController();
  const input = new PassThrough();
  const result = readPrivateFrame(input, 64, controller.signal);
  input.write(Buffer.from([0, 0, 0, 10, 83]));
  controller.abort();
  await assert.rejects(result, /^Error: private_frame_cancelled$/u);
});

test("write failure after delivery begins is unknown and never reveals input", async () => {
  let calls = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { calls++; callback(new Error("synthetic-secret")); } });
  await assert.rejects(writePrivateFrame(output, { jwt: "synthetic-secret" }, 1024, signal()), /^Error: private_frame_delivery_unknown$/u);
  assert.equal(calls, 1);
});
