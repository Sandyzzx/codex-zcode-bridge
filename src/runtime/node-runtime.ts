/** SQLite Authority runtime range. This is separate from the product engines gate. */
export const SUPPORTED_NODE_RANGE = ">=24.16.0 <25";

/** Accepts stable Node 24 releases from 24.16.0 onward, and no Node 25+. */
export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 24 && minor >= 16 && patch >= 0;
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(`Unsupported Node.js runtime ${version}; SQLite Authority requires Node ${SUPPORTED_NODE_RANGE}.`);
  }
}
