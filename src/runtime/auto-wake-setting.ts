import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./errors.js";
import { atomicRename } from "../store/atomic-rename.js";
import { withProcessLock } from "../store/process-lock.js";

export const AUTO_WAKE_RUNTIME_KEY = "ZCODE_BRIDGE_AUTO_WAKE";
const SETTINGS_LIMIT_BYTES = 64 * 1024;

export function autoWakeEnabledFromEnvironment(env: NodeJS.ProcessEnv): boolean {
  const raw = env[AUTO_WAKE_RUNTIME_KEY]?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

export async function readAutoWakeSetting(settingsDirectory: string): Promise<boolean> {
  const config = await readRuntimeConfig(settingsDirectory);
  const value = config[AUTO_WAKE_RUNTIME_KEY];
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") {
    throw new BridgeError("provider_config_invalid", `${AUTO_WAKE_RUNTIME_KEY} must be "true" or "false"`);
  }
  return autoWakeEnabledFromEnvironment({ [AUTO_WAKE_RUNTIME_KEY]: value });
}

export async function writeAutoWakeSetting(settingsDirectory: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") {
    throw new BridgeError("provider_config_invalid", "auto_wake must be a boolean");
  }
  await mkdir(settingsDirectory, { recursive: true });
  await withProcessLock(path.join(settingsDirectory, ".settings.lock"), async () => {
    const config = await readRuntimeConfig(settingsDirectory);
    config[AUTO_WAKE_RUNTIME_KEY] = enabled ? "true" : "false";
    const serialized = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > SETTINGS_LIMIT_BYTES) {
      throw new BridgeError("provider_config_invalid", "Updated Bridge runtime config would exceed 64 KiB");
    }
    const configPath = path.join(settingsDirectory, "runtime-config.json");
    const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await atomicRename(tempPath, configPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new BridgeError(
        "provider_config_invalid",
        `Could not save Bridge runtime config: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

async function readRuntimeConfig(settingsDirectory: string): Promise<Record<string, unknown>> {
  const configPath = path.join(settingsDirectory, "runtime-config.json");
  try {
    const info = await stat(configPath);
    if (!info.isFile() || info.size > SETTINGS_LIMIT_BYTES) {
      throw new BridgeError("provider_config_invalid", "Bridge runtime config is not a small regular JSON file");
    }
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BridgeError("provider_config_invalid", "Bridge runtime config must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("provider_config_invalid", "Could not read Bridge runtime config", { cause: error });
  }
}
