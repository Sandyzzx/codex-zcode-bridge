import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const STORE_SCHEMA_VERSION = 1 as const;
const EVIDENCE_SCHEMA_VERSION = 1 as const;
const MAX_EVIDENCE_RECORDS = 200;

export type RuntimeProbeType = "static" | "protocol" | "real_provider" | "billing";
export type RuntimeEvidenceResult = "PASS" | "FAIL" | "INCOMPLETE";
export type CapabilityStatus =
  | "SAFE"
  | "UNSAFE"
  | "INCOMPLETE"
  | "VERIFIED"
  | "EXPERIMENTAL"
  | "UNVERIFIED"
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "INCONCLUSIVE"
  | "NOT_RUN";

export interface RuntimeAssetIdentity {
  readonly bytes: number | null;
  readonly sha256: string | null;
}

export interface RuntimeInstallationIdentity {
  readonly desktop_version: string | null;
  readonly desktop_app_version: string | null;
  readonly desktop_build_commit_id: string | null;
  readonly node_version: string | null;
  readonly installation_safety: string;
  readonly runtime_status: string;
  readonly manifest_status: string;
  readonly experimental_authorization: {
    readonly state: string;
    readonly scopes: readonly string[];
  };
  readonly assets: Readonly<Record<string, RuntimeAssetIdentity>>;
}

export interface RuntimeEvidenceRecord {
  readonly schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  readonly evidence_id: string;
  readonly fingerprint: string;
  readonly captured_at: string;
  readonly installation: RuntimeInstallationIdentity;
  readonly probe_type: RuntimeProbeType;
  readonly probe_scope: string;
  readonly result: RuntimeEvidenceResult;
  readonly classification: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly evidence_source: string;
  readonly evidence_digest: string;
  readonly limitations: readonly string[];
}

interface EvidenceStore {
  readonly schema_version: typeof STORE_SCHEMA_VERSION;
  readonly updated_at: string;
  readonly records: readonly RuntimeEvidenceRecord[];
}

export interface RuntimeCapability {
  readonly status: CapabilityStatus;
  readonly evidence_id: string | null;
  readonly source: string;
  readonly limitation: string | null;
}

export interface RuntimeCompatibilitySnapshot {
  readonly schema_version: 1;
  readonly captured_at: string;
  readonly fingerprint: string | null;
  readonly installation: RuntimeInstallationIdentity | null;
  readonly runtime_changed: boolean;
  readonly previous_fingerprint: string | null;
  readonly changed_assets: readonly string[];
  readonly warnings: readonly string[];
  readonly capabilities: Readonly<Record<string, RuntimeCapability>>;
  readonly evidence: readonly RuntimeEvidenceRecord[];
  readonly evidence_count: number;
  readonly manifest_modified: false;
  readonly model_requests: 0;
}

export interface RuntimeCompatibilityServiceOptions {
  readonly projectRoot: string;
  readonly historyPath?: string;
  readonly inspectEnvironment: () => Promise<Record<string, unknown>>;
  readonly runProtocolProbe: () => Promise<Record<string, unknown>>;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class RuntimeCompatibilityError extends Error {
  readonly status: number;

  constructor(
    readonly code:
      | "RUNTIME_INSPECTION_FAILED"
      | "RUNTIME_FINGERPRINT_UNAVAILABLE"
      | "RUNTIME_UNSAFE"
      | "RUNTIME_PROBE_AUTHORIZATION_REQUIRED"
      | "RUNTIME_PROBE_UNAVAILABLE"
      | "RUNTIME_EVIDENCE_STORE_INVALID",
    message: string,
    status = 409,
  ) {
    super(message);
    this.name = "RuntimeCompatibilityError";
    this.status = status;
  }
}

export class RuntimeCompatibilityService {
  readonly #historyPath: string;
  readonly #inspectEnvironment: () => Promise<Record<string, unknown>>;
  readonly #runProtocolProbe: () => Promise<Record<string, unknown>>;
  readonly #now: () => Date;
  readonly #createId: () => string;

