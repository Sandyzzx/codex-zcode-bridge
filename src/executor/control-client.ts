import net from "node:net";
import { randomUUID } from "node:crypto";
import { createExecutorFrameDecoder, encodeExecutorFrame } from "./frame.js";
import { EXECUTOR_CONTROL_PROTOCOL_VERSION, type ExecutorControlRequest, type ExecutorControlResponse } from "./protocol.js";

export interface ExecutorControlClientOptions {
  readonly pipeName: string;
  readonly connectTimeoutMs?: number;
}

export class ExecutorControlClient {
  readonly #pipeName: string;
  readonly #connectTimeoutMs: number;
  #socket: net.Socket | null = null;
  #pending = new Map<string, { readonly resolve: (response: ExecutorControlResponse) => void; readonly reject: (error: Error) => void }>();

  constructor(options: ExecutorControlClientOptions) {
    this.#pipeName = options.pipeName;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.#pipeName);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("EXECUTOR_UNAVAILABLE"));
      }, this.#connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.#socket = socket;
        const decoder = createExecutorFrameDecoder();
        decoder.setEncoding("utf8");
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
          this.#failPending("EXECUTOR_UNAVAILABLE");
          socket.destroy(error);
        });
        socket.on("error", (error) => {
          this.#failPending("EXECUTOR_UNAVAILABLE");
          reject(error);
        });
        socket.on("close", () => this.#failPending("EXECUTOR_UNAVAILABLE"));
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(method: ExecutorControlRequest["method"], params: Record<string, unknown>, signal?: AbortSignal, idempotencyKey?: string): Promise<ExecutorControlResponse> {
    if (!this.#socket || this.#socket.destroyed) return Promise.reject(new Error("EXECUTOR_UNAVAILABLE"));
    const request: ExecutorControlRequest = {
      protocol_version: EXECUTOR_CONTROL_PROTOCOL_VERSION,
      request_id: randomUUID(),
      method,
      params,
      // The transport records the key for diagnostics, while durable submission
      // idempotency remains owned by task_id/operation_id in SQLite.
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    };
    const attempt = new Promise<ExecutorControlResponse>((resolve, reject) => {
      this.#pending.set(request.request_id, { resolve, reject });
      this.#socket!.write(encodeExecutorFrame(request), (error) => {
        if (error) {
          this.#pending.delete(request.request_id);
          reject(new Error("SUBMISSION_UNKNOWN"));
        }
      });
    });
    if (!signal) return attempt;
    signal.addEventListener("abort", () => {
      const pending = this.#pending.get(request.request_id);
      if (pending) {
        this.#pending.delete(request.request_id);
        pending.reject(new Error("REQUEST_CANCELLED"));
      }
    }, { once: true });
    return attempt;
  }

  #failPending(code: string): void {
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending.reject(new Error(code));
    }
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
    this.#failPending("EXECUTOR_UNAVAILABLE");
  }
}
