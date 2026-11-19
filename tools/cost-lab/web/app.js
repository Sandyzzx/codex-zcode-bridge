import {
  buildStartPlanView,
  compareStartPlanViews,
  startPlanFreshness,
} from "./startplan-view.mjs";

const app = {
  csrfToken: null,
  session: null,
  environment: null,
  startPlan: null,
  activeVerificationId: null,
  pollTimer: null,
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  bindNavigation();
  bindActions();
  void bootstrap();
});

async function bootstrap() {
  try {
    const session = await getJson("/api/session");
    app.session = session;
    app.csrfToken = session.csrf_token;
    $("#server-dot").classList.add("online");
    $("#server-status").textContent = "Local server online";
    await Promise.all([loadEnvironment(), loadHistory()]);
    const initialPage = window.location.hash.slice(1);
    if (initialPage) showPage(initialPage);
    if (session.active_verification_id) {
      app.activeVerificationId = session.active_verification_id;
      showPage("verification");
      await pollVerification();
    }
  } catch (error) {
    $("#server-status").textContent = "Local server unavailable";
    showToast(error.message, true);
  }
}

function bindNavigation() {
  for (const item of $$(".nav-item")) {
    item.addEventListener("click", () => showPage(item.dataset.page));
  }
}

function bindActions() {
  $("#run-env-check").addEventListener("click", () => void runEnvironmentCheck(false));
  $("#run-deep-check").addEventListener("click", () => void runEnvironmentCheck(true));
  $("#capture-billing").addEventListener("click", () => void captureBilling());
  $("#refresh-startplan").addEventListener("click", () => void refreshStartPlan());
  $("#view-startplan-history").addEventListener("click", () => {
    $("#startplan-history-count").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#compare-startplan").addEventListener("click", () => void toggleStartPlanComparison());
  $("#verification-consent").addEventListener("change", (event) => {
    $("#start-verification").disabled = !event.currentTarget.checked;
  });
  $("#verification-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void startVerification();
  });
}

function showPage(name) {
  const valid = $$(".page").some((page) => page.id === `page-${name}`);
  if (!valid) return;
  for (const page of $$(".page")) page.classList.toggle("active", page.id === `page-${name}`);
  for (const item of $$(".nav-item")) item.classList.toggle("active", item.dataset.page === name);
  history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "history") void loadHistory();
  if (name === "billing") void loadStartPlanData();
}

async function loadEnvironment(deep = false) {
  const environment = deep
    ? await postJson("/api/environment/check", { deep: true })
    : await getJson("/api/environment");
  app.environment = environment;
  renderEnvironment(environment);
  return environment;
}

function renderEnvironment(environment) {
  const zcode = environment.zcode ?? {};
  const runtimePassed = zcode.runtime_status === "OFFICIAL_RUNTIME_VERIFIED";
  const discountPassed = zcode.discount_status === "OFFICIAL_DISCOUNT_VERIFIED";
  $("#dash-runtime").textContent = runtimePassed ? "VERIFIED" : "UNVERIFIED";
  $("#dash-discount").textContent = discountPassed ? "0.67 VERIFIED" : "NOT VERIFIED";
  $("#dash-billing").textContent = environment.billing_reader?.status ?? "UNKNOWN";
  $("#runtime-version").textContent = zcode.version ?? "UNVERIFIED";
  $("#runtime-version").className = `tag ${runtimePassed ? "pass" : "fail"}`;
  const bundle = zcode.assets?.bundle;
  replaceChildren($("#runtime-facts"), [
    fact("Bundle", bundle?.status ?? "UNKNOWN", bundle?.sha256 ?? "unavailable"),
    fact("SHA-256", bundle?.sha256 ? shortHash(bundle.sha256) : "unavailable", "manifest pinned"),
    fact("Node", environment.host?.node_version ?? "unknown", environment.host?.node_compatible ? "compatible" : "incompatible"),
    fact("Request security", zcode.request_security_capability ?? "unknown", zcode.appserver_protocol ?? ""),
  ]);
  renderChecks(environment);
}

