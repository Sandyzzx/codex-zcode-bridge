import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { currentSqliteRuntimeRoster, currentSqliteRuntimeRosterDigest } from "../runtime/sqlite-runtime-roster.js";
import { isSupportedNodeVersion } from "../runtime/node-runtime.js";

try {
  if (!isSupportedNodeVersion(process.versions.node)) throw new Error("SQLite upgrade requires Node >=24.16.0 <25, matching the Bridge runtime");
  const { values } = parseArgs({ options: {
    source: { type: "string" }, destination: { type: "string" }, database: { type: "string", default: "bridge.sqlite" },
    offline: { type: "boolean", default: false },
  }});
  if (!values.source || !values.destination || !values.offline) throw new Error(
    "Stop every Bridge Manager first. Usage: upgrade-sqlite-v14 --source <absolute state-root> --destination <empty absolute state-root> --database bridge.sqlite --offline. Source is retained; switch authority.json data_root only after verification. Production upgrade requires Owner authorization.");
  const oldRoster = { ...currentSqliteRuntimeRoster(), schema_version: 13 };
  const { IsolatedAdmissionStore } = await import("../sqlite-candidate/wp6b2b1/store.mjs");
  const receipt = IsolatedAdmissionStore.upgradeV13Copy(values.source, values.destination, {
    databaseFileName: values.database, offline: true,
    expectedV13RuntimeRosterDigest: createHash("sha256").update(JSON.stringify(oldRoster)).digest("hex"),
    runtimeRosterDigest: currentSqliteRuntimeRosterDigest(),
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`SQLITE_V14_UPGRADE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
