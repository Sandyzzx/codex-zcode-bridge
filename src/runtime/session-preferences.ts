import type { TaskPackage, ZCodeModelSelection } from "../interfaces.js";
import { BridgeError } from "./errors.js";

export const ZCODE_SESSION_MODES = ["plan", "build", "edit", "yolo"] as const;
export type ZCodeSessionMode = (typeof ZCODE_SESSION_MODES)[number];

export interface ResolvedSessionPreferences {
  readonly mode: ZCodeSessionMode;
  readonly model: ZCodeModelSelection | null;
  readonly modelSource: "task" | "user_default" | "zcode_default";
}

/** Task selection wins; otherwise apply the validated user default pair. */
export function resolveSessionPreferences(
  taskModel: TaskPackage["model"],
  env: NodeJS.ProcessEnv,
): ResolvedSessionPreferences {
  const providerId = env["ZCODE_BRIDGE_DEFAULT_PROVIDER_ID"]?.trim() ?? "";
  const modelId = env["ZCODE_BRIDGE_DEFAULT_MODEL_ID"]?.trim() ?? "";
  const reasoningLevel = env["ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL"]?.trim() ?? "";
  const configuredMode = env["ZCODE_BRIDGE_MODE"]?.trim() || "yolo";

  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_BRIDGE_DEFAULT_PROVIDER_ID and ZCODE_BRIDGE_DEFAULT_MODEL_ID must be set together",
    );
  }
  if (!isSessionMode(configuredMode)) {
    throw new BridgeError(
      "provider_config_invalid",
      `ZCODE_BRIDGE_MODE must be one of: ${ZCODE_SESSION_MODES.join(", ")}`,
    );
  }
  if (reasoningLevel && !taskModel && !providerId) {
    throw new BridgeError(
      "provider_config_invalid",
      "ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL requires a default model pair or a per-task model",
    );
  }

  const inheritedReasoningLevel = taskModel && providerId && modelId &&
    (providerId !== taskModel.provider_id.trim() || modelId !== taskModel.model_id.trim())
    ? ""
    : reasoningLevel;

  const model = taskModel
    ? {
        provider_id: taskModel.provider_id.trim(),
        model_id: taskModel.model_id.trim(),
        ...(taskModel.reasoning_level?.trim() || inheritedReasoningLevel
          ? { reasoning_level: taskModel.reasoning_level?.trim() || inheritedReasoningLevel }
          : {}),
      }
    : providerId && modelId
      ? {
          provider_id: providerId,
          model_id: modelId,
          ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}),
        }
      : null;

  if (model && (!model.provider_id || !model.model_id)) {
    throw new BridgeError("provider_config_invalid", "Configured provider and model IDs must not be blank");
  }

  return {
    mode: configuredMode as ZCodeSessionMode,
    model,
    modelSource: taskModel ? "task" : model ? "user_default" : "zcode_default",
  };
}

function isSessionMode(value: string): value is ZCodeSessionMode {
  return (ZCODE_SESSION_MODES as readonly string[]).includes(value);
}
