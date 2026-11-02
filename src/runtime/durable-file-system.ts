import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, renameSync } from "node:fs";
import path from "node:path";

export interface DurableFileOperations {
  /** Atomically replace an existing destination without crossing directories. */
  replaceFileSync(source: string, destination: string): void;
  /** Atomically move a file to a destination that must not already exist. */
  moveFileSync(source: string, destination: string): void;
  /** Make an existing directory entry durable. */
  flushDirectorySync(directory: string): void;
}

const WINDOWS_OPERATION_TIMEOUT_MS = 10_000;

// The script is fixed. Paths and the operation selector cross the process
// boundary through dedicated environment variables, never through command
// interpolation. A successful result means MoveFileExW completed with
// MOVEFILE_WRITE_THROUGH and the destination directory was flushed.
const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodexBridgeDurableFileSystem {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FlushFileBuffers(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileExW(string source, string destination, uint flags);

  public static int Move(string source, string destination, bool replace) {
    uint flags = 0x00000008u;
    if (replace) flags |= 0x00000001u;
    if (!MoveFileExW(source, destination, flags)) return 20 + Marshal.GetLastWin32Error();
    return Flush(System.IO.Path.GetDirectoryName(destination));
  }

  public static int Flush(string directory) {
    const uint GENERIC_WRITE = 0x40000000u;
    const uint FILE_SHARE_READ_WRITE_DELETE = 0x00000001u | 0x00000002u | 0x00000004u;
    const uint OPEN_EXISTING = 3u;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000u;
    IntPtr handle = CreateFileW(
      directory,
      GENERIC_WRITE,
      FILE_SHARE_READ_WRITE_DELETE,
      IntPtr.Zero,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      IntPtr.Zero);
    if (handle == new IntPtr(-1)) return 2000 + Marshal.GetLastWin32Error();
    try {
      if (!FlushFileBuffers(handle)) return 3000 + Marshal.GetLastWin32Error();
      return 0;
    } finally {
      CloseHandle(handle);
    }
  }
}
'@

$operation = [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_DURABLE_OPERATION')
$source = [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_DURABLE_SOURCE')
$destination = [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_DURABLE_DESTINATION')
$replace = [Environment]::GetEnvironmentVariable('CODEX_BRIDGE_DURABLE_REPLACE') -eq '1'

if ($operation -eq 'flush') {
  if ([string]::IsNullOrWhiteSpace($source)) { exit 10 }
  exit ([CodexBridgeDurableFileSystem]::Flush($source))
}

if ($operation -eq 'move') {
  if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($destination)) { exit 11 }
  exit ([CodexBridgeDurableFileSystem]::Move($source, $destination, $replace))
}

exit 12
`;

const WINDOWS_HELPER_COMMAND = Buffer.from(WINDOWS_HELPER_SCRIPT, "utf16le").toString("base64");

function canonicalParent(filePath: string): string {
  return path.dirname(path.resolve(filePath));
}

function assertSameDirectory(source: string, destination: string): void {
  const left = canonicalParent(source);
  const right = canonicalParent(destination);
  const same = process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
  if (!same) throw new Error("durable file operation requires one directory");
  if (path.resolve(source) === path.resolve(destination)) {
    throw new Error("durable file operation requires distinct files");
  }
}

function flushDirectoryPosix(directory: string): void {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function runWindowsHelper(
  operation: "move" | "flush",
  source: string,
  destination: string | null,
  replace: boolean,
): void {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      WINDOWS_HELPER_COMMAND,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BRIDGE_DURABLE_OPERATION: operation,
        CODEX_BRIDGE_DURABLE_SOURCE: source,
        CODEX_BRIDGE_DURABLE_DESTINATION: destination ?? "",
        CODEX_BRIDGE_DURABLE_REPLACE: replace ? "1" : "0",
      },
      maxBuffer: 64 * 1024,
      timeout: WINDOWS_OPERATION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    const status = result.status ?? null;
    const win32 = status === null
      ? null
      : status >= 3_000
        ? status - 3_000
        : status >= 2_000
          ? status - 2_000
          : status >= 20
            ? status - 20
            : null;
    const code = win32 === 5
      ? "EPERM"
      : win32 === 32 || win32 === 33
        ? "EBUSY"
        : win32 === 183
          ? "EEXIST"
          : win32 === null
            ? (result.error?.name ?? result.signal ?? `status_${String(status)}`)
            : `EWINDOWS_${win32}`;
    const error = new Error(`windows_durable_file_operation_failed:${code}`) as NodeJS.ErrnoException;
    error.code = code;
    throw error;
  }
}

function moveFileSync(source: string, destination: string, replace: boolean): void {
  assertSameDirectory(source, destination);
  if (process.platform === "win32") {
    runWindowsHelper("move", path.resolve(source), path.resolve(destination), replace);
    return;
  }
  renameSync(source, destination);
  flushDirectoryPosix(canonicalParent(destination));
}

export const defaultDurableFileOperations: DurableFileOperations = Object.freeze({
  replaceFileSync(source: string, destination: string): void {
    moveFileSync(source, destination, existsSync(destination));
  },
  moveFileSync(source: string, destination: string): void {
    moveFileSync(source, destination, false);
  },
  flushDirectorySync(directory: string): void {
    const resolved = path.resolve(directory);
    if (process.platform === "win32") {
      runWindowsHelper("flush", resolved, null, false);
      return;
    }
    flushDirectoryPosix(resolved);
  },
});
