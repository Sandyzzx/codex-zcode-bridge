import assert from "node:assert/strict";
import test from "node:test";
import { parseWindowsTreeCapture, terminateWindowsProcessTree, type WindowsCleanupDependencies } from "../src/adapters/windows-process-cleanup.js";
import type { ProbeVerdict } from "../src/runtime/process-probe.js";

const requests = parseWindowsTreeCapture("bridge_tree_snapshot_v1\n101|123\n102|456", 101);
function verdict(state: ProbeVerdict["state"]): ProbeVerdict {
  return { state, reason_code: state === "exited" ? "pid_absent" : "test", observed_at: new Date().toISOString() };
}
function fixture(after: ProbeVerdict["state"][], code: number | null = 0, before: ProbeVerdict["state"][] = ["alive", "alive"]): WindowsCleanupDependencies & { kills: number[] } {
  let probes = 0;
  const kills: number[] = [];
  return {
    kills, capture: async () => requests,
    probe: async () => (probes++ === 0 ? before : after).map(verdict),
    kill: async (pid) => { kills.push(pid); return code; },
  };
}

test("taskkill nonzero is resolved only by fresh exit evidence for root and descendants", async () => {
  const dependencies = fixture(["exited", "exited"], 128);
  await terminateWindowsProcessTree(101, 0, dependencies);
  assert.deepEqual(dependencies.kills, [101]);
});

test("successful taskkill and root exit cannot hide a surviving descendant", async () => {
  await assert.rejects(terminateWindowsProcessTree(101, 0, fixture(["exited", "alive"])), /recorded executors remain alive/);
});

test("a localized command failure does not leak its text or defeat verified natural exit", async () => {
  const dependencies = fixture(["exited", "exited"]);
  dependencies.kill = async () => { throw new Error("本地化错误与私有路径 �"); };
  await terminateWindowsProcessTree(101, 0, dependencies);
  const live = fixture(["exited", "alive"]);
  live.kill = dependencies.kill;
  await assert.rejects(terminateWindowsProcessTree(101, 0, live), (error: Error) => {
    assert.match(error.message, /command_error/);
    assert.doesNotMatch(error.message, /本地化|私有|�/);
    return true;
  });
});

test("unknown post-termination probe does not release the process tree", async () => {
  await assert.rejects(terminateWindowsProcessTree(101, 0, fixture(["exited", "unknown"], 128)), /probe_unverified/);
});

test("unknown pre-termination identity prevents signaling", async () => {
  const dependencies = fixture(["exited", "exited"], 0, ["unknown", "alive"]);
  await assert.rejects(terminateWindowsProcessTree(101, 0, dependencies), /probe_unverified/);
  assert.deepEqual(dependencies.kills, []);
});

test("a root PID whose old identity exited is never signaled even with a surviving child", async () => {
  const dependencies = fixture(["exited", "alive"], 0, ["exited", "alive"]);
  await assert.rejects(terminateWindowsProcessTree(101, 0, dependencies), /root exited/);
  assert.deepEqual(dependencies.kills, []);
  const exited = fixture(["exited", "exited"], 0, ["exited", "exited"]);
  await terminateWindowsProcessTree(101, 0, exited);
  assert.deepEqual(exited.kills, []);
});

test("incomplete probe batches cannot prove omitted descendants exited", async () => {
  const dependencies = fixture(["exited", "exited"]);
  dependencies.probe = async () => [verdict("exited")];
  await assert.rejects(terminateWindowsProcessTree(101, 0, dependencies), /probe_unverified/);
  assert.deepEqual(dependencies.kills, []);
});

test("tree capture requires a complete ASCII protocol and retains absent root for recheck", () => {
  const absent = parseWindowsTreeCapture("bridge_tree_snapshot_v1\n101|absent\n102|456", 101);
  assert.equal(absent[0]?.identity, null);
  for (const bad of ["101|123", "bridge_tree_snapshot_v1\n102|456", "bridge_tree_snapshot_v1\n101|", "bridge_tree_snapshot_v1\n101|123\n101|456", "bridge_tree_snapshot_v1\n101|123\ntruncated"]) {
    assert.throws(() => parseWindowsTreeCapture(bad, 101), /snapshot_invalid/);
  }
});
