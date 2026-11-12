import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const destination = path.join(repoRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const runtimeEventsSource = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "runtime-events.sql");
const runtimeEventsDestination = path.join(
  repoRoot,
  "dist-test",
  "src",
  "sqlite-candidate",
  "wp6b2b1",
  "runtime-events.sql",
);
const administrativeSource = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "admin-abandonment.sql");
const administrativeDestination = path.join(
  repoRoot,
  "dist-test",
  "src",
  "sqlite-candidate",
  "wp6b2b1",
  "admin-abandonment.sql",
);
const exceptionSource = path.join(repoRoot, "src", "store", "json-history-result-exceptions.mjs");
const exceptionDestination = path.join(repoRoot, "dist-test", "src", "store", "json-history-result-exceptions.mjs");
const impactMapSource = path.join(repoRoot, "test", "test-impact-map.json");
const impactMapDestination = path.join(repoRoot, "dist-test", "test", "test-impact-map.json");
const envProbeSource = path.join(repoRoot, "test", "sqlite-candidate", "wp6b-wiring", "worker-env-probe.ps1");
const envProbeDestination = path.join(repoRoot, "dist-test", "test", "sqlite-candidate", "wp6b-wiring", "worker-env-probe.ps1");
const feedbackProjectionSource = path.join(repoRoot, "src", "feedback", "task-feedback-projection.mjs");
const feedbackProjectionDestination = path.join(repoRoot, "dist-test", "src", "feedback", "task-feedback-projection.mjs");
const feedbackProjectionTypesSource = path.join(repoRoot, "src", "feedback", "task-feedback-projection.d.mts");
const feedbackProjectionTypesDestination = path.join(repoRoot, "dist-test", "src", "feedback", "task-feedback-projection.d.mts");
const runtimeEventChannelSource = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "runtime-event-channel.mjs");
const runtimeEventChannelDestination = path.join(repoRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1", "runtime-event-channel.mjs");
const runtimeEventChannelTypesSource = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "runtime-event-channel.d.mts");
const runtimeEventChannelTypesDestination = path.join(repoRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1", "runtime-event-channel.d.mts");

await mkdir(path.dirname(destination), { recursive: true });
await mkdir(path.dirname(exceptionDestination), { recursive: true });
await mkdir(path.dirname(impactMapDestination), { recursive: true });
await mkdir(path.dirname(envProbeDestination), { recursive: true });
await mkdir(path.dirname(feedbackProjectionDestination), { recursive: true });
await Promise.all([
  copyFile(source, destination),
  copyFile(runtimeEventsSource, runtimeEventsDestination),
  copyFile(administrativeSource, administrativeDestination),
  copyFile(exceptionSource, exceptionDestination),
  copyFile(impactMapSource, impactMapDestination),
  copyFile(envProbeSource, envProbeDestination),
  copyFile(feedbackProjectionSource, feedbackProjectionDestination),
  copyFile(feedbackProjectionTypesSource, feedbackProjectionTypesDestination),
  copyFile(runtimeEventChannelSource, runtimeEventChannelDestination),
  copyFile(runtimeEventChannelTypesSource, runtimeEventChannelTypesDestination),
]);
console.log("Copied SQLite schemas and the test impact map into the compiled test layout.");

await copyFile(path.join(repoRoot,'src/sqlite-candidate/wp6b2b1/schema-v13.sql'),path.join(repoRoot,'dist-test/src/sqlite-candidate/wp6b2b1/schema-v13.sql'));
