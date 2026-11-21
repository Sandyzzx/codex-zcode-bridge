// Single inventory for committed outputs rebuilt by scripts/build-plugin.mjs.
// Add or remove an entry here in the same change as its producer and validator.
export const GENERATED_ARTIFACTS = Object.freeze([
  "plugins/codex-zcode-bridge/dist/bridge.mjs",
  "plugins/codex-zcode-bridge/dist/wait-task.mjs",
  "plugins/codex-zcode-bridge/dist/admin-abandon-held-operation.mjs",
  "plugins/codex-zcode-bridge/dist/schema.sql",
  "plugins/codex-zcode-bridge/dist/runtime-events.sql",
  "plugins/codex-zcode-bridge/dist/admin-abandonment.sql",
  "plugins/codex-zcode-bridge/worker/worker-main.mjs",
  "plugins/codex-zcode-bridge/worker/vendor/pkg/browser-host.cjs",
  "plugins/codex-zcode-bridge/worker/vendor/browsers.json",
  "plugins/codex-zcode-bridge/worker/vendor/package.json",
]);
