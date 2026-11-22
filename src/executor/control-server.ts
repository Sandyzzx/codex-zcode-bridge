import net from "node:net";
import type { ProgressTaskManager } from "../interfaces.js";
import type { DoctorReport } from "../runtime/doctor.js";
import type { ZCodeModelSettings } from "../runtime/model-settings.js";
import { createExecutorFrameDecoder, encodeExecutorFrame } from "./frame.js";
import {
  EXECUTOR_CONTROL_PROTOCOL_VERSION,
  parseExecutorControlParams,
  type ExecutorControlRequest,
  type ExecutorControlResponse,
} from "./protocol.js";

export interface ExecutorControlServerOptions {
  readonly pipeName: string;
  readonly manager: ProgressTaskManager;
  readonly modelSettings?: Pick<ZCodeModelSettings, "listModels" | "getDefaultModel" | "setDefaultModel" | "clearDefaultModel">;
  readonly doctor?: () => Promise<DoctorReport>;
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
  /** Wait for already accepted mutating requests without closing the pipe. */
  drainMutations(): Promise<void>;
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

async function dispatch(options: ExecutorControlServerOptions, request: ExecutorControlRequest): Promise<Record<string, unknown>> {
  const manager = options.manager;
  switch (request.method) {
    // The shared TaskPackage schema allows a routable model without provider_id;
    // Manager routing resolves that public input before persistence.
    case "createTask": return await manager.createTask(request.params.task as Parameters<ProgressTaskManager["createTask"]>[0]) as unknown as Record<string, unknown>;
    case "getStatus": return await manager.getStatus(request.params.task_id) as unknown as Record<string, unknown>;
    case "getResult": return await manager.getResult(request.params.task_id) as unknown as Record<string, unknown>;
    case "continueTask": return await manager.continueTask(request.params.input) as unknown as Record<string, unknown>;
    case "cancelTask": return await manager.cancelTask(request.params.task_id) as unknown as Record<string, unknown>;
    case "getEvents": return await manager.getEvents(request.params.input) as unknown as Record<string, unknown>;
    case "getFeedback": {
      if (!manager.getFeedback) throw new Error("FEEDBACK_UNAVAILABLE");
      return await manager.getFeedback(request.params.task_id) as unknown as Record<string, unknown>;
    }
    case "getAttention": {
      if (!manager.getAttention) throw new Error("ATTENTION_UNAVAILABLE");
      return await manager.getAttention(request.params.task_id) as unknown as Record<string, unknown>;
    }
    case "replyToInteraction": return await manager.replyToInteraction(request.params.input) as unknown as Record<string, unknown>;
    case "listModels":
      if (!options.modelSettings) throw Object.assign(new Error("MODEL_SETTINGS_UNAVAILABLE"), { code: "MODEL_SETTINGS_UNAVAILABLE" });
      return await options.modelSettings.listModels(request.params.workspace) as unknown as Record<string, unknown>;
    case "getDefaultModel":
      if (!options.modelSettings) throw Object.assign(new Error("MODEL_SETTINGS_UNAVAILABLE"), { code: "MODEL_SETTINGS_UNAVAILABLE" });
      return await options.modelSettings.getDefaultModel() as unknown as Record<string, unknown>;
    case "setDefaultModel":
      if (!options.modelSettings) throw Object.assign(new Error("MODEL_SETTINGS_UNAVAILABLE"), { code: "MODEL_SETTINGS_UNAVAILABLE" });
      return await options.modelSettings.setDefaultModel(request.params) as unknown as Record<string, unknown>;
    case "clearDefaultModel":
      if (!options.modelSettings) throw Object.assign(new Error("MODEL_SETTINGS_UNAVAILABLE"), { code: "MODEL_SETTINGS_UNAVAILABLE" });
      return await options.modelSettings.clearDefaultModel() as unknown as Record<string, unknown>;
    case "doctor":
      if (!options.doctor) throw Object.assign(new Error("DOCTOR_UNAVAILABLE"), { code: "DOCTOR_UNAVAILABLE" });
      return await options.doctor() as unknown as Record<string, unknown>;
    case "health": return { state: "active" };
  }
}

const MUTATING_METHODS = new Set<ExecutorControlRequest["method"]>([
  "createTask",
  "continueTask",
  "cancelTask",
  "replyToInteraction",
  "setDefaultModel",
  "clearDefaultModel",
]);
const CONTROL_METHODS = new Set<ExecutorControlRequest["method"]>([
  ...MUTATING_METHODS,
  "getStatus",
  "getResult",
  "getEvents",
  "getFeedback",
  "getAttention",
  "listModels",
  "getDefaultModel",
  "setDefaultModel",
  "clearDefaultModel",
  "doctor",
  "health",
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
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let mutationsInFlight = 0;
  const mutationWaiters = new Set<() => void>();
  const live = { service: "active" as "active" | "shutdown_pending" | "lease_unknown" | "closed", connections: 0 };
  const sockets = new Set<net.Socket>();
  const optionsExecutorState = () => options.executorState?.() ?? live.service;
  const mutationFinished = (): void => {
    mutationsInFlight = Math.max(0, mutationsInFlight - 1);
    if (mutationsInFlight !== 0) return;
    for (const resolve of mutationWaiters) resolve();
    mutationWaiters.clear();
  };
  const drainMutations = (): Promise<void> => {
    if (mutationsInFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => mutationWaiters.add(resolve));
  };
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
        const raw = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
        if (raw.protocol_version !== EXECUTOR_CONTROL_PROTOCOL_VERSION
          || typeof raw.request_id !== "string" || !raw.request_id
          || typeof raw.method !== "string"
          || !CONTROL_METHODS.has(raw.method as ExecutorControlRequest["method"])) {
          throw new Error("EXECUTOR_CONTROL_REQUEST_INVALID");
        }
        const method = raw.method as ExecutorControlRequest["method"];
        request = {
          ...raw,
          method,
          params: parseExecutorControlParams(method, raw.params),
        } as ExecutorControlRequest;
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined);
        return;
      }
      openRequests += 1;
      const currentState = optionsExecutorState();
      const fenced = MUTATING_METHODS.has(request.method) ? fenceError(currentState) : null;
      const mutating = MUTATING_METHODS.has(request.method);
      if (mutating) mutationsInFlight += 1;
      const operation = fenced
        ? Promise.reject(Object.assign(new Error(fenced.message), { code: fenced.code }))
        : request.method === "health"
          ? Promise.resolve({ state: currentState })
          : dispatch(options, request);
      void operation
        .then((result) => writeResponse(response(request, true, optionsExecutorState, options.leaseId, result)))
        .catch((error: unknown) => writeResponse(response(request, false, optionsExecutorState, options.leaseId, undefined, {
          code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EXECUTOR_REQUEST_FAILED",
          message: error instanceof Error ? error.message : String(error),
        })))
        .finally(() => {
          openRequests -= 1;
          if (mutating) mutationFinished();
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
      try {
        server.close(() => undefined);
      } catch {
        // A listener that never started has no closeable handle.
      }
      reject(error);
    };
    server.once("error", fail);
    server.listen(options.pipeName, () => {
      if (options.unrefServer !== true) server.ref();
      server.off("error", fail);
      resolve({
        pipeName: options.pipeName,
        get connections() { return live.connections; },
        drainMutations,
        async close() {
          if (closePromise) return closePromise;
          if (live.service === "closed") return;
          closePromise = (async () => {
            live.service = "shutdown_pending";
            closing = true;
            const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
            await drainMutations();
            for (const socket of sockets) socket.end();
            await closed;
            live.service = "closed";
          })();
          return closePromise;
        },
      });
    });
  });
}
