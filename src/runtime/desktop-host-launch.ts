import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const ZCODE_APP_VERSION_ENV = "ZCODE_APP_VERSION";
export const ZCODE_BUILD_COMMIT_ID_ENV = "ZCODE_BUILD_COMMIT_ID";

const APP_SERVER_ARGS = ["app-server", "--stdio", "--surface", "desktop"] as const;
const BUILD_METADATA_PATH = ["out", "metadata", "build-meta.json"] as const;
const MAX_ASAR_HEADER_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BUILD_COMMIT_PATTERN = /^[0-9a-f]{8}$/u;

interface AsarEntry {
  readonly offset?: unknown;
  readonly size?: unknown;
  readonly unpacked?: boolean;
  readonly link?: string;
  readonly files?: Record<string, AsarEntry>;
}

interface DesktopMetadata {
  readonly appVersion: string;
  readonly buildCommitId: string;
}

export interface OfficialHostLaunchIdentity {
  readonly productVersion: string;
}

/**
 * Build the exact child launch used by both the task adapter and model-catalog
 * probe. Installed Desktop metadata is authoritative when present. The
 * Official Host supplies its verified product-version fallback separately;
 * malformed, unsupported, or conflicting installed metadata fails closed.
 */
export function buildZCodeAppServerLaunch(
  zcodeEntrypoint: string,
  baseEnv: NodeJS.ProcessEnv,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const metadata = readDesktopMetadata(zcodeEntrypoint);
  return {
    args: [...APP_SERVER_ARGS],
    env: metadata === null
      ? { ...baseEnv }
      : {
          ...baseEnv,
          [ZCODE_APP_VERSION_ENV]: metadata.appVersion,
          [ZCODE_BUILD_COMMIT_ID_ENV]: metadata.buildCommitId,
        },
  };
}

/**
 * Use the fixed Official Host's compiled product version only when no verified
 * Desktop identity is already present. A build commit ID is never synthesized
 * from an upstream source commit; it remains available only from valid
 * adjacent Desktop build metadata.
 */
export function withOfficialHostLaunchIdentity(
  baseEnv: NodeJS.ProcessEnv,
  identity: OfficialHostLaunchIdentity,
): NodeJS.ProcessEnv {
  const installedVersion = baseEnv[ZCODE_APP_VERSION_ENV];
  const installedBuildCommitId = baseEnv[ZCODE_BUILD_COMMIT_ID_ENV];
  if (installedVersion !== undefined || installedBuildCommitId !== undefined) {
    if (typeof installedVersion !== "string"
      || !VERSION_PATTERN.test(installedVersion)
      || typeof installedBuildCommitId !== "string"
      || !BUILD_COMMIT_PATTERN.test(installedBuildCommitId)) {
      throw invalidLaunchIdentity();
    }
    return { ...baseEnv };
  }

  const productVersion = identity.productVersion.trim();
  if (!VERSION_PATTERN.test(productVersion)) throw invalidLaunchIdentity();
  return {
    ...baseEnv,
    [ZCODE_APP_VERSION_ENV]: productVersion,
  };
}

