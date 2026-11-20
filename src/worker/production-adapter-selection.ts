import type { OfficialProviderRuntimeCapability } from "../runtime/official-app-server-runtime.js";

export type ProductionAdapterKind = "official_host";

const OFFICIAL_CODING_PLAN_PROVIDER_IDS = new Set<string>([
  "account:bigmodel-individual-coding-plan",
  "bigmodel-individual-coding-plan",
  "builtin:bigmodel-coding-plan",
]);
const OFFICIAL_START_PLAN_PROVIDER_ID = "account:bigmodel-start-plan" as const;

/**
 * Runtime selection is provider-neutral. The compatibility manifest verifies
 * the installed AppServer; each Provider's registry, entitlement, API-key or
 * OAuth path remains authoritative after selection.
 */
export function selectOfficialProviderRuntime(
  providerId: string | undefined,
): OfficialProviderRuntimeCapability {
  if (providerId && OFFICIAL_CODING_PLAN_PROVIDER_IDS.has(providerId)) {
    return "coding_plan_discount";
  }
  if (providerId === OFFICIAL_START_PLAN_PROVIDER_ID) return "start_plan_static";
  return "installed_runtime";
}

/**
 * Production adapter selection is intentionally limited to immutable runtime
 * facts. Task input, environment variables, and persisted settings cannot
 * redirect the Worker to a different host implementation.
 */
export function selectProductionAdapter(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ProductionAdapterKind {
  if (platform === "win32" && architecture === "x64") return "official_host";
  const error = new Error(
    `The Bridge Worker does not support ${platform}/${architecture}.`,
  ) as Error & { code: string };
  error.code = "unsupported_worker_platform";
  throw error;
}
