import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTrustedLocalCandidateContext } from "../../src/host/stdio.js";
import { codexHostProfile } from "../../src/host/profile.js";
import { isTrustedLocalStdioContext } from "../../src/runtime/trusted-local-deployment.js";
import { createHostTrustedLocalPolicyProvider, loadTrustedLocalPolicyConfig } from "../../src/runtime/trusted-local-policy-config.js";
import { resolveTrustedLocalExecutionProfile } from "../../src/runtime/trusted-local-profile.js";
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

test("built-in trusted-local policy needs no settings file and preserves the bounded execution profile", () => {
  const fx = fixture();
  try {
    writeFileSync(fx.file, JSON.stringify({ workspace_roots: ["D:\\not-used"] }));
    const loaded = loadTrustedLocalPolicyConfig(fx.host);
    assert.equal(loaded.status, "loaded");
    assert.equal(loaded.source, "built-in-local-stdio");
    assert.equal(loaded.config.policy_revision, "single-user-local-v2");
    assert.equal(loaded.config.execution_profile_id, "local-build-v1");
    assert.equal(loaded.config.unrestricted, false);
    assert.equal("workspace_roots" in loaded.config, false);
    assert.equal("deployment" in loaded.config, false, "deployment evidence comes from the Host composition, not policy bytes");
    assert.deepEqual(resolveTrustedLocalExecutionProfile(loaded.config.execution_profile_id), {
      id: "local-build-v1", sessionMode: "build", unrestricted: false,
    });
    const live = createHostTrustedLocalPolicyProvider(fx.host);
    const decision = live.checkPermission({
      workspace: fx.workspace,
      task: { operation_id: "op-1", task_id: "task-1", attempt: 1, execution_profile_id: "unrestricted" },
    });
    assert.equal(decision.state, "allow");
    if (decision.state === "allow") {
      assert.equal(decision.execution_profile_id, "local-build-v1");
      assert.equal(decision.execution_mode, "build");
      assert.equal(decision.policy_revision, "single-user-local-v2");
    }
    const otherWorkspace = path.join(fx.root, "other-workspace");
    mkdirSync(otherWorkspace);
    assert.equal(live.checkPermission({ workspace: otherWorkspace, task: { operation_id: "op-2", task_id: "task-2", attempt: 1 } }).state, "allow");
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
