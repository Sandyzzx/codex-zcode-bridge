import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/runtime/errors.js";
import { assertUnrestrictedExecutionEnabled, createMinimalOsEnv, createWorkerEnv } from "../src/runtime/child-env.js";

test("child environments keep only OS and explicit Bridge settings", () => {
  const source = {
    PATH: "safe-path",
    HOME: "/home/test",
    API_TOKEN: "must-not-leak",
    HTTPS_PROXY: "http://secret-proxy",
    ZCODE_OTHER_SECRET: "must-not-leak",
    ZCODE_BRIDGE_NODE: "/opt/node",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/config/builtin.json",
    ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1",
  };
  const worker = createWorkerEnv(source);
  assert.equal(worker.PATH, "safe-path");
  assert.equal(worker.ZCODE_BRIDGE_NODE, "/opt/node");
  assert.equal(worker.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "/config/builtin.json");
  assert.equal(worker.API_TOKEN, undefined);
  assert.equal(worker.HTTPS_PROXY, undefined);
  assert.equal(worker.ZCODE_OTHER_SECRET, undefined);

  const child = createMinimalOsEnv(source);
  assert.equal(child.PATH, "safe-path");
  if (process.platform === "win32") {
    assert.equal(child.HOME, undefined);
  } else {
    assert.equal(child.HOME, "/home/test");
  }
  assert.equal(child.API_TOKEN, undefined);
  assert.equal(child.ZCODE_BRIDGE_NODE, undefined);
});

test("unrestricted execution requires an explicit opt-in", () => {
  assert.throws(
    () => assertUnrestrictedExecutionEnabled({}),
    (error: unknown) => error instanceof BridgeError && error.code === "execution_mode_disabled",
  );
  assert.doesNotThrow(() => assertUnrestrictedExecutionEnabled({ ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1" }));
});
