import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTrustedLocalCandidateContext } from "../../src/host/stdio.js";
import { codexHostProfile } from "../../src/host/profile.js";
import { isTrustedLocalStdioContext } from "../../src/runtime/trusted-local-deployment.js";
import { createHostTrustedLocalPolicyProvider, loadTrustedLocalPolicyConfig } from "../../src/runtime/trusted-local-policy-config.js";
import { resolveTrustedLocalExecutionProfile } from "../../src/runtime/trusted-local-profile.js";
import { createTrustedLocalPolicyProvider } from "../../src/sqlite-candidate/wp6b2b1/trusted-local-policy.js";
import { LifecycleGateError, openClaimOnlyDriver } from "../../src/store/lifecycle-gate.js";

function fixture(): { root: string; host: ReturnType<typeof codexHostProfile>; workspace: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-trusted-policy-"));
  const home = path.join(root, "home");
  const settings = path.join(home, ".codex", "codex-zcode-bridge");
  const workspace = path.join(root, "workspace");
  mkdirSync(settings, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const host = codexHostProfile(home);
  return { root, host, workspace, file: path.join(settings, "trusted-local-policy.json") };
}

function policy(workspace: string): Record<string, unknown> {
  return {
    schema_version: 1,
    enabled: true,
    policy_revision: "owner-r2a-1",
    workspace_roots: [workspace],
    execution_profile_id: "local-build-v1",
    allowed_operation_kinds: ["attempt_lifecycle"],
    unrestricted: false,
  };
}

test("trusted policy loads only from the Host settings file and has a bounded actual profile mapping", () => {
  const fx = fixture();
  try {
    assert.equal(loadTrustedLocalPolicyConfig(fx.host).status, "disabled");
    writeFileSync(fx.file, JSON.stringify(policy(fx.workspace)));
    const loaded = loadTrustedLocalPolicyConfig(fx.host);
    assert.equal(loaded.status, "loaded");
    if (loaded.status !== "loaded") return;
    assert.equal(loaded.config.execution_profile_id, "local-build-v1");
    assert.equal(loaded.config.unrestricted, false);
    assert.equal("deployment" in loaded.config, false, "deployment evidence comes from the Host composition, not policy bytes");
    assert.deepEqual(resolveTrustedLocalExecutionProfile(loaded.config.execution_profile_id), {
      id: "local-build-v1", sessionMode: "build", unrestricted: false,
    });
    const provider = createTrustedLocalPolicyProvider(loaded.config);
    assert.equal(provider.checkPermission({
      workspace: fx.workspace,
      task: { operation_id: "op-1", task_id: "task-1", attempt: 1, execution_profile_id: "unrestricted" },
    }).state, "allow");
    const decision = provider.checkPermission({ workspace: fx.workspace, task: { operation_id: "op-2", task_id: "task-2", attempt: 1 } });
    assert.equal(decision.state, "allow");
    if (decision.state === "allow") {
      assert.equal(decision.execution_profile_id, "local-build-v1");
      assert.equal(decision.execution_mode, "build");
    }
    const live = createHostTrustedLocalPolicyProvider(fx.host);
    assert.equal(live.checkPermission({ workspace: fx.workspace, task: { operation_id: "op-3", task_id: "task-3", attempt: 1 } }).state, "allow");
    const otherWorkspace = path.join(fx.root, "other-workspace");
    mkdirSync(otherWorkspace);
    writeFileSync(fx.file, JSON.stringify(policy(otherWorkspace)));
    assert.equal(live.checkPermission({ workspace: fx.workspace, task: { operation_id: "op-4", task_id: "task-4", attempt: 1 } }).state, "deny");
    writeFileSync(fx.file, "{invalid");
    assert.equal(live.checkPermission({ workspace: fx.workspace, task: { operation_id: "op-5", task_id: "task-5", attempt: 1 } }).state, "unknown");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("invalid, unknown-profile, oversized and symlink policy sources fail closed", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.file, JSON.stringify({ ...policy(fx.workspace), extra: true }));
    assert.equal(loadTrustedLocalPolicyConfig(fx.host).status, "invalid");
    writeFileSync(fx.file, JSON.stringify({ ...policy(fx.workspace), execution_profile_id: "yolo" }));
    assert.equal(loadTrustedLocalPolicyConfig(fx.host).status, "invalid");
    writeFileSync(fx.file, " ".repeat(65_537));
    assert.equal(loadTrustedLocalPolicyConfig(fx.host).status, "invalid");
    rmSync(fx.file);
    symlinkSync(fx.workspace, fx.file, "junction");
    assert.equal(loadTrustedLocalPolicyConfig(fx.host).status, "invalid");
    assert.equal(resolveTrustedLocalExecutionProfile("unrestricted"), null);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("only the local stdio Host composition can create the in-process Candidate capability", async () => {
  const fx = fixture();
  const unopenedRoot = path.join(fx.root, "must-not-open");
  let candidateModulesLoaded = false;
  try {
    const context = createTrustedLocalCandidateContext(fx.host);
    assert.equal(isTrustedLocalStdioContext(context), true);
    assert.equal(isTrustedLocalStdioContext({ policy: context.policy, status: "enabled" }), false);

    const base = {
      dataRoot: unopenedRoot,
      workerEntryPath: path.join(fx.root, "worker-not-used.mjs"),
      bridgeEntryPath: path.join(fx.root, "bridge-not-used.mjs"),
      loadModules: async () => {
        candidateModulesLoaded = true;
        throw new Error("candidate modules must not load without a Host capability");
      },
    };
    const assertRejectedBeforeAdmission = async (trustedLocalContext?: unknown) => {
      await assert.rejects(
        openClaimOnlyDriver({
          ...base,
          ...(trustedLocalContext === undefined ? {} : { trustedLocalContext: trustedLocalContext as never }),
        }),
        (error: unknown) => error instanceof LifecycleGateError && error.code === "trusted_local_deployment_untrusted",
      );
      assert.equal(candidateModulesLoaded, false);
      assert.equal(existsSync(unopenedRoot), false);
    };

    await assertRejectedBeforeAdmission();
    await assertRejectedBeforeAdmission({ transport: "stdio", single_user: true, remote: false });
    await assertRejectedBeforeAdmission({ transport: "http", single_user: true, remote: true });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
