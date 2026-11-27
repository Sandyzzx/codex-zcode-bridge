import { lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  START_PLAN_BILLING_ORIGIN,
  START_PLAN_BILLING_PATH,
  START_PLAN_PROVIDER_ID,
  normalizeStartPlanSnapshot,
  sanitizeOfficialStartPlanPayload,
} from "./startplan-billing.mjs";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function readerError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.cause) error.cause = options.cause;
  return error;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

async function fileMetadata(filePath) {
  try {
    const info = await lstat(filePath);
    return {
      exists: true,
      type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
      symbolic_link: info.isSymbolicLink(),
      size: info.size,
      mtime_ms: info.mtimeMs,
      birthtime_ms: info.birthtimeMs,
      mode: info.mode,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function sameMetadata(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertOfficialRequest(input, expectedAppVersion) {
  const isRequestObject = isRecord(input) && Object.hasOwn(input, "url");
  const rawUrl = isRequestObject ? input.url : input;
  const rawMethod = isRequestObject ? input.init?.method : null;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (error) {
    throw readerError("startplan_billing_url_invalid", "Official billing URL is invalid.", {
      cause: error,
    });
  }
  if (url.origin !== START_PLAN_BILLING_ORIGIN) {
    throw readerError("startplan_billing_origin_invalid", "Official billing origin is invalid.");
  }
  if (url.pathname !== START_PLAN_BILLING_PATH) {
    throw readerError("startplan_billing_path_invalid", "Official billing path is invalid.");
  }
  if (String(rawMethod ?? "GET").toUpperCase() !== "GET") {
    throw readerError("startplan_billing_method_invalid", "Official billing method is invalid.");
  }
  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  if (queryKeys.length !== 1 || queryKeys[0] !== "app_version") {
    throw readerError("startplan_billing_query_invalid", "Official billing query is invalid.");
  }
  if (url.searchParams.get("app_version") !== expectedAppVersion) {
    throw readerError("startplan_billing_version_mismatch", "Official billing version is invalid.");
  }
  return {
    method: "GET",
    origin: url.origin,
    path: url.pathname,
    query_keys: queryKeys,
    app_version: expectedAppVersion,
  };
}

async function defaultOfficialDependencies(projectRoot) {
  const authFile = path.join(projectRoot, "dist", "src", "runtime", "start-plan-production-auth.js");
  const adapterFile = path.join(projectRoot, "dist", "src", "adapters", "official-host-adapter.js");
  let authModule;
  let adapterModule;
  try {
    authModule = await import(pathToFileURL(authFile).href);
    adapterModule = await import(pathToFileURL(adapterFile).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") {
      throw readerError(
        "startplan_official_reader_build_missing",
        "Build the official Bridge sources before refreshing Start Plan billing.",
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof authModule.StartPlanBillingEntitlement !== "function") {
    throw readerError(
      "startplan_entitlement_missing",
      "The compiled official Start Plan entitlement reader is missing.",
    );
  }
  if (typeof adapterModule.loadOfficialHostProductVersion !== "function"
      || typeof adapterModule.loadOfficialStartPlanAuthenticationResolverFactory !== "function") {
    throw readerError(
      "startplan_authentication_reader_missing",
      "The compiled official Start Plan authentication reader is missing.",
    );
  }
  return {
    StartPlanBillingEntitlement: authModule.StartPlanBillingEntitlement,
    loadOfficialHostProductVersion: adapterModule.loadOfficialHostProductVersion,
    loadOfficialStartPlanAuthenticationResolverFactory:
      adapterModule.loadOfficialStartPlanAuthenticationResolverFactory,
  };
}

export function assertOfficialStartPlanBillingRequest(input, expectedAppVersion) {
  return assertOfficialRequest(input, expectedAppVersion);
}

export async function readOfficialStartPlanBilling(options = {}) {
  if (!options.dataBaseDir) {
    throw readerError("startplan_data_base_dir_required", "The official ZCode data directory is required.");
  }
  if (!options.officialHostWorker) {
    throw readerError("startplan_official_host_worker_required", "The official Host Worker is required.");
  }
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const dataBaseDir = path.resolve(options.dataBaseDir);
  const officialHostWorker = path.resolve(options.officialHostWorker);
  const workerUrl = pathToFileURL(officialHostWorker);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const dependencies = options.officialDependencies ?? await defaultOfficialDependencies(projectRoot);
  const transportFetch = options.transportFetch ?? globalThis.fetch;
  const credentialFile = path.join(dataBaseDir, ".zcode", "v2", "credentials.json");
  const keyringLockFile = `${credentialFile}.keyring.lock`;
  const operationController = new AbortController();
  const abortFromParent = () => operationController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    operationController.abort(readerError("startplan_billing_timeout", "Official billing refresh timed out."));
  }, timeoutMs);
  const credentialBefore = await fileMetadata(credentialFile);
  const lockBefore = await fileMetadata(keyringLockFile);
  if (lockBefore.exists) {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
    throw readerError(
      "startplan_keyring_lock_present_before_capture",
      "The official keyring lock was already present before the read.",
    );
  }
  let requestCount = 0;
  let captured = null;
  try {
    const productVersion = await dependencies.loadOfficialHostProductVersion(workerUrl);
    const resolverFactory =
      await dependencies.loadOfficialStartPlanAuthenticationResolverFactory(workerUrl);
    const resolver = resolverFactory({ dataBaseDir });
    const auth = await resolver.resolveStartPlanAuthentication({
      family: "bigmodel",
      signal: operationController.signal,
    });
    operationController.signal.throwIfAborted();
    if (!auth?.requestCredential || !auth?.deviceMid || !auth?.accountIdentity) {
      throw readerError(
        "startplan_authentication_unavailable",
        "Official Start Plan authentication is unavailable.",
      );
    }
    const fetchImpl = async (input, init) => {
      requestCount += 1;
      if (requestCount !== 1) {
        throw readerError(
          "startplan_multiple_billing_requests_forbidden",
          "More than one official billing request was attempted.",
        );
      }
      const requestMetadata = assertOfficialRequest(input, productVersion);
      const headerNames = Object.keys(Object.fromEntries(new Headers(init?.headers))).sort();
      const started = performance.now();
      let response;
      try {
        response = await transportFetch(input, {
          ...init,
          signal: AbortSignal.any([
            init?.signal ?? operationController.signal,
            operationController.signal,
          ]),
        });
      } catch (error) {
        if (operationController.signal.aborted) throw operationController.signal.reason;
        throw readerError("startplan_billing_transport_failed", "Official billing transport failed.", {
          cause: error,
        });
      }
      const responseText = await response.clone().text();
      if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
        throw readerError("startplan_billing_response_too_large", "Official billing response is too large.");
      }
      let raw = null;
      try {
        raw = JSON.parse(responseText);
      } catch {
        // A malformed 200 response is retained as an integrity failure.
      }
      captured = {
        ...requestMetadata,
        header_names: headerNames,
        http_status: response.status,
        response_bytes: Buffer.byteLength(responseText, "utf8"),
        content_type: response.headers.get("content-type"),
        request_id_hash: response.headers.get("x-request-id")
          ? sanitizeOfficialStartPlanPayload({ request_id: response.headers.get("x-request-id") }).request_id
          : null,
        duration_ms: Math.round(performance.now() - started),
        raw,
      };
      return response;
    };
    const entitlement = new dependencies.StartPlanBillingEntitlement({
      getAppVersion: async () => productVersion,
      fetchImpl,
      now,
    });
    const officialEntitlement = await entitlement.check({
      account: START_PLAN_PROVIDER_ID,
      provider: START_PLAN_PROVIDER_ID,
      model: "GLM-5.3-Flash",
      deviceMid: auth.deviceMid,
      jwt: auth.requestCredential,
      signal: operationController.signal,
    });
    operationController.signal.throwIfAborted();
    if (requestCount !== 1 || !captured) {
      throw readerError(
        "startplan_billing_request_not_observed",
        "The official billing response was not observed.",
      );
    }
    if (captured.http_status !== 200 || !isRecord(captured.raw)) {
      const code = captured.http_status === 401
        ? "startplan_billing_unauthorized"
        : captured.http_status === 403
          ? "startplan_billing_forbidden"
          : captured.http_status === 429
            ? "startplan_billing_rate_limited"
            : "startplan_billing_response_invalid";
      throw readerError(code, `Official billing returned HTTP ${captured.http_status ?? "transport"}.`);
    }
    const capturedAt = new Date(now()).toISOString();
    const requestMetadata = {
      method: captured.method,
      origin: captured.origin,
      path: captured.path,
      query_keys: captured.query_keys,
      app_version: captured.app_version,
      header_names: captured.header_names,
      http_status: captured.http_status,
      response_bytes: captured.response_bytes,
      content_type: captured.content_type,
      request_id_hash: captured.request_id_hash,
      duration_ms: captured.duration_ms,
      attempts: requestCount,
    };
    const snapshot = normalizeStartPlanSnapshot(captured.raw, {
      capturedAt,
      source: "official_billing_balance",
      accountIdentity: auth.accountIdentity,
      officialEntitlement,
      requestMetadata,
    });
    const credentialAfter = await fileMetadata(credentialFile);
    const lockAfter = await fileMetadata(keyringLockFile);
    const state = {
      credentials_unchanged: sameMetadata(credentialBefore, credentialAfter),
      keyring_lock_released: !lockAfter.exists,
      credential_metadata: {
        before: credentialBefore,
        after: credentialAfter,
      },
      keyring_lock: {
        before: lockBefore,
        after: lockAfter,
      },
    };
    return {
      captured_at: capturedAt,
      sanitized_raw: {
        schema_version: 1,
        source: "official_billing_balance",
        request: requestMetadata,
        payload: sanitizeOfficialStartPlanPayload(captured.raw),
      },
      snapshot,
      metadata: {
        schema_version: 1,
        official_runtime: {
          product_version: productVersion,
          worker_module: path.relative(projectRoot, officialHostWorker).replaceAll("\\", "/"),
        },
        authentication: {
          resolver: "createOfficialStartPlanAuthenticationResolver",
          credential_read: "read_only",
          account_hash: snapshot.account.key,
        },
        request: requestMetadata,
        state,
        process: {
          model_requests_triggered: 0,
          official_billing_get_attempts: requestCount,
        },
      },
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
