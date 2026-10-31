import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprintRuntimeArtifact, verifyWorkerProvenance, type RuntimeBuildProvenance } from "../src/runtime/build-provenance.js";

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-runtime-provenance-"));
  const bridgePath = path.join(root, "bridge.mjs");
  const workerPath = path.join(root, "worker-main.mjs");
  const otherWorkerPath = path.join(root, "other-worker.mjs");
  writeFileSync(bridgePath, "bridge fixture", "utf8");
  writeFileSync(workerPath, "worker fixture", "utf8");
  writeFileSync(otherWorkerPath, "other worker fixture", "utf8");
  const expected: RuntimeBuildProvenance = {
    bridge: fingerprintRuntimeArtifact(bridgePath),
    worker: fingerprintRuntimeArtifact(workerPath),
  };
  return { root, bridgePath, workerPath, otherWorkerPath, expected };
}

function envelope(expected: RuntimeBuildProvenance): string {
  return JSON.stringify(expected);
}

test("Bridge launch with matching canonical path and SHA256 is verified", () => {
  const fixture = makeFixture();
  try {
    const checked = verifyWorkerProvenance({
      bridgeLaunchMarker: true,
      rawEnvelope: envelope(fixture.expected),
      actualWorker: fingerprintRuntimeArtifact(fixture.workerPath),
    });
    assert.equal(checked.status, "verified");
    assert.equal(checked.workerMatchesExpected, true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a valid expected envelope with another existing worker path is rejected", () => {
  const fixture = makeFixture();
  try {
    const wrongExpected = { ...fixture.expected, worker: fingerprintRuntimeArtifact(fixture.otherWorkerPath) };
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope: envelope(wrongExpected), actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "rejected");
    assert.equal(checked.errorCode, "provenance_path_mismatch");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a SHA256 mismatch on the matching path is rejected", () => {
  const fixture = makeFixture();
  try {
    const wrongExpected = { ...fixture.expected, worker: { ...fixture.expected.worker, sha256: "0".repeat(64) } };
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope: envelope(wrongExpected), actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "rejected");
    assert.equal(checked.errorCode, "provenance_hash_mismatch");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a Bridge marker with missing provenance is rejected distinctly", () => {
  const fixture = makeFixture();
  try {
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope: undefined, actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "rejected");
    assert.equal(checked.errorCode, "provenance_missing");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("malformed JSON and malformed envelope structure are rejected distinctly", () => {
  const fixture = makeFixture();
  try {
    for (const rawEnvelope of ["{", JSON.stringify({ ...fixture.expected, extra: true }), JSON.stringify({ ...fixture.expected, worker: { ...fixture.expected.worker, sha256: "bad" } })]) {
      const checked = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope, actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
      assert.equal(checked.status, "rejected");
      assert.equal(checked.errorCode, "provenance_malformed");
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("legacy direct launch without a Bridge marker or envelope stays explicitly unverified", () => {
  const fixture = makeFixture();
  try {
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: false, rawEnvelope: undefined, actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "unverified");
    assert.equal(checked.workerMatchesExpected, false);
    if (checked.status === "unverified") assert.equal(checked.reason, "provenance_unverified_legacy");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("legacy direct launch cannot bypass validation by supplying malformed provenance", () => {
  const fixture = makeFixture();
  try {
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: false, rawEnvelope: "{", actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "rejected");
    assert.equal(checked.errorCode, "provenance_malformed");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("modifying the actual bundle after Bridge fingerprinting is rejected by SHA256", () => {
  const fixture = makeFixture();
  try {
    const expected = fixture.expected;
    writeFileSync(fixture.workerPath, "modified worker fixture", "utf8");
    const checked = verifyWorkerProvenance({ bridgeLaunchMarker: true, rawEnvelope: envelope(expected), actualWorker: fingerprintRuntimeArtifact(fixture.workerPath) });
    assert.equal(checked.status, "rejected");
    assert.equal(checked.errorCode, "provenance_hash_mismatch");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