function renderChecks(environment) {
  const zcode = environment.zcode ?? {};
  const checks = [
    {
      name: "Runtime Discovery",
      status: zcode.installed ? "PASS" : "FAIL",
      detail: zcode.installed
        ? `Found installed runtime from ${zcode.install_source ?? "configured source"}.`
        : "Installed ZCode AppServer was not discovered.",
    },
    {
      name: "Bundle Hash Verification",
      status: zcode.assets?.bundle?.status ?? "UNKNOWN",
      detail: zcode.assets?.bundle?.sha256
        ? `SHA-256 ${zcode.assets.bundle.sha256}`
        : "No matching installed bundle hash.",
    },
    {
      name: "Node Compatibility",
      status: environment.host?.node_compatible ? "PASS" : "FAIL",
      detail: `Detected Node ${environment.host?.node_version ?? "unknown"}; verified range is 24.16.x.`,
    },
    {
      name: "Billing Reader",
      status: environment.billing_reader?.status ?? "UNKNOWN",
      detail: environment.billing_reader?.accessor ?? "Official billing accessor unavailable.",
    },
    {
      name: "Credential Readability",
      status: environment.credential_readability?.status ?? "UNKNOWN",
      detail: "Only file metadata was inspected. Credential contents were not read or returned.",
    },
    {
      name: "Resource Isolation",
      status: environment.resource_isolation?.status ?? "UNKNOWN",
      detail: `${environment.resource_isolation?.server_binding ?? "unknown binding"}; model requests on page load: ${environment.resource_isolation?.model_requests_on_page_load ?? "unknown"}.`,
    },
    {
      name: "AppServer Protocol Smoke",
      status: environment.appserver_protocol_smoke?.status ?? "NOT_RUN",
      detail: environment.appserver_protocol_smoke?.reason ?? "Deep check not requested; this did not send a model request.",
    },
    {
      name: "Runtime Compatibility",
      status: zcode.runtime_status ?? "UNKNOWN",
      detail: zcode.discount_status === "OFFICIAL_DISCOUNT_VERIFIED"
        ? "Installed bundle matches the manifest with verified Coding Plan discount evidence."
        : "The installed bundle must not be represented as discount-compatible.",
    },
  ];
  replaceChildren($("#environment-checks"), checks.map((check) => {
    const article = element("article", "check-card");
    const header = element("header");
    header.append(element("h3", "", check.name), statusTag(check.status));
    article.append(header, element("p", "", check.detail));
    return article;
  }));
}

