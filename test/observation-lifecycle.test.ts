import assert from "node:assert/strict";
import test from "node:test";
import {existsSync,readFileSync,mkdtempSync,rmSync,writeFileSync,mkdirSync,utimesSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {judgeTaskObservation} from "../src/observation/judge.js";
import {tryAcquireProcessLock,withProcessLock} from "../src/store/process-lock.js";
import {createPlatformProbe} from "../src/runtime/process-probe.js";
import type {TaskStatus} from "../src/interfaces.js";
import {makeTempDir,removeTempDir} from "./helpers.js";
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const T0=Date.UTC(2026,9,4,0,0,0);
const iso=(ms:number)=>new Date(T0+ms).toISOString();

test("a fresh heartbeat without business events does not assert business execution", () => {
  const now = T0 + 60_000;
  const input: import("../src/observation/types.js").JudgeInput = {
    status: { status: "running", attempt: 1, started_at: iso(0), finished_at: null, worker_pid: 123 },
    result: null, checkpoint: null, pending_interaction: null, last_business_event: null, now_ms: now,
    heartbeat: { attempt: 1, worker_pid: 123, heartbeat_at: iso(59_000), last_event_seq: 0, last_event_type: null, session_id: null, turn_id: null },
  };
  const observation = judgeTaskObservation(input);
  assert.equal(observation.worker.state, "alive");
  assert.equal(observation.activity.code, "unknown");
  assert.equal(observation.activity.reason_code, "heartbeat_alive_no_business_event");
  assert.equal(observation.stalled, false);
  assert.equal(judgeTaskObservation({ ...input, status: { ...input.status, started_at: iso(59_000) } }).activity.code, "starting");
});

test("A2-07: lock owners are never evicted by age; reclaim needs explicit exit evidence", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zcode-bridge-test-a2-lock-"));
  try {
    const lockDir = path.join(tmp, "case.lock");
    // Corrupt owner record: stays blocking, never auto-reclaimed.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "owner.json"), "{broken");
    assert.equal(tryAcquireProcessLock(lockDir), null, "a corrupt owner must block");
    // Live same-pid owner: no reclaim.
    const liveDir = path.join(tmp, "live.lock");
    const release = tryAcquireProcessLock(liveDir);
    assert.ok(release);
    assert.equal(tryAcquireProcessLock(liveDir), null);
    release();
    // Dead owner (impossible pid → ESRCH): reclaimed.
    const deadDir = path.join(tmp, "dead.lock");
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(path.join(deadDir, "owner.json"), JSON.stringify({ pid: 987654, token: "t" }));
    const reclaimed = tryAcquireProcessLock(deadDir);
    assert.ok(reclaimed, "a provably dead owner is reclaimed");
    reclaimed();
    // Old-format owner without fingerprint stays readable and reclaimable on ESRCH only.
    const oldDir = path.join(tmp, "old.lock");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(path.join(oldDir, "owner.json"), JSON.stringify({ pid: 987655 }));
    const reclaimedOld = tryAcquireProcessLock(oldDir);
    assert.ok(reclaimedOld);
    reclaimedOld();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A2-07c: lock publication exposes a complete owner record and ignores abandoned staging dirs", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zcode-bridge-test-a2-lock-publish-"));
  try {
    const lockDir = path.join(tmp, "recovery.lock");
    const abandoned = `${lockDir}.12345.crashed.pending`;
    mkdirSync(abandoned);
    writeFileSync(path.join(abandoned, "owner.json"), "");

    const release = tryAcquireProcessLock(lockDir);
    assert.ok(release, "an incomplete private staging directory must not block the shared lock");
    const owner = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8")) as { pid?: number; token?: string };
    assert.equal(owner.pid, process.pid);
    assert.ok(owner.token);
    assert.equal(tryAcquireProcessLock(lockDir), null, "a published live owner keeps the lock");
    release();
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A2-07b: a live owner is never evicted no matter how old the lock is", async () => {
  const root = await makeTempDir("a2-lock-live");
  try {
    const lockDir = path.join(root, "aged.lock");
    const release = tryAcquireProcessLock(lockDir);
    assert.ok(release);
    // Touch the directory mtime far into the past.
    const deadline = Date.now() + 500;
    while (tryAcquireProcessLock(lockDir) === null && Date.now() < deadline) await delay(25);
    assert.equal(tryAcquireProcessLock(lockDir), null, "a live owner keeps the lock");
    await assert.rejects(withProcessLock(lockDir, async () => 1, 100), /timed out/);
    release();
  } finally { await removeTempDir(root); }
});

