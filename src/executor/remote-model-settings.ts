import type {
  DefaultModelSelection,
  ZCodeModelCatalog,
} from "../runtime/model-settings.js";
import type { ExecutorControlClient } from "./control-client.js";
import type {
  ExecutorControlMethod,
  ExecutorControlParamsByMethod,
} from "./protocol.js";

export class RemoteModelSettings {
  readonly #client: ExecutorControlClient;

  constructor(client: ExecutorControlClient) {
    this.#client = client;
  }

  async #call<M extends ExecutorControlMethod>(
    method: M,
    params: ExecutorControlParamsByMethod[M],
  ): Promise<Record<string, unknown>> {
    await this.#client.connect();
    const response = await this.#client.request(method, params);
    if (!response.ok) {
      const error = new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED") as Error & { code?: string };
      error.code = response.error?.code ?? "EXECUTOR_REQUEST_FAILED";
      throw error;
    }
    return response.result ?? {};
  }

  async listModels(workspace: string): Promise<ZCodeModelCatalog> {
    return this.#call("listModels", { workspace }) as unknown as ZCodeModelCatalog;
  }

  async getDefaultModel(): Promise<{ configured: boolean; model: DefaultModelSelection | null }> {
    return this.#call("getDefaultModel", {}) as unknown as { configured: boolean; model: DefaultModelSelection | null };
  }

  async setDefaultModel(selection: DefaultModelSelection): Promise<{ configured: true; model: DefaultModelSelection }> {
    return this.#call("setDefaultModel", selection) as unknown as {
      configured: true;
      model: DefaultModelSelection;
    };
  }

  async clearDefaultModel(): Promise<{ configured: false; model: null }> {
    return this.#call("clearDefaultModel", {}) as unknown as { configured: false; model: null };
  }
}
