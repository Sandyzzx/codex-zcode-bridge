import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const destination = path.join(repoRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
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

await mkdir(path.dirname(destination), { recursive: true });
await mkdir(path.dirname(exceptionDestination), { recursive: true });
await mkdir(path.dirname(impactMapDestination), { recursive: true });
await Promise.all([
  copyFile(source, destination),
  copyFile(administrativeSource, administrativeDestination),
  copyFile(exceptionSource, exceptionDestination),
  copyFile(impactMapSource, impactMapDestination),
]);
console.log("Copied SQLite schemas and the test impact map into the compiled test layout.");
