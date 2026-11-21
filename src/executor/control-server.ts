import net from "node:net";
import type { ProgressTaskManager } from "../interfaces.js";
import { createExecutorFrameDecoder, encodeExecutorFrame } from "./frame.js";
import {
  EXECUTOR_CONTROL_PROTOCOL_VERSION,
  type ExecutorControlRequest,
  type ExecutorControlResponse,
} from "./protocol.js";

export interface ExecutorControlServerOptions {
  readonly pipeName: string;
  readonly manager: ProgressTaskManager;
  readonly leaseId: string;
  readonly executorState?: () => "active" | "shutdown_pending" | "lease_unknown" | "closed";
  readonly onServerError?: (error: unknown) => void;
  readonly onClientError?: (error: unknown) => void;
  readonly onClientClose?: () => void;
  /** Test/embedding escape hatch for the standalone process-lifetime hold. */
  readonly unrefServer?: boolean;
}

export interface ExecutorControlServerHandle {
  readonly pipeName: string;
  readonly connections: number;
  close(): Promise<void>;
}

function response(
  request: ExecutorControlRequest,
  ok: boolean,
  executorState: () => "active" | "shutdown_pending" | "lease_unknown" | "closed",
  leaseId: string,
  value?: Record<string, unknown>,
  error?: { code: string; message: string },
): ExecutorControlResponse {
  return {
    protocol_version: EXECUTOR_CONTROL_PROTOCOL_VERSION,
    request_id: request.request_id,
    ok,
    ...(ok ? { result: value ?? {} } : { error }),
    executor_state: {
      state: executorState(),
      lease_id: leaseId,
    },
  };
}

async function dispatch(manager: ProgressTaskManager, request: ExecutorControlRequest): Promise<Record<string, unknown>> {
  switch (request.method) {
    case "createTask": return manager.createTask(request.params.task as Parameters<ProgressTaskManager["createTask"]>[0]) as unknown as Record<string, unknown>;
    case "getStatus": return manager.getStatus(String(request.params.task_id)) as unknown as Record<string, unknown>;
    case "getResult": return manager.getResult(String(request.params.task_id)) as unknown as Record<string, unknown>;
    case "continueTask": return manager.continueTask(request.params.input as Parameters<ProgressTaskManager["continueTask"]>[0]) as unknown as Record<string, unknown>;
    case "cancelTask": return manager.cancelTask(String(request.params.task_id)) as unknown as Record<string, unknown>;
    case "getEvents": return manager.getEvents(request.params.input as Parameters<ProgressTaskManager["getEvents"]>[0]) as unknown as Record<string, unknown>;
    case "getFeedback": {
      if (!manager.getFeedback) throw new Error("FEEDBACK_UNAVAILABLE");
      return manager.getFeedback(String(request.params.task_id)) as unknown as Record<string, unknown>;
    }
    case "getAttention": {
      if (!manager.getAttention) throw new Error("ATTENTION_UNAVAILABLE");
      return manager.getAttention(String(request.params.task_id)) as unknown as Record<string, unknown>;
    }
    case "replyToInteraction": return manager.replyToInteraction(request.params.input as Parameters<ProgressTaskManager["replyToInteraction"]>[0]) as unknown as Record<string, unknown>;
    case "health": return { state: "active" };
  }
}

const MUTATING_METHODS = new Set<ExecutorControlRequest["method"]>([
  "createTask",
  "continueTask",
  "cancelTask",
  "replyToInteraction",
]);

function fenceError(state: "active" | "shutdown_pending" | "lease_unknown" | "closed"):
  { readonly code: string; readonly message: string } | null {
  if (state === "shutdown_pending") {
    return { code: "EXECUTOR_SHUTDOWN_PENDING", message: "Executor is evaluating an idle-only shutdown request" };
  }
  if (state === "lease_unknown") {
    return { code: "EXECUTOR_LEASE_LOST", message: "Executor lease ownership is unknown; lifecycle mutations are fenced" };
  }
  if (state === "closed") {
    return { code: "EXECUTOR_UNAVAILABLE", message: "Executor control service is closed" };
  }
  return null;
}

export function startExecutorControlServer(options: ExecutorControlServerOptions): Promise<ExecutorControlServerHandle> {
  let state: "active" | "shutdown_pending" | "lease_unknown" | "closed" = "active";
  let closing = false;
  const live = { service: "active" as "active" | "shutdown_pending" | "lease_unknown" | "closed", connections: 0 };
  const sockets = new Set<net.Socket>();
  const optionsExecutorState = () => options.executorState?.() ?? live.service;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    live.connections += 1;
    let openRequests = 0;
    const maybeReadyToClose = (): void => {
      if (closing && openRequests === 0) socket.end();
    };
    const decoder = createExecutorFrameDecoder();
    socket.pipe(decoder);
    socket.resume();
    const writeResponse = (value: ExecutorControlResponse): void => {
      if (!socket.destroyed) socket.write(encodeExecutorFrame(value));
    };
    decoder.on("data", (chunk: Buffer) => {
      let request: ExecutorControlRequest;
      try {
        request = JSON.parse(chunk.toString("utf8")) as ExecutorControlRequest;
        if (request.protocol_version !== EXECUTOR_CONTROL_PROTOCOL_VERSION
          || typeof request.request_id !== "string" || !request.request_id
          || typeof request.method !== "string") {
          throw new Error("EXECUTOR_CONTROL_REQUEST_INVALID");
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
        return;
      }
      openRequests += 1;
      const currentState = optionsExecutorState();
      const fenced = MUTATING_METHODS.has(request.method) ? fenceError(currentState) : null;
      const operation = fenced
        ? Promise.reject(Object.assign(new Error(fenced.message), { code: fenced.code }))
        : request.method === "health"
          ? Promise.resolve({ state: currentState })
          : dispatch(options.manager, request);
      void operation
        .then((result) => writeResponse(response(request, true, optionsExecutorState, options.leaseId, result)))
        .catch((error: unknown) => writeResponse(response(request, false, optionsExecutorState, options.leaseId, undefined, {
          code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EXECUTOR_REQUEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
        })))
        .finally(() => {
          openRequests -= 1;
          maybeReadyToClose();
        });
    });
    decoder.on("error", (error) => {
      options.onClientError?.(error);
      socket.destroy(error);
    });
    socket.on("error", (error) => options.onClientError?.(error));
    socket.on("close", () => {
      sockets.delete(socket);
      live.connections = Math.max(0, live.connections - 1);
      options.onClientClose?.();
    });
  });
  // Standalone ownership needs this handle to keep the process alive; the
  // caller can explicitly unref an embedded server if that behavior is wanted.
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      options.onServerError?.(error);
      reject(error);
    };
    server.once("error", fail);
    server.listen(options.pipeName, () => {
      if (options.unrefServer !== true) server.ref();
      server.off("error", fail);
      resolve({
        pipeName: options.pipeName,
        get connections() { return live.connections; },
        async close() {
          if (live.service === "closed") return;
          live.service = "shutdown_pending";
          closing = true;
          for (const socket of sockets) socket.end();
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            if (live.connections === 0) resolveClose();
          });
          live.service = "closed";
        },
      });
    });
  });
}
