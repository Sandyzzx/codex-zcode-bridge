import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireExecutorLease,
  assertExecutorLeaseTransition,
  authorityRootDigest,
  clearExecutorLease,
  EXECUTOR_LEASE_FILE,
  EXECUTOR_LEASE_RELEASED_FILE,
  inspectExecutorLease,
} from "../src/executor/lease.js";
import { PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe, type ProbeRequest, type ProbeVerdict } from "../src/runtime/process-probe.js";
import type { ProgressTaskManager, TaskPackage } from "../src/interfaces.js";

const identity = (pid: number, fingerprint: string): ProcessIdentity => ({
  pid,
  fingerprint,
  fingerprint_precision: "exact",
  identity_version: PROCESS_IDENTITY_VERSION,
  platform: process.platform,
  captured_at: new Date().toISOString(),
});

function probeWith(verdict: ProbeVerdict, expectedPid?: number): ProcessProbe {
  return {
    platform: process.platform,
    identityOf: async (pid: number) => identity(pid, "probe-fingerprint"),
    selfIdentity: async () => identity(process.pid, "self-fingerprint"),
    probe: async (requests: readonly ProbeRequest[]) => requests.map((request) => request.pid === expectedPid ? verdict : {
      state: "exited",
      reason_code: "pid_absent",
      observed_at: new Date().toISOString(),
    }),
  };
}

const options = (
  root: string,
  processProbe: ProcessProbe,
  pid = process.pid,
  fingerprint = "self-fingerprint",
  ownerKind: "executor" | "legacy_mcp" = "executor",
) => ({
  authorityRoot: root,
  ownerKind,
  processProbe,
  identity: identity(pid, fingerprint),
  bridgeSha256: "a".repeat(64),
  workerSha256: "b".repeat(64),
  pipeName: "test-pipe",
});

test("acquire atomically creates an active exact-process lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    const handle = await acquireExecutorLease(options(root, probeWith({ state: "unknown", reason_code: "unused", observed_at: "" })));
    const lease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8"));
    assert.equal(lease.authority_root_digest, authorityRootDigest(root));
    assert.equal(lease.owner.process_id, process.pid);
    assert.equal(lease.owner.start_fingerprint, "self-fingerprint");
    await handle.release();
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    const released = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE), "utf8"));
    assert.equal(released.lease_id, lease.lease_id);
    assert.equal(released.state, "released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact live owner prevents a second owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    await acquireExecutorLease(options(root, probeWith({ state: "unknown", reason_code: "unused", observed_at: "" })));
    await assert.rejects(() => acquireExecutorLease(options(root, probeWith({
      state: "alive",
      reason_code: "pid_and_fingerprint_match",
      observed_at: "",
    }, process.pid))), /EXECUTOR_ALREADY_ACTIVE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new legacy MCP Host and an Executor cannot own the same Root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
      process.pid,
      "self-fingerprint",
      "legacy_mcp",
    ));
    await assert.rejects(() => acquireExecutorLease(options(
      root,
      probeWith({ state: "alive", reason_code: "pid_and_fingerprint_match", observed_at: "" }, process.pid),
      process.pid,
      "self-fingerprint",
      "executor",
    )), /EXECUTOR_ALREADY_ACTIVE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown owners and PID reuse fail closed as stale_unknown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    await acquireExecutorLease(options(root, probeWith({ state: "unknown", reason_code: "unused", observed_at: "" })));
    await assert.rejects(() => acquireExecutorLease(options(root, probeWith({
      state: "unknown",
      reason_code: "query_timeout",
      observed_at: "",
    }, process.pid))), /owner_probe_unknown/u);
    const stale = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8"));
    assert.equal(stale.state, "stale_unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact owner exit still requires explicit lease recovery", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
      process.pid,
      "dead-owner-fingerprint",
    ));
    await assert.rejects(() => acquireExecutorLease(options(root, probeWith({
      state: "exited",
      reason_code: "pid_absent",
      observed_at: "",
    }, 999_999))), /owner_exited_requires_explicit_clear/u);
    const stale = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8"));
    assert.equal(stale.state, "stale_unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual lease clear refuses an exact live owner and clears only a proven exit", async () => {
  const liveRoot = mkdtempSync(path.join(tmpdir(), "executor-lease-live-"));
  const deadRoot = mkdtempSync(path.join(tmpdir(), "executor-lease-dead-"));
  try {
    await acquireExecutorLease(options(
      liveRoot,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
    ));
    await assert.rejects(() => clearExecutorLease({
      authorityRoot: liveRoot,
      processProbe: probeWith({
        state: "alive",
        reason_code: "pid_and_fingerprint_match",
        observed_at: "",
      }, process.pid),
    }), (error: unknown) => (error as { code?: string }).code === "EXECUTOR_LEASE_OWNER_ACTIVE");
    assert.equal(existsSync(path.join(liveRoot, EXECUTOR_LEASE_FILE)), true);

    await acquireExecutorLease(options(
      deadRoot,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
      process.pid,
      "dead-owner-fingerprint",
    ));
    const cleared = await clearExecutorLease({
      authorityRoot: deadRoot,
      processProbe: probeWith({
        state: "exited",
        reason_code: "pid_absent",
        observed_at: "",
      }, 999_999),
    });
    assert.equal(cleared.state, "stale_unknown");
    assert.equal(existsSync(path.join(deadRoot, EXECUTOR_LEASE_FILE)), false);
  } finally {
    rmSync(liveRoot, { recursive: true, force: true });
    rmSync(deadRoot, { recursive: true, force: true });
  }
});

