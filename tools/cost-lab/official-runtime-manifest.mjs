import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const VERIFIED_OFFICIAL_RUNTIME_MANIFEST = Object.freeze({
  schema_version: 1,
  product: "ZCode Desktop",
  version: "3.18.2.10443",
  node_compatibility: "24.16.x",
  appserver_protocol: "app-server --stdio --surface desktop",
  request_security_capability: "OfficialRequestSecurity",
  coding_plan_discount_verified: true,
  verified_effective_extra_ratio: 0.67,
  start_plan_static_compatibility: "OFFLINE_VERIFIED",
  verification_date: "2026-11-18",
  assets: Object.freeze({
    bundle: Object.freeze({
      relative_path: "resources/glm/zcode.cjs",
      bytes: 15_675_386,
      sha256: "08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c",
    }),
    runtime_host: Object.freeze({
      relative_path: "resources/tools/runtime-host/zcode-runtime-host.exe",
      bytes: 179_608,
      sha256: "c2c8ff5ff28cbddc4f177c094aa67c322830889612251bd173baaabc89379ab4",
    }),
    builtin_provider_config: Object.freeze({
      relative_path: "resources/config/provider/zcode-builtin.json",
      bytes: 261_659,
      sha256: "ef3d64656cb5281cce292b77ef12e96b5251582cfb00cdf9eb08e3d4565abb69",
    }),
  }),
  production_manifest: "docs/evidence/coding-plan-official-discount-verification-20261118.md",
});

export async function inspectOfficialRuntimeAssets(installRoot) {
  const root = path.resolve(installRoot);
  const result = {};
  let verified = true;
  for (const [name, expected] of Object.entries(VERIFIED_OFFICIAL_RUNTIME_MANIFEST.assets)) {
    const filePath = path.resolve(root, expected.relative_path);
    const inside = isPathInside(root, filePath);
    if (!inside) {
      result[name] = {
        status: "REJECTED",
        relative_path: expected.relative_path,
        error: "resolved_outside_install_root",
      };
      verified = false;
      continue;
    }
    try {
      const metadata = await stat(filePath);
      const readable = await access(filePath).then(() => true, () => false);
      const digest = metadata.isFile() && readable
        ? createHash("sha256").update(await readFile(filePath)).digest("hex")
        : null;
      const status =
        metadata.isFile() &&
        readable &&
        metadata.size === expected.bytes &&
        digest === expected.sha256
          ? "VERIFIED"
          : "UNVERIFIED";
      if (status !== "VERIFIED") verified = false;
      result[name] = {
        status,
        relative_path: expected.relative_path.replaceAll(path.sep, "/"),
        bytes: metadata.isFile() ? metadata.size : null,
        sha256: digest,
        expected_bytes: expected.bytes,
        expected_sha256: expected.sha256,
      };
    } catch (error) {
      verified = false;
      result[name] = {
        status: "MISSING",
        relative_path: expected.relative_path.replaceAll(path.sep, "/"),
        error: errorCode(error),
      };
    }
  }
  return {
    install_root_fingerprint: createHash("sha256").update(root).digest("hex"),
    runtime_status: verified ? "OFFICIAL_RUNTIME_VERIFIED" : "OFFICIAL_RUNTIME_UNVERIFIED",
    discount_status: verified
      ? "OFFICIAL_DISCOUNT_VERIFIED"
      : "OFFICIAL_DISCOUNT_NOT_VERIFIED",
    manifest: VERIFIED_OFFICIAL_RUNTIME_MANIFEST,
    assets: result,
  };
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function errorCode(error) {
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : null;
  return typeof code === "string" ? code : "unavailable";
}
