export type ProductionAdapterKind = "official_host" | "direct_app_server";

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
  if ((platform === "linux" || platform === "darwin")
    && (architecture === "x64" || architecture === "arm64")) {
    return "direct_app_server";
  }
  const error = new Error(
    `The Bridge Worker does not support ${platform}/${architecture}.`,
  ) as Error & { code: string };
  error.code = "unsupported_worker_platform";
  throw error;
}
