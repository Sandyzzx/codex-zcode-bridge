// RuntimeResolver per docs/INTERFACES.md (frozen) and the runtime behavior in
// docs/ARCHITECTURE.md:
// - Bridge overrides: ZCODE_BRIDGE_NODE, ZCODE_BRIDGE_ZCODE_CJS, ZCODE_BRIDGE_DATA_DIR.
// - Provider config: prefer a valid inherited official pair
//   (ZCODE_BUILTIN_PROVIDER_CONFIG_FILE + ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
//   otherwise resolve the builtin from the ZCode installation and the personal
//   config from ZCODE_DATA_BASE_DIR or the home directory.
// - Validates paths and JSON structure only; never logs or returns file
//   contents; never copies or edits ZCode files; never silently accepts a stub.
import { accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError } from "./errors.js";
import type { RuntimeResolver, ZCodeRuntimeConfig } from "../interfaces.js";

export interface RuntimeResolverOptions {
  /** Environment used for all lookups; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home directory used for personal-config discovery; defaults to os.homedir(). */
  homeDir?: string;
  /** Bridge installation directory used as the default data root; auto-detected otherwise. */
  packageRoot?: string;
}

export class NodeRuntimeResolver implements RuntimeResolver {
  readonly #env: NodeJS.ProcessEnv;
  readonly #homeDir: string;
  readonly #packageRoot: string | null;

  constructor(options: RuntimeResolverOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#homeDir = options.homeDir ?? homedir();
    this.#packageRoot = options.packageRoot ?? null;
  }

  async resolve(): Promise<ZCodeRuntimeConfig> {
    const env = this.#env;

    // Node executable: explicit override or `node` on PATH (frozen contract).
    let nodeExecutable = "node";
    const nodeOverride = env["ZCODE_BRIDGE_NODE"]?.trim();
    if (nodeOverride) {
      this.#assertReadableFile(
        nodeOverride,
        "ZCODE_BRIDGE_NODE is set but is not a readable file",
      );
      nodeExecutable = nodeOverride;
    }

