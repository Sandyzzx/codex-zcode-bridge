/** MCP-facing doctor contract. Runtime implementation types stay behind IPC. */
export interface McpDoctorReport {
  readonly checked_at: string;
  readonly execution_mode: string;
  readonly checks: ReadonlyArray<{
    readonly name: string;
    readonly status: "ok" | "warning" | "error" | "unknown";
    readonly summary: string;
  }>;
}

export interface McpModelSelection {
  readonly provider_id: string;
  readonly model_id: string;
  readonly reasoning_level?: string;
}

export interface McpModelCatalog {
  readonly workspace: string;
  readonly current_model: { readonly provider_id: string; readonly model_id: string } | null;
  readonly models: ReadonlyArray<{
    readonly provider_id: string;
    readonly model_id: string;
    readonly label: string;
    readonly provider_label?: string;
    readonly context_window?: number;
    readonly max_output_tokens?: number;
    readonly reasoning_levels?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
    readonly reasoning_default_level?: string;
    readonly disabled_reason?: string;
  }>;
  readonly account_provider_sync: "not_needed" | "applied" | "failed";
  readonly cache_status?: "fresh" | "refreshed";
  readonly cached_at?: string;
  readonly warning?: string;
}

export interface McpModelSettings {
  listModels(workspace: string): Promise<McpModelCatalog>;
  getDefaultModel(): Promise<{ configured: boolean; model: McpModelSelection | null }>;
  setDefaultModel(selection: McpModelSelection): Promise<{ configured: true; model: McpModelSelection }>;
  clearDefaultModel(): Promise<{ configured: false; model: null }>;
}
