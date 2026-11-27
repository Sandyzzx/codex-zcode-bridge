import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  OFFICIAL_PROTOCOL_SMOKE_METHOD,
  PROJECT_ROOT,
  runOfficialAppServerProtocolSmoke,
} from "../official-app-server-protocol-smoke.mjs";

const RUN_ROOT = path.join(PROJECT_ROOT, ".run");
const FIXED_ID = "00000000-0000-4000-8000-000000000003";

test("zero-model protocol smoke starts, inspects, and releases the official runtime", async () => {
  await mkdir(RUN_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(RUN_ROOT, "protocol-smoke-test-"));
  const install = path.join(root, "install");
  const files = {
    bundle: path.join(install, "resources", "glm", "zcode.cjs"),
    runtimeHost: path.join(install, "resources", "tools", "runtime-host", "zcode-runtime-host.exe"),
    builtin: path.join(install, "resources", "config", "provider", "zcode-builtin.json"),
    personal: path.join(root, "data", ".zcode", "v2", "provider_config.json"),
  };
  try {
    for (const filePath of Object.values(files)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "synthetic\n", "utf8");
    }
    const requested = [];
    let disposedWorkspace = 0;
    let disposedAll = 0;
    let environmentDuringConnect = null;
    const runRootParent = path.join(root, "authority", ".run");
    const options = {
      projectRoot: root,
      runRootParent,
      createId: () => FIXED_ID,
      timeoutMs: 5_000,
      inspectRuntime: async () => ({
        install_root: install,
        runtime_status: "OFFICIAL_RUNTIME_UNVERIFIED",
        installation_safety: "OFFICIAL_INSTALLATION_SAFE",
        installation_fingerprint: "a".repeat(64),
        desktop_version: "3.18.2.10443",
        desktop_app_version: "3.18.2",
        desktop_build_commit_id: "2681f4af",
        manifest: { version: "3.18.2.10443", desktop_app_version: "3.18.2", desktop_build_commit_id: "2681f4af" },
        assets: {
          bundle: { relative_path: "resources/glm/zcode.cjs", sha256: "a".repeat(64) },
          runtime_host: {
            relative_path: "resources/tools/runtime-host/zcode-runtime-host.exe",
            sha256: "b".repeat(64),
          },
          builtin_provider_config: {
            relative_path: "resources/config/provider/zcode-builtin.json",
            sha256: "c".repeat(64),
          },
        },
      }),
      resolveDataRoot: () => ({ dataBaseDir: path.join(root, "data") }),
      loadHostModule: async () => ({
        ZCodeAgentProcessManager: class {
          constructor(options) {
            this.options = options;
          }
          async getClient(workspace) {
            environmentDuringConnect = process.env.ZCODE_RUNTIME_HOST_PATH;
            assert.equal(workspace.workspacePath.startsWith(root), true);
            const command = await this.options.commandResolver({ workspacePath: workspace.workspacePath });
            assert.equal(command.args[1], "app-server");
            assert.deepEqual(command.args.slice(2), ["--stdio", "--surface", "desktop"]);
            assert.equal(command.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, files.builtin);
            assert.equal(command.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, files.personal);
            assert.equal(command.env.ZCODE_RUNTIME_HOST_PATH, files.runtimeHost);
            return {
              request: async (method, params, resultSchema, requestOptions) => {
                assert.equal(resultSchema, undefined);
                assert.equal(requestOptions.timeoutMs, 5_000);
                requested.push({ method, params });
                return { sessionLifecycleWorkspace: true };
              },
            };
          }
          async getRuntimeIdentity() {
            return { processId: 4242, identity: "synthetic" };
          }
          async disposeWorkspace() {
            disposedWorkspace += 1;
          }
          async disposeAllAndWait() {
            disposedAll += 1;
          }
          listManagedProcesses() {
            return [];
          }
        },
      }),
    };
    const result = await runOfficialAppServerProtocolSmoke(options);

    assert.equal(result.status, "PASS");
    assert.equal(result.evidence.protocol_initialized, true);
    assert.equal(result.evidence.session_created, false);
    assert.equal(result.evidence.model_requests, 0);
    assert.equal(environmentDuringConnect, files.runtimeHost);
    assert.deepEqual(requested, [{ method: OFFICIAL_PROTOCOL_SMOKE_METHOD, params: {} }]);
    assert.equal(disposedWorkspace, 1);
    assert.equal(disposedAll, 1);
    await assert.rejects(access(path.join(runRootParent, "cost-lab-web", `protocol-smoke-${FIXED_ID}`)));

    const controller = new AbortController();
    const aborted = await runOfficialAppServerProtocolSmoke({
      ...options,
      signal: controller.signal,
      createManager: (module, managerOptions) => new (class extends module.ZCodeAgentProcessManager {
        async getClient(workspace) {
          const client = await super.getClient(workspace);
          controller.abort(new Error("protocol_smoke_timeout"));
          return client;
        }
      })(managerOptions),
    });
    assert.equal(aborted.status, "FAIL");
    assert.equal(aborted.reason, "protocol_smoke_timeout");
    assert.equal(requested.length, 1);
    assert.equal(disposedWorkspace, 2);
    assert.equal(disposedAll, 2);
    await assert.rejects(access(path.join(runRootParent, "cost-lab-web", `protocol-smoke-${FIXED_ID}`)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol smoke allows a safe unverified runtime but still requires launch assets", async () => {
  const result = await runOfficialAppServerProtocolSmoke({
    inspectRuntime: async () => ({
      install_root: "C:\\Synthetic\\ZCode",
      runtime_status: "OFFICIAL_RUNTIME_UNVERIFIED",
      installation_safety: "OFFICIAL_INSTALLATION_SAFE",
      desktop_app_version: "4.0.0",
      manifest: null,
      assets: {},
    }),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.reason, "runtime_launch_assets_incomplete");
  assert.equal(result.evidence.model_requests, 0);
});

test("protocol smoke no longer accepts an experimental authorization as a substitute for launch assets", async () => {
  const result = await runOfficialAppServerProtocolSmoke({
    inspectRuntime: async () => ({
      install_root: "C:\\Synthetic\\ZCode",
      runtime_status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
      installation_safety: "OFFICIAL_INSTALLATION_SAFE",
      installation_fingerprint: "a".repeat(64),
      desktop_version: "3.19.0.10774",
      desktop_app_version: "3.19.0",
      desktop_build_commit_id: "a7ed1054",
      manifest: null,
      assets: {},
    }),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.reason, "runtime_launch_assets_incomplete");
  assert.equal(result.evidence.model_requests, 0);
});

test("protocol smoke report never exposes a literal fixture path", async () => {
  const result = await runOfficialAppServerProtocolSmoke({
    inspectRuntime: async () => ({
      install_root: "D:\\Users\\Sandy\\ZCode",
      runtime_status: "OFFICIAL_RUNTIME_VERIFIED",
      desktop_version: "3.18.2.10443",
      desktop_app_version: "3.18.2",
      desktop_build_commit_id: "2681f4af",
      manifest: { version: "3.18.2.10443", desktop_app_version: "3.18.2", desktop_build_commit_id: "2681f4af" },
      assets: {
        bundle: { relative_path: "resources/glm/zcode.cjs", sha256: createHash("sha256").update("b").digest("hex") },
        runtime_host: { relative_path: "resources/tools/runtime-host/zcode-runtime-host.exe", sha256: "c".repeat(64) },
        builtin_provider_config: { relative_path: "resources/config/provider/zcode-builtin.json", sha256: "d".repeat(64) },
      },
    }),
    resolveDataRoot: () => ({ dataBaseDir: "D:\\Users\\Sandy\\missing" }),
  });
  assert.equal(result.status, "FAIL");
  assert.equal(JSON.stringify(result).includes("Sandy"), false);
});