    // zcode.cjs entrypoint: explicit override or discovery in the installation.
    let zcodeEntrypoint: string;
    const entryOverride = env["ZCODE_BRIDGE_ZCODE_CJS"]?.trim();
    if (entryOverride) {
      this.#assertReadableFile(
        entryOverride,
        "ZCODE_BRIDGE_ZCODE_CJS is set but is not a readable file",
      );
      zcodeEntrypoint = entryOverride;
    } else {
      const candidates = installCandidates(env, ["resources", "glm", "zcode.cjs"]);
      const discovered = candidates.find(isReadableFile);
      if (!discovered) {
        throw new BridgeError(
          "runtime_not_found",
          `zcode.cjs was not found; searched: ${candidates.join(", ") || "(no installation roots available)"}`,
        );
      }
      zcodeEntrypoint = discovered;
    }

    // Provider pair (see class doc). An inherited pair must be complete.
    const builtinEnv = env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim() || null;
    const personalEnv = env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]?.trim() || null;

    let builtinConfigFile: string;
    let personalConfigFile: string;

    if (builtinEnv && personalEnv) {
      this.#validateBuiltinConfig(builtinEnv);
      this.#validatePersonalConfig(personalEnv);
      builtinConfigFile = builtinEnv;
      personalConfigFile = personalEnv;
    } else {
      if (builtinEnv) {
        this.#validateBuiltinConfig(builtinEnv);
        builtinConfigFile = builtinEnv;
      } else {
        const candidates = installCandidates(env, [
          "resources",
          "config",
          "provider",
          "zcode-builtin.json",
        ]);
        const discovered = candidates.find(isReadableFile);
        if (!discovered) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE is not set and no builtin provider config was found in the ZCode installation; searched: " +
              (candidates.join(", ") || "(no installation roots available)"),
          );
        }
        this.#validateBuiltinConfig(discovered);
        builtinConfigFile = discovered;
      }

      if (personalEnv) {
        this.#validatePersonalConfig(personalEnv);
        personalConfigFile = personalEnv;
      } else {
        const candidates = [env["ZCODE_DATA_BASE_DIR"]?.trim(), this.#homeDir]
          .filter((base): base is string => Boolean(base))
          .map((base) => path.join(base, ".zcode", "v2", "provider_config.json"));
        const existing = candidates.filter((candidate) => existsSync(candidate));
        if (existing.length === 0) {
          throw new BridgeError(
            "provider_config_missing",
            "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is not set and no personal provider config exists at any of: " +
              candidates.join(", "),
          );
        }
        let accepted: string | null = null;
        let lastError: string | null = null;
        for (const candidate of existing) {
          try {
            this.#validatePersonalConfig(candidate);
            accepted = candidate;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
        if (!accepted) {
          throw new BridgeError(
            "provider_config_invalid",
            `No usable personal provider config among: ${existing.join(", ")}; last validation failure: ${lastError ?? "unknown"}`,
          );
        }
        personalConfigFile = accepted;
      }
    }

    // Bridge data root: explicit override or the Bridge installation directory.
    const dataOverride = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
    let dataRoot: string;
    if (dataOverride) {
      if (!path.isAbsolute(dataOverride)) {
        throw new Error(
          `ZCODE_BRIDGE_DATA_DIR must be an absolute path when set, got: ${dataOverride}`,
        );
      }
      dataRoot = path.normalize(dataOverride);
    } else {
      dataRoot = this.#packageRoot ?? findPackageRoot();
    }

    return {
      nodeExecutable,
      zcodeEntrypoint,
      providerBuiltinConfigFile: builtinConfigFile,
      providerPersonalConfigFile: personalConfigFile,
      dataRoot,
    };
  }

  #assertReadableFile(filePath: string, label: string): void {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("runtime_not_found", `${label}: ${filePath}`);
    }
  }

  /**
   * Structure validation only. The verified differential signal for the
   * CLI-created stub is an empty providerRules map (see docs/ZCODE_RUNTIME.md);
   * rejecting it implements "never silently select a known stub".
   */
  #validatePersonalConfig(filePath: string): void {
    const parsed = this.#readJsonConfig(filePath, "personal provider config");
    const config = parsed["config"];
    if (!isPlainObject(config)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config has no config object: ${filePath}`,
      );
    }
    const providerConfigRules = config["providerConfigRules"];
    const rules = isPlainObject(providerConfigRules)
      ? providerConfigRules["providerRules"]
      : undefined;
    if (!isNonEmptyCollection(rules)) {
      throw new BridgeError(
        "provider_config_invalid",
        `Personal provider config contains no provider rules (this matches the known CLI-created stub shape): ${filePath}`,
      );
    }
  }

  #validateBuiltinConfig(filePath: string): void {
    const parsed = this.#readJsonConfig(filePath, "builtin provider config");
    if (!isPlainObject(parsed["config"])) {
      throw new BridgeError(
        "provider_config_invalid",
        `Builtin provider config has no config object: ${filePath}`,
      );
    }
  }

  #readJsonConfig(filePath: string, label: string): Record<string, unknown> {
    if (!isReadableFile(filePath)) {
      throw new BridgeError("provider_config_missing", `${label} not found: ${filePath}`);
    }
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not readable: ${filePath} (${errorText(error)})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new BridgeError(
        "provider_config_invalid",
        `${label} is not valid JSON: ${filePath} (${errorText(error)})`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new BridgeError("provider_config_invalid", `${label} is not a JSON object: ${filePath}`);
    }
    return parsed;
  }
}

function installCandidates(env: NodeJS.ProcessEnv, relative: readonly string[]): string[] {
  const roots = [
    env["ZCODE_WINDOWS_APP_INSTALL_DIR"]?.trim(),
    env["LOCALAPPDATA"]?.trim()
      ? path.join(env["LOCALAPPDATA"]!.trim(), "Programs", "ZCode")
      : null,
  ].filter((root): root is string => Boolean(root));
  return roots.map((root) => path.join(root, ...relative));
}

function isReadableFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
    accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Walks up from the module location to the directory containing package.json. */
export function findPackageRoot(startDir?: string): string {
  let current = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `Cannot locate the Bridge package root (no package.json above ${startDir ?? "module directory"})`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}
