import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = resolve(process.env.CODEX_HOME || resolve(process.env.USERPROFILE || "", ".codex"));
const outputPath = resolve(repoRoot, ".evidence", "rollout-token-evidence.json");
const digest = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const keys = ["total_tokens", "input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];

function parseArgs(argv) {
  const pairs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--rollout" || !argv[i + 1] || argv[i + 2] !== "--thread-id" || !argv[i + 3]) {
      throw new Error("usage: --rollout <explicit-jsonl> --thread-id <expected-thread-id> [repeat]");
    }
    pairs.push({ file: resolve(argv[i + 1]), expectedThreadId: argv[i + 3] });
    i += 3;
  }
  if (pairs.length === 0) throw new Error("at least one explicit rollout is required");
  return pairs;
}

function counters(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, Number.isSafeInteger(value[key]) ? value[key] : null]));
}

function sourceKind(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.kind ?? (Object.keys(value).sort().join(",") || null);
  return null;
}

async function inspect({ file, expectedThreadId }) {
  const sessionsRoots = [resolve(home, "sessions"), resolve(home, "archived_sessions")];
  const inAllowedRoot = sessionsRoots.some(root => {
    const rel = relative(root, file);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  });
  if (!inAllowedRoot) throw new Error("rollout_must_be_under_codex_home_session_storage");
  const before = await fs.stat(file);
  const fileHash = digest(basename(file));
  const snapshot = {
    fileId: `rollout#${fileHash}`,
    fileBytesBefore: before.size,
    modifiedAtBefore: before.mtime.toISOString(),
    expectedThreadId: `thread#${digest(expectedThreadId)}`,
    filenameThreadMatch: basename(file).includes(expectedThreadId),
    sessionMeta: null,
    modelNames: [],
    lineCount: 0,
    invalidJsonLineCount: 0,
    tokenCountEvents: [],
    eventKinds: {},
    compactionMarkers: [],
    resumeMarkers: [],
  };
  const handle = await fs.open(file, "r");
  try {
    const lastByte = Buffer.alloc(1);
    const lastByteRead = before.size > 0 ? await handle.read(lastByte, 0, 1, before.size - 1) : { bytesRead: 0 };
    snapshot.endsWithNewline = lastByteRead.bytesRead === 1 && lastByte[0] === 10;
  } finally {
    await handle.close();
  }

  const processLine = line => {
    snapshot.lineCount += 1;
    let record;
    try { record = JSON.parse(line); } catch { snapshot.invalidJsonLineCount += 1; return; }
    const payload = record?.payload ?? {};
    const type = record?.type ?? "unknown";
    const payloadType = payload?.type ?? "";
    const eventKey = type === "event_msg" ? `${type}:${payloadType || "unknown"}` : type;
    snapshot.eventKinds[eventKey] = (snapshot.eventKinds[eventKey] ?? 0) + 1;

    if (type === "session_meta" && !snapshot.sessionMeta) {
      snapshot.sessionMeta = {
        idMatchesExpected: payload.id === expectedThreadId,
        sessionIdMatchesExpected: payload.session_id === expectedThreadId,
        id: typeof payload.id === "string" ? `thread#${digest(payload.id)}` : null,
        sessionId: typeof payload.session_id === "string" ? `session#${digest(payload.session_id)}` : null,
        parentThreadId: typeof payload.parent_thread_id === "string" ? `thread#${digest(payload.parent_thread_id)}` : null,
        threadSource: payload.thread_source ?? null,
        originator: payload.originator ?? null,
        source: sourceKind(payload.source),
        timestamp: payload.timestamp ?? record.timestamp ?? null,
        provider: payload.model_provider ?? null,
        cliVersion: payload.cli_version ?? null,
        historyMode: payload.history_mode ?? null,
        multiAgentVersion: payload.multi_agent_version ?? null,
      };
    }
    if (type === "turn_context" && typeof payload.model === "string" && !snapshot.modelNames.includes(payload.model)) {
      snapshot.modelNames.push(payload.model);
    }
    if (type === "event_msg" && payloadType === "token_count") {
      const info = payload.info;
      if (!info || typeof info !== "object") {
        snapshot.tokenCountEvents.push({ line: snapshot.lineCount, timestamp: record.timestamp ?? null, emptyInfo: true, total: null, last: null, modelContextWindow: null });
        return;
      }
      snapshot.tokenCountEvents.push({
        eventOrder: snapshot.tokenCountEvents.length + 1,
        line: snapshot.lineCount,
        timestamp: record.timestamp ?? null,
        eventSequence: Number.isSafeInteger(record.event_seq) ? record.event_seq : Number.isSafeInteger(record.seq) ? record.seq : null,
        total: counters(info.total_token_usage),
        last: counters(info.last_token_usage),
        modelContextWindow: Number.isSafeInteger(info.model_context_window) ? info.model_context_window : null,
        totalPresent: Object.hasOwn(info, "total_token_usage") && info.total_token_usage !== null,
        lastPresent: Object.hasOwn(info, "last_token_usage") && info.last_token_usage !== null,
        contextWindowPresent: Object.hasOwn(info, "model_context_window") && info.model_context_window !== null,
      });
    }
    if (/compact/i.test(type) || /compact/i.test(payloadType)) snapshot.compactionMarkers.push({ line: snapshot.lineCount, type, payloadType, timestamp: record.timestamp ?? null });
    if (/resume|replay/i.test(type) || /resume|replay/i.test(payloadType)) snapshot.resumeMarkers.push({ line: snapshot.lineCount, type, payloadType, timestamp: record.timestamp ?? null });
  };
  let pendingLine = null;
  for await (const line of createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })) {
    if (pendingLine !== null) processLine(pendingLine);
    pendingLine = line;
  }
  if (pendingLine !== null) {
    if (snapshot.endsWithNewline) processLine(pendingLine);
    else snapshot.trailingPartialLineIgnored = true;
  }
  snapshot.compactionMarkerCount = snapshot.compactionMarkers.length;
  snapshot.resumeMarkerCount = snapshot.resumeMarkers.length;
  snapshot.compactionComparisons = snapshot.compactionMarkers.map(marker => {
    const beforeToken = snapshot.tokenCountEvents.filter(event => event.line < marker.line).at(-1) ?? null;
    const afterToken = snapshot.tokenCountEvents.find(event => event.line > marker.line) ?? null;
    return { marker, before: beforeToken && { line: beforeToken.line, timestamp: beforeToken.timestamp, total: beforeToken.total?.total_tokens ?? null, last: beforeToken.last?.total_tokens ?? null, modelContextWindow: beforeToken.modelContextWindow ?? null }, after: afterToken && { line: afterToken.line, timestamp: afterToken.timestamp, total: afterToken.total?.total_tokens ?? null, last: afterToken.last?.total_tokens ?? null, modelContextWindow: afterToken.modelContextWindow ?? null } };
  });

  const after = await fs.stat(file);
  snapshot.fileBytesAfter = after.size;
  snapshot.modifiedAtAfter = after.mtime.toISOString();
  snapshot.changedDuringRead = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  snapshot.identityVerified = snapshot.filenameThreadMatch && snapshot.sessionMeta?.idMatchesExpected === true &&
    snapshot.sessionMeta?.sessionIdMatchesExpected === true && snapshot.sessionMeta?.threadSource === "user" &&
    snapshot.sessionMeta?.parentThreadId === null;
  snapshot.latestSelection = "last-valid-token_count-in-file-order";
  snapshot.latest = snapshot.tokenCountEvents.at(-1) ?? null;
  snapshot.duplicateSnapshotCount = snapshot.tokenCountEvents.reduce((count, item, index, all) =>
    index > 0 && JSON.stringify([item.total, item.last, item.modelContextWindow]) ===
      JSON.stringify([all[index - 1].total, all[index - 1].last, all[index - 1].modelContextWindow]) ? count + 1 : count, 0);
  const totals = snapshot.tokenCountEvents.map(item => item.total?.total_tokens).filter(Number.isSafeInteger);
  snapshot.totalDecreaseCount = totals.reduce((count, value, index) => index > 0 && value < totals[index - 1] ? count + 1 : count, 0);
  snapshot.absoluteSnapshotEvidence = snapshot.tokenCountEvents.length > 0 && snapshot.tokenCountEvents.every(item => item.total !== null && item.last !== null);
  snapshot.eventMsgCount = snapshot.eventKinds["event_msg:unknown"] === undefined
    ? Object.entries(snapshot.eventKinds).filter(([name]) => name.startsWith("event_msg:")).reduce((sum, [, count]) => sum + count, 0)
    : snapshot.eventKinds["event_msg:unknown"];
  return snapshot;
}

const evidence = {
  probe: "codex-rollout-readonly-token-probe",
  observedAt: new Date().toISOString(),
  codexHomeSource: process.env.CODEX_HOME ? "CODEX_HOME_environment" : "default_user_profile_Codex_home",
  codexHomePath: "<redacted>",
  results: await Promise.all(parseArgs(process.argv.slice(2)).map(inspect)),
};
await fs.mkdir(dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output: ".evidence/rollout-token-evidence.json", results: evidence.results.map(x => ({ fileId: x.fileId, identityVerified: x.identityVerified, sessionMeta: x.sessionMeta, modelNames: x.modelNames, bytes: x.fileBytesAfter, lineCount: x.lineCount, invalidJsonLineCount: x.invalidJsonLineCount, trailingPartialLineIgnored: x.trailingPartialLineIgnored ?? false, tokenCountEvents: x.tokenCountEvents.length, compactionComparisons: x.compactionComparisons, resumeMarkers: x.resumeMarkers, latest: x.latest, changedDuringRead: x.changedDuringRead, endsWithNewline: x.endsWithNewline, totalDecreaseCount: x.totalDecreaseCount })) }, null, 2)}\n`);
