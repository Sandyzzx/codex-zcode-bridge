import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeError } from "../src/runtime/errors.js";
import {
  buildZCodeAppServerLaunch,
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
} from "../src/runtime/desktop-host-launch.js";

interface DesktopMetadataFixture {
  readonly appVersion: string;
  readonly buildCommitId: string;
  readonly packageVersion?: string;
}

interface LaunchFixture {
  readonly root: string;
  readonly entrypoint: string;
  readonly launchLog: string;
  readonly archivePath: string;
}

interface ChildLaunchRecord {
  readonly argv: string[];
  readonly env: {
    readonly appVersion: string | null;
    readonly buildCommitId: string | null;
    readonly keepMe: string | null;
  };
}

test("passes one official Desktop surface and dynamic installed metadata to the child", async () => {
  const fixture = await makeLaunchFixture({ appVersion: "9.8.7", buildCommitId: "deadbeef" });
  try {
    const launch = buildZCodeAppServerLaunch(fixture.entrypoint, {
      PATH: process.env.PATH,
      KEEP_ME: "preserved",
    });
    assert.deepEqual(launch.args, ["app-server", "--stdio", "--surface", "desktop"]);
    assert.equal(launch.args.filter((arg) => arg === "--surface").length, 1);

    const record = await runChild(fixture, launch.args, launch.env);
    assert.deepEqual(record.argv, ["app-server", "--stdio", "--surface", "desktop"]);
    assert.equal(record.env.appVersion, "9.8.7");
    assert.equal(record.env.buildCommitId, "deadbeef");
    assert.equal(record.env.keepMe, "preserved");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("keeps Desktop surface but omits identity variables when installed metadata is missing", async () => {
  const fixture = await makeLaunchFixture(null);
  try {
    const launch = buildZCodeAppServerLaunch(fixture.entrypoint, {
      PATH: process.env.PATH,
      KEEP_ME: "preserved",
    });
    const record = await runChild(fixture, launch.args, launch.env);
    assert.deepEqual(record.argv, ["app-server", "--stdio", "--surface", "desktop"]);
    assert.equal(record.env.appVersion, null);
    assert.equal(record.env.buildCommitId, null);
    assert.equal(record.env.keepMe, "preserved");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed for malformed installed metadata", async () => {
  const fixture = await makeLaunchFixture({
    appVersion: "3.17.2",
    buildCommitId: "a2d1ba73",
    buildMetadataText: "{not-json",
  });
  try {
    assert.throws(
      () => buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH }),
      (error: unknown) => metadataErrorContains(error, "build-meta.json is not valid JSON"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed for unsupported installed version metadata", async () => {
  const fixture = await makeLaunchFixture({
    appVersion: "3.17",
    buildCommitId: "a2d1ba73",
    packageVersion: "3.17",
  });
  try {
    assert.throws(
      () => buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH }),
      (error: unknown) => metadataErrorContains(error, "unsupported version or build commit format"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when package and build metadata versions conflict", async () => {
  const fixture = await makeLaunchFixture({
    appVersion: "3.17.3",
    buildCommitId: "a2d1ba73",
    packageVersion: "3.17.2",
  });
  try {
    assert.throws(
      () => buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH }),
      (error: unknown) => metadataErrorContains(error, "conflicting application versions"),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed for structurally invalid ASAR file tables", async () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly header: unknown }> = [
    { name: "root files missing", header: {} },
    { name: "root files array", header: { files: [] } },
    { name: "root files non-object", header: { files: "invalid" } },
    {
      name: "out is not a directory",
      header: { files: { out: { offset: "0", size: 0 } } },
    },
    {
      name: "metadata is not a directory",
      header: { files: { out: { files: { metadata: { offset: "0", size: 0 } } } } },
    },
    {
      name: "build metadata is not an object",
      header: {
        files: {
          out: { files: { metadata: { files: { "build-meta.json": [] } } } },
        },
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = await makeLaunchFixture(null);
    try {
      await writeAsarArchiveHeader(fixture.archivePath, testCase.header, []);
      assert.throws(
        () => buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH }),
        providerConfigInvalid,
        testCase.name,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("treats a valid ASAR without build metadata as missing metadata", async () => {
  const fixture = await makeLaunchFixture(
    { appVersion: "3.17.2", buildCommitId: "a2d1ba73" },
    { omitBuildMetadata: true },
  );
  try {
    const launch = buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH });
    const record = await runChild(fixture, launch.args, launch.env);
    assert.equal(record.env.appVersion, null);
    assert.equal(record.env.buildCommitId, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails closed when build metadata exists without package.json", async () => {
  const fixture = await makeLaunchFixture(
    { appVersion: "3.17.2", buildCommitId: "a2d1ba73" },
    { omitPackageJson: true },
  );
  try {
    assert.throws(
      () => buildZCodeAppServerLaunch(fixture.entrypoint, { PATH: process.env.PATH }),
      providerConfigInvalid,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function makeLaunchFixture(
  metadata: (DesktopMetadataFixture & { readonly buildMetadataText?: string }) | null,
  options: { readonly omitPackageJson?: boolean; readonly omitBuildMetadata?: boolean } = {},
): Promise<LaunchFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-desktop-launch-"));
  const installResources = path.join(root, "resources");
  const archivePath = path.join(installResources, "app.asar");
  const runtimeDirectory = path.join(installResources, "glm");
  await mkdir(runtimeDirectory, { recursive: true });
  const entrypoint = path.join(runtimeDirectory, "zcode.cjs");
  const launchLog = path.join(root, "launch.json");
  await writeFile(entrypoint, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.LAUNCH_LOG, JSON.stringify({",
    "argv: process.argv.slice(2),",
    "env: {",
    "appVersion: process.env.ZCODE_APP_VERSION ?? null,",
    "buildCommitId: process.env.ZCODE_BUILD_COMMIT_ID ?? null,",
    "keepMe: process.env.KEEP_ME ?? null,",
    "},",
    "}));",
  ].join("\n"), "utf8");

  if (metadata !== null) {
    const packageVersion = metadata.packageVersion ?? metadata.appVersion;
    const buildMetadataText = metadata.buildMetadataText ?? JSON.stringify({
      appVersion: metadata.appVersion,
      minCompatibleVersion: metadata.appVersion,
      buildCommitId: metadata.buildCommitId,
      buildTime: "2026-11-02T06:32:36.912Z",
      electronBuilderVersion: "26.17.0",
    });
    const files: Record<string, string> = {};
    if (options.omitPackageJson !== true) {
      files["package.json"] = JSON.stringify({ version: packageVersion });
    }
    if (options.omitBuildMetadata !== true) {
      files["out/metadata/build-meta.json"] = buildMetadataText;
    }
    await writeAsarArchive(archivePath, files);
  }
  return { root, entrypoint, launchLog, archivePath };
}

async function runChild(
  fixture: { readonly entrypoint: string; readonly launchLog: string },
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ChildLaunchRecord> {
  const child = spawn(process.execPath, [fixture.entrypoint, ...args], {
    env: { ...env, LAUNCH_LOG: fixture.launchLog },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(await readFile(fixture.launchLog, "utf8")) as ChildLaunchRecord;
}

async function writeAsarArchive(archivePath: string, files: Record<string, string>): Promise<void> {
  const contentBuffers = Object.values(files).map((value) => Buffer.from(value, "utf8"));
  const entries = new Map<string, { offset: string; size: number }>();
  let contentOffset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    entries.set(filePath, { offset: String(contentOffset), size: Buffer.byteLength(content) });
    contentOffset += Buffer.byteLength(content);
  }

  const header: { files: Record<string, unknown> } = { files: {} };
  for (const [filePath, entry] of entries) {
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
    node[parts.at(-1)!] = entry;
  }

  assertOfficialAsarFileTypes(header.files);
  await writeAsarArchiveHeader(archivePath, header, contentBuffers);
}

async function writeAsarArchiveHeader(
  archivePath: string,
  header: unknown,
  contentBuffers: readonly Buffer[],
): Promise<void> {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const paddedHeader = Buffer.alloc(Math.ceil(headerJson.length / 4) * 4);
  headerJson.copy(paddedHeader);
  const sizeHeader = Buffer.alloc(16);
  sizeHeader.writeUInt32LE(4, 0);
  sizeHeader.writeUInt32LE(paddedHeader.length + 8, 4);
  sizeHeader.writeUInt32LE(paddedHeader.length + 4, 8);
  sizeHeader.writeUInt32LE(headerJson.length, 12);
  await writeFile(archivePath, Buffer.concat([sizeHeader, paddedHeader, ...contentBuffers]));
}

function assertOfficialAsarFileTypes(files: Record<string, unknown>): void {
  for (const entry of Object.values(files)) {
    assert.equal(typeof entry, "object");
    assert.notEqual(entry, null);
    assert.equal(Array.isArray(entry), false);
    const record = entry as Record<string, unknown>;
    if ("files" in record) {
      assert.equal(typeof record.files, "object");
      assert.notEqual(record.files, null);
      assert.equal(Array.isArray(record.files), false);
      assertOfficialAsarFileTypes(record.files as Record<string, unknown>);
    } else {
      assert.equal(typeof record.offset, "string");
      assert.equal(typeof record.size, "number");
    }
  }
}

function metadataErrorContains(error: unknown, text: string): boolean {
  return error instanceof BridgeError
    && error.code === "provider_config_invalid"
    && error.message.includes(text);
}

function providerConfigInvalid(error: unknown): boolean {
  return error instanceof BridgeError && error.code === "provider_config_invalid";
}