function readDesktopMetadata(zcodeEntrypoint: string): DesktopMetadata | null {
  const archivePath = path.resolve(path.dirname(zcodeEntrypoint), "..", "app.asar");
  let archive: { readonly packageJson: Buffer; readonly buildMetadata: Buffer };
  try {
    archive = readAsarMetadataFiles(archivePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw invalidMetadata("could not be read");
  }

  const packageJson = parseObject(archive.packageJson, "package.json");
  const buildMetadata = parseObject(archive.buildMetadata, "build-meta.json");
  const packageVersion = packageJson["version"];
  const appVersion = buildMetadata["appVersion"];
  const buildCommitId = buildMetadata["buildCommitId"];

  if (typeof packageVersion !== "string" || typeof appVersion !== "string" || typeof buildCommitId !== "string") {
    throw invalidMetadata("is missing required fields");
  }
  if (!VERSION_PATTERN.test(packageVersion) || !VERSION_PATTERN.test(appVersion) || !BUILD_COMMIT_PATTERN.test(buildCommitId)) {
    throw invalidMetadata("uses an unsupported version or build commit format");
  }
  if (packageVersion !== appVersion) {
    throw invalidMetadata("contains conflicting application versions");
  }
  return { appVersion, buildCommitId };
}

function readAsarMetadataFiles(archivePath: string): { readonly packageJson: Buffer; readonly buildMetadata: Buffer } {
  const fd = openSync(archivePath, "r");
  try {
    const sizeHeader = Buffer.alloc(16);
    readExact(fd, sizeHeader, 16, 0);
    if (sizeHeader.readUInt32LE(0) !== 4) throw new Error("invalid asar header");

    const headerPayloadBytes = sizeHeader.readUInt32LE(4);
    const headerBytes = sizeHeader.readUInt32LE(12);
    if (headerBytes === 0 || headerBytes > MAX_ASAR_HEADER_BYTES || headerPayloadBytes < headerBytes) {
      throw new Error("invalid asar header size");
    }

    const headerBuffer = Buffer.alloc(headerBytes);
    readExact(fd, headerBuffer, headerBytes, 16);
    const root = parseObject(headerBuffer, "asar header") as unknown as { files?: Record<string, AsarEntry> };
    if (!isRecord(root.files)) throw new Error("asar header file table is not an object");

    const buildEntry = findEntry(root.files, BUILD_METADATA_PATH);
    if (buildEntry === null) throw new Error("asar build metadata is missing");
    const packageEntry = findEntry(root.files, ["package.json"]);
    if (packageEntry === null) throw new Error("asar package.json is missing");

    return {
      packageJson: readEntry(fd, packageEntry, 8 + headerPayloadBytes),
      buildMetadata: readEntry(fd, buildEntry, 8 + headerPayloadBytes),
    };
  } finally {
    closeSync(fd);
  }
}

function findEntry(root: Record<string, AsarEntry>, parts: readonly string[]): AsarEntry | null {
  let files = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (!Object.hasOwn(files, part)) return null;
    const current = files[part];
    if (!isRecord(current)) throw new Error(`asar ${part} entry is not an object`);
    if (index === parts.length - 1) return current as AsarEntry;
    if (!isRecord(current.files)) throw new Error(`asar ${part} entry is not a directory`);
    files = current.files as Record<string, AsarEntry>;
  }
  return null;
}

function readEntry(fd: number, entry: AsarEntry, contentOffset: number): Buffer {
  const offset = asNonNegativeSafeInteger(entry.offset);
  const size = asNonNegativeSafeInteger(entry.size);
  if (entry.files || entry.unpacked || entry.link || offset === null || size === null
    || size > MAX_METADATA_BYTES || !Number.isSafeInteger(contentOffset + offset)) {
    throw new Error("invalid asar metadata entry");
  }
  const output = Buffer.alloc(size);
  readExact(fd, output, output.length, contentOffset + offset);
  return output;
}

function asNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readExact(fd: number, target: Buffer, length: number, position: number): void {
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, target, offset, length - offset, position + offset);
    if (read === 0) throw new Error("unexpected end of asar file");
    offset += read;
  }
}

function parseObject(buffer: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw invalidMetadata(`${label} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidMetadata(`${label} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function invalidMetadata(reason: string): BridgeError {
  return new BridgeError(
    "provider_config_invalid",
    `Installed ZCode Desktop metadata ${reason}; refusing to invent a Desktop identity.`,
  );
}

function invalidLaunchIdentity(): BridgeError {
  return new BridgeError(
    "provider_config_invalid",
    "Official Host launch identity is invalid; refusing to mix Desktop, Host, or CLI versions.",
  );
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
