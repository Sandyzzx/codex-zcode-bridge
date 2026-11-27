// Shared fixtures for ADR-066 official Built-in registry tests.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimal synthetic `app.asar` carrying the Desktop build metadata Bridge reads. */
export async function writeDesktopAsar(
  installRoot: string,
  metadata: { readonly appVersion: string; readonly buildCommitId: string },
): Promise<string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "zcode-desktop-fixture", version: metadata.appVersion }),
    "out/metadata/build-meta.json": JSON.stringify({
      appVersion: metadata.appVersion,
      buildCommitId: metadata.buildCommitId,
    }),
  };
  const contentBuffers = Object.values(files).map((value) => Buffer.from(value, "utf8"));
  const header: { files: Record<string, unknown> } = { files: {} };
  let offset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split("/");
    let node = header.files;
    for (const part of parts.slice(0, -1)) {
      const existing = node[part] as { files?: Record<string, unknown> } | undefined;
      if (!existing) {
        const created = { files: {} as Record<string, unknown> };
        node[part] = created;
        node = created.files;
      } else {
        node = existing.files!;
      }
    }
    node[parts.at(-1)!] = { offset: String(offset), size: Buffer.byteLength(content) };
    offset += Buffer.byteLength(content);
  }
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const paddedHeader = Buffer.alloc(Math.ceil(headerJson.length / 4) * 4);
  headerJson.copy(paddedHeader);
  const sizeHeader = Buffer.alloc(16);
  sizeHeader.writeUInt32LE(4, 0);
  sizeHeader.writeUInt32LE(paddedHeader.length + 8, 4);
  sizeHeader.writeUInt32LE(paddedHeader.length + 4, 8);
  sizeHeader.writeUInt32LE(headerJson.length, 12);
  const archivePath = path.join(installRoot, "resources", "app.asar");
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, Buffer.concat([sizeHeader, paddedHeader, ...contentBuffers]));
  return archivePath;
}

/** A release in the Observed official shape; `marker` makes content unique. */
export function registryRelease(revision: number, marker: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [
          { providerId: `account:fixture-${marker}`, config: { builtinModelIds: [`MODEL-${marker}`] } },
        ],
      },
      modelConfigRules: { modelRules: [] },
    },
  });
}

/**
 * The client platform label of the machine running the test. ZCode Desktop
 * writes its runtime registry under its own platform, so the fixture follows
 * the real host instead of assuming Windows.
 */
export function hostClientPlatform(): string {
  const operatingSystem = process.platform === "win32" ? "windows" : process.platform;
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${operatingSystem}-${architecture}`;
}

/** The official runtime registry location, computed independently of the production code. */
export function runtimeRegistryFile(
  dataBaseDir: string,
  options: {
    readonly appVersion: string;
    readonly origin?: string;
    readonly platform?: string;
  },
): string {
  const endpointKey = createHash("sha256").update(options.origin ?? "https://zcode.z.ai").digest("hex").slice(0, 32);
  return path.join(
    dataBaseDir,
    ".zcode",
    "v2",
    "runtime",
    "provider",
    options.platform ?? hostClientPlatform(),
    options.appVersion,
    `endpoint-${endpointKey}`,
    "zcode-builtin.json",
  );
}

export async function writeRuntimeRegistry(
  dataBaseDir: string,
  text: string,
  options: {
    readonly appVersion: string;
    readonly origin?: string;
    readonly platform?: string;
  },
): Promise<string> {
  const file = runtimeRegistryFile(dataBaseDir, options);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}
