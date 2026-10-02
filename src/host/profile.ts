import { homedir } from "node:os";
import path from "node:path";

/** Supplied by the calling host's entry point; execution semantics stay shared. */
export interface BridgeHostProfile {
  readonly name: string;
  readonly settingsDirectory: string;
  readonly legacySettingsDirectories?: readonly string[];
  readonly workerEntryPath?: string;
  readonly instructions?: string;
  readonly defaultDataRoot?: string;
}

export function codexHostProfile(homeDirectory = homedir()): BridgeHostProfile {
  return { name: "codex-zcode-bridge", settingsDirectory: path.join(homeDirectory, ".codex", "codex-zcode-bridge") };
}

export function validateHostProfile(host: BridgeHostProfile): BridgeHostProfile {
  if (!host || typeof host.name !== "string" || !host.name.trim() || typeof host.settingsDirectory !== "string" || !path.isAbsolute(host.settingsDirectory)) throw new Error("invalid Bridge host profile");
  if (host.legacySettingsDirectories !== undefined && (!Array.isArray(host.legacySettingsDirectories) || host.legacySettingsDirectories.some((directory) => typeof directory !== "string" || !path.isAbsolute(directory)))) throw new Error("host migration directories must be absolute");
  if (host.workerEntryPath !== undefined && (typeof host.workerEntryPath !== "string" || !path.isAbsolute(host.workerEntryPath))) throw new Error("host worker entry must be absolute");
  if (host.instructions !== undefined && typeof host.instructions !== "string") throw new Error("host instructions must be text");
  if (host.defaultDataRoot !== undefined && (typeof host.defaultDataRoot !== "string" || !path.isAbsolute(host.defaultDataRoot))) throw new Error("host default data root must be absolute");
  return host;
}
