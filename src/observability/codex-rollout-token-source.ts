import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

const ROLLOUT_SUBDIRECTORIES = ["sessions", "archived_sessions"] as const;
export interface CodexRolloutUsageBreakdown {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export interface CodexRolloutTokenSnapshot {
  threadId: string;
  turnId: null;
  total: CodexRolloutUsageBreakdown | null;
  last: CodexRolloutUsageBreakdown | null;
  modelContextWindow: number | null;
  observedAt: string | null;
  eventOrder: number;
  lineNumber: number;
  source: "codex_rollout_token_count";
  absoluteSnapshot: true;
}

export interface CodexRolloutReadResult {
  state: "ok" | "thread_identity_unverified" | "no_token_usage";
  threadId: string;
  sessionId: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  originator: string | null;
  provider: string | null;
  cliVersion: string | null;
  historyMode: string | null;
  modelNames: string[];
  sourceFile: string;
  sourceFileId: string;
  sourceFileBytes: number;
  sourceFileModifiedAt: string;
  lineCount: number;
  invalidJsonLineCount: number;
  trailingPartialLineIgnored: boolean;
  changedDuringRead: boolean;
  tokenCountEventCount: number;
  emptyUsageEventCount: number;
  compactionMarkerCount: number;
  latest: CodexRolloutTokenSnapshot | null;
}

export interface CodexRolloutFileIdentity {
  device: string;
  inode: string;
  birthtimeMs: number;
}

export interface CodexRolloutDiscoveredFile {
  sourceFile: string;
  sourceFileId: string;
  identity: CodexRolloutFileIdentity;
  sessionId: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  originator: string | null;
  provider: string | null;
  cliVersion: string | null;
}

export interface CodexRolloutDiscoveryResult {
  state: "found" | "not_found" | "identity_unverified" | "ambiguous";
  threadId: string;
  codexHome: string;
  filenameCandidateCount: number;
  validatedFileCount: number;
  sourceFile: string | null;
  sourceFileId: string | null;
  identity: CodexRolloutFileIdentity | null;
  sessionId: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  originator: string | null;
  provider: string | null;
  cliVersion: string | null;
}

export interface CodexRolloutTailState {
  threadId: string;
  sourceFile: string;
  sourceFileId: string;
  fileIdentity: CodexRolloutFileIdentity;
  offset: number;
  pendingBytes: number;
  lastValidSnapshot: CodexRolloutTokenSnapshot | null;
}

export interface CodexRolloutTailPollResult {
  status: "updated" | "unchanged" | "partial_line" | "no_token_usage" |
    "compaction_observed" | "identity_unverified" | "file_changed";
  resetReason: "initial" | "truncated" | "replaced" | null;
  snapshot: CodexRolloutTokenSnapshot | null;
  state: CodexRolloutTailState;
  bytesRead: number;
  newTokenCountEventCount: number;
  duplicateSnapshotCount: number;
  emptyUsageEventCount: number;
  invalidJsonLineCount: number;
  compactionMarkerCount: number;
  observedAfterCompaction: boolean;
}

function fileId(file: string): string {
  return `rollout#${createHash("sha256").update(basename(file)).digest("hex").slice(0, 12)}`;
}

function numeric(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function usage(raw: unknown): CodexRolloutUsageBreakdown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    totalTokens: numeric(value.total_tokens),
    inputTokens: numeric(value.input_tokens),
    cachedInputTokens: numeric(value.cached_input_tokens),
    cacheWriteInputTokens: numeric(value.cache_write_input_tokens),
    outputTokens: numeric(value.output_tokens),
    reasoningOutputTokens: numeric(value.reasoning_output_tokens),
  };
}

function isWithin(root: string, file: string): boolean {
  const pathFromRoot = relative(root, file);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function fileIdentity(stats: { dev: number; ino: number; birthtimeMs: number }): CodexRolloutFileIdentity {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameFileIdentity(left: CodexRolloutFileIdentity, right: CodexRolloutFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeMs === right.birthtimeMs;
}

async function boundaryFingerprint(file: string, offset: number): Promise<string | null> {
  if (offset === 0) return null;
  const handle = await open(file, "r");
  try {
    const start = Math.max(0, offset - 4096);
    const buffer = Buffer.alloc(offset - start);
    const result = await handle.read(buffer, 0, buffer.length, start);
    if (result.bytesRead !== buffer.length) return null;
    return createHash("sha256").update(String(offset)).update(buffer).digest("hex");
  } finally {
    await handle.close();
  }
}

function validateThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)) {
    throw new Error("invalid_thread_id");
  }
}

