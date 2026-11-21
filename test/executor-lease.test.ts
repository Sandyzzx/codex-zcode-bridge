import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireExecutorLease, authorityRootDigest, EXECUTOR_LEASE_FILE } from "../src/executor/lease.js";
import { PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe, type ProbeRequest, type ProbeVerdict } from "../src/runtime/process-probe.js";

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

const options = (root: string, processProbe: ProcessProbe, pid = process.pid, fingerprint = "self-fingerprint") => ({
  authorityRoot: root,
  ownerKind: "executor" as const,
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
    assert.equal(lease.state, "active");
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
