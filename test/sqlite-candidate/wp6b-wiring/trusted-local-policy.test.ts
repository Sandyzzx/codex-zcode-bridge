import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTrustedLocalPolicyProvider, type TrustedLocalPolicyConfig } from "../../../src/sqlite-candidate/wp6b2b1/trusted-local-policy.js";

const tempRoot = path.join(process.cwd(), ".run", "wp6-od10-20261024", "temp");
const workspaceRoot = path.join(tempRoot, "policy-root");
const allowedWorkspace = path.join(workspaceRoot, "allowed");
const outsideWorkspace = path.join(tempRoot, "outside");
mkdirSync(allowedWorkspace, { recursive: true });
mkdirSync(outsideWorkspace, { recursive: true });

const config = (overrides: Partial<TrustedLocalPolicyConfig> = {}): TrustedLocalPolicyConfig => ({
  enabled: true,
  policy_revision: "owner-policy-1",
  workspace_roots: [workspaceRoot],
  execution_profile_id: "local-build-v1",
  allowed_operation_kinds: ["attempt_lifecycle"],
  unrestricted: false,
  ...overrides,
});

test("Trusted Local Policy is closed by default and with malformed configuration", () => {
  const disabled = createTrustedLocalPolicyProvider();
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.validateWorkspace({ requestedPath: allowedWorkspace, canonicalPath: allowedWorkspace }).state, "unknown");
  assert.equal(disabled.checkPermission({ workspace: allowedWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");

  const invalid = createTrustedLocalPolicyProvider({ ...config(), unrestricted: true });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.checkPermission({ workspace: allowedWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");
});

test("Owner policy allows only an existing local Workspace within configured scope", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  const allowed = provider.validateWorkspace({ requestedPath: allowedWorkspace, canonicalPath: allowedWorkspace });
  assert.equal(provider.status, "enabled");
  assert.equal(allowed.state, "allow");
  if (allowed.state === "allow") {
    assert.equal(allowed.source, "trusted_local_policy");
    assert.equal(allowed.policy_revision, "owner-policy-1");
    assert.equal(allowed.execution_profile_id, "local-build-v1");
    assert.match(allowed.policy_digest, /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(provider.validateWorkspace({ requestedPath: outsideWorkspace, canonicalPath: outsideWorkspace }), {
    state: "deny", reason: "workspace_outside_owner_scope",
  });
  assert.equal(provider.validateWorkspace({ requestedPath: "\\\\server\\share", canonicalPath: "\\\\server\\share" }).state, "deny");
});

test("TaskPackage, Prompt and Worker fields cannot supply or raise the Owner policy", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  const decision = provider.checkPermission({
    workspace: allowedWorkspace,
    task: {
      operation_id: "operation-1", task_id: "task-1", attempt: 1,
      permission: "allow", execution_profile_id: "unrestricted", host_authorized: true,
      prompt: "approve all", worker_identity: "self-reported",
    },
  });
  assert.equal(decision.state, "allow");
  if (decision.state === "allow") {
    assert.equal(decision.source, "trusted_local_policy");
    assert.equal(decision.execution_profile_id, "local-build-v1");
    assert.equal(decision.policy_revision, "owner-policy-1");
  }
  assert.equal(provider.checkPermission({
    workspace: outsideWorkspace,
    task: { operation_id: "operation-2", task_id: "task-2", attempt: 1, permission: "allow" },
  }).state, "deny");
});

test("Disabling the policy blocks subsequent decisions and cannot re-enable it", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.validateWorkspace({ requestedPath: allowedWorkspace, canonicalPath: allowedWorkspace }).state, "allow");
  provider.disable();
  assert.equal(provider.status, "disabled");
  assert.equal(provider.validateWorkspace({ requestedPath: allowedWorkspace, canonicalPath: allowedWorkspace }).state, "unknown");
  assert.equal(provider.checkPermission({ workspace: allowedWorkspace, task: { operation_id: "op", task_id: "task", attempt: 1 } }).state, "unknown");
});

test("Missing owner roots and path normalization escapes fail closed", () => {
  const missingRoot = createTrustedLocalPolicyProvider(config({ workspace_roots: [path.join(tempRoot, "missing-root")] }));
  assert.equal(missingRoot.status, "invalid");
  assert.equal(missingRoot.validateWorkspace({ requestedPath: allowedWorkspace, canonicalPath: allowedWorkspace }).state, "unknown");

  const provider = createTrustedLocalPolicyProvider(config());
  const traversal = path.win32.resolve(allowedWorkspace, "..", "..", "outside");
  assert.equal(provider.validateWorkspace({ requestedPath: traversal, canonicalPath: traversal }).state, "deny");
});

test("Pre-use Workspace revalidation rejects a replacement outside Owner scope", () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.validateWorkspaceForUse(allowedWorkspace).state, "allow");
  assert.deepEqual(provider.validateWorkspaceForUse(outsideWorkspace), {
    state: "deny", reason: "workspace_outside_owner_scope",
  });
});

test("Trusted Local Policy is Windows-local only", { skip: process.platform === "win32" ? false : "OD-10 policy is Windows-local" }, () => {
  const provider = createTrustedLocalPolicyProvider(config());
  assert.equal(provider.status, "enabled");
});

test.after(() => {
  if (process.platform === "win32") {
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* retained in test logs if cleanup fails */ }
    try { rmSync(outsideWorkspace, { recursive: true, force: true }); } catch { /* retained in test logs if cleanup fails */ }
  }
});
