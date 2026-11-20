import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { GENERATED_ARTIFACTS } from "../scripts/lib/generated-artifacts.mjs";

const BYTE_COPIED_GENERATED_SQL_INPUTS = [
  "src/sqlite-candidate/wp6b2b1/admin-abandonment.sql",
  "src/sqlite-candidate/wp6b2b1/runtime-events.sql",
  "src/sqlite-candidate/wp6b2b1/schema.sql",
];

function assertLfCheckout(paths: readonly string[]) {
  const result = spawnSync("git", ["check-attr", "eol", "--", ...paths], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const attributes = result.stdout.trim().split(/\r?\n/);
  assert.equal(attributes.length, paths.length);
  for (const attribute of attributes) assert.match(attribute, /: eol: lf$/);
}

test("generated artifact inventory covers every committed plugin build output", () => {
  const expected = new Set([
    "plugins/codex-zcode-bridge/dist/admin-abandon-held-operation.mjs",
    "plugins/codex-zcode-bridge/dist/admin-abandonment.sql",
    "plugins/codex-zcode-bridge/dist/bridge.mjs",
    "plugins/codex-zcode-bridge/dist/runtime-events.sql",
    "plugins/codex-zcode-bridge/dist/schema.sql",
    "plugins/codex-zcode-bridge/dist/wait-task.mjs",
    "plugins/codex-zcode-bridge/worker/vendor/browsers.json",
    "plugins/codex-zcode-bridge/worker/vendor/package.json",
    "plugins/codex-zcode-bridge/worker/vendor/pkg/browser-host.cjs",
    "plugins/codex-zcode-bridge/worker/worker-main.mjs",
  ]);
  assert.deepEqual(new Set(GENERATED_ARTIFACTS), expected);
  assert.equal(new Set(GENERATED_ARTIFACTS).size, GENERATED_ARTIFACTS.length);
});

test("the freshness command exposes the same inventory", () => {
  const result = spawnSync(process.execPath, ["scripts/check-generated-artifacts.mjs", "--list"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(new Set(JSON.parse(result.stdout) as string[]), new Set(GENERATED_ARTIFACTS));
});

test("generated artifacts always check out with the generators' LF bytes", () => {
  assertLfCheckout(GENERATED_ARTIFACTS);
});

test("byte-copied SQL inputs always check out with the generated LF bytes", () => {
  assertLfCheckout(BYTE_COPIED_GENERATED_SQL_INPUTS);
});
