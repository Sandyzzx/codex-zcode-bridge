import { authorityRootDigest } from "./lease.js";

export function executorPipeName(root: string): string {
  return `\\\\.\\pipe\\codex-zcode-bridge-executor-v1-${authorityRootDigest(root)}`;
}
