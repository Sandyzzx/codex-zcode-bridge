// Supported composition surface for calling hosts. Do not import internal files.
export * from "./interfaces.js";
export { buildTaskFeedbackSnapshotV01 } from "./feedback/task-feedback.js";
export { renderTaskFeedback } from "./feedback/renderer.js";
export { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./host/profile.js";
export { DirectWorkspaceProvider } from "./workspace/direct-provider.js";
export { createBridgeServer, SERVER_VERSION, type BridgeServerOptions } from "./mcp/server.js";
export { NodeRuntimeResolver, loadPersistedRuntimeEnvironment } from "./runtime/resolver.js";
export { ZCodeModelSettings } from "./runtime/model-settings.js";
export { runBridgeDoctor } from "./runtime/doctor.js";
export { ZCodeAppServerAdapter } from "./adapters/zcode-app-server-adapter.js";
export { BridgeError, type BridgeErrorCode } from "./runtime/errors.js";
export { TaskManagerError } from "./manager/errors.js";
export type { ZCodeModelCatalog, ZCodeModelCatalogEntry, DefaultModelSelection } from "./runtime/model-settings.js";
export { startBridge } from "./host/stdio.js";
// A1/A2 observation and process-identity surface.
export { createPlatformProbe, livenessVerdict, identityFormatVersion, type ProcessProbe, type ProcessIdentity, type ProbeRequest, type ProbeVerdict } from "./runtime/process-probe.js";
export { judgeTaskObservation } from "./observation/judge.js";
export { DEFAULT_JUDGE_OPTIONS } from "./observation/types.js";
export type { TaskObservation as ObservationShape, ExecutorObservation, ActivityCode } from "./observation/types.js";
export { sanitizeDiagnostics, DiagnosticCounters, DIAGNOSTIC_FIELD_WHITELIST } from "./observation/diagnostics.js";
// A4 human feedback projection.
export { renderFeedback, formatTokens, formatDuration, escapeCell, type FeedbackInput } from "./feedback/template.js";
export { codexMasterTokenFeedback } from "./feedback/codex-master-token.js";
export { CodexMasterTokenUsageSource, type CodexMasterTokenUsageResult } from "./observability/codex-master-token-usage.js";
// B4 usage normalization.
export { normalizeUsage, addNonOverlappingUsage, phaseDuration } from "./usage/normalize.js";

export { SqliteLifecycleMcpAuthority, type SqliteAuthorityOptions } from "./manager/sqlite-lifecycle-mcp-authority.js";
