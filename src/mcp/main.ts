#!/usr/bin/env node
// Codex stdio entry point. Host-neutral startup lives in host/stdio.ts.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../host/stdio.js";
export { resolveDataRoot, resolveMaxConcurrentWorkers } from "../host/stdio.js";

// Run the server only when this file is the process entry point (importing
// the module — e.g. from tests — must not start listening on stdin).
// Compared through realpath: symlink or junction installs report the
// physical path in import.meta.url while argv[1] keeps the link path, and
// a textual comparison would make a real launch silently do nothing.
const isEntry = process.argv[1] !== undefined && sameRealPath(import.meta.url, process.argv[1]);

function sameRealPath(moduleUrl: string, argvPath: string): boolean {
  try {
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    const entryPath = realpathSync(path.resolve(argvPath));
    return process.platform === "win32"
      ? modulePath.toLocaleLowerCase("en-US") === entryPath.toLocaleLowerCase("en-US")
      : modulePath === entryPath;
  } catch {
    return false;
  }
}
if (isEntry) {
  void startBridge().catch((error: unknown) => {
    console.error(`[bridge] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
