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
  readonly executorState?: () => "active" | "shutdown_pending" | "closed";
  readonly onServerError?: (error: unknown) => void;
  readonly onClientError?: (error: unknown) => void;
  readonly onClientClose?: () => void;
}

export interface ExecutorControlServerHandle {
  readonly pipeName: string;
  readonly connections: number;
  close(): Promise<void>;
}

function response(
  request: ExecutorControlRequest,
  ok: boolean,
  executorState: () => "active" | "shutdown_pending" | "closed",
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

export function startExecutorControlServer(options: ExecutorControlServerOptions): Promise<ExecutorControlServerHandle> {
  let state: "active" | "shutdown_pending" | "closed" = "active";
  let closing = false;
  const live = { service: "active" as "active" | "shutdown_pending" | "closed", connections: 0 };
  const optionsExecutorState = () => options.executorState?.() ?? live.service;
  const server = net.createServer((socket) => {
    live.connections += 1;
    let openRequests = 0;
    const maybeReadyToClose = (): void => {
      if (closing && openRequests === 0) socket.end();
    };
    socket.setEncoding("utf8");
    const decoder = createExecutorFrameDecoder();
    decoder.setEncoding("utf8");
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
      void dispatch(options.manager, request)
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
      live.connections = Math.max(0, live.connections - 1);
      options.onClientClose?.();
    });
  });
  server.unref();
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      options.onServerError?.(error);
      reject(error);
    };
    server.once("error", fail);
    server.listen(options.pipeName, () => {
      server.off("error", fail);
      resolve({
        pipeName: options.pipeName,
        get connections() { return live.connections; },
        async close() {
          if (live.service === "closed") return;
          live.service = "shutdown_pending";
          closing = true;
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
