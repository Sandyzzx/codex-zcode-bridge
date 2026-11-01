import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORICAL_RESULT_EXCEPTIONS,
  annotateHistoricalResultException,
  historicalResultExceptionArchiveMatches,
  historicalResultExceptionFor,
  historicalResultExceptionSetDigest,
  historicalResultExceptionTaskIds,
  isCanonicalHistoricalResultExceptionSet,
} from "../src/store/json-history-result-exceptions.mjs";

const canonical = HISTORICAL_RESULT_EXCEPTIONS.map(annotateHistoricalResultException);

test("historical Result exception policy accepts only the three reviewed identities", () => {
  assert.equal(canonical.length, 3);
  assert.equal(isCanonicalHistoricalResultExceptionSet(canonical), true);
  assert.equal(new Set(canonical.map((entry) => entry.exception_id)).size, 3);
  assert.deepEqual(historicalResultExceptionTaskIds(canonical), [
    "CAD2BIM_FULL_AUDIT_RM02_001",
    "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930",
  ]);
  assert.equal(historicalResultExceptionSetDigest(canonical), historicalResultExceptionSetDigest(canonical));

  for (const exception of canonical) {
    assert.deepEqual(
      historicalResultExceptionFor(
        exception.task_id,
        exception.stored_attempt,
        exception.relative_path,
        exception.sha256,
        exception.byte_length,
      ),
      HISTORICAL_RESULT_EXCEPTIONS.find((entry) => entry.exception_id === exception.exception_id),
    );
  }
});

test("historical Result exception policy rejects missing, extra and identity-drifted entries", () => {
  assert.equal(isCanonicalHistoricalResultExceptionSet(canonical.slice(0, 2)), false);
  assert.equal(isCanonicalHistoricalResultExceptionSet([
    ...canonical,
    { ...canonical[0], exception_id: "unreviewed-fourth-exception" },
  ]), false);
  assert.equal(isCanonicalHistoricalResultExceptionSet([
    { ...canonical[0], sha256: "0".repeat(64) },
    canonical[1],
    canonical[2],
  ]), false);
  assert.equal(historicalResultExceptionFor(
    canonical[0]!.task_id,
    canonical[0]!.stored_attempt,
    canonical[0]!.relative_path,
    "0".repeat(64),
    canonical[0]!.byte_length,
  ), null);
});

test("archive acceptance distinguishes the exact reviewed anomalies from ordinary archives", () => {
  const tasks = [
    {
      task_id: "CAD2BIM_FULL_AUDIT_RM02_001",
      classification: "conflict",
      archive_status: "unresolved",
      anomalies: canonical
        .filter((entry) => entry.task_id === "CAD2BIM_FULL_AUDIT_RM02_001")
        .map((entry) => entry.archive_anomaly),
    },
    {
      task_id: "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930",
      classification: "conflict",
      archive_status: "unresolved",
      anomalies: canonical
        .filter((entry) => entry.task_id === "PROJECT-ALIGNMENT-DOC-HYGIENE-CLOSE-1-COMMIT-20260930")
        .map((entry) => entry.archive_anomaly),
    },
  ];
  const manifest = {
    archive_status: "unresolved",
    anomalies: canonical.map((entry) => entry.archive_anomaly),
    tasks,
  };
  assert.equal(historicalResultExceptionArchiveMatches(manifest), true);
  assert.equal(historicalResultExceptionArchiveMatches({
    ...manifest,
    anomalies: [...manifest.anomalies, { ...manifest.anomalies[0], path: "unreviewed/result.json" }],
  }), false);
  assert.equal(historicalResultExceptionArchiveMatches({
    archive_status: "archived",
    anomalies: [],
    tasks: [],
  }), false);
});
