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

async function makeLaunchFixture(
  metadata: (DesktopMetadataFixture & { readonly buildMetadataText?: string }) | null,
): Promise<{ readonly root: string; readonly entrypoint: string; readonly launchLog: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-desktop-launch-"));
  const installResources = path.join(root, "resources");
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
    await writeAsarArchive(path.join(installResources, "app.asar"), {
      "package.json": JSON.stringify({ version: packageVersion }),
      "out/metadata/build-meta.json": buildMetadataText,
    });
  }
  return { root, entrypoint, launchLog };
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
  const entries = new Map<string, { offset: string; size: string }>();
  let contentOffset = 0;
  for (const [filePath, content] of Object.entries(files)) {
    // The installed asar file table serializes these as decimal strings.
    entries.set(filePath, { offset: String(contentOffset), size: String(Buffer.byteLength(content)) });
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

function metadataErrorContains(error: unknown, text: string): boolean {
  return error instanceof BridgeError
    && error.code === "provider_config_invalid"
    && error.message.includes(text);
}
