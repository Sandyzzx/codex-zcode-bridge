import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
export const OFFICIAL_RUNTIME_PATH = path.join(
  SCRIPT_ROOT,
  "vendor",
  "official-billing-runtime.mjs",
);
export const OFFICIAL_RUNTIME_SHA256 =
  "dcb3fc7cb7a62e7a6dbe7ce8a9e1427075309458453641f6a4c7e8e1971a63e6";
export const OFFICIAL_KEYRING_NATIVE_SHA256 =
  "52b16658275b7848f8081a6542fee3448f1b1c5d3a36487107ae0e7cec95ac6f";
const OFFICIAL_HOST_MODULES = path.join(
  PROJECT_ROOT,
  "plugins",
  "codex-zcode-bridge",
  "worker",
  "vendor",
  "official-host",
  "win32-x64-node24.16.0-zcode3.18.2-fec97590",
  "node_modules",
  "@napi-rs",
);
export const OFFICIAL_KEYRING_JS_PATH = path.join(OFFICIAL_HOST_MODULES, "keyring", "index.js");
export const OFFICIAL_KEYRING_NATIVE_PATH = path.join(
  OFFICIAL_HOST_MODULES,
  "keyring-win32-x64-msvc",
  "keyring.win32-x64-msvc.node",
);
let keyringHook;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function verifyFile(filePath, expectedSha256, code) {
  const metadata = await stat(filePath).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`${code}_missing`);
  const digest = sha256(await readFile(filePath));
  if (digest !== expectedSha256) throw new Error(`${code}_hash_mismatch`);
  return digest;
}

export async function verifyOfficialVendor() {
  const runtimeSha256 = await verifyFile(
    OFFICIAL_RUNTIME_PATH,
    OFFICIAL_RUNTIME_SHA256,
    "official_billing_runtime",
  );
  const keyringNativeSha256 = await verifyFile(
    OFFICIAL_KEYRING_NATIVE_PATH,
    OFFICIAL_KEYRING_NATIVE_SHA256,
    "official_keyring_native",
  );
  await verifyFile(
    OFFICIAL_KEYRING_JS_PATH,
    "8a89db37f981d05b484eb063adae3399660ae7734ad38797463e5691382f5036",
    "official_keyring_js",
  );
  return {
    runtime_sha256: runtimeSha256,
    keyring_native_sha256: keyringNativeSha256,
    keyring_native_source: "official_host_vendor",
  };
}

export async function prepareOfficialBillingVendor({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error(`official_billing_vendor_unsupported_platform:${platform}:${arch}`);
  }
  const integrity = await verifyOfficialVendor();
  env.NAPI_RS_NATIVE_LIBRARY_PATH = OFFICIAL_KEYRING_NATIVE_PATH;
  // The vendored bundle leaves this import external. Only redirect its import,
  // so other modules retain their normal package resolution.
  const bundleUrl = pathToFileURL(OFFICIAL_RUNTIME_PATH).href;
  keyringHook ??= registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@napi-rs/keyring" && context.parentURL === bundleUrl) {
        return {
          url: pathToFileURL(OFFICIAL_KEYRING_JS_PATH).href,
          format: "commonjs",
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  return integrity;
}