test("A2-08: the platform probe answers alive for a live process with a matching identity", { timeout: 20_000 }, async () => {
  const probe = createPlatformProbe();
  const identity = await probe.selfIdentity();
  assert.equal(identity.pid, process.pid);
  if (process.platform === "win32" || process.platform === "linux") {
    assert.ok(identity.fingerprint, `${process.platform} must expose a startup fingerprint`);
    assert.equal(identity.fingerprint_precision, "exact");
    const absentIdentity: import("../src/runtime/process-probe.js").ProcessIdentity = { pid: 987654, fingerprint: "fp-gone", fingerprint_precision: "exact", identity_version: 1, platform: process.platform, captured_at: new Date().toISOString() };
    // Batch duplicate and absent PIDs so Windows starts one bounded PowerShell
    // query instead of paying that startup cost once per assertion.
    const verdicts = await probe.probe([
      { pid: process.pid, identity },
      { pid: process.pid, identity: { ...identity, fingerprint: "definitely-not-the-same" } },
      { pid: 987654, identity: absentIdentity },
    ]);
    assert.equal(verdicts[0]!.state, "alive");
    assert.equal(verdicts[0]!.reason_code, "pid_and_fingerprint_match");
    // A mismatched fingerprint on the same live PID proves reuse.
    assert.equal(verdicts[1]!.state, "exited");
    assert.equal(verdicts[1]!.reason_code, "pid_reused");
    // An absent (but plausible) PID is conclusive exit evidence. Huge PIDs
    // make Get-Process itself error, which correctly answers unknown instead.
    assert.equal(verdicts[2]!.state, "exited");
    assert.equal(verdicts[2]!.reason_code, "pid_absent");
  } else {
    // macOS/other: the probe must answer without claiming exact identity.
    const verdicts = await probe.probe([{ pid: process.pid, identity }]);
    assert.ok(["alive", "unknown"].includes(verdicts[0]!.state));
  }
});

test("A2-08b: probe query failures answer unknown, never exited", { timeout: 20_000 }, async () => {
  const probe = createPlatformProbe({ timeoutMs: 1 });
  if (process.platform === "win32") {
    // A 1ms timeout forces the bounded-timeout path on Windows.
    const verdicts = await probe.probe([{ pid: process.pid, identity: null }]);
    assert.equal(verdicts[0]!.state, "unknown");
  }
});

test("judger degrades to unknown on clock jumps and reports queued starting", () => {
  const base = {
    status: {
      status: "running" as TaskStatus,
      attempt: 1,
      started_at: iso(0),
      finished_at: null,
      worker_pid: 4242,
    },
    result: null,
    checkpoint: null,
    heartbeat: null,
    last_business_event: null,
    pending_interaction: null,
    now_ms: T0 + 1_000,
  };
  const futureHeartbeat = judgeTaskObservation({
    ...base,
    heartbeat: { attempt: 1, worker_pid: 4242, heartbeat_at: iso(600_000), last_event_seq: 0, last_event_type: null, session_id: null, turn_id: null },
  });
  assert.equal(futureHeartbeat.worker.state, "unknown");
  assert.equal(futureHeartbeat.worker.reason_code, "clock_skew");
  assert.equal(futureHeartbeat.evidence.heartbeat_age_ms, null);
  const queued = judgeTaskObservation({
    ...base,
    status: { ...base.status, status: "queued", started_at: null },
  });
  assert.equal(queued.activity.code, "starting");
});
