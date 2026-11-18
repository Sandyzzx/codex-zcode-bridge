import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

const resolverModule = new URL("../../dist/src/runtime/official-app-server-runtime.js", import.meta.url);

export async function inspectOfficialRuntimeAssets({ env, platform, arch } = {}) {
  if (!(await access(resolverModule).then(() => true, () => false))) {
    return {
      install_root: null,
      install_root_fingerprint: null,
      runtime_status: "OFFICIAL_RUNTIME_UNVERIFIED",
      discount_status: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
      reason: "bridge_build_missing",
      manifest: null,
      assets: {},
    };
  }
  const { OfficialAppServerRuntimeResolver } = await import(resolverModule.href);
  const runtime = await new OfficialAppServerRuntimeResolver({ env, platform, architecture: arch }).inspect();
  const root = runtime.install_dir;
  const assets = {};
  for (const name of ["bundle", "runtime_host", "builtin_provider_config"]) {
    const file = runtime[`${name}_path`];
    if (root && file) {
      assets[name] = {
        relative_path: path.relative(root, file).split(path.sep).join("/"),
        bytes: runtime[`${name}_bytes`],
        sha256: runtime[`${name}_sha256`],
      };
    }
  }
  return {
    install_root: root,
    install_source: runtime.install_source,
    install_root_fingerprint: root ? createHash("sha256").update(root).digest("hex") : null,
    runtime_status: runtime.status,
    discount_status: runtime.discount_capability,
    desktop_version: runtime.desktop_version,
    node_executable: runtime.node_executable,
    reason: runtime.reason,
    manifest: runtime.manifest && { ...runtime.manifest, version: runtime.manifest.desktop_version },
    assets,
  };
}
