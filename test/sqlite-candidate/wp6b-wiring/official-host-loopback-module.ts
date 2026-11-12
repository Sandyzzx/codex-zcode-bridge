const SESSION_ID = "sess_worker_loopback_11111111-aaaa-4bbb-8ccc-cccccccccccc";
const TURN_ID = "turn_worker_loopback_1";
const REPORT = {
  summary: "Official Host loopback completed the Worker task",
  files_changed: [],
  tests: [],
  issues: [],
  needs_master_decision: false,
};

type Listener = (value: unknown) => void;
type Workspace = { readonly workspacePath: string; readonly workspaceIdentity: string };
type Model = { providerId: string; modelId: string };
type RuntimeIdentity = {
  readonly generation: number;
  readonly identity: string;
  readonly processId: number;
  readonly workspaceKey: string;
};

export class ZCodeProtocolClient {
  readonly isDisposed = false;
  readonly #notifications = new Set<Listener>();
  readonly #requests = new Set<Listener>();
  readonly #close = new Set<Listener>();
  #model: Model = { providerId: "provider-default", modelId: "model-default" };

  onNotification(listener: Listener): { dispose(): void } {
    this.#notifications.add(listener);
    return { dispose: () => { this.#notifications.delete(listener); } };
  }

  onRequest(listener: Listener): { dispose(): void } {
    this.#requests.add(listener);
    return { dispose: () => { this.#requests.delete(listener); } };
  }

  onClose(listener: Listener): { dispose(): void } {
    this.#close.add(listener);
    return { dispose: () => { this.#close.delete(listener); } };
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "session/create" || method === "session/resume") return this.#snapshot();
    if (method === "session/setModel") {
      this.#model = params.model as Model;
      return this.#snapshot();
    }
    if (method === "session/subscribe" || method === "session/setMode") return {};
    if (method === "session/events") return { events: [] };
    if (method === "provider/updateAccountConfig") return {};
    if (method === "session/send") {
      setTimeout(() => {
        this.#notify({
          method: "session/event",
          params: {
            sessionId: SESSION_ID,
            seq: 1,
            turnId: TURN_ID,
            type: "turn.started",
            payload: { turnId: TURN_ID },
          },
        });
        this.#notify({
          method: "session/event",
          params: {
            sessionId: SESSION_ID,
            seq: 2,
            turnId: TURN_ID,
            type: "turn.completed",
            payload: {
              response: JSON.stringify(REPORT),
              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
              resultType: "success",
            },
          },
        });
      }, 0);
      return {};
    }
    throw new Error(`unexpected loopback Host request: ${method}`);
  }

  async respond(): Promise<void> {}
  async respondError(): Promise<void> {}
  replayEvents(events: unknown[]): void {
    for (const event of events) this.#notify({ method: "session/event", params: event });
  }
  prewarmCleanup(): void {}
  emitClose(): void {
    for (const listener of this.#close) listener({ exitCode: 0 });
  }
  get stderr(): string {
    return "";
  }

  #notify(value: unknown): void {
    for (const listener of this.#notifications) listener(value);
  }

  #snapshot(): Record<string, unknown> {
    return {
      session: { sessionId: SESSION_ID },
      settings: {
        model: {
          current: this.#model,
          available: [{ ref: this.#model, label: "Worker loopback model" }],
        },
      },
      runtime: { eventSeq: 0 },
    };
  }
}

export class ZCodeAgentProcessManager {
  readonly #client = new ZCodeProtocolClient();
  #workspace: Workspace | null = null;
  #disposed = false;

  async getClient(workspace: Workspace): Promise<ZCodeProtocolClient> {
    this.#workspace = workspace;
    return this.#client;
  }

  async getRuntimeIdentity(workspace: Workspace): Promise<RuntimeIdentity> {
    this.#workspace = workspace;
    return {
      generation: 1,
      identity: `worker-loopback:${process.pid}`,
      processId: process.pid,
      workspaceKey: workspace.workspaceIdentity,
    };
  }

  listManagedProcesses(): Array<{
    readonly pid: number;
    readonly workspacePath: string;
    readonly workspaceIdentity: string;
  }> {
    return this.#disposed || !this.#workspace ? [] : [{
      pid: process.pid,
      workspacePath: this.#workspace.workspacePath,
      workspaceIdentity: this.#workspace.workspaceIdentity,
    }];
  }

  isSharedRuntime(): boolean {
    return false;
  }

  async disposeWorkspace(): Promise<void> {
    this.#disposed = true;
    this.#client.emitClose();
  }

  async disposeAllAndWait(): Promise<void> {
    this.#disposed = true;
  }
}
