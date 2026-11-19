export function createStartPlanStatus(key, parameters = null, {
  suffix = null,
  freshness = null,
  preserve = false,
} = {}) {
  return {
    key,
    parameters,
    suffix,
    freshness,
    preserve,
  };
}

export function resolveStartPlanStatus(status, {
  translate,
  formatTime,
  translateReason,
}) {
  if (!status) return null;
  const parameters = materializeParameters(status.parameters, formatTime);
  return {
    stateText: [translate(status.key, parameters), status.suffix]
      .filter(Boolean)
      .join(" "),
    freshness: status.freshness
      ? {
          text: status.freshness.key
            ? translate(status.freshness.key)
            : status.freshness.text ?? "UNKNOWN",
          className: status.freshness.className ?? "tag",
          title: translateReason(status.freshness.reason) ?? "",
        }
      : null,
  };
}

function materializeParameters(parameters, formatTime) {
  if (!parameters || typeof parameters !== "object") return parameters;
  return Object.hasOwn(parameters, "at")
    ? { ...parameters, at: formatTime(parameters.at) }
    : parameters;
}
