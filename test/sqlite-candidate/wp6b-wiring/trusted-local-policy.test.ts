import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTrustedLocalPolicyProvider, type TrustedLocalPolicyConfig } from "../../../src/sqlite-candidate/wp6b2b1/trusted-local-policy.js";

const tempRoot = path.join(process.cwd(), ".run", "wp6-od10-20261024", "temp");
const firstWorkspace = path.join(tempRoot, "first-workspace");
const secondWorkspace = path.join(tempRoot, "second-workspace");
const nonDirectory = path.join(tempRoot, "not-a-directory.txt");
mkdirSync(firstWorkspace, { recursive: true });
mkdirSync(secondWorkspace, { recursive: true });
writeFileSync(nonDirectory, "fixture");

const config = (overrides: Partial<TrustedLocalPolicyConfig> = {}): TrustedLocalPolicyConfig => ({
  enabled: true,
  policy_revision: "single-user-local-v2",
  execution_profile_id: "local-build-v1",
  allowed_operation_kinds: ["attempt_lifecycle"],
  unrestricted: false,
  ...overrides,
});

test("Trusted Local Policy is closed by default and with malformed configuration", () => {
  const disabled = createTrustedLocalPolicyProvider();
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.validateWorkspace({ requestedPath: firstWorkspace, canonicalPath: firstWorkspace }).state, "unknown");
  assert.equal(disabled.checkPermission({ workspace: firstWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");

  const invalid = createTrustedLocalPolicyProvider({ ...config(), unrestricted: true });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.checkPermission({ workspace: firstWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");
});

test("Host policy accepts ordinary existing local project directories without a configured root list", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  const forwardSlashWorkspace = firstWorkspace.replaceAll("\\", "/");
  for (const workspace of [firstWorkspace, secondWorkspace, forwardSlashWorkspace]) {
    const allowed = provider.validateWorkspace({ requestedPath: workspace, canonicalPath: workspace });
    assert.equal(allowed.state, "allow");
    if (allowed.state === "allow") {
      assert.equal(allowed.source, "trusted_local_policy");
      assert.equal(allowed.policy_revision, "single-user-local-v2");
      assert.equal(allowed.execution_profile_id, "local-build-v1");
      assert.match(allowed.policy_digest, /^[0-9a-f]{64}$/u);
      assert.equal(path.win32.normalize(allowed.canonical_path), path.win32.normalize(workspace));
    }
  }
});

test("Relative, remote, missing, non-directory and canonical-mismatch paths fail closed", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.deepEqual(provider.validateWorkspace({ requestedPath: "relative\\path", canonicalPath: "relative\\path" }), {
    state: "deny", reason: "workspace_path_form_denied",
  });
  assert.deepEqual(provider.validateWorkspace({ requestedPath: "\\\\server\\share", canonicalPath: "\\\\server\\share" }), {
    state: "deny", reason: "workspace_path_form_denied",
  });
  assert.deepEqual(provider.validateWorkspace({
    requestedPath: path.join(tempRoot, "missing"),
    canonicalPath: path.join(tempRoot, "missing"),
  }), { state: "unknown", reason: "workspace_unavailable" });
  assert.deepEqual(provider.validateWorkspace({ requestedPath: nonDirectory, canonicalPath: nonDirectory }), {
    state: "unknown", reason: "workspace_not_directory",
  });
  assert.deepEqual(provider.validateWorkspace({ requestedPath: firstWorkspace, canonicalPath: secondWorkspace }), {
    state: "deny", reason: "workspace_canonical_mismatch",
  });
});

test("TaskPackage, Prompt and Worker fields cannot supply or raise the Host policy", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  const decision = provider.checkPermission({
    workspace: firstWorkspace,
    task: {
      operation_id: "operation-1", task_id: "task-1", attempt: 1,
      permission: "allow", execution_profile_id: "unrestricted", host_authorized: true,
      prompt: "approve all", worker_identity: "self-reported", workspace_roots: ["C:\\"],
    },
  });
  assert.equal(decision.state, "allow");
  if (decision.state === "allow") {
    assert.equal(decision.source, "trusted_local_policy");
    assert.equal(decision.execution_profile_id, "local-build-v1");
    assert.equal(decision.policy_revision, "single-user-local-v2");
  }
  assert.equal(provider.checkPermission({
    workspace: firstWorkspace,
    task: { task_id: "task-2", attempt: 1 },
  }).state, "deny");
});

test("Disabling the policy blocks subsequent decisions and cannot re-enable it", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.validateWorkspace({ requestedPath: firstWorkspace, canonicalPath: firstWorkspace }).state, "allow");
  provider.disable();
  assert.equal(provider.status, "disabled");
  assert.equal(provider.validateWorkspace({ requestedPath: firstWorkspace, canonicalPath: firstWorkspace }).state, "unknown");
  assert.equal(provider.checkPermission({ workspace: firstWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");
});

test("Pre-use workspace revalidation accepts local projects and rejects unavailable or remote paths", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.validateWorkspaceForUse(firstWorkspace).state, "allow");
  assert.equal(provider.validateWorkspaceForUse(secondWorkspace).state, "allow");
  assert.deepEqual(provider.validateWorkspaceForUse(path.join(tempRoot, "missing")), {
    state: "unknown", reason: "workspace_unavailable",
  });
  assert.deepEqual(provider.validateWorkspaceForUse("\\\\server\\share"), {
    state: "deny", reason: "workspace_path_form_denied",
  });
});

test("Policy callbacks remain valid when the Store invokes them without an object receiver", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  const { checkPermission, validateWorkspace } = provider;
  const validated = validateWorkspace({ requestedPath: firstWorkspace, canonicalPath: firstWorkspace });
  assert.equal(validated.state, "allow");
  const decision = checkPermission({
    workspace: firstWorkspace,
    task: { operation_id: "operation-unbound", task_id: "task-unbound", attempt: 1 },
  });
  assert.equal(decision.state, "allow");
  if (decision.state === "allow") {
    assert.equal(path.win32.normalize(decision.canonical_path), path.win32.normalize(firstWorkspace));
  }
});

test("Trusted Local Policy is Windows-local only", { skip: process.platform === "win32" ? false : "Trusted Local Policy is Windows-local" }, () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.status, "enabled");
});

test.after(() => {
  if (process.platform === "win32") {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* retained in test logs if cleanup fails */ }
  }
});
