import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  PROFILER_REPORT_KIND,
  PROFILER_SNAPSHOT_KIND,
} from "./constants.mjs";
import {
  assertProfilerReport,
  assertProfilerSnapshot,
} from "./schema.mjs";
import { sha256 } from "./util.mjs";

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function prospectiveRealPath(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const real = realpathSync.native(current);
  return path.resolve(real, ...suffix);
}

function resolveWriteTarget(targetPath, options) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new Error("profiler_output_path_empty");
  }
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const target = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(baseDir, targetPath);
  const roots = (options.allowedRoots ?? [baseDir]).map((root) => path.resolve(root));
  const targetComparable = comparablePath(prospectiveRealPath(target));
  const allowed = roots.some((root) => (
    isWithin(comparablePath(prospectiveRealPath(root)), targetComparable)
  ));
  if (!allowed) throw new Error("profiler_output_outside_allowed_root");
  return target;
}

function writeAtomicJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  return {
    path: target,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256(text),
  };
}

export function writeProfilerSnapshot(snapshot, targetPath, options = {}) {
  assertProfilerSnapshot(snapshot);
  const target = resolveWriteTarget(targetPath, options);
  return writeAtomicJson(target, snapshot);
}

export function readProfilerSnapshot(targetPath) {
  const value = JSON.parse(readFileSync(targetPath, "utf8"));
  if (value?.kind !== PROFILER_SNAPSHOT_KIND) throw new Error("profiler_snapshot_kind_invalid");
  return assertProfilerSnapshot(value);
}

export function writeProfilerReport(report, targetPath, options = {}) {
  assertProfilerReport(report);
  const target = resolveWriteTarget(targetPath, options);
  return writeAtomicJson(target, report);
}

export function readProfilerReport(targetPath) {
  const value = JSON.parse(readFileSync(targetPath, "utf8"));
  if (value?.kind !== PROFILER_REPORT_KIND) throw new Error("profiler_report_kind_invalid");
  return assertProfilerReport(value);
}

export function profilerFileIdentity(targetPath) {
  const info = statSync(targetPath);
  return {
    path: path.resolve(targetPath),
    bytes: info.size,
    modified_at: new Date(info.mtimeMs).toISOString(),
  };
}
