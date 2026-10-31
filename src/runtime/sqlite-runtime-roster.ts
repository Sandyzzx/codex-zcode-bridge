import { createHash } from "node:crypto";

export const SQLITE_CUTOVER_PROTOCOL_VERSION = "wp6-stop-world-json-sqlite-v1";
export const SQLITE_CUTOVER_VERIFIER_VERSION = "wp6-json-cutover-v1";
export const SQLITE_CANDIDATE_SCHEMA_VERSION = 13;

export interface SqliteRuntimeRoster {
  readonly node: string;
  readonly sqlite: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly schema_version: typeof SQLITE_CANDIDATE_SCHEMA_VERSION;
  readonly cutover_protocol_version: typeof SQLITE_CUTOVER_PROTOCOL_VERSION;
}

export function currentSqliteRuntimeRoster(): SqliteRuntimeRoster {
  return {
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? "unavailable",
    platform: process.platform,
    architecture: process.arch,
    schema_version: SQLITE_CANDIDATE_SCHEMA_VERSION,
    cutover_protocol_version: SQLITE_CUTOVER_PROTOCOL_VERSION,
  };
}

export function currentSqliteRuntimeRosterDigest(): string {
  const roster = currentSqliteRuntimeRoster();
  return createHash("sha256").update(JSON.stringify(roster)).digest("hex");
}