async function runEnvironmentCheck(deep) {
  const button = deep ? $("#run-deep-check") : $("#run-env-check");
  button.disabled = true;
  $("#env-check-state").textContent = deep ? "Running zero-model protocol check..." : "Inspecting local runtime...";
  try {
    const environment = deep ? await postJson("/api/environment/check", { deep: true }) : await loadEnvironment();
    renderEnvironment(environment);
    $("#env-check-state").textContent = "Environment check completed. No model request was sent.";
    showToast("Environment check completed");
  } catch (error) {
    $("#env-check-state").textContent = "Environment check failed.";
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function startVerification() {
  const button = $("#start-verification");
  button.disabled = true;
  try {
    const started = await postJson("/api/verifications", {
      confirmation: app.session?.confirmation_phrase,
      provider: app.session?.provider,
      model: app.session?.model,
      reasoning: "low",
    });
    app.activeVerificationId = started.id;
    renderVerificationProgress({ status: started.status });
    showToast("Real verification authorized");
    await pollVerification();
  } catch (error) {
    button.disabled = !$("#verification-consent").checked;
    showToast(error.message, true);
  }
}

async function pollVerification() {
  clearTimeout(app.pollTimer);
  if (!app.activeVerificationId) return;
  try {
    const record = await getJson(`/api/verifications/${app.activeVerificationId}`);
    renderVerificationProgress(record);
    if (["QUEUED", "RUNNING", "MODEL_REQUESTED", "AWAITING_SETTLEMENT"].includes(record.status)) {
      app.pollTimer = setTimeout(() => void pollVerification(), 2_000);
      return;
    }
    renderVerificationResult(record);
    await loadHistory();
    if (record.status !== "SUCCEEDED") showToast(record.error?.message ?? "Verification did not complete.", true);
    else if (record.reconciliation?.billing_reconciliation === "PASS") showToast("Verification and billing reconciliation completed");
    else showToast("Verification completed. Official billing is inconclusive.");
  } catch (error) {
    showToast(error.message, true);
    app.pollTimer = setTimeout(() => void pollVerification(), 4_000);
  }
}

function renderVerificationProgress(record) {
  const status = record.status ?? "QUEUED";
  const statusElement = $("#verification-status");
  statusElement.textContent = status;
  statusElement.className = `tag ${status === "SUCCEEDED" ? "pass" : ["FAILED", "INTERRUPTED"].includes(status) ? "fail" : ""}`;
  const stage = {
    QUEUED: 0,
    RUNNING: 0,
    MODEL_REQUESTED: 1,
    AWAITING_SETTLEMENT: 3,
    SUCCEEDED: 5,
    FAILED: -1,
    INTERRUPTED: -1,
  }[status] ?? 0;
  for (const [index, item] of $$("#verification-progress li").entries()) {
    item.className = stage === 5 || index < stage ? "done" : index === stage ? "active" : stage === -1 && index === 0 ? "failed" : "";
  }
}

function renderVerificationResult(record) {
  const container = $("#verification-result");
  const reconciliation = record.reconciliation;
  if (!reconciliation) {
    container.replaceChildren();
    return;
  }
  const calculation = reconciliation.calculation ?? {};
  const settlementStatus = reconciliation.settlement_status ?? "UNKNOWN";
  const actualCredits = reconciliation.calculation?.actual_credits;
  const noObservedCreditDelta = settlementStatus === "NO_OBSERVED_CREDIT_DELTA";
  const creditDisplay = {
    NO_OBSERVED_CREDIT_DELTA: "NOT OBSERVED",
    CREDITS_PENDING: "PENDING",
    UNATTRIBUTED_DELTA: "UNATTRIBUTED",
  }[settlementStatus] ?? "unknown";
  const panel = element("article", "panel");
  const title = element("div", "panel-title");
  title.append(
    element("span", "", "Reconciliation"),
    statusTag(reconciliation.billing_reconciliation ?? "INCONCLUSIVE"),
  );
  const metrics = element("div", "metric-grid");
  metrics.append(
    metric(
      "Actual credits",
      Number.isFinite(actualCredits) ? formatNumber(actualCredits) : creditDisplay,
    ),
    metric("Expected normal", formatNumber(calculation.expected_normal)),
    metric("Expected with 0.67", formatNumber(calculation.expected_with_0_67)),
    metric(
      "Effective extra ratio",
      formatExtraRatio({
        billing_reconciliation: reconciliation.billing_reconciliation,
        effective_extra_ratio: calculation.effective_extra_ratio,
      }, 8),
    ),
    metric("Cached input", formatInteger(reconciliation.request_usage?.cached_input_tokens)),
    metric("Uncached input", formatInteger(reconciliation.request_usage?.uncached_input_tokens)),
    metric("Output", formatInteger(reconciliation.request_usage?.output_tokens)),
    metric(
      "Token match",
      reconciliation.token_match ? "PASS" :
        settlementStatus === "UNATTRIBUTED_DELTA" ? "MISMATCH" : "INCONCLUSIVE",
    ),
  );
  panel.append(title, metrics);
  const details = element("dl", "fact-grid");
  details.append(
    fact("Time multiplier", formatNumber(calculation.time_multiplier), "off-peak 0.5 is separate from campaign 0.67"),
    fact(
      "Settlement",
      settlementStatus,
      noObservedCreditDelta
        ? "The official ledger has yet to show this charge."
        : reconciliation.limitation ?? record.status,
    ),
    fact("Observed model attempts", String(record.model_requests ?? "Unknown"), `${record.request_usage?.total_tokens ?? "unknown"} reported tokens`),
    fact("Billing window", record.billing_window?.time_zone ?? "Asia/Shanghai", "official hourly ledger"),
  );
  panel.append(details);
  container.replaceChildren(panel);
}

async function captureBilling() {
  const button = $("#capture-billing");
  button.disabled = true;
  $("#billing-state").textContent = "Reading official snapshot...";
  try {
    const snapshot = await postJson("/api/billing/snapshot", {});
    renderBillingSnapshot(snapshot);
    $("#billing-state").textContent = `Snapshot captured ${new Date(snapshot.captured_at).toLocaleString()}.`;
    showToast("Official billing snapshot captured");
  } catch (error) {
    $("#billing-state").textContent = "Snapshot failed.";
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderBillingSnapshot(snapshot) {
  const model = snapshot.models?.find((row) => row.model === "GLM-5.3-Flash");
  const hours = (model?.hours ?? []).filter((hour) =>
    hour.total_tokens !== 0 || hour.total_credits !== 0,
  );
  const panel = element("article", "panel");
  const title = element("div", "panel-title");
  title.append(element("span", "", "Official Coding Plan hourly ledger"), statusTag(snapshot.integrity?.status ?? "PARTIAL"));
  panel.append(title);
  if (hours.length === 0) {
    panel.append(element("p", "", model
      ? "No GLM-5.3-Flash activity was observed in the current range."
      : "The current snapshot has no GLM-5.3-Flash ledger row."));
  } else {
    const rows = element("div", "history-list");
    for (const hour of hours) {
      const row = element("div", "history-row");
      row.append(
        compactValue("Hour", hour.bucket),
        compactValue("Tokens", formatInteger(hour.total_tokens)),
        compactValue("Credits", formatNumber(hour.total_credits, 6)),
        compactValue("Cached", formatInteger(hour.cached_input_tokens)),
        compactValue("Output", formatInteger(hour.output_tokens)),
      );
      rows.append(row);
    }
    panel.append(rows);
  }
  $("#billing-result").replaceWith(panel);
  panel.id = "billing-result";
}

async function loadHistory() {
  const history = await getJson("/api/history");
  const latest = history.items?.[0];
  if (latest) {
    $("#dash-ratio").textContent = formatExtraRatio(latest, 6);
  }
  renderLatestExperiment(latest);
  renderHistory(history.items ?? []);
}

function renderLatestExperiment(latest) {
  const target = $("#latest-experiment");
  if (!latest) {
    target.className = "empty-state";
    target.textContent = "No experiment history yet.";
    return;
  }
  target.className = "";
  const row = element("div", "history-row");
  row.append(
    compactValue("Model", latest.model),
    compactValue("Status", latest.status),
    compactValue("Extra ratio", formatExtraRatio(latest, 8)),
    compactValue("Started", formatDateTime(latest.started_at)),
    exportLink(latest.id),
  );
  target.replaceChildren(row);
}

function renderHistory(items) {
  const list = $("#history-list");
  if (!items.length) {
    list.replaceChildren(element("div", "empty-state", "No redacted experiments have been recorded."));
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const row = element("div", "history-row");
    row.append(
      compactValue("Model", item.model),
      compactValue("Status", item.status),
      compactValue("Credits", item.credit_class ?? "UNKNOWN"),
      compactValue("Ratio", formatExtraRatio(item, 8)),
      exportLink(item.id),
    );
    return row;
  }));
}

async function loadStartPlanData() {
  try {
    const [latest, history] = await Promise.all([
      getJson("/api/billing/startplan/latest"),
      getJson("/api/billing/startplan/history?limit=25"),
    ]);
    app.startPlan = { ...latest, history: history.items ?? [] };
    renderStartPlan(app.startPlan);
  } catch (error) {
    app.startPlan = null;
    renderStartPlanError(error.message);
  }
}

async function refreshStartPlan() {
  const button = $("#refresh-startplan");
  button.disabled = true;
  $("#startplan-freshness").textContent = "LOADING";
  $("#startplan-freshness").className = "tag";
  $("#startplan-state").textContent = "Reading official billing/balance...";
  try {
    const refreshed = await postJson("/api/billing/startplan/refresh", {});
    await loadStartPlanData();
    const snapshot = refreshed.snapshot?.snapshot ?? refreshed.snapshot;
    $("#startplan-state").textContent = refreshed.deduplicated
      ? "Official snapshot already stored; no duplicate history entry."
      : `Official snapshot captured ${formatDateTime(snapshot?.captured_at)}.`;
    showToast("Start Plan official balance refreshed");
  } catch (error) {
    $("#startplan-freshness").textContent = "ERROR";
    $("#startplan-freshness").className = "tag fail";
    $("#startplan-state").textContent = `Refresh failed: ${error.message}`;
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderStartPlan(data) {
  const view = buildStartPlanView(data, Date.now());
  const freshness = view.freshness.status;
  const freshnessNode = $("#startplan-freshness");
  freshnessNode.textContent = freshness;
  freshnessNode.className = `tag ${freshness === "FRESH"
    ? "pass"
    : freshness === "EXPIRED"
      ? "fresh-expired"
      : freshness === "STALE"
        ? "fresh-stale"
        : ""}`.trim();

  if (!view.available) {
    $("#startplan-plan").textContent = "No snapshot";
    $("#startplan-plan-status").textContent = "UNKNOWN";
    $("#startplan-total").textContent = "—";
    $("#startplan-remaining").textContent = "—";
    $("#startplan-updated").textContent = "Never captured";
    $("#startplan-progress-fill").style.width = "0%";
    $("#startplan-progress-value").textContent = "UNKNOWN";
    $("#startplan-progress-detail").textContent = "Refresh explicitly to read the official Start Plan balance.";
    replaceChildren($("#startplan-facts"), [
      fact("Entitlement", "UNKNOWN"),
      fact("Unit", "UNKNOWN"),
      fact("Billing period", "UNKNOWN"),
      fact("Expiry", "UNKNOWN"),
    ]);
    $("#startplan-buckets").replaceChildren(
      element("div", "empty-state", "No Start Plan snapshot yet."),
    );
    renderStartPlanHistory([]);
    setStartPlanExport(null);
    return;
  }

  const summary = view.summary;
  $("#startplan-plan").textContent = summary.plan_type ?? summary.plan_id ?? "UNKNOWN";
  $("#startplan-plan-status").textContent = summary.plan_status ?? "UNKNOWN";
  $("#startplan-total").textContent = displayInteger(summary.total_balance);
  $("#startplan-remaining").textContent = displayInteger(summary.remaining_balance);
  $("#startplan-updated").textContent = `Captured ${formatDateTime(summary.captured_at)}`;
  $("#startplan-progress-fill").style.width =
    view.progress.percent === null ? "0%" : `${view.progress.percent.toFixed(1)}%`;
  $("#startplan-progress-value").textContent =
    view.progress.percent === null ? "UNKNOWN" : `${view.progress.percent.toFixed(1)}% used`;
  $("#startplan-progress-detail").textContent =
    `${displayInteger(summary.used_balance)} used / ${displayInteger(summary.total_balance)} ${summary.unit_type ?? "unit unknown"}`;
  replaceChildren($("#startplan-facts"), [
    fact("Entitlement", summary.entitlement_status ?? "UNKNOWN"),
    fact("Unit", summary.unit_type ?? "UNKNOWN"),
    fact(
      "Billing period",
      summary.billing_period
        ? `${formatDateTime(summary.billing_period.start)} - ${formatDateTime(summary.billing_period.end)}`
        : "UNKNOWN",
    ),
    fact("Expiry", summary.expiry ? formatDateTime(summary.expiry) : "UNKNOWN"),
  ]);
  renderStartPlanBuckets(view.buckets);
  renderStartPlanHistory(view.history);
  setStartPlanExport(data.snapshot?.id ?? null);
  $("#startplan-state").textContent =
    `Latest data: ${freshness}. Page views use the local snapshot only.`;
  $("#startplan-compare").hidden = true;
}

function renderStartPlanBuckets(buckets) {
  const target = $("#startplan-buckets");
  if (!buckets.length) {
    target.replaceChildren(element("div", "empty-state", "The official response contained no balance buckets."));
    return;
  }
  target.replaceChildren(...buckets.map((bucket) => {
    const card = element("article", "bucket-card");
    const header = element("header");
    const name = element("div");
    name.append(
      element("h4", "", bucket.label ?? "Bucket"),
      element("span", "mono", bucket.key ?? "bucket id unavailable"),
    );
    header.append(name, statusTag(bucket.model_ids.includes("glm-5.3-flash") ? "GLM-5.3-FLASH" : bucket.unit_type ?? "UNKNOWN"));
    const metrics = element("div", "bucket-metrics");
    metrics.append(
      compactValue("Total", displayInteger(bucket.total_units)),
      compactValue("Used", displayInteger(bucket.used_units)),
      compactValue("Remaining", displayInteger(bucket.remaining_units)),
    );
    const dates = element("dl", "fact-grid");
    dates.append(
      fact("Period start", formatDateTime(bucket.period_start)),
      fact("Period end", formatDateTime(bucket.period_end)),
      fact("Expiry", formatDateTime(bucket.expires_at)),
      fact("Entitlement", bucket.entitlement_key ?? "UNKNOWN"),
    );
    card.append(header, metrics, dates);
    return card;
  }));
}

function renderStartPlanHistory(items) {
  $("#startplan-history-count").textContent = `${items.length} snapshot${items.length === 1 ? "" : "s"}`;
  const target = $("#startplan-history");
  if (!items.length) {
    target.replaceChildren(element("div", "empty-state", "No Start Plan snapshots have been stored."));
    return;
  }
  target.replaceChildren(...[...items].reverse().map((item) => {
    const snapshot = item.snapshot ?? item;
    const freshness = startPlanFreshness(snapshot, Date.now()).status;
    const row = element("div", "history-row startplan-history-row");
    row.append(
      compactValue("Captured", formatDateTime(item.captured_at)),
      compactValue("Plan", item.plan_type ?? item.plan_id ?? "UNKNOWN"),
      compactValue("Used", displayInteger(item.used_balance)),
      compactValue("Remaining", displayInteger(item.remaining_balance)),
      compactValue("Freshness", freshness),
      startPlanExportLink(item.id),
    );
    return row;
  }));
}

function toggleStartPlanComparison() {
  const panel = $("#startplan-compare");
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  const items = app.startPlan?.history ?? [];
  if (items.length < 2) {
    panel.hidden = false;
    panel.replaceChildren(element("p", "", "At least two snapshots are required for comparison."));
    return;
  }
  const current = items.at(-1).snapshot ?? items.at(-1);
  const previous = items.at(-2).snapshot ?? items.at(-2);
  const comparison = compareStartPlanViews(previous, current);
  const heading = element("h3", "", `Snapshot comparison: ${comparison.status}`);
  panel.replaceChildren(heading);
  if (comparison.rows.length) {
    panel.append(...comparison.rows.map((row) => {
      const line = element("div", "comparison-row");
      line.append(
        element("strong", "", row.label),
        compactValue("Status", row.status),
        compactValue("Used delta", signedInteger(row.used_delta)),
        compactValue("Remaining delta", signedInteger(row.remaining_delta)),
      );
      return line;
    }));
  } else {
    panel.append(element("p", "", comparison.reason ?? "Snapshots cannot be compared."));
  }
  panel.hidden = false;
}

function renderStartPlanError(message) {
  $("#startplan-freshness").textContent = "ERROR";
  $("#startplan-freshness").className = "tag fail";
  $("#startplan-state").textContent = `Unable to load local Start Plan state: ${message}`;
}

function setStartPlanExport(id) {
  const link = $("#export-startplan");
  if (!id) {
    link.removeAttribute("href");
    link.classList.add("disabled-link");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = `/api/billing/startplan/history/${encodeURIComponent(id)}/export`;
  link.setAttribute("download", "");
  link.classList.remove("disabled-link");
  link.setAttribute("aria-disabled", "false");
}

function startPlanExportLink(id) {
  const link = element("a", "text-link", "Export");
  link.href = `/api/billing/startplan/history/${encodeURIComponent(id)}/export`;
  link.setAttribute("download", "");
  return link;
}

async function getJson(url) {
  return request(url, { method: "GET" });
}

async function postJson(url, body) {
  return request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cost-Lab-CSRF": app.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

async function request(url, options) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: response was not JSON`);
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  return payload.data;
}

function fact(label, value, detail) {
  const wrapper = element("div");
  wrapper.append(
    element("dt", "", label),
    element("dd", "", value),
  );
  if (detail) wrapper.append(element("small", "", detail));
  return wrapper;
}

function metric(label, value) {
  const wrapper = element("div", "metric");
  wrapper.append(element("small", "", label), element("strong", "", value));
  return wrapper;
}

function compactValue(label, value) {
  const wrapper = element("div");
  wrapper.append(element("small", "", label), element("strong", "", String(value ?? "unknown")));
  return wrapper;
}

function exportLink(id) {
  const link = element("a", "text-link", "Export redacted evidence");
  link.href = `/api/history/${encodeURIComponent(id)}/export`;
  link.setAttribute("download", "");
  return link;
}

function statusTag(status) {
  const normalized = String(status ?? "UNKNOWN");
  const kind = ["PASS", "VERIFIED", "SUCCEEDED", "COMPLETE", "FRESH", "OFFICIAL_RUNTIME_VERIFIED", "OFFICIAL_DISCOUNT_VERIFIED"].includes(normalized)
    ? "pass"
    : ["FAIL", "FAILED", "MISSING", "REJECTED", "UNVERIFIED", "EXPIRED", "OFFICIAL_RUNTIME_UNVERIFIED", "OFFICIAL_DISCOUNT_NOT_VERIFIED"].includes(normalized)
      ? "fail"
      : "";
  return element("span", `tag ${kind}`.trim(), normalized);
}

function replaceChildren(target, children) {
  target.replaceChildren(...children);
}

function element(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = String(text);
  return node;
}

function shortHash(value) {
  const text = String(value);
  return text.length > 24 ? `${text.slice(0, 12)}...${text.slice(-8)}` : text;
}

function formatNumber(value, digits = 6) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unknown";
}

function formatExtraRatio(item, digits = 6) {
  return item?.billing_reconciliation === "PASS" && Number.isFinite(item.effective_extra_ratio)
    ? formatNumber(item.effective_extra_ratio, digits)
    : "INCONCLUSIVE";
}

function formatInteger(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString("en-US") : "unknown";
}

function displayInteger(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString("en-US") : "—";
}

function signedInteger(value) {
  if (!Number.isSafeInteger(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

function formatDateTime(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

function showToast(message, error = false) {
  const toast = $("#toast");
  clearTimeout(app.toastTimer);
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  app.toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4_500);
}
