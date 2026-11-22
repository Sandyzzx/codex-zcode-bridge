import net from "node:net";
import { randomUUID } from "node:crypto";
import { createExecutorFrameDecoder, encodeExecutorFrame } from "./frame.js";
import {
  EXECUTOR_CONTROL_PROTOCOL_VERSION,
  type ExecutorControlMethod,
  type ExecutorControlParamsByMethod,
  type ExecutorControlRequest,
  type ExecutorControlResponse,
} from "./protocol.js";

export interface ExecutorControlClientOptions {
  readonly pipeName: string;
  readonly connectTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: ExecutorControlRequest["method"];
  readonly resolve: (response: ExecutorControlResponse) => void;
  readonly reject: (error: Error) => void;
}

function executorError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function submissionUnknownCode(method: ExecutorControlRequest["method"]): string {
  if (method === "createTask"
    || method === "continueTask"
    || method === "replyToInteraction"
    || method === "setDefaultModel"
    || method === "clearDefaultModel") {
    return "SUBMISSION_UNKNOWN";
  }
  if (method === "cancelTask") return "TASK_CANCEL_REQUESTED";
  return "EXECUTOR_UNAVAILABLE";
}

export class ExecutorControlClient {
  readonly #pipeName: string;
  readonly #connectTimeoutMs: number;
  #socket: net.Socket | null = null;
  #pending = new Map<string, PendingRequest>();

  constructor(options: ExecutorControlClientOptions) {
    this.#pipeName = options.pipeName;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  async connect(): Promise<void> {
    if (this.#socket && !this.#socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.#pipeName);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(executorError("EXECUTOR_UNAVAILABLE"));
      }, this.#connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.#socket = socket;
        const decoder = createExecutorFrameDecoder();
        socket.pipe(decoder);
        socket.resume();
        decoder.on("data", (chunk: Buffer) => {
          try {
            const response = JSON.parse(chunk.toString("utf8")) as ExecutorControlResponse;
            const pending = this.#pending.get(response.request_id);
            if (pending) {
              this.#pending.delete(response.request_id);
              pending.resolve(response);
            }
          } catch {
            this.#failPending("EXECUTOR_CONTROL_RESPONSE_MALFORMED");
            socket.destroy();
          }
        });
        decoder.on("error", (error) => {
          this.#failPending(undefined, socket);
          socket.destroy(error);
        });
        socket.on("error", (error) => {
          this.#failPending("EXECUTOR_UNAVAILABLE");
          reject(error);
        });
        socket.on("close", () => {
          if (this.#socket === socket) this.#socket = null;
          this.#failPending(undefined, socket);
        });
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(Object.assign(executorError("EXECUTOR_UNAVAILABLE"), { cause: error }));
      });
    });
  }

  request<M extends ExecutorControlMethod>(
    method: M,
    params: ExecutorControlParamsByMethod[M],
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<ExecutorControlResponse> {
    if (!this.#socket || this.#socket.destroyed) {
      return Promise.reject(executorError("EXECUTOR_UNAVAILABLE"));
    }
    const request = {
      protocol_version: EXECUTOR_CONTROL_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method,
      params,
      // The transport records the key for diagnostics, while durable submission
      // idempotency remains owned by task_id/operation_id in SQLite.
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    } as ExecutorControlRequest;
    const attempt = new Promise<ExecutorControlResponse>((resolve, reject) => {
      this.#pending.set(request.request_id, { method, resolve, reject });
      this.#socket!.write(encodeExecutorFrame(request), (error) => {
        if (error) {
          this.#pending.delete(request.request_id);
          reject(executorError(submissionUnknownCode(method)));
        }
      });
    });
    if (!signal) return attempt;
    signal.addEventListener("abort", () => {
      const pending = this.#pending.get(request.request_id);
      if (pending) {
        this.#pending.delete(request.request_id);
        pending.reject(executorError("REQUEST_CANCELLED"));
      }
    }, { once: true });
    return attempt;
  }

  #failPending(code: string | undefined, socket?: net.Socket): void {
    for (const [requestId, pending] of this.#pending) {
      if (socket && this.#socket !== null && this.#socket !== socket) continue;
      this.#pending.delete(requestId);
      pending.reject(executorError(code ?? submissionUnknownCode(pending.method)));
    }
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    // A pending submission may already have reached the Executor. Preserve
    // the method-specific unknown/cancel classification on an intentional
    // client close just as for a lost socket response.
    this.#failPending(undefined);
    socket?.destroy();
  }
}
