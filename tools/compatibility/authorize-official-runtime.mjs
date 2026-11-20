import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
const RESOLVER_MODULE = new URL("../../dist/src/runtime/official-app-server-runtime.js", import.meta.url);
const SCOPES = new Set([
  "coding_plan_probe",
  "start_plan_probe",
  "other_provider_probe",
]);
const FINGERPRINT = /^[0-9a-f]{64}$/u;

async function main() {
  const [command = "inspect", ...tokens] = process.argv.slice(2);
  if (command === "inspect") {
    const descriptor = await inspect();
    process.stdout.write(`${JSON.stringify(publicDescriptor(descriptor), null, 2)}\n`);
    return;
  }
  if (command === "grant") {
    const options = parseGrantArguments(tokens);
    const descriptor = await inspect();
    assertGrantable(descriptor, options);
    const authorizationFile = path.resolve(options.output);
    if (!isInside(path.join(PROJECT_ROOT, ".run"), authorizationFile)) {
      throw new Error("authorization_output_must_be_inside_project_run_directory");
    }
    const document = await mergeAuthorizationDocument(authorizationFile, {
      installation_fingerprint: descriptor.installation_fingerprint,
      desktop_version: descriptor.desktop_version,
      authorized_at: new Date().toISOString(),
      authorized_by: options.authorizedBy,
      scopes: [...options.scopes],
    });
    await mkdir(path.dirname(authorizationFile), { recursive: true });
    await writeFile(authorizationFile, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "w",
    });
    process.stdout.write(`${JSON.stringify({
      status: "AUTHORIZED",
      output: authorizationFile,
      installation_fingerprint: descriptor.installation_fingerprint,
      desktop_version: descriptor.desktop_version,
      scopes: options.scopes,
      model_requests: 0,
    }, null, 2)}\n`);
    return;
  }
  throw new Error("usage: authorize-official-runtime.mjs inspect | grant --fingerprint <sha256> --scope <scope> --output <file> [--authorized-by <name>]");
}

async function inspect() {
  const { OfficialAppServerRuntimeResolver } = await import(RESOLVER_MODULE.href);
  const resolver = new OfficialAppServerRuntimeResolver();
  return resolver.inspect();
}

function publicDescriptor(descriptor) {
  return {
    status: descriptor.status,
    installation_safety: descriptor.installation_safety ?? null,
    installation_fingerprint: descriptor.installation_fingerprint ?? null,
    desktop_version: descriptor.desktop_version,
    desktop_app_version: descriptor.desktop_app_version ?? null,
    desktop_build_commit_id: descriptor.desktop_build_commit_id ?? null,
    node_version: descriptor.node_version,
    node_compatible: descriptor.node_compatible,
    bundle_sha256: descriptor.bundle_sha256,
    builtin_provider_config_sha256: descriptor.builtin_provider_config_sha256,
    runtime_host_sha256: descriptor.runtime_host_sha256,
    desktop_executable_sha256: descriptor.desktop_executable_sha256 ?? null,
    desktop_archive_sha256: descriptor.desktop_archive_sha256 ?? null,
    desktop_signer_thumbprint: descriptor.desktop_executable_signer_thumbprint ?? null,
    runtime_host_signer_thumbprint: descriptor.runtime_host_signer_thumbprint ?? null,
    experimental_authorization_state: descriptor.experimental_authorization?.state ?? null,
    experimental_authorization_scopes: descriptor.experimental_authorization?.scopes ?? [],
    discount_capability: descriptor.discount_capability,
    start_plan_static_compatibility: descriptor.start_plan_static_compatibility,
    reason: descriptor.reason,
  };
}

function parseGrantArguments(tokens) {
  let expectedFingerprint = null;
  let output = null;
  let authorizedBy = "owner";
  const scopes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (token === "--fingerprint" && value) {
      expectedFingerprint = value;
      index += 1;
    } else if (token === "--output" && value) {
      output = value;
      index += 1;
    } else if (token === "--authorized-by" && value) {
      authorizedBy = value;
      index += 1;
    } else if (token === "--scope" && value) {
      if (!SCOPES.has(value)) throw new Error(`unsupported experimental scope: ${value}`);
      scopes.push(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${token}`);
    }
  }
  if (!expectedFingerprint || !FINGERPRINT.test(expectedFingerprint)) {
    throw new Error("an exact installation fingerprint is required");
  }
  if (!output || !path.isAbsolute(output)) {
    throw new Error("an absolute project-local output path is required");
  }
  if (!authorizedBy.trim()) throw new Error("authorized-by must not be empty");
  if (scopes.length === 0) throw new Error("at least one explicit experimental scope is required");
  return {
    expectedFingerprint,
    output,
    authorizedBy: authorizedBy.trim(),
    scopes: [...new Set(scopes)],
  };
}

function assertGrantable(descriptor, options) {
  if (descriptor.installation_safety !== "OFFICIAL_INSTALLATION_SAFE") {
    throw new Error(`installation safety check failed: ${descriptor.reason ?? "unknown"}`);
  }
  if (descriptor.installation_fingerprint !== options.expectedFingerprint) {
    throw new Error("installation fingerprint changed; inspect again before granting authorization");
  }
  if (!descriptor.desktop_version || !descriptor.installation_fingerprint) {
    throw new Error("installation identity is incomplete");
  }
  if (descriptor.status === "OFFICIAL_RUNTIME_VERIFIED") {
    throw new Error("installation is already production-verified; experimental authorization is unnecessary");
  }
  if (descriptor.status !== "OFFICIAL_RUNTIME_UNVERIFIED"
    && descriptor.status !== "OFFICIAL_RUNTIME_EXPERIMENTAL") {
    throw new Error(`installation cannot be granted experimental authorization: ${descriptor.status}`);
  }
}

async function mergeAuthorizationDocument(filePath, record) {
  let document = { schema_version: 1, authorizations: [] };
  try {
    await stat(filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || parsed.schema_version !== 1 || !Array.isArray(parsed.authorizations)) {
      throw new Error("existing authorization file has an unsupported schema");
    }
    document = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  document.authorizations = document.authorizations.filter((entry) =>
    !(entry?.installation_fingerprint === record.installation_fingerprint
      && entry?.desktop_version === record.desktop_version));
  document.authorizations.push(record);
  return document;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