test("lease inspection is read-only and reports exact owner state plus heartbeat age", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-inspect-"));
  try {
    const before = Date.now();
    const handle = await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
    ));
    const inspection = await inspectExecutorLease({
      authorityRoot: root,
      processProbe: probeWith({
        state: "alive",
        reason_code: "pid_and_fingerprint_match",
        observed_at: "",
      }, process.pid),
      now: () => before + 5_000,
    });
    assert.equal(inspection.lease.lease_id, handle.lease.lease_id);
    assert.equal(inspection.owner_state, "alive");
    assert.ok(inspection.heartbeat_age_ms !== null && inspection.heartbeat_age_ms >= 0);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a release publish failure cannot be mistaken for a releasable owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    const handle = await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
    ));
    mkdirSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE));
    await assert.rejects(() => handle.release(), (error: unknown) =>
      (error as { code?: string }).code === "EXECUTOR_LEASE_RELEASE_UNKNOWN");
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
    const unpublished = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8"));
    assert.equal(unpublished.state, "released");
    await assert.rejects(() => acquireExecutorLease(options(root, probeWith({
      state: "exited",
      reason_code: "pid_absent",
      observed_at: "",
    }, process.pid))), /unpublished_released_lease_requires_clear/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing lease fences heartbeat and reports the failure to the Executor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    const handle = await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
    ));
    unlinkSync(path.join(root, EXECUTOR_LEASE_FILE));
    let reported: Error | null = null;
    await assert.rejects(() => handle.heartbeat({ onUnknown: (error) => { reported = error; } }));
    assert.ok(reported);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing unleased Authority requires an explicit one-time transition", () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-transition-"));
  try {
    writeFileSync(path.join(root, "bridge.sqlite"), "", "utf8");
    assert.throws(() => assertExecutorLeaseTransition({
      authorityRoot: root,
      databaseFileName: "bridge.sqlite",
      acceptUnleasedExistingRoot: false,
    }), (error: unknown) => (error as { code?: string }).code === "EXECUTOR_LEASE_TRANSITION_REQUIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit transition acknowledgement permits a stopped historical owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-transition-"));
  try {
    writeFileSync(path.join(root, "bridge.sqlite"), "", "utf8");
    assert.doesNotThrow(() => assertExecutorLeaseTransition({
      authorityRoot: root,
      databaseFileName: "bridge.sqlite",
      acceptUnleasedExistingRoot: true,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a released Lease history does not require another transition acknowledgement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-transition-"));
  try {
    const handle = await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
    ));
    await handle.release();
    writeFileSync(path.join(root, "bridge.sqlite"), "", "utf8");
    assert.doesNotThrow(() => assertExecutorLeaseTransition({
      authorityRoot: root,
      databaseFileName: "bridge.sqlite",
      acceptUnleasedExistingRoot: false,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("transition acknowledgement cannot bypass an exact live old owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-transition-"));
  try {
    await acquireExecutorLease(options(
      root,
      probeWith({ state: "unknown", reason_code: "unused", observed_at: "" }),
      process.pid,
      "self-fingerprint",
      "legacy_mcp",
    ));
    assert.doesNotThrow(() => assertExecutorLeaseTransition({
      authorityRoot: root,
      databaseFileName: "bridge.sqlite",
      acceptUnleasedExistingRoot: true,
    }));
    await assert.rejects(() => acquireExecutorLease(options(
      root,
      probeWith({ state: "alive", reason_code: "pid_and_fingerprint_match", observed_at: "" }, process.pid),
    )), /EXECUTOR_ALREADY_ACTIVE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed lease fails closed before ownership", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-lease-"));
  try {
    writeFileSync(path.join(root, EXECUTOR_LEASE_FILE), "{bad");
    await assert.rejects(() => acquireExecutorLease(options(root, probeWith({
      state: "exited",
      reason_code: "pid_absent",
      observed_at: "",
    }))), /EXECUTOR_LEASE_MALFORMED/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
