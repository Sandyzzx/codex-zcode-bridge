import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import type { SqliteLifecycleMcpAuthority } from "../../src/manager/sqlite-lifecycle-mcp-authority.js";
import type { createBridgeServer } from "../../src/mcp/server.js";

export interface StdioLifecycleHost {
  shutdown(reason: string): Promise<boolean>;
}

/** Test-only legacy Host harness; production MCP never owns a Manager. */
export function serveStdioLifecycleHost(
  server: ReturnType<typeof createBridgeServer>,
  manager: Pick<SqliteLifecycleMcpAuthority, "shutdown">,
  options: {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly onShutdownFailure?: (reason: string, error: unknown) => void;
    readonly onShutdownComplete?: (reason: string) => void;
  } = {},
): StdioLifecycleHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let handle: StdioServerHandle;
  let closed = false;
  let disconnected = false;
  let current: Promise<boolean> | null = null;
  let shutdown!: (reason: string) => Promise<boolean>;
  const onDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    void shutdown("EOF");
  };
  stdin.once("end", onDisconnect);
  stdin.once("close", onDisconnect);
  shutdown = (reason: string): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    if (current) return current;
    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        await manager.shutdown();
        if (!disconnected) await handle.close();
        closed = true;
        options.onShutdownComplete?.(reason);
        return true;
      } catch (error) {
        options.onShutdownFailure?.(reason, error);
        return false;
      } finally {
        if (current === attempt) current = null;
      }
    })();
    current = attempt;
    return attempt;
  };
  handle = serveStdio(() => server, { transport });
  if (stdin.readableEnded || stdin.destroyed) queueMicrotask(onDisconnect);
  return { shutdown };
}