  constructor(options: RuntimeCompatibilityServiceOptions) {
    this.#historyPath = path.resolve(
      options.historyPath
        ?? path.join(options.projectRoot, ".run", "bridge-console", "runtime-compatibility.json"),
    );
    this.#inspectEnvironment = options.inspectEnvironment;
    this.#runProtocolProbe = options.runProtocolProbe;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async inspect(): Promise<RuntimeCompatibilitySnapshot> {
    const environment = await this.#readEnvironment(this.#inspectEnvironment);
    const installation = installationIdentity(environment);
    const fingerprint = stringValue(recordValue(environment.zcode), "installation_fingerprint");
    if (!fingerprint) {
      throw new RuntimeCompatibilityError(
        "RUNTIME_FINGERPRINT_UNAVAILABLE",
        "The exact installed Runtime fingerprint is unavailable.",
        503,
      );
    }
    const store = this.#readStore();
    const previous = previousDistinctFingerprint(store.records, fingerprint);
    const staticResult = installation.installation_safety === "OFFICIAL_INSTALLATION_SAFE"
      ? "PASS"
      : installation.installation_safety === "OFFICIAL_INSTALLATION_UNSAFE"
        ? "FAIL"
        : "INCOMPLETE";
    const staticEvidence = this.#recordStatic({
      fingerprint,
      installation,
      result: staticResult,
      environment,
    });
    const updated = this.#appendDeduplicated(store, staticEvidence);
    return buildSnapshot({
      capturedAt: this.#now().toISOString(),
      fingerprint,
      installation,
      records: updated.records,
      environment,
      previous,
    });
  }

  async runAuthorizedProtocolProbe(): Promise<RuntimeCompatibilitySnapshot> {
    const before = await this.#readEnvironment(this.#inspectEnvironment);
    const installation = installationIdentity(before);
    const fingerprint = stringValue(recordValue(before.zcode), "installation_fingerprint");
    if (!fingerprint) {
      throw new RuntimeCompatibilityError(
        "RUNTIME_FINGERPRINT_UNAVAILABLE",
        "The exact installed Runtime fingerprint is unavailable.",
        503,
      );
    }
    if (installation.installation_safety !== "OFFICIAL_INSTALLATION_SAFE") {
      throw new RuntimeCompatibilityError(
        "RUNTIME_UNSAFE",
        "Protocol probing is unavailable until the installation passes the safety gate.",
        403,
      );
    }
    const runtimeStatus = installation.runtime_status;
    const authorizationState = installation.experimental_authorization.state;
    if (runtimeStatus !== "OFFICIAL_RUNTIME_VERIFIED"
      && !(runtimeStatus === "OFFICIAL_RUNTIME_EXPERIMENTAL" && authorizationState === "authorized")) {
      throw new RuntimeCompatibilityError(
        "RUNTIME_PROBE_AUTHORIZATION_REQUIRED",
        "A verified manifest match or exact-fingerprint experimental authorization is required.",
        403,
      );
    }
    const probed = await this.#readEnvironment(this.#runProtocolProbe, "RUNTIME_PROBE_UNAVAILABLE");
    const protocol = recordValue(probed.appserver_protocol_smoke);
    const status = stringValue(protocol, "status");
    if (status !== "PASS" && status !== "FAIL") {
      throw new RuntimeCompatibilityError(
        "RUNTIME_PROBE_UNAVAILABLE",
        "The zero-model protocol probe did not return a terminal verdict.",
        502,
      );
    }
    const evidence = this.#recordProtocol({
      fingerprint,
      installation,
      result: status,
      protocol,
    });
    const storeBefore = this.#readStore();
    const previous = previousDistinctFingerprint(storeBefore.records, fingerprint);
    const store = this.#appendDeduplicated(storeBefore, evidence);
    return buildSnapshot({
      capturedAt: this.#now().toISOString(),
      fingerprint,
      installation,
      records: store.records,
      environment: probed,
      previous,
    });
  }

  async candidateReport(): Promise<Record<string, unknown>> {
    const snapshot = await this.inspect();
    if (!snapshot.fingerprint || !snapshot.installation) {
      throw new RuntimeCompatibilityError("RUNTIME_FINGERPRINT_UNAVAILABLE", "No Runtime identity is available.");
    }
    return {
      schema_version: 1,
      kind: "runtime_compatibility_candidate",
      generated_at: this.#now().toISOString(),
      fingerprint: snapshot.fingerprint,
      installation: snapshot.installation,
      detected_changes: snapshot.changed_assets,
      capabilities: snapshot.capabilities,
      evidence: snapshot.evidence,
      manifest_candidate: {
        desktop_version: snapshot.installation.desktop_version,
        desktop_app_version: snapshot.installation.desktop_app_version,
        desktop_build_commit_id: snapshot.installation.desktop_build_commit_id,
        bundle_sha256: snapshot.installation.assets.bundle?.sha256 ?? null,
        builtin_provider_config_sha256:
          snapshot.installation.assets.builtin_provider_config?.sha256 ?? null,
        runtime_host_sha256: snapshot.installation.assets.runtime_host?.sha256 ?? null,
        verification_stage: "CANDIDATE",
      },
      approval: {
        production_manifest_modified: false,
        experimental_promoted: false,
        provider_authorization_granted: false,
        owner_review_required: true,
      },
      limitations: [
        "This report is generated from the current fingerprint only.",
        "Static or protocol evidence does not verify provider execution or billing.",
        "No production compatibility manifest was modified.",
      ],
    };
  }

  #recordStatic(input: {
    readonly fingerprint: string;
    readonly installation: RuntimeInstallationIdentity;
    readonly result: RuntimeEvidenceResult;
    readonly environment: Record<string, unknown>;
  }): RuntimeEvidenceRecord {
    return sealEvidence({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      evidence_id: this.#createId(),
      fingerprint: input.fingerprint,
      captured_at: this.#now().toISOString(),
      installation: input.installation,
      probe_type: "static",
      probe_scope: "installation/safety",
      result: input.result,
      classification: String(input.installation.installation_safety),
      provider: null,
      model: null,
      evidence_source: "OfficialAppServerRuntimeResolver",
      limitations: [
        "Static inspection does not create a model session.",
        "Static PASS does not prove Provider execution, billing, or discount compatibility.",
      ],
    });
  }

  #recordProtocol(input: {
    readonly fingerprint: string;
    readonly installation: RuntimeInstallationIdentity;
    readonly result: RuntimeEvidenceResult;
    readonly protocol: Record<string, unknown>;
  }): RuntimeEvidenceRecord {
    return sealEvidence({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      evidence_id: this.#createId(),
      fingerprint: input.fingerprint,
      captured_at: this.#now().toISOString(),
      installation: input.installation,
      probe_type: "protocol",
      probe_scope: "runtime/capabilities",
      result: input.result,
      classification: input.result === "PASS" ? "PROTOCOL_PASS" : "PROTOCOL_FAIL",
      provider: null,
      model: null,
      evidence_source: "Official AppServer protocol smoke",
      limitations: [
        "The probe creates no session and sends no model request.",
        "Protocol PASS does not elevate Coding Plan, Start Plan, or other Provider capabilities.",
        input.result === "PASS"
          ? "The probe verified bounded process disposal after the capability response."
          : "Cleanup and Provider capabilities remain unverified after a failed probe.",
      ],
    });
  }

  #appendDeduplicated(store: EvidenceStore, record: RuntimeEvidenceRecord): EvidenceStore {
    const latest = store.records.at(-1);
    const duplicate = store.records.find((item) =>
      item.fingerprint === record.fingerprint
      && (item.evidence_digest === record.evidence_digest
        || evidenceSemanticDigest(item) === record.evidence_digest));
    if (latest?.fingerprint === record.fingerprint && duplicate) return store;
    const retained = duplicate
      ? store.records.filter((item) => item.evidence_id !== duplicate.evidence_id)
      : store.records;
    const next: EvidenceStore = {
      schema_version: STORE_SCHEMA_VERSION,
      updated_at: this.#now().toISOString(),
      records: [...retained, record].slice(-MAX_EVIDENCE_RECORDS),
    };
    this.#writeStore(next);
    return next;
  }

  #readStore(): EvidenceStore {
    if (!existsSync(this.#historyPath)) {
      return { schema_version: STORE_SCHEMA_VERSION, updated_at: this.#now().toISOString(), records: [] };
    }
    try {
      const metadata = lstatSync(this.#historyPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) {
        throw new Error("unsafe_store");
      }
      const parsed = JSON.parse(readFileSync(this.#historyPath, "utf8")) as Partial<EvidenceStore>;
      if (parsed.schema_version !== STORE_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
        throw new Error("schema_invalid");
      }
      const records = parsed.records.filter(validEvidenceRecord).slice(-MAX_EVIDENCE_RECORDS);
      if (records.length !== parsed.records.length) throw new Error("record_invalid");
      return {
        schema_version: STORE_SCHEMA_VERSION,
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : this.#now().toISOString(),
        records,
      };
    } catch (error) {
      throw new RuntimeCompatibilityError(
        "RUNTIME_EVIDENCE_STORE_INVALID",
        `Runtime evidence store is invalid: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
  }

  #writeStore(store: EvidenceStore): void {
    const parent = path.dirname(this.#historyPath);
    // Synchronous create/write keeps this small local evidence file free of a
    // second asynchronous authority. The store is not task persistence.
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    const temporary = `${this.#historyPath}.new-${this.#createId()}`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, this.#historyPath);
  }

  async #readEnvironment(
    inspect: () => Promise<Record<string, unknown>>,
    code: "RUNTIME_INSPECTION_FAILED" | "RUNTIME_PROBE_UNAVAILABLE" = "RUNTIME_INSPECTION_FAILED",
  ): Promise<Record<string, unknown>> {
    try {
      const environment = await inspect();
      if (!recordValue(environment.zcode)) throw new Error("zcode_identity_missing");
      return environment;
    } catch (error) {
      if (error instanceof RuntimeCompatibilityError) throw error;
      throw new RuntimeCompatibilityError(
        code,
        `Runtime ${code === "RUNTIME_PROBE_UNAVAILABLE" ? "probe" : "inspection"} failed: `
          + (error instanceof Error ? error.message : String(error)),
        code === "RUNTIME_PROBE_UNAVAILABLE" ? 502 : 503,
      );
    }
  }
}

function buildSnapshot(input: {
  readonly capturedAt: string;
  readonly fingerprint: string;
  readonly installation: RuntimeInstallationIdentity;
  readonly records: readonly RuntimeEvidenceRecord[];
  readonly environment: Record<string, unknown>;
  readonly previous: RuntimeEvidenceRecord | null;
}): RuntimeCompatibilitySnapshot {
  const currentEvidence = input.records.filter((record) => record.fingerprint === input.fingerprint);
  const previousFingerprint = input.previous?.fingerprint ?? null;
  const changedAssets = currentAssetChanges(input.installation, input.previous?.installation ?? null);
  const capabilities = capabilityMatrix(input.installation, currentEvidence);
  const zcode = recordValue(input.environment.zcode);
  const warnings = Array.isArray(input.environment.warnings)
    ? input.environment.warnings.filter((item): item is string => typeof item === "string")
    : [];
  if (previousFingerprint !== null && previousFingerprint !== input.fingerprint) {
    warnings.unshift("RUNTIME_CHANGED");
  }
  return {
    schema_version: 1,
    captured_at: input.capturedAt,
    fingerprint: input.fingerprint,
    installation: input.installation,
    runtime_changed: previousFingerprint !== null && previousFingerprint !== input.fingerprint,
    previous_fingerprint: previousFingerprint,
    changed_assets: changedAssets,
    warnings,
    capabilities,
    evidence: currentEvidence.slice().reverse(),
    evidence_count: currentEvidence.length,
    manifest_modified: false,
    model_requests: 0,
    ...(stringValue(zcode, "reason") ? { reason: stringValue(zcode, "reason") } : {}),
  } as RuntimeCompatibilitySnapshot;
}

function installationIdentity(environment: Record<string, unknown>): RuntimeInstallationIdentity {
  const zcode = recordValue(environment.zcode);
  const host = recordValue(environment.host);
  const manifest = recordValue(zcode.manifest);
  const authorization = recordValue(zcode.experimental_authorization);
  const assets = recordValue(zcode.assets);
  const desktopExecutable = recordValue(zcode.desktop_executable);
  const desktopArchive = recordValue(zcode.desktop_archive);
  const normalizedAssets: Record<string, RuntimeAssetIdentity> = {};
  for (const name of ["bundle", "runtime_host", "builtin_provider_config"]) {
    const value = recordValue(assets[name]);
    normalizedAssets[name] = {
      bytes: safeInteger(value.bytes),
      sha256: shaString(value.sha256),
    };
  }
  normalizedAssets.desktop_executable = {
    bytes: safeInteger(desktopExecutable.bytes),
    sha256: shaString(desktopExecutable.sha256),
  };
  normalizedAssets.desktop_archive = {
    bytes: safeInteger(desktopArchive.bytes),
    sha256: shaString(desktopArchive.sha256),
  };
  const runtimeStatus = stringValue(zcode, "runtime_status") ?? "OFFICIAL_RUNTIME_UNVERIFIED";
  return {
    desktop_version: stringValue(zcode, "version") ?? stringValue(zcode, "desktop_version"),
    desktop_app_version: stringValue(zcode, "desktop_app_version"),
    desktop_build_commit_id: stringValue(zcode, "desktop_build_commit_id"),
    node_version: stringValue(host, "node_version"),
    installation_safety: stringValue(zcode, "installation_safety") ?? "OFFICIAL_INSTALLATION_INCOMPLETE",
    runtime_status: runtimeStatus,
    manifest_status: runtimeStatus === "OFFICIAL_RUNTIME_VERIFIED"
      ? "VERIFIED"
      : runtimeStatus === "OFFICIAL_RUNTIME_EXPERIMENTAL"
        ? "EXPERIMENTAL"
        : "UNVERIFIED",
    experimental_authorization: {
      state: stringValue(authorization, "state") ?? "not_configured",
      scopes: Array.isArray(authorization.scopes)
        ? authorization.scopes.filter((item): item is string => typeof item === "string")
        : [],
    },
    assets: normalizedAssets,
  };
}

function capabilityMatrix(
  installation: RuntimeInstallationIdentity,
  evidence: readonly RuntimeEvidenceRecord[],
): Readonly<Record<string, RuntimeCapability>> {
  const staticEvidence = latest(evidence, (item) => item.probe_type === "static");
  const protocolEvidence = latest(evidence, (item) => item.probe_type === "protocol");
  const codingPlanEvidence = latest(evidence, (item) =>
    item.probe_type === "real_provider"
    && item.provider === "account:bigmodel-individual-coding-plan");
  const startPlanEvidence = latest(evidence, (item) =>
    item.probe_type === "real_provider"
    && item.provider === "account:bigmodel-start-plan");
  const otherProviderEvidence = latest(evidence, (item) =>
    item.probe_type === "real_provider"
    && item.provider !== null
    && !["account:bigmodel-individual-coding-plan", "account:bigmodel-start-plan"].includes(item.provider));
  const billingEvidence = latest(evidence, (item) =>
    item.probe_type === "billing"
    && item.provider === "account:bigmodel-individual-coding-plan");
  return {
    installation_safety: capability(
      installation.installation_safety === "OFFICIAL_INSTALLATION_SAFE"
        ? "SAFE"
        : installation.installation_safety === "OFFICIAL_INSTALLATION_UNSAFE"
          ? "UNSAFE"
          : "INCOMPLETE",
      staticEvidence,
      "Official installation safety inspection",
    ),
    manifest_compatibility: capability(installation.manifest_status as CapabilityStatus, staticEvidence,
      "Exact Runtime compatibility manifest"),
    protocol: evidenceCapability(protocolEvidence, "No authorized zero-model protocol evidence exists."),
    coding_plan_execution: evidenceCapability(
      codingPlanEvidence,
      "No Coding Plan provider execution evidence exists.",
    ),
    coding_plan_billing: billingCapability(billingEvidence),
    start_plan_execution: evidenceCapability(
      startPlanEvidence,
      "No Start Plan execution evidence exists.",
    ),
    other_providers: evidenceCapability(
      otherProviderEvidence,
      "No other Provider execution evidence exists.",
    ),
    cleanup: protocolEvidence?.result === "PASS"
      ? capability("VERIFIED", protocolEvidence, "Authorized protocol probe disposed its bounded runtime processes")
      : evidenceCapability(null, "No runtime cleanup evidence exists."),
  };
}

function evidenceCapability(
  record: RuntimeEvidenceRecord | null,
  limitation: string,
): RuntimeCapability {
  if (!record) return capability("NOT_RUN", null, "No matching evidence", limitation);
  return capability(
    record.result === "PASS" ? "PASS" : record.result === "INCOMPLETE" ? "INCONCLUSIVE" : "FAIL",
    record,
    record.evidence_source,
    record.limitations[0] ?? null,
  );
}

function billingCapability(record: RuntimeEvidenceRecord | null): RuntimeCapability {
  if (!record) {
    return capability(
      "NOT_RUN",
      null,
      "No matching evidence",
      "No attributable Coding Plan billing evidence exists.",
    );
  }
  const verified = record.result === "PASS"
    && /^(?:VERIFIED|BILLING_VERIFIED)$/iu.test(record.classification);
  return capability(
    verified ? "VERIFIED" : record.result === "FAIL" ? "FAIL" : "INCONCLUSIVE",
    record,
    record.evidence_source,
    record.limitations[0] ?? null,
  );
}

function capability(
  status: CapabilityStatus,
  evidence: RuntimeEvidenceRecord | null,
  source: string,
  limitation: string | null = null,
): RuntimeCapability {
  return {
    status,
    evidence_id: evidence?.evidence_id ?? null,
    source,
    limitation,
  };
}

function latest(
  records: readonly RuntimeEvidenceRecord[],
  predicate: (record: RuntimeEvidenceRecord) => boolean,
): RuntimeEvidenceRecord | null {
  return [...records].reverse().find(predicate) ?? null;
}

function previousDistinctFingerprint(
  records: readonly RuntimeEvidenceRecord[],
  fingerprint: string,
): RuntimeEvidenceRecord | null {
  const last = records.at(-1);
  if (!last || last.fingerprint === fingerprint) return null;
  return [...records].reverse().find((record) => record.fingerprint === last.fingerprint) ?? last;
}

function currentAssetChanges(
  current: RuntimeInstallationIdentity,
  previous: RuntimeInstallationIdentity | null,
): readonly string[] {
  if (!previous) return [];
  const changes: string[] = [];
  for (const key of new Set([...Object.keys(current.assets), ...Object.keys(previous.assets)])) {
    if (current.assets[key]?.sha256 !== previous.assets[key]?.sha256
      || current.assets[key]?.bytes !== previous.assets[key]?.bytes) {
      changes.push(key);
    }
  }
  if (current.desktop_version !== previous.desktop_version) changes.push("desktop_version");
  if (current.desktop_app_version !== previous.desktop_app_version) changes.push("desktop_app_version");
  if (current.desktop_build_commit_id !== previous.desktop_build_commit_id) changes.push("desktop_build_commit_id");
  if (current.node_version !== previous.node_version) changes.push("node_version");
  return changes.sort();
}

function sealEvidence(
  value: Omit<RuntimeEvidenceRecord, "evidence_digest">,
): RuntimeEvidenceRecord {
  const digest = evidenceSemanticDigest(value);
  return { ...value, evidence_digest: digest };
}

function evidenceSemanticDigest(
  value: Pick<
    RuntimeEvidenceRecord,
    | "schema_version"
    | "fingerprint"
    | "installation"
    | "probe_type"
    | "probe_scope"
    | "result"
    | "classification"
    | "provider"
    | "model"
    | "evidence_source"
    | "limitations"
  >,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      schema_version: value.schema_version,
      fingerprint: value.fingerprint,
      installation: value.installation,
      probe_type: value.probe_type,
      probe_scope: value.probe_scope,
      result: value.result,
      classification: value.classification,
      provider: value.provider,
      model: value.model,
      evidence_source: value.evidence_source,
      limitations: value.limitations,
    }), "utf8")
    .digest("hex");
}

function validEvidenceRecord(value: unknown): value is RuntimeEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RuntimeEvidenceRecord>;
  if (record.schema_version !== EVIDENCE_SCHEMA_VERSION
    || typeof record.evidence_id !== "string" || record.evidence_id.length < 1
    || typeof record.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(record.fingerprint)
    || typeof record.captured_at !== "string"
    || !["static", "protocol", "real_provider", "billing"].includes(record.probe_type ?? "")
    || typeof record.probe_scope !== "string"
    || !["PASS", "FAIL", "INCOMPLETE"].includes(record.result ?? "")
    || typeof record.classification !== "string"
    || typeof record.evidence_source !== "string"
    || typeof record.evidence_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.evidence_digest)
    || !Array.isArray(record.limitations)) {
    return false;
  }
  const { evidence_digest: digest, ...body } = record as RuntimeEvidenceRecord;
  const legacyDigest = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
  return evidenceSemanticDigest(body) === digest || legacyDigest === digest;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value)) ?? "null";
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortObject(item)]));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function shaString(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}
