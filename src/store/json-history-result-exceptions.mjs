import { createHash } from "node:crypto";

export const HISTORICAL_RESULT_EXCEPTION_POLICY_VERSION = 1;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export const HISTORICAL_RESULT_EXCEPTIONS = freeze([
  {
    exception_id: "cad2bim_rm02_attempt_2_result_stored_at_3",
    task_id: "CAD2BIM_FULL_AUDIT_RM02_001",
    stored_attempt: 3,
    internal_attempt: 2,
    relative_path: "CAD2BIM_FULL_AUDIT_RM02_001/attempts/3/result.json",
    sha256: "539c76d236155688feb906a8dfb9764f92a2f76ff8e16b97e6177c2e7bd95530",
    byte_length: 13981,
    archive_anomaly: {
      code: "conflicting_projection",
      path: "CAD2BIM_FULL_AUDIT_RM02_001/attempts/3/result.json",
      record_type: "attempt",
      detail: "result_attempt_does_not_match_storage_generation",
    },
  },
  {
    exception_id: "cad2bim_rm02_attempt_3_result_stored_at_4",
    task_id: "CAD2BIM_FULL_AUDIT_RM02_001",
    stored_attempt: 4,
    internal_attempt: 3,
    relative_path: "CAD2BIM_FULL_AUDIT_RM02_001/attempts/4/result.json",
    sha256: "ec6faea33c6b3b7c299b2c4a6094c431b670d807e00398ed03364ec5a1c61cd3",
    byte_length: 12989,
    archive_anomaly: {
      code: "conflicting_projection",
      path: "CAD2BIM_FULL_AUDIT_RM02_001/attempts/4/result.json",
      record_type: "attempt",
      detail: "result_attempt_does_not_match_storage_generation",
    },
  },
  {
    exception_id: "project_alignment_current_attempt_2_root_result_binds_1",
    task_id: "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930",
    stored_attempt: 2,
    internal_attempt: 1,
    relative_path: "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930/result.json",
    sha256: "494235a230178fe2aeb0128210bba0cf8fec5029202b07b0a1b3648476d3e12e",
    byte_length: 6247,
    archive_anomaly: {
      code: "conflicting_projection",
      path: "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930/result.json",
      record_type: "result",
      detail: "result_attempt_does_not_match_storage_generation",
    },
  },
]);

export function historicalResultExceptionArtifactId(relativePath) {
  const digest = createHash("sha256").update(relativePath).digest("hex");
  return `artifact-${digest.slice(0, 40)}`;
}

export function historicalResultExceptionFor(taskId, storedAttempt, relativePath, sha256, byteLength) {
  return HISTORICAL_RESULT_EXCEPTIONS.find((entry) =>
    entry.task_id === taskId
    && entry.stored_attempt === storedAttempt
    && entry.relative_path === relativePath
    && entry.sha256 === sha256
    && entry.byte_length === byteLength
  ) ?? null;
}

export function annotateHistoricalResultException(entry) {
  return Object.freeze({
    exception_id: entry.exception_id,
    task_id: entry.task_id,
    stored_attempt: entry.stored_attempt,
    internal_attempt: entry.internal_attempt,
    relative_path: entry.relative_path,
    artifact_id: historicalResultExceptionArtifactId(entry.relative_path),
    sha256: entry.sha256,
    byte_length: entry.byte_length,
    archive_anomaly: Object.freeze({ ...entry.archive_anomaly }),
  });
}

export function historicalResultExceptionSetDigest(entries) {
  return createHash("sha256").update(canonical(entries)).digest("hex");
}

export function isCanonicalHistoricalResultExceptionSet(entries) {
  if (!Array.isArray(entries) || entries.length !== HISTORICAL_RESULT_EXCEPTIONS.length) return false;
  return HISTORICAL_RESULT_EXCEPTIONS.every((expected, index) => {
    const actual = entries[index];
    const annotated = annotateHistoricalResultException(expected);
    return canonical(actual) === canonical(annotated);
  });
}

export function historicalResultExceptionTaskIds(entries) {
  return [...new Set(entries.map((entry) => entry.task_id))].sort((left, right) => left.localeCompare(right, "en"));
}

export function historicalResultExceptionArchiveMatches(manifest) {
  if (!manifest || !Array.isArray(manifest.anomalies) || !Array.isArray(manifest.tasks)) return false;
  const expectedAnomalies = HISTORICAL_RESULT_EXCEPTIONS
    .map((entry) => entry.archive_anomaly)
    .sort((left, right) => canonical(left).localeCompare(canonical(right), "en"));
  const actualAnomalies = [...manifest.anomalies]
    .sort((left, right) => canonical(left).localeCompare(canonical(right), "en"));
  if (manifest.archive_status !== "unresolved" || canonical(actualAnomalies) !== canonical(expectedAnomalies)) return false;

  const taskIds = historicalResultExceptionTaskIds(HISTORICAL_RESULT_EXCEPTIONS);
  for (const taskId of taskIds) {
    const task = manifest.tasks.find((candidate) => candidate.task_id === taskId);
    const expected = HISTORICAL_RESULT_EXCEPTIONS
      .filter((entry) => entry.task_id === taskId)
      .map((entry) => entry.archive_anomaly)
      .sort((left, right) => canonical(left).localeCompare(canonical(right), "en"));
    const actual = task && Array.isArray(task.anomalies)
      ? [...task.anomalies].sort((left, right) => canonical(left).localeCompare(canonical(right), "en"))
      : null;
    if (!task || task.classification !== "conflict" || task.archive_status !== "unresolved"
      || canonical(actual) !== canonical(expected)) return false;
  }
  return manifest.tasks
    .filter((task) => !taskIds.includes(task.task_id))
    .every((task) => task.archive_status === "archived" && Array.isArray(task.anomalies) && task.anomalies.length === 0);
}