function filenameMatchesThread(file: string, threadId: string): boolean {
  const name = basename(file);
  return name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`);
}

function sessionMeta(payload: Record<string, unknown>, expectedThreadId: string): Omit<CodexRolloutDiscoveredFile, "sourceFile" | "sourceFileId" | "identity"> | null {
  const parentThreadId = typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : null;
  const threadSource = typeof payload.thread_source === "string" ? payload.thread_source : null;
  const id = typeof payload.id === "string" ? payload.id : null;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  if (id !== expectedThreadId || (sessionId !== null && sessionId !== expectedThreadId) ||
      parentThreadId !== null || threadSource !== "user") {
    return null;
  }
  return {
    sessionId,
    parentThreadId,
    threadSource,
    originator: typeof payload.originator === "string" ? payload.originator : null,
    provider: typeof payload.model_provider === "string" ? payload.model_provider : null,
    cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : null,
  };
}

async function readSessionMeta(file: string, expectedThreadId: string): Promise<CodexRolloutDiscoveredFile | null> {
  let pathStats;
  try {
    pathStats = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) return null;
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    if (!sameFileIdentity(fileIdentity(pathStats), fileIdentity(stats))) return null;
    const buffer = Buffer.alloc(Math.min(stats.size, 256 * 1024));
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, result.bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.type !== "session_meta" || !record.payload ||
          typeof record.payload !== "object" || Array.isArray(record.payload)) {
        continue;
      }
      const validated = sessionMeta(record.payload as Record<string, unknown>, expectedThreadId);
      if (!validated) return null;
      return {
        sourceFile: file,
        sourceFileId: fileId(file),
        identity: fileIdentity(stats),
        ...validated,
      };
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function findFilenameCandidates(root: string, threadId: string): Promise<string[]> {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return [];
  const candidates: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && filenameMatchesThread(path, threadId)) {
        candidates.push(path);
      }
    }
  }
  return candidates.sort();
}

export async function readCodexRolloutTokenSnapshot(input: {
  codexHome: string;
  rolloutFile: string;
  expectedThreadId: string;
}): Promise<CodexRolloutReadResult> {
  const codexHome = resolve(input.codexHome);
  const rolloutFile = resolve(input.rolloutFile);
  const expectedThreadId = input.expectedThreadId;
  if (!expectedThreadId) throw new Error("expected_thread_id_required");
  if (!ROLLOUT_SUBDIRECTORIES.some(subdirectory => isWithin(resolve(codexHome, subdirectory), rolloutFile))) {
    throw new Error("rollout_file_outside_codex_home_sessions");
  }

  const before = await lstat(rolloutFile);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("rollout_file_not_regular_file");
  const handle = await open(rolloutFile, "r");
  let endsWithNewline = true;
  try {
    if (before.size > 0) {
      const lastByte = Buffer.alloc(1);
      const result = await handle.read(lastByte, 0, 1, before.size - 1);
      endsWithNewline = result.bytesRead === 1 && lastByte[0] === 10;
    }
  } finally {
    await handle.close();
  }

  let sessionMeta: Record<string, unknown> | null = null;
  const models = new Set<string>();
  let lineCount = 0;
  let invalidJsonLineCount = 0;
  let tokenCountEventCount = 0;
  let emptyUsageEventCount = 0;
  let compactionMarkerCount = 0;
  let trailingPartialLineIgnored = false;
  let latest: CodexRolloutTokenSnapshot | null = null;
  let pendingLine: string | null = null;

  const processLine = (line: string): void => {
    lineCount += 1;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      invalidJsonLineCount += 1;
      return;
    }
    const payload = record.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : {};
    const type = record.type;
    if (type === "session_meta" && sessionMeta === null) sessionMeta = payload;
    if (type === "turn_context" && typeof payload.model === "string") models.add(payload.model);
    if (type === "compacted") compactionMarkerCount += 1;
    if (type !== "event_msg" || payload.type !== "token_count") return;

    tokenCountEventCount += 1;
    const info = payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
      ? payload.info as Record<string, unknown>
      : null;
    if (!info) {
      emptyUsageEventCount += 1;
      return;
    }
    const total = usage(info.total_token_usage);
    const last = usage(info.last_token_usage);
    const observedAt = typeof record.timestamp === "string" ? record.timestamp : null;
    if (!total || total.totalTokens === null) {
      emptyUsageEventCount += 1;
      return;
    }
    latest = {
      threadId: expectedThreadId,
      turnId: null,
      total,
      last,
      modelContextWindow: numeric(info.model_context_window),
      observedAt,
      eventOrder: tokenCountEventCount,
      lineNumber: lineCount,
      source: "codex_rollout_token_count",
      absoluteSnapshot: true,
    };
  };

  for await (const line of createInterface({ input: createReadStream(rolloutFile, { encoding: "utf8" }), crlfDelay: Infinity })) {
    if (pendingLine !== null) processLine(pendingLine);
    pendingLine = line;
  }
  if (pendingLine !== null) {
    if (endsWithNewline) processLine(pendingLine);
    else trailingPartialLineIgnored = true;
  }

  const after = await lstat(rolloutFile);
  const meta: Record<string, unknown> = sessionMeta ?? {};
  const metadataIdMatches = meta.id === expectedThreadId;
  const sessionId = typeof meta.session_id === "string" ? meta.session_id : null;
  const sessionIdMatches = sessionId === null || sessionId === expectedThreadId;
  const parentThreadId = typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null;
  const threadSource = typeof meta.thread_source === "string" ? meta.thread_source : null;
  const filenameThreadMatch = basename(rolloutFile).includes(expectedThreadId);
  const changedDuringRead = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
  const identityVerified = metadataIdMatches && sessionIdMatches && parentThreadId === null &&
    threadSource === "user" && filenameThreadMatch && !changedDuringRead;

  return {
    state: !identityVerified ? "thread_identity_unverified" : latest ? "ok" : "no_token_usage",
    threadId: expectedThreadId,
    sessionId,
    parentThreadId,
    threadSource,
    originator: typeof meta.originator === "string" ? meta.originator : null,
    provider: typeof meta.model_provider === "string" ? meta.model_provider : null,
    cliVersion: typeof meta.cli_version === "string" ? meta.cli_version : null,
    historyMode: typeof meta.history_mode === "string" ? meta.history_mode : null,
    modelNames: [...models].sort(),
    sourceFile: rolloutFile,
    sourceFileId: fileId(rolloutFile),
    sourceFileBytes: after.size,
    sourceFileModifiedAt: after.mtime.toISOString(),
    lineCount,
    invalidJsonLineCount,
    trailingPartialLineIgnored,
    changedDuringRead,
    tokenCountEventCount,
    emptyUsageEventCount,
    compactionMarkerCount,
    latest: identityVerified ? latest : null,
  };
}

export async function discoverCodexRolloutByThreadId(input: {
  codexHome: string;
  expectedThreadId: string;
}): Promise<CodexRolloutDiscoveryResult> {
  validateThreadId(input.expectedThreadId);
  const codexHome = resolve(input.codexHome);
  const filenameCandidates: string[] = [];
  for (const subdirectory of ROLLOUT_SUBDIRECTORIES) {
    filenameCandidates.push(...await findFilenameCandidates(resolve(codexHome, subdirectory), input.expectedThreadId));
  }

  const validated: CodexRolloutDiscoveredFile[] = [];
  for (const candidate of filenameCandidates) {
    const metadata = await readSessionMeta(candidate, input.expectedThreadId);
    if (metadata && filenameMatchesThread(candidate, input.expectedThreadId)) validated.push(metadata);
  }

  const state = validated.length === 1
    ? "found"
    : validated.length > 1
      ? "ambiguous"
      : filenameCandidates.length > 0
        ? "identity_unverified"
        : "not_found";
  const found = state === "found" ? validated[0] : null;
  return {
    state,
    threadId: input.expectedThreadId,
    codexHome,
    filenameCandidateCount: filenameCandidates.length,
    validatedFileCount: validated.length,
    sourceFile: found?.sourceFile ?? null,
    sourceFileId: found?.sourceFileId ?? null,
    identity: found?.identity ?? null,
    sessionId: found?.sessionId ?? null,
    parentThreadId: found?.parentThreadId ?? null,
    threadSource: found?.threadSource ?? null,
    originator: found?.originator ?? null,
    provider: found?.provider ?? null,
    cliVersion: found?.cliVersion ?? null,
  };
}

function snapshotFingerprint(snapshot: CodexRolloutTokenSnapshot): string {
  return JSON.stringify({
    total: snapshot.total,
    last: snapshot.last,
    modelContextWindow: snapshot.modelContextWindow,
  });
}

interface ParsedTailLine {
  tokenCount: boolean;
  emptyUsage: boolean;
  compaction: boolean;
  snapshot: CodexRolloutTokenSnapshot | null;
}

function parseTailLine(
  line: string,
  threadId: string,
  eventOrder: number,
  lineNumber: number,
): ParsedTailLine | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.type === "compacted") {
    return { tokenCount: false, emptyUsage: false, compaction: true, snapshot: null };
  }
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null;
  if (record.type !== "event_msg" || payload?.type !== "token_count") {
    return { tokenCount: false, emptyUsage: false, compaction: false, snapshot: null };
  }
  const info = payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
    ? payload.info as Record<string, unknown>
    : null;
  if (!info) {
    return { tokenCount: true, emptyUsage: true, compaction: false, snapshot: null };
  }
  const total = usage(info.total_token_usage);
  if (!total || total.totalTokens === null) {
    return { tokenCount: true, emptyUsage: true, compaction: false, snapshot: null };
  }
  return {
    tokenCount: true,
    emptyUsage: false,
    compaction: false,
    snapshot: {
      threadId,
      turnId: null,
      total,
      last: usage(info.last_token_usage),
      modelContextWindow: numeric(info.model_context_window),
      observedAt: typeof record.timestamp === "string" ? record.timestamp : null,
      eventOrder,
      lineNumber,
      source: "codex_rollout_token_count",
      absoluteSnapshot: true,
    },
  };
}

export class CodexRolloutTailReader {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private offset = 0;
  private lineCount = 0;
  private tokenCountEventCount = 0;
  private lastFingerprint: string | null = null;
  private lastValidSnapshot: CodexRolloutTokenSnapshot | null = null;
  private fileIdentity: CodexRolloutFileIdentity;
  private tailBoundaryFingerprint: string | null = null;
  private initialized = false;
  private compactionPending = false;
  private readonly sourceFileId: string;

  private constructor(
    private readonly codexHome: string,
    private readonly rolloutFile: string,
    private readonly expectedThreadId: string,
    identity: CodexRolloutFileIdentity,
    private readonly chunkSize = 64 * 1024,
  ) {
    this.fileIdentity = identity;
    this.sourceFileId = fileId(rolloutFile);
  }

  static async open(input: {
    codexHome: string;
    rolloutFile: string;
    expectedThreadId: string;
    chunkSize?: number;
  }): Promise<CodexRolloutTailReader> {
    validateThreadId(input.expectedThreadId);
    const codexHome = resolve(input.codexHome);
    const rolloutFile = resolve(input.rolloutFile);
    if (!ROLLOUT_SUBDIRECTORIES.some(subdirectory => isWithin(resolve(codexHome, subdirectory), rolloutFile))) {
      throw new Error("rollout_file_outside_codex_home_sessions");
    }
    if (!filenameMatchesThread(rolloutFile, input.expectedThreadId)) {
      throw new Error("thread_identity_unverified");
    }
    const metadata = await readSessionMeta(rolloutFile, input.expectedThreadId);
    if (!metadata) throw new Error("thread_identity_unverified");
    if (input.chunkSize !== undefined && (!Number.isSafeInteger(input.chunkSize) || input.chunkSize <= 0)) {
      throw new Error("invalid_chunk_size");
    }
    return new CodexRolloutTailReader(
      codexHome,
      rolloutFile,
      input.expectedThreadId,
      metadata.identity,
      input.chunkSize,
    );
  }

  state(): CodexRolloutTailState {
    return {
      threadId: this.expectedThreadId,
      sourceFile: this.rolloutFile,
      sourceFileId: this.sourceFileId,
      fileIdentity: this.fileIdentity,
      offset: this.offset,
      pendingBytes: this.pending.length,
      lastValidSnapshot: this.lastValidSnapshot,
    };
  }

  private reset(identity: CodexRolloutFileIdentity): void {
    this.pending = Buffer.alloc(0);
    this.offset = 0;
    this.lineCount = 0;
    this.tokenCountEventCount = 0;
    this.lastFingerprint = null;
    this.lastValidSnapshot = null;
    this.tailBoundaryFingerprint = null;
    this.compactionPending = false;
    this.fileIdentity = identity;
  }

  private processCompleteLines(): {
    updated: CodexRolloutTokenSnapshot | null;
    newTokenCountEventCount: number;
    duplicateSnapshotCount: number;
    emptyUsageEventCount: number;
    invalidJsonLineCount: number;
    compactionMarkerCount: number;
    observedAfterCompaction: boolean;
  } {
    let updated: CodexRolloutTokenSnapshot | null = null;
    let newTokenCountEventCount = 0;
    let duplicateSnapshotCount = 0;
    let emptyUsageEventCount = 0;
    let invalidJsonLineCount = 0;
    let compactionMarkerCount = 0;
    let observedAfterCompaction = false;
    let newline = this.pending.indexOf(10);
    while (newline >= 0) {
      const lineBytes = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      const line = lineBytes.toString("utf8");
      this.lineCount += 1;
      const parsed = parseTailLine(line, this.expectedThreadId, this.tokenCountEventCount + 1, this.lineCount);
      if (!parsed) {
        invalidJsonLineCount += 1;
      } else {
        if (parsed.compaction) {
          compactionMarkerCount += 1;
          this.compactionPending = true;
        }
        if (parsed.tokenCount) {
          this.tokenCountEventCount += 1;
          newTokenCountEventCount += 1;
        }
        if (parsed.emptyUsage) emptyUsageEventCount += 1;
        if (parsed.snapshot) {
          const fingerprint = snapshotFingerprint(parsed.snapshot);
          if (fingerprint === this.lastFingerprint) {
            duplicateSnapshotCount += 1;
          } else {
            this.lastFingerprint = fingerprint;
            this.lastValidSnapshot = parsed.snapshot;
            updated = parsed.snapshot;
            observedAfterCompaction = this.compactionPending;
            this.compactionPending = false;
          }
        }
      }
      newline = this.pending.indexOf(10);
    }
    return {
      updated,
      newTokenCountEventCount,
      duplicateSnapshotCount,
      emptyUsageEventCount,
      invalidJsonLineCount,
      compactionMarkerCount,
      observedAfterCompaction,
    };
  }

  async poll(): Promise<CodexRolloutTailPollResult> {
    let pathBefore;
    try {
      pathBefore = await lstat(this.rolloutFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return this.result("file_changed", null, null, 0, {
        newTokenCountEventCount: 0,
        duplicateSnapshotCount: 0,
        emptyUsageEventCount: 0,
        invalidJsonLineCount: 0,
        compactionMarkerCount: 0,
        observedAfterCompaction: false,
      });
    }
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
      return this.result("identity_unverified", null, null, 0, {
        newTokenCountEventCount: 0,
        duplicateSnapshotCount: 0,
        emptyUsageEventCount: 0,
        invalidJsonLineCount: 0,
        compactionMarkerCount: 0,
        observedAfterCompaction: false,
      });
    }
    const identityBefore = fileIdentity(pathBefore);
    let resetReason: CodexRolloutTailPollResult["resetReason"] = !this.initialized
      ? "initial"
      : !sameFileIdentity(this.fileIdentity, identityBefore)
        ? "replaced"
        : pathBefore.size < this.offset
          ? "truncated"
          : null;

    if (!resetReason && this.offset > 0) {
      const currentBoundary = await boundaryFingerprint(this.rolloutFile, this.offset);
      if (currentBoundary !== null && currentBoundary !== this.tailBoundaryFingerprint) {
        resetReason = "truncated";
      }
    }

    if (resetReason) {
      const metadata = await readSessionMeta(this.rolloutFile, this.expectedThreadId);
      if (!metadata || !sameFileIdentity(metadata.identity, identityBefore)) {
        this.reset(identityBefore);
        this.initialized = false;
        return this.result("identity_unverified", resetReason, null, 0, {
          newTokenCountEventCount: 0,
          duplicateSnapshotCount: 0,
          emptyUsageEventCount: 0,
          invalidJsonLineCount: 0,
          compactionMarkerCount: 0,
          observedAfterCompaction: false,
        });
      }
      this.reset(identityBefore);
    }

    let handle;
    try {
      handle = await open(this.rolloutFile, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      return this.result("file_changed", resetReason, null, 0, {
        newTokenCountEventCount: 0,
        duplicateSnapshotCount: 0,
        emptyUsageEventCount: 0,
        invalidJsonLineCount: 0,
        compactionMarkerCount: 0,
        observedAfterCompaction: false,
      });
    }
    let bytesRead = 0;
    let bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let fileChangedDuringRead = false;
    let nextBoundaryFingerprint: string | null = null;
    try {
      const openBefore = await handle.stat();
      if (!sameFileIdentity(fileIdentity(openBefore), identityBefore)) {
        fileChangedDuringRead = true;
      } else {
        const target = openBefore.size;
        const chunks: Buffer[] = [];
        let position = this.offset;
        while (position < target && !fileChangedDuringRead) {
          const length = Math.min(this.chunkSize, target - position);
          const chunk = Buffer.allocUnsafe(length);
          const read = await handle.read(chunk, 0, length, position);
          if (read.bytesRead === 0) break;
          chunks.push(chunk.subarray(0, read.bytesRead));
          position += read.bytesRead;
          bytesRead += read.bytesRead;
        }
        bytes = Buffer.concat(chunks, bytesRead);
        const openAfter = await handle.stat();
        let pathAfter;
        try {
          pathAfter = await lstat(this.rolloutFile);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          fileChangedDuringRead = true;
        }
        if (pathAfter && (
          !sameFileIdentity(fileIdentity(openAfter), identityBefore) ||
          !sameFileIdentity(fileIdentity(pathAfter), identityBefore) ||
          !pathAfter.isFile() || pathAfter.isSymbolicLink() ||
          openAfter.size < target || pathAfter.size < target
        )) {
          fileChangedDuringRead = true;
        }
        if (!fileChangedDuringRead && this.offset > 0) {
          const oldBoundaryAfterRead = await boundaryFingerprint(this.rolloutFile, this.offset);
          if (oldBoundaryAfterRead !== this.tailBoundaryFingerprint) {
            fileChangedDuringRead = true;
          }
        }
        if (!fileChangedDuringRead) {
          const nextOffset = this.offset + bytesRead;
          nextBoundaryFingerprint = await boundaryFingerprint(this.rolloutFile, nextOffset);
          if (nextOffset > 0 && nextBoundaryFingerprint === null) {
            fileChangedDuringRead = true;
          }
        }
      }
    } finally {
      await handle.close();
    }

    if (fileChangedDuringRead) {
      return this.result("file_changed", resetReason, null, 0, {
        newTokenCountEventCount: 0,
        duplicateSnapshotCount: 0,
        emptyUsageEventCount: 0,
        invalidJsonLineCount: 0,
        compactionMarkerCount: 0,
        observedAfterCompaction: false,
      });
    }

    this.offset += bytesRead;
    this.tailBoundaryFingerprint = nextBoundaryFingerprint;
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    const processed = this.processCompleteLines();
    this.initialized = true;
    const status = processed.updated
      ? "updated"
      : processed.compactionMarkerCount > 0
        ? "compaction_observed"
        : processed.duplicateSnapshotCount > 0
          ? "unchanged"
          : this.pending.length > 0
            ? "partial_line"
            : this.tokenCountEventCount === 0
              ? "no_token_usage"
              : "unchanged";
    return this.result(status, resetReason, processed.updated, bytesRead, processed);
  }

  private result(
    status: CodexRolloutTailPollResult["status"],
    resetReason: CodexRolloutTailPollResult["resetReason"],
    snapshot: CodexRolloutTokenSnapshot | null,
    bytesRead: number,
    processed: Pick<CodexRolloutTailPollResult,
      "newTokenCountEventCount" | "duplicateSnapshotCount" | "emptyUsageEventCount" |
      "invalidJsonLineCount" | "compactionMarkerCount" | "observedAfterCompaction">,
  ): CodexRolloutTailPollResult {
    return {
      status,
      resetReason,
      snapshot,
      state: this.state(),
      bytesRead,
      ...processed,
    };
  }
}
