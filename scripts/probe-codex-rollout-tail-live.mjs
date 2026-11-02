import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CodexRolloutTailReader,
  discoverCodexRolloutByThreadId,
} from "../dist/src/observability/codex-rollout-token-source.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidencePath = resolve(root, ".evidence", "rollout-tail-live-evidence.json");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name}_requires_value`);
  return process.argv[index + 1];
}

const threadId = option("--thread-id");
if (!threadId) throw new Error("usage: --thread-id <thread-id> [--timeout-seconds 90] [--poll-ms 1000]");
const timeoutSeconds = Number(option("--timeout-seconds", "90"));
const pollMs = Number(option("--poll-ms", "1000"));
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 300) {
  throw new Error("timeout_seconds_out_of_range");
}
if (!Number.isFinite(pollMs) || pollMs < 250 || pollMs > 30_000) {
  throw new Error("poll_ms_out_of_range");
}

const codexHome = resolve(option("--codex-home", process.env.CODEX_HOME ?? resolve(homedir(), ".codex")));
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const safeSnapshot = snapshot => snapshot ? {
  threadId: `thread#${hash(snapshot.threadId)}`,
  turnId: snapshot.turnId,
  total: snapshot.total,
  last: snapshot.last,
  modelContextWindow: snapshot.modelContextWindow,
  observedAt: snapshot.observedAt,
  eventOrder: snapshot.eventOrder,
  lineNumber: snapshot.lineNumber,
  source: snapshot.source,
  absoluteSnapshot: snapshot.absoluteSnapshot,
} : null;

const evidence = {
  probe: "codex-rollout-tail-live-readonly",
  threadId: `thread#${hash(threadId)}`,
  codexHomeSource: process.env.CODEX_HOME ? "explicit_environment" : option("--codex-home") ? "explicit_argument" : "default_user_profile",
  codexHomePath: "<redacted>",
  modelRequestIssued: false,
  startedAt: new Date().toISOString(),
  discovery: null,
  initial: null,
  update: null,
  polls: 0,
  conclusion: "LIVE_APPEND_NOT_OBSERVED",
};

try {
  const discovery = await discoverCodexRolloutByThreadId({ codexHome, expectedThreadId: threadId });
  evidence.discovery = {
    state: discovery.state,
    threadId: discovery.threadId ? `thread#${hash(discovery.threadId)}` : null,
    filenameCandidateCount: discovery.filenameCandidateCount,
    validatedFileCount: discovery.validatedFileCount,
    sourceFileId: discovery.sourceFileId,
    parentThreadId: discovery.parentThreadId,
    threadSource: discovery.threadSource,
    originator: discovery.originator,
    provider: discovery.provider,
    cliVersion: discovery.cliVersion,
  };
  if (discovery.state !== "found" || !discovery.sourceFile) {
    evidence.conclusion = `THREAD_PATH_${discovery.state.toUpperCase()}`;
  } else {
    const reader = await CodexRolloutTailReader.open({
      codexHome,
      rolloutFile: discovery.sourceFile,
      expectedThreadId: threadId,
    });
    const initial = await reader.poll();
    evidence.initial = {
      status: initial.status,
      offset: initial.state.offset,
      pendingBytes: initial.state.pendingBytes,
      snapshot: safeSnapshot(initial.state.lastValidSnapshot),
    };

    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, pollMs));
      const result = await reader.poll();
      evidence.polls += 1;
      if (result.status === "updated" && result.state.offset > initial.state.offset) {
        evidence.update = {
          status: result.status,
          resetReason: result.resetReason,
          bytesRead: result.bytesRead,
          offset: result.state.offset,
          pendingBytes: result.state.pendingBytes,
          newTokenCountEventCount: result.newTokenCountEventCount,
          duplicateSnapshotCount: result.duplicateSnapshotCount,
          compactionMarkerCount: result.compactionMarkerCount,
          observedAfterCompaction: result.observedAfterCompaction,
          snapshot: safeSnapshot(result.snapshot),
        };
        evidence.conclusion = "LIVE_APPEND_OBSERVED";
        break;
      }
      if (result.status === "identity_unverified" || result.status === "file_changed") {
        evidence.update = {
          status: result.status,
          resetReason: result.resetReason,
          bytesRead: result.bytesRead,
          offset: result.state.offset,
          pendingBytes: result.state.pendingBytes,
          snapshot: null,
        };
        break;
      }
    }
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.name : "unknown";
  evidence.conclusion = "PROBE_ERROR";
} finally {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, ".evidence"), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

process.stdout.write(`${JSON.stringify({ output: ".evidence/rollout-tail-live-evidence.json", conclusion: evidence.conclusion, discovery: evidence.discovery, initial: evidence.initial, update: evidence.update, polls: evidence.polls }, null, 2)}\n`);
