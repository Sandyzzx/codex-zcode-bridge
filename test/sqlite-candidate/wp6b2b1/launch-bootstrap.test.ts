import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Writable } from "node:stream";
import test from "node:test";
import {
  createLaunchBootstrap,
  decodeLaunchBootstrap,
  encodeLaunchBootstrap,
  deriveAdmissionPolicySnapshotDigest,
  spawnAndBootstrapOnce,
  writeLaunchBootstrap,
} from "../../../src/sqlite-candidate/wp6b2b1/launch-bootstrap.js";

const secret = "launch-token-must-never-cross-the-worker-boundary";
const request = {
  operation_id: "op-private-channel",
  task_id: "task-private-channel",
  attempt: 4,
  generation: 9001,
  launch_id: "launch-private-channel",
  launch_epoch: 2,
  launch_token: secret,
  policy_snapshot: (() => {
    const snapshot = {
      operation_id: "op-private-channel",
      task_id: "task-private-channel",
      attempt: 4,
      generation: 9001,
      workspace_ref: "C:\\synthetic\\workspace",
      authorization_source: "trusted_local_policy" as const,
      policy_revision: "policy-v1",
      policy_digest: "a".repeat(64),
      execution_profile_id: "local-build-v1",
    };
    return { ...snapshot, policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(snapshot) };
  })(),
};

test("bootstrap carries the Manager-issued token and rejects Worker-invented extra fields", () => {
  const bootstrap = createLaunchBootstrap(request);
  assert.deepEqual(Object.keys(bootstrap).sort(), ["attempt", "authorization_source", "execution_profile_id", "generation", "launch_epoch", "launch_id", "launch_token", "operation_id", "policy_digest", "policy_revision", "policy_snapshot_digest", "protocol", "task_id", "workspace_ref"]);
  assert.equal(bootstrap.launch_token, secret);
  assert.deepEqual(decodeLaunchBootstrap(encodeLaunchBootstrap(bootstrap)), bootstrap);
  assert.throws(() => encodeLaunchBootstrap({ ...bootstrap, worker_reported_pid: 1234 }), /invalid launch bootstrap fields/u);
  assert.throws(() => encodeLaunchBootstrap({ ...bootstrap, policy_digest: "b".repeat(64) }), /invalid launch bootstrap fields/u,
    "policy snapshot fields must match the digest bound to the private Bootstrap");
  assert.throws(() => encodeLaunchBootstrap({ ...bootstrap, policy_snapshot_digest: undefined }), /invalid launch bootstrap fields/u,
    "missing policy snapshot evidence is rejected");
});

test("one-shot inherited child pipe carries token without argv, environment, or raw log exposure", async (t) => {
  const childCode = [
    "const { createReadStream } = require('node:fs');",
    "const { createHash } = require('node:crypto');",
    "(async()=>{ let frame=''; for await (const chunk of createReadStream(null,{fd:3,autoClose:true})) frame+=chunk.toString('utf8');",
    "const value=JSON.parse(frame);",
    "process.stdout.write(JSON.stringify({operation_id:value.operation_id,tokenDigest:createHash('sha256').update(value.launch_token).digest('hex'),envHasToken:Object.values(process.env).includes(value.launch_token),argv:process.argv,envNames:Object.keys(process.env)})); })().catch(error=>{ console.error(error); process.exitCode=1; });",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childCode], {
    stdio: ["ignore", "pipe", "ignore", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const spawned = child.pid !== undefined ? Promise.resolve() : once(child, "spawn");
  await spawned;
  const pipe = child.stdio[3];
  assert.ok(pipe && "write" in pipe, "dedicated inherited fd 3 must be writable by Manager");
  const launchChild = Object.assign(child, { bootstrapChannel: pipe as Writable });
  let stdout = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  const closePromise = once(child, "close");
  const sent = await spawnAndBootstrapOnce(() => launchChild, request);
  assert.equal(sent.state, "bootstrap_sent");
  if (sent.state !== "bootstrap_sent") throw new Error("bootstrap unexpectedly not sent");
  assert.equal(sent.child, launchChild);
  const [exitCode] = await closePromise;
  assert.equal(exitCode, 0);
  const observation = JSON.parse(stdout) as { operation_id: string; tokenDigest: string; envHasToken: boolean; argv: string[]; envNames: string[] };
  assert.equal(observation.operation_id, request.operation_id);
  assert.equal(observation.tokenDigest, createHash("sha256").update(secret).digest("hex"));
  assert.equal(observation.envHasToken, false);
  assert.equal(child.spawnargs.join(" ").includes(secret), false);
  assert.equal(observation.envNames.some((name) => /launch.?token/iu.test(name)), false);
  assert.equal(stdout.includes(secret), false, "test child emits only a digest, never the raw token");
});

test("decoder rejects incomplete, multi-frame, oversized, and unknown-protocol messages", () => {
  assert.throws(() => decodeLaunchBootstrap("{}"), /invalid launch bootstrap frame/u);
  assert.throws(() => decodeLaunchBootstrap("{}\n{}\n"), /invalid launch bootstrap frame/u);
  assert.throws(() => decodeLaunchBootstrap(Buffer.alloc(8_193, 0x61)), /invalid launch bootstrap frame/u);
  const valid = createLaunchBootstrap(request);
  assert.throws(() => decodeLaunchBootstrap(encodeLaunchBootstrap({ ...valid, protocol: "unknown" })), /invalid launch bootstrap fields/u);
  assert.throws(() => decodeLaunchBootstrap(Buffer.from([0xff, 0x0a])), /invalid launch bootstrap UTF-8/u);
});

test("closed or failed token pipe returns an error to Manager", async () => {
  const broken = (): Writable => new Writable({ write(_chunk, _encoding, callback) { callback(new Error("private pipe failed")); } });
  await assert.rejects(writeLaunchBootstrap(broken(), request), /private pipe failed/u);
  const child = {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    bootstrapChannel: broken(),
    kill: () => true,
    on() { return this; },
  };
  let spawnCalls = 0;
  const unknown = await spawnAndBootstrapOnce(() => { spawnCalls += 1; return child; }, request);
  assert.equal(unknown.state, "launch_outcome_unknown");
  if (unknown.state !== "launch_outcome_unknown") throw new Error("failed channel unexpectedly reported sent");
  assert.equal(unknown.reason, "private_channel_failed");
  assert.equal(unknown.child, child, "Manager keeps the actual child observation context");
  assert.equal(spawnCalls, 1, "no helper retry can spawn a second child");
});
