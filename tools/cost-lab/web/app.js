import {
  buildStartPlanView,
  compareStartPlanViews,
  startPlanFreshness,
} from "./startplan-view.mjs";
import {
  LANGUAGE_STORAGE_KEY,
  applyTranslations,
  localeForLanguage,
  normalizeLanguage,
  resolveLanguage,
  translate,
} from "./i18n.mjs";
import {
  createStartPlanStatus,
  resolveStartPlanStatus,
} from "./startplan-status.mjs";

const app = {
  language: "en",
  csrfToken: null,
  session: null,
  environment: null,
  history: [],
  latestExperiment: null,
  billingSnapshot: null,
  verificationRecord: null,
  startPlan: null,
  startPlanStatus: null,
  profiler: {
    latest: null,
    report: null,
    reports: [],
    comparison: null,
    timelineExpanded: false,
    timelineReportId: null,
  },
  activeVerificationId: null,
  pollTimer: null,
  toastTimer: null,
  transientTranslations: new Map(),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const t = (key, parameters) => translate(app.language, key, parameters);

document.addEventListener("DOMContentLoaded", () => {
  setLanguage(initialLanguage(), { persist: false, rerender: false });
  bindNavigation();
  bindActions();
  bindLanguageSwitch();
  void bootstrap();
});

function initialLanguage() {
  let stored = null;
  try {
    stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    // Storage may be disabled; browser language remains a safe fallback.
  }
  return resolveLanguage(stored, window.navigator.language);
}

function bindLanguageSwitch() {
  for (const button of $$("[data-language]")) {
    button.addEventListener("click", () => {
      const language = normalizeLanguage(button.dataset.language);
      if (language && language !== app.language) setLanguage(language);
    });
  }
}

function setLanguage(language, { persist = true, rerender = true } = {}) {
  app.language = normalizeLanguage(language) ?? "en";
  document.documentElement.lang = app.language;
  document.title = t("meta.title");
  applyTranslations(document, app.language);
  for (const button of $$("[data-language]")) {
    button.setAttribute(
      "aria-pressed",
      String(normalizeLanguage(button.dataset.language) === app.language),
    );
  }
  if (persist) {
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, app.language);
    } catch {
      // Language still applies for this page view.
    }
  }
  if (rerender) rerenderLocalizedContent();
}

function rerenderLocalizedContent() {
  if (app.environment) renderEnvironment(app.environment);
  renderLatestExperiment(app.latestExperiment);
  renderHistory(app.history);
  if (app.verificationRecord) renderVerificationResult(app.verificationRecord);
  if (app.billingSnapshot) renderBillingSnapshot(app.billingSnapshot);
  if (app.startPlan) {
    renderStartPlan(app.startPlan, { preserveStatus: true });
  } else {
    applyStartPlanStatus();
  }
  if (app.profiler.latest) renderProfilerLatest(app.profiler.latest);
  if (app.profiler.report) renderProfilerReport(app.profiler.report);
  if (app.profiler.comparison) renderProfilerComparison(app.profiler.comparison);
  applyTransientTranslations();
}

function startPlanReason(reason) {
  if (!reason) return null;
  const key = `startplan.reason.${reason}`;
  return key === t(key) ? reason : t(key);
}

async function bootstrap() {
  try {
    const session = await getJson("/api/session");
    app.session = session;
    app.csrfToken = session.csrf_token;
    $("#server-dot").classList.add("online");
    setTranslatedText($("#server-status"), "server.online");
    await Promise.all([loadEnvironment(), loadHistory()]);
    const initialPage = window.location.hash.slice(1);
    if (initialPage) showPage(initialPage);
    if (session.active_verification_id) {
      app.activeVerificationId = session.active_verification_id;
      showPage("verification");
      await pollVerification();
    }
  } catch (error) {
    setTranslatedText($("#server-status"), "server.unavailable");
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
  $("#collect-profiler").addEventListener("click", () => void collectProfiler());
  $("#analyze-profiler").addEventListener("click", () => void analyzeProfiler());
  $("#compare-profiler").addEventListener("click", () => void compareProfilerReports());
  $("#profiler-timeline-toggle").addEventListener("click", () => {
    setProfilerTimelineExpanded(!app.profiler.timelineExpanded);
  });
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
  if (name === "profiler") void loadProfilerHome();
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
    fact(t("dashboard.bundle"), bundle?.status ?? "UNKNOWN", bundle?.sha256 ?? t("dashboard.unavailable")),
    fact(t("dashboard.sha256"), bundle?.sha256 ? shortHash(bundle.sha256) : t("dashboard.unavailable"), t("dashboard.manifestPinned")),
    fact(
      t("dashboard.node"),
      environment.host?.node_version ?? "UNKNOWN",
      environment.host?.node_compatible ? t("environment.compatible") : t("environment.incompatible"),
    ),
    fact(t("dashboard.requestSecurity"), zcode.request_security_capability ?? "UNKNOWN", zcode.appserver_protocol ?? ""),
  ]);
  renderChecks(environment);
}

function renderChecks(environment) {
  const zcode = environment.zcode ?? {};
  const checks = [
    {
      name: t("environment.runtimeDiscovery"),
      status: zcode.installed ? "PASS" : "FAIL",
      detail: zcode.installed
        ? t("environment.foundRuntime", {
            source: zcode.install_source ?? t("environment.configuredSource"),
          })
        : t("environment.runtimeNotFound"),
    },
    {
      name: t("environment.bundleHash"),
      status: zcode.assets?.bundle?.status ?? "UNKNOWN",
      detail: zcode.assets?.bundle?.sha256
        ? `SHA-256 ${zcode.assets.bundle.sha256}`
        : t("environment.noBundleHash"),
    },
    {
      name: t("environment.nodeCompatibility"),
      status: environment.host?.node_compatible ? "PASS" : "FAIL",
      detail: t("environment.nodeDetail", {
        version: environment.host?.node_version ?? "UNKNOWN",
      }),
    },
    {
      name: t("environment.billingReader"),
      status: environment.billing_reader?.status ?? "UNKNOWN",
      detail: environment.billing_reader?.accessor ?? t("environment.billingAccessorUnavailable"),
    },
    {
      name: t("environment.credentialReadability"),
      status: environment.credential_readability?.status ?? "UNKNOWN",
      detail: t("environment.credentialMetadata"),
    },
    {
      name: t("environment.resourceIsolation"),
      status: environment.resource_isolation?.status ?? "UNKNOWN",
      detail: t("environment.isolationDetail", {
        binding: environment.resource_isolation?.server_binding ?? "UNKNOWN",
        requests: environment.resource_isolation?.model_requests_on_page_load ?? "UNKNOWN",
      }),
    },
    {
      name: t("environment.protocolSmoke"),
      status: environment.appserver_protocol_smoke?.status ?? "NOT_RUN",
      detail: environment.appserver_protocol_smoke?.reason ?? t("environment.deepNotRequested"),
    },
    {
      name: t("environment.runtimeCompatibility"),
      status: zcode.runtime_status ?? "UNKNOWN",
      detail: zcode.discount_status === "OFFICIAL_DISCOUNT_VERIFIED"
        ? t("environment.runtimeVerifiedDetail")
        : t("environment.runtimeUnverifiedDetail"),
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
  setTranslatedText(
    $("#env-check-state"),
    deep ? "environment.runningDeep" : "environment.running",
  );
  try {
    const environment = deep ? await postJson("/api/environment/check", { deep: true }) : await loadEnvironment();
    renderEnvironment(environment);
    setTranslatedText($("#env-check-state"), "environment.completed");
    showToast(t("environment.toastCompleted"));
  } catch (error) {
    setTranslatedText($("#env-check-state"), "environment.failed");
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
    showToast(t("verification.authorizedToast"));
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
    app.verificationRecord = record;
    renderVerificationResult(record);
    await loadHistory();
    if (record.status !== "SUCCEEDED") {
      showToast(record.error?.message ?? t("verification.didNotComplete"), true);
    } else if (record.reconciliation?.billing_reconciliation === "PASS") {
      showToast(t("verification.completedReconciled"));
    } else {
      showToast(t("verification.completedInconclusive"));
    }
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
    element("span", "", t("verification.reconciliation")),
    statusTag(reconciliation.billing_reconciliation ?? "INCONCLUSIVE"),
  );
  const metrics = element("div", "metric-grid");
  metrics.append(
    metric(
      t("verification.actualCredits"),
      Number.isFinite(actualCredits) ? formatNumber(actualCredits) : creditDisplay,
    ),
    metric(t("verification.expectedNormal"), formatNumber(calculation.expected_normal)),
    metric(t("verification.expectedWithDiscount"), formatNumber(calculation.expected_with_0_67)),
    metric(
      t("verification.effectiveRatio"),
      formatExtraRatio({
        billing_reconciliation: reconciliation.billing_reconciliation,
        effective_extra_ratio: calculation.effective_extra_ratio,
      }, 8),
    ),
    metric(t("verification.cachedInput"), formatInteger(reconciliation.request_usage?.cached_input_tokens)),
    metric(t("verification.uncachedInput"), formatInteger(reconciliation.request_usage?.uncached_input_tokens)),
    metric(t("verification.output"), formatInteger(reconciliation.request_usage?.output_tokens)),
    metric(
      t("verification.tokenMatch"),
      reconciliation.token_match ? "PASS" :
        settlementStatus === "UNATTRIBUTED_DELTA"
          ? t("verification.mismatch")
          : t("verification.inconclusive"),
    ),
  );
  panel.append(title, metrics);
  const details = element("dl", "fact-grid");
  details.append(
    fact(
      t("verification.timeMultiplier"),
      formatNumber(calculation.time_multiplier),
      t("verification.timeMultiplierNote"),
    ),
    fact(
      t("verification.settlement"),
      settlementStatus,
      noObservedCreditDelta
        ? t("verification.ledgerPending")
        : reconciliation.limitation ?? record.status,
    ),
    fact(
      t("verification.observedAttempts"),
      String(record.model_requests ?? t("common.unknown")),
      t("verification.reportedTokens", {
        count: record.request_usage?.total_tokens ?? t("common.unknown"),
      }),
    ),
    fact(
      t("verification.billingWindow"),
      record.billing_window?.time_zone ?? "Asia/Shanghai",
      t("verification.officialHourlyLedger"),
    ),
  );
  panel.append(details);
  container.replaceChildren(panel);
}

async function captureBilling() {
  const button = $("#capture-billing");
  button.disabled = true;
  setTranslatedText($("#billing-state"), "billing.reading");
  try {
    const snapshot = await postJson("/api/billing/snapshot", {});
    app.billingSnapshot = snapshot;
    renderBillingSnapshot(snapshot);
    setTranslatedText($("#billing-state"), "billing.captured", {
      at: formatDateTime(snapshot.captured_at),
    });
    showToast(t("billing.capturedToast"));
  } catch (error) {
    setTranslatedText($("#billing-state"), "billing.failed");
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
  title.append(element("span", "", t("billing.hourlyLedger")), statusTag(snapshot.integrity?.status ?? "PARTIAL"));
  panel.append(title);
  if (hours.length === 0) {
    panel.append(element("p", "", model
      ? t("billing.noActivity")
      : t("billing.noLedgerRow")));
  } else {
    const rows = element("div", "history-list");
    for (const hour of hours) {
      const row = element("div", "history-row");
      row.append(
        compactValue(t("billing.hour"), hour.bucket),
        compactValue(t("billing.tokens"), formatInteger(hour.total_tokens)),
        compactValue(t("billing.credits"), formatNumber(hour.total_credits, 6)),
        compactValue(t("billing.cached"), formatInteger(hour.cached_input_tokens)),
        compactValue(t("billing.output"), formatInteger(hour.output_tokens)),
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
  app.latestExperiment = latest ?? null;
  app.history = history.items ?? [];
  if (latest) {
    $("#dash-ratio").textContent = formatExtraRatio(latest, 6);
  } else {
    $("#dash-ratio").textContent = t("dashboard.noExperiment");
  }
  renderLatestExperiment(latest);
  renderHistory(app.history);
}

function renderLatestExperiment(latest) {
  const target = $("#latest-experiment");
  if (!latest) {
    target.className = "empty-state";
    target.textContent = t("common.noExperiment");
    return;
  }
  target.className = "";
  const row = element("div", "history-row");
  row.append(
    compactValue(t("dashboard.model"), latest.model),
    compactValue(t("dashboard.status"), latest.status),
    compactValue(t("dashboard.extraRatio"), formatExtraRatio(latest, 8)),
    compactValue(t("dashboard.started"), formatDateTime(latest.started_at)),
    exportLink(latest.id),
  );
  target.replaceChildren(row);
}

function renderHistory(items) {
  const list = $("#history-list");
  if (!items.length) {
    list.replaceChildren(element("div", "empty-state", t("history.empty")));
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const row = element("div", "history-row");
    row.append(
      compactValue(t("dashboard.model"), item.model),
      compactValue(t("dashboard.status"), item.status),
      compactValue(t("history.credits"), item.credit_class ?? "UNKNOWN"),
      compactValue(t("history.ratio"), formatExtraRatio(item, 8)),
      exportLink(item.id),
    );
    return row;
  }));
}

async function loadStartPlanData({ preserveStatus = false } = {}) {
  if (!preserveStatus) app.startPlanStatus = null;
  try {
    const [latest, history] = await Promise.all([
      getJson("/api/billing/startplan/latest"),
      getJson("/api/billing/startplan/history?limit=25"),
    ]);
    app.startPlan = { ...latest, history: history.items ?? [] };
    renderStartPlan(app.startPlan, { preserveStatus });
    return true;
  } catch (error) {
    app.startPlan = null;
    renderStartPlanError(error.message);
    return false;
  }
}

async function refreshStartPlan() {
  const button = $("#refresh-startplan");
  button.disabled = true;
  setStartPlanStatus("startplan.readingBalance", null, {
    freshness: { key: "startplan.loading", className: "tag" },
    preserve: true,
  });
  try {
    const refreshed = await postJson("/api/billing/startplan/refresh", {});
    const localStateLoaded = await loadStartPlanData({ preserveStatus: true });
    if (!localStateLoaded) return;
    const snapshot = refreshed.snapshot?.snapshot ?? refreshed.snapshot;
    setStartPlanStatus(
      refreshed.deduplicated ? "startplan.deduplicated" : "startplan.captured",
      refreshed.deduplicated ? null : { at: snapshot?.captured_at ?? null },
      {
        freshness: app.startPlan
          ? startPlanFreshnessPresentation(buildStartPlanView(app.startPlan, Date.now()))
          : null,
        preserve: true,
      },
    );
    showToast(t("startplan.refreshedToast"));
  } catch (error) {
    setStartPlanStatus("startplan.refreshFailed", { message: error.message }, {
      freshness: { key: "startplan.error", className: "tag fail" },
      preserve: true,
    });
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderStartPlan(data, { preserveStatus = false } = {}) {
  const view = buildStartPlanView(data, Date.now());
  const freshness = view.freshness.status;
  const freshnessPresentation = startPlanFreshnessPresentation(view);
  applyStartPlanFreshness(freshnessPresentation);

  if (!view.available) {
    $("#startplan-plan").textContent = t("startplan.noSnapshotValue");
    $("#startplan-plan-status").textContent = "UNKNOWN";
    $("#startplan-total").textContent = "—";
    $("#startplan-remaining").textContent = "—";
    $("#startplan-updated").textContent = t("startplan.neverCapturedValue");
    $("#startplan-progress-fill").style.width = "0%";
    $("#startplan-progress-value").textContent = "UNKNOWN";
    $("#startplan-progress-detail").textContent = t("startplan.refreshHint");
    replaceChildren($("#startplan-facts"), [
      fact(t("startplan.entitlement"), "UNKNOWN"),
      fact(t("startplan.unit"), "UNKNOWN"),
      fact(t("startplan.billingPeriod"), "UNKNOWN"),
      fact(t("startplan.expiry"), "UNKNOWN"),
    ]);
    $("#startplan-buckets").replaceChildren(
      element("div", "empty-state", t("startplan.noSnapshot")),
    );
    renderStartPlanHistory([]);
    setStartPlanExport(null);
    updateStartPlanStatus(freshness, null, preserveStatus, freshnessPresentation);
    return;
  }

  const summary = view.summary;
  $("#startplan-plan").textContent = summary.plan_type ?? summary.plan_id ?? "UNKNOWN";
  $("#startplan-plan-status").textContent = summary.plan_status ?? "UNKNOWN";
  $("#startplan-total").textContent = displayInteger(summary.total_balance);
  $("#startplan-remaining").textContent = displayInteger(summary.remaining_balance);
  $("#startplan-updated").textContent = t("startplan.capturedAt", {
    at: formatDateTime(summary.captured_at),
  });
  $("#startplan-progress-fill").style.width =
    view.progress.percent === null ? "0%" : `${view.progress.percent.toFixed(1)}%`;
  $("#startplan-progress-value").textContent =
    view.progress.percent === null
      ? "UNKNOWN"
      : t("startplan.percentUsed", { percent: view.progress.percent.toFixed(1) });
  $("#startplan-progress-detail").textContent =
    t("startplan.usageDetail", {
      used: displayInteger(summary.used_balance),
      total: displayInteger(summary.total_balance),
      unit: summary.unit_type ?? t("startplan.unitUnknown"),
    });
  replaceChildren($("#startplan-facts"), [
    fact(t("startplan.entitlement"), summary.entitlement_status ?? "UNKNOWN"),
    fact(t("startplan.unit"), summary.unit_type ?? "UNKNOWN"),
    fact(
      t("startplan.billingPeriod"),
      summary.billing_period
        ? `${formatDateTime(summary.billing_period.start)} - ${formatDateTime(summary.billing_period.end)}`
        : "UNKNOWN",
    ),
    fact(t("startplan.expiry"), summary.expiry ? formatDateTime(summary.expiry) : "UNKNOWN"),
  ]);
  renderStartPlanBuckets(view.buckets);
  renderStartPlanHistory(view.history);
  setStartPlanExport(data.snapshot?.id ?? null);
  const reason = startPlanReason(view.freshness.reason);
  updateStartPlanStatus(freshness, reason, preserveStatus, freshnessPresentation);
  $("#startplan-compare").hidden = true;
}

function renderStartPlanBuckets(buckets) {
  const target = $("#startplan-buckets");
  if (!buckets.length) {
    target.replaceChildren(element("div", "empty-state", t("startplan.noBuckets")));
    return;
  }
  target.replaceChildren(...buckets.map((bucket) => {
    const card = element("article", "bucket-card");
    const header = element("header");
    const name = element("div");
    name.append(
      element("h4", "", bucket.label ?? t("startplan.bucket")),
      element("span", "mono", bucket.key ?? t("startplan.bucketIdUnavailable")),
    );
    header.append(name, statusTag(bucket.model_ids.includes("glm-5.3-flash") ? "GLM-5.3-FLASH" : bucket.unit_type ?? "UNKNOWN"));
    const metrics = element("div", "bucket-metrics");
    metrics.append(
      compactValue(t("startplan.total"), displayInteger(bucket.total_units)),
      compactValue(t("startplan.used"), displayInteger(bucket.used_units)),
      compactValue(t("startplan.remaining"), displayInteger(bucket.remaining_units)),
    );
    const dates = element("dl", "fact-grid");
    dates.append(
      fact(t("startplan.periodStart"), formatDateTime(bucket.period_start)),
      fact(t("startplan.periodEnd"), formatDateTime(bucket.period_end)),
      fact(t("startplan.expiry"), formatDateTime(bucket.expires_at)),
      fact(t("startplan.entitlement"), bucket.entitlement_key ?? "UNKNOWN"),
    );
    card.append(header, metrics, dates);
    return card;
  }));
}

function renderStartPlanHistory(items) {
  $("#startplan-history-count").textContent = items.length === 1
    ? t("startplan.oneSnapshot")
    : t("startplan.snapshotCount", { count: items.length });
  const target = $("#startplan-history");
  if (!items.length) {
    target.replaceChildren(element("div", "empty-state", t("startplan.noStored")));
    return;
  }
  target.replaceChildren(...[...items].reverse().map((item) => {
    const snapshot = item.snapshot ?? item;
    const freshness = startPlanFreshness(snapshot, Date.now()).status;
    const row = element("div", "history-row startplan-history-row");
    row.append(
      compactValue(t("startplan.capturedLabel"), formatDateTime(item.captured_at)),
      compactValue(t("startplan.plan"), item.plan_type ?? item.plan_id ?? "UNKNOWN"),
      compactValue(t("startplan.used"), displayInteger(item.used_balance)),
      compactValue(t("startplan.remaining"), displayInteger(item.remaining_balance)),
      compactValue(t("startplan.freshness"), freshness),
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
    panel.replaceChildren(element("p", "", t("startplan.atLeastTwo")));
    return;
  }
  const current = items.at(-1).snapshot ?? items.at(-1);
  const previous = items.at(-2).snapshot ?? items.at(-2);
  const comparison = compareStartPlanViews(previous, current);
  const heading = element("h3", "", t("startplan.comparisonTitle", {
    status: comparison.status,
  }));
  panel.replaceChildren(heading);
  if (comparison.rows.length) {
    panel.append(...comparison.rows.map((row) => {
      const line = element("div", "comparison-row");
      line.append(
        element("strong", "", row.label),
        compactValue(t("startplan.status"), row.status),
        compactValue(t("startplan.usedDelta"), signedInteger(row.used_delta)),
        compactValue(t("startplan.remainingDelta"), signedInteger(row.remaining_delta)),
      );
      return line;
    }));
  } else {
    panel.append(element("p", "", startPlanReason(comparison.reason) ?? t("startplan.cannotCompare")));
  }
  panel.hidden = false;
}

function renderStartPlanError(message) {
  setStartPlanStatus("startplan.loadFailed", { message }, {
    freshness: { key: "startplan.error", className: "tag fail" },
    preserve: true,
  });
}

function updateStartPlanStatus(freshness, reason, preserveStatus, freshnessPresentation) {
  if (preserveStatus && app.startPlanStatus?.preserve) {
    applyStartPlanStatus();
    return;
  }
  setStartPlanStatus("startplan.latestData", { status: freshness }, {
    suffix: reason,
    freshness: freshnessPresentation,
    preserve: false,
  });
}

function setStartPlanStatus(key, parameters, {
  suffix = null,
  freshness = null,
  preserve = false,
} = {}) {
  app.startPlanStatus = createStartPlanStatus(key, parameters, {
    suffix,
    freshness,
    preserve,
  });
  applyStartPlanStatus();
}

function applyStartPlanStatus() {
  const resolved = resolveStartPlanStatus(app.startPlanStatus, {
    translate: t,
    formatTime: formatDateTime,
    translateReason: startPlanReason,
  });
  if (!resolved) return;
  const state = $("#startplan-state");
  state.textContent = resolved.stateText;
  applyStartPlanFreshness(resolved.freshness);
}

function startPlanFreshnessPresentation(view) {
  const status = view.freshness.status;
  return {
    text: status,
    className: `tag ${status === "FRESH"
      ? "pass"
      : status === "EXPIRED"
        ? "fresh-expired"
        : status === "STALE"
          ? "fresh-stale"
          : ""}`.trim(),
    reason: view.freshness.reason ?? null,
  };
}

function applyStartPlanFreshness(presentation) {
  if (!presentation) return;
  const node = $("#startplan-freshness");
  node.textContent = presentation.key ? t(presentation.key) : presentation.text ?? "UNKNOWN";
  node.className = presentation.className ?? "tag";
  node.title = startPlanReason(presentation.reason) ?? "";
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
  const link = element("a", "text-link", t("common.export"));
  link.href = `/api/billing/startplan/history/${encodeURIComponent(id)}/export`;
  link.setAttribute("download", "");
  return link;
}

async function loadProfilerHome() {
  try {
    const data = await getJson("/api/profiler/latest");
    app.profiler.latest = data;
    app.profiler.reports = data.reports ?? [];
    renderProfilerLatest(data);
    if (data.status === "READY" && data.reports?.[0] && app.profiler.report?.report_id !== data.reports[0].report_id) {
      app.profiler.report = await getJson(`/api/profiler/reports/${encodeURIComponent(data.reports[0].report_id)}`);
      renderProfilerReport(app.profiler.report);
    }
  } catch (error) {
    $("#profiler-state").textContent = t("profiler.loadFailed", { message: error.message });
    showToast(error.message, true);
  }
}

async function collectProfiler() {
  const button = $("#collect-profiler");
  button.disabled = true;
  $("#profiler-state").textContent = t("profiler.loading");
  try {
    const data = await postJson("/api/profiler/collect", {});
    app.profiler.latest = data;
    app.profiler.reports = data.reports ?? [];
    renderProfilerLatest(data);
    showToast(t("profiler.collectedToast"));
  } catch (error) {
    $("#profiler-state").textContent = t("profiler.collectionFailed", { message: error.message });
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function analyzeProfiler() {
  const selected = $("#profiler-thread").value;
  if (!selected) {
    showToast(t("profiler.chooseSessionFirst"), true);
    return;
  }
  const button = $("#analyze-profiler");
  button.disabled = true;
  $("#profiler-state").textContent = t("profiler.creating");
  try {
    const [kind, id] = selected.split(":", 2);
    const report = await postJson("/api/profiler/analyze", kind === "thread"
      ? { thread_id: id }
      : { agent_id: id });
    app.profiler.report = report;
    renderProfilerReport(report);
    const listing = await getJson("/api/profiler/reports");
    app.profiler.reports = listing.reports ?? [];
    renderProfilerReportOptions();
    $("#profiler-state").textContent = t("profiler.reportCreated", {
      report: shortHash(report.report_id),
      snapshot: shortHash(report.source_snapshot_id),
    });
    showToast(t("profiler.reportCreatedToast"));
  } catch (error) {
    $("#profiler-state").textContent = t("profiler.analysisFailed", { message: error.message });
    showToast(error.message, true);
  } finally {
    button.disabled = !$("#profiler-thread").value;
  }
}

async function compareProfilerReports() {
  const before = $("#profiler-before").value;
  const after = $("#profiler-after").value;
  if (!before || !after) return;
  const button = $("#compare-profiler");
  button.disabled = true;
  $("#profiler-comparison-status").textContent = t("profiler.comparing");
  try {
    const comparison = await postJson("/api/profiler/compare", { before, after });
    app.profiler.comparison = comparison;
    renderProfilerComparison(comparison);
    showToast(t("profiler.comparisonCompleted"));
  } catch (error) {
    $("#profiler-comparison-status").textContent = t("startplan.error");
    showToast(error.message, true);
  } finally {
    button.disabled = $("#profiler-before").value === "" || $("#profiler-after").value === "";
  }
}

function renderProfilerLatest(data) {
  const ready = data.status === "READY";
  $("#profiler-snapshot").textContent = ready ? shortHash(data.snapshot_id) : "NONE";
  $("#profiler-mode").textContent = ready ? data.collection_mode ?? "READ ONLY" : "NOT COLLECTED";
  $("#profiler-state").textContent = ready
    ? t("profiler.snapshotCaptured", {
        snapshot: shortHash(data.snapshot_id),
        at: formatDateTime(data.captured_at),
      })
    : t("profiler.noSnapshotLoaded");

  const sessions = data.sessions ?? [];
  renderProfilerAgentTable(sessions);
  replaceChildren($("#profiler-provenance"), [
    fact(t("profiler.snapshot"), ready ? shortHash(data.snapshot_id) : t("profiler.notCollected")),
    fact(t("profiler.generated"), formatDateTime(data.generated_at)),
    fact(
      t("profiler.sources"),
      String(data.sources?.length ?? 0),
      t("profiler.collectionMode", { mode: data.collection_mode ?? "UNKNOWN" }),
    ),
    fact(t("profiler.warnings"), String(data.warnings?.length ?? 0), t("profiler.unknownRemains")),
  ]);
  app.profiler.reports = data.reports ?? [];
  renderProfilerReportOptions();
  renderProfilerThreadOptions(sessions);
  if (!app.profiler.report) {
    setProfilerExport(null);
    setProfilerTimelineExpanded(false);
    setProfilerTimelineExport(null);
    $("#profiler-total").textContent = "UNKNOWN";
    $("#profiler-cache").textContent = "UNKNOWN";
    $("#profiler-polling").textContent = "UNKNOWN";
  }
}

function renderProfilerThreadOptions(sessions) {
  const select = $("#profiler-thread");
  const previous = select.value;
  const eligible = [...sessions]
    .filter((session) => session.agent_id && session.kind !== "UNKNOWN")
    .sort((left, right) => {
      const rank = { MASTER: 0, SUBAGENT: 1, WORKER: 2 };
      return (rank[left.kind] ?? 9) - (rank[right.kind] ?? 9)
        || (right.total_tokens ?? 0) - (left.total_tokens ?? 0);
    });
  select.replaceChildren(element("option", "", t("common.chooseSession")));
  select.firstElementChild.value = "";
  for (const session of eligible) {
    const option = element(
      "option",
      "",
      `${session.kind} · ${session.nickname ?? shortHash(session.agent_id)} · ${formatUiInteger(session.total_tokens)} ${t("common.tokens")}`,
    );
    option.value = `agent:${session.agent_id}`;
    select.append(option);
  }
  const preferred = eligible.find((session) => session.kind === "MASTER") ?? eligible[0];
  select.value = eligible.some((session) => `agent:${session.agent_id}` === previous)
    ? previous
    : preferred
      ? `agent:${preferred.agent_id}`
      : "";
  $("#analyze-profiler").disabled = !select.value;
}

function renderProfilerAgentTable(sessions) {
  const rows = sessions.map((session) => [
    session.kind,
    `${session.nickname ?? "-"} / ${shortHash(session.agent_id)}`,
    `${session.provider ?? "UNKNOWN"} / ${session.model ?? "UNKNOWN"}`,
    formatUiInteger(session.total_tokens),
    formatUiInteger(session.input_tokens),
    formatUiInteger(session.cached_input_tokens),
    formatUiInteger(session.output_tokens),
    formatUiInteger(session.response_count),
    formatUiDuration(session.duration_ms),
    session.evidence_level ?? "UNKNOWN",
  ]);
  const target = $("#profiler-sessions");
  target.replaceChildren(dataTable(
    [
      t("profiler.table.kind"),
      t("profiler.table.agent"),
      t("profiler.table.providerModel"),
      t("profiler.table.total"),
      t("profiler.table.input"),
      t("profiler.table.cached"),
      t("profiler.table.output"),
      t("profiler.table.resp"),
      t("profiler.table.duration"),
      t("profiler.table.evidence"),
    ],
    rows,
    t("profiler.noSessions"),
  ));
}

function renderProfilerReport(report) {
  if (app.profiler.timelineReportId !== report.report_id) {
    app.profiler.timelineReportId = report.report_id;
    app.profiler.timelineExpanded = false;
  }
  const overall = report.usage?.overall ?? {};
  $("#profiler-total").textContent = formatUiInteger(overall.total_tokens);
  $("#profiler-cache").textContent = formatUiPercent(report.context?.cache?.overall_cache_hit_rate);
  $("#profiler-polling").textContent = formatUiInteger(report.mcp?.waiting?.model_driven_poll_usage?.total_tokens);
  $("#profiler-evidence").textContent = overall.evidence_level ?? "UNKNOWN";
  $("#profiler-conservation").textContent = report.phases?.conservation?.status ?? "UNKNOWN";
  const compactionCount = report.context?.compactions?.count ?? 0;
  const timelineCount = report.timeline_meta?.total_event_count ?? report.timeline?.length ?? 0;
  const diagnosticCount = report.diagnostics?.length ?? 0;
  $("#profiler-compactions").textContent = compactionCount === 1
    ? t("profiler.oneCompaction")
    : t("profiler.compactionCount", { count: compactionCount });
  $("#profiler-timeline-count").textContent = timelineCount === 1
    ? t("profiler.oneEvent")
    : t("profiler.eventCount", { count: timelineCount });
  $("#profiler-diagnostics-count").textContent = diagnosticCount === 1
    ? t("profiler.oneFinding")
    : t("profiler.findingCount", { count: diagnosticCount });
  $("#profiler-state").textContent = t("profiler.reportGenerated", {
    report: shortHash(report.report_id),
    at: formatDateTime(report.generated_at),
  });
  replaceChildren($("#profiler-provenance"), [
    fact(t("profiler.snapshot"), shortHash(report.source_snapshot_id)),
    fact(t("profiler.generated"), formatDateTime(report.generated_at)),
    fact(
      t("profiler.agents"),
      String(report.agents?.length ?? 0),
      t("common.providerModelGroups", { count: report.usage?.by_provider?.length ?? 0 }),
    ),
    fact(
      t("profiler.evidence"),
      overall.evidence_level ?? "UNKNOWN",
      t("profiler.missingUsage", {
        count: overall.unknown_usage_response_count ?? "UNKNOWN",
      }),
    ),
  ]);
  setProfilerExport(report.report_id);
  setProfilerTimelineExport(report);
  renderProfilerAgentTable(report.agents ?? []);
  renderProfilerPhases(report);
  renderProfilerContext(report);
  renderProfilerMcp(report);
  renderProfilerTimeline(report);
  setProfilerTimelineExpanded(app.profiler.timelineExpanded);
  renderProfilerDiagnostics(report);
}

function renderProfilerPhases(report) {
  const rows = (report.phases?.summary ?? []).map((row) => [
    row.phase,
    formatUiInteger(row.usage?.total_tokens),
    formatUiPercent(row.token_share),
    formatUiInteger(row.response_count),
    formatUiInteger(row.tool_call_count),
    row.evidence_level,
  ]);
  $("#profiler-phases").replaceChildren(dataTable(
    [
      t("profiler.table.phase"),
      t("profiler.table.tokens"),
      t("profiler.table.share"),
      t("profiler.table.responses"),
      t("profiler.table.tools"),
      t("profiler.table.evidence"),
    ],
    rows,
    t("profiler.noPhases"),
  ));
}

function renderProfilerContext(report) {
  const context = report.context ?? {};
  const cache = context.cache ?? {};
  replaceChildren($("#profiler-context"), [
    metric(t("profiler.cacheMetric"), formatUiPercent(cache.overall_cache_hit_rate)),
    metric(t("profiler.uncachedInput"), formatUiPercent(cache.overall_uncached_input_ratio)),
    metric(t("profiler.observedContent"), formatUiInteger(context.context?.total_observed_content_bytes)),
    metric(t("profiler.estimatedTokens"), formatUiInteger(context.context?.total_estimated_content_tokens)),
    metric(t("profiler.repeatedReads"), formatUiInteger(context.repeated_reads?.repeated_read_count)),
    metric(t("profiler.compactions"), formatUiInteger(context.compactions?.count)),
  ]);
  const rows = (context.context?.sources ?? []).map((row) => [
    row.category,
    formatUiInteger(row.item_count),
    formatUiInteger(row.bytes),
    formatUiInteger(row.estimated_tokens),
    row.evidence_level,
  ]);
  $("#profiler-context-sources").replaceChildren(dataTable(
    [
      t("profiler.table.source"),
      t("profiler.table.items"),
      t("profiler.table.bytes"),
      t("profiler.table.estimatedTokens"),
      t("profiler.table.evidence"),
    ],
    rows,
    t("profiler.noContextSources"),
  ));
}

function renderProfilerMcp(report) {
  const mcp = report.mcp ?? {};
  const waiting = mcp.waiting ?? {};
  replaceChildren($("#profiler-mcp-metrics"), [
    metric(t("profiler.mcpCalls"), formatUiInteger(mcp.by_tool?.reduce((sum, row) => sum + (row.call_count ?? 0), 0))),
    metric(t("profiler.wallTime"), formatUiDuration(waiting.mcp_call_duration_ms?.total)),
    metric(t("profiler.pureWait"), formatUiDuration(waiting.pure_wait_ms)),
    metric(t("profiler.modelPolls"), formatUiInteger(waiting.model_driven_poll_count)),
    metric(t("profiler.pollingTokens"), formatUiInteger(waiting.model_driven_poll_usage?.total_tokens)),
    metric(t("profiler.pollShare"), formatUiPercent(waiting.model_driven_poll_share_of_master_tokens)),
  ]);
  const rows = (mcp.by_tool ?? []).map((row) => [
    row.tool_name,
    formatUiInteger(row.call_count),
    formatUiInteger(row.failure_count),
    formatUiInteger(row.duplicate_count),
    formatUiDuration(row.duration_ms?.total),
    formatUiInteger(row.output_bytes?.total),
    formatUiInteger(row.estimated_output_tokens?.total),
    formatUiInteger(row.polling_usage?.total_tokens),
  ]);
  $("#profiler-mcp").replaceChildren(dataTable(
    [
      t("profiler.table.tool"),
      t("profiler.table.calls"),
      t("profiler.table.failures"),
      t("profiler.table.duplicates"),
      t("profiler.table.duration"),
      t("profiler.table.bytes"),
      t("profiler.table.estimatedTokens"),
      t("profiler.table.pollTokens"),
    ],
    rows,
    t("profiler.noMcp"),
  ));
}

function renderProfilerTimeline(report) {
  const target = $("#profiler-timeline");
  const entries = (report.timeline ?? []).slice(-200);
  if (!entries.length) {
    target.replaceChildren(element("div", "empty-state", t("profiler.noTimeline")));
    return;
  }
  target.replaceChildren(...entries.map((entry) => {
    const row = element("article", `timeline-entry timeline-${String(entry.kind).toLowerCase()}`);
    const marker = element("span", "timeline-marker");
    const content = element("div", "timeline-content");
    const header = element("header");
    header.append(
      element("strong", "", entry.kind),
      element("span", "tag", entry.evidence_level ?? "UNKNOWN"),
    );
    const detail = element("p", "");
    if (entry.kind === "RESPONSE") {
      detail.textContent = `${formatUiInteger(entry.total_tokens)} ${t("common.tokens")} · ${entry.response_id} · ${entry.status}`;
    } else if (entry.kind === "MCP_TOOL") {
      detail.textContent = `${entry.tool_name} · ${formatUiDuration(entry.duration_ms)} · ${formatUiInteger(entry.output_bytes)} ${t("common.bytes")} · ${entry.status}`;
    } else if (entry.kind === "WORKER") {
      detail.textContent = `${entry.task_id} ${t("profiler.attempt", { attempt: entry.attempt })} · ${formatUiDuration(entry.duration_ms)} · ${t("profiler.turns", { count: entry.turn_count })} · ${entry.status}`;
    } else {
      detail.textContent = `${t("profiler.window", { window: entry.window_number ?? "UNKNOWN" })} · ${t("profiler.retainedEstimate", { count: formatUiInteger(entry.estimated_retained_context_tokens) })} · ${entry.status}`;
    }
    const time = element("time", "mono", formatDateTime(entry.at));
    content.append(header, detail, time);
    row.append(marker, content);
    return row;
  }));
  if (report.timeline_meta?.truncated) {
    target.append(element("p", "inline-state", t("profiler.timelineTruncated", {
      shown: report.timeline_meta.event_count,
      total: report.timeline_meta.total_event_count,
    })));
  }
}

function setProfilerTimelineExpanded(expanded) {
  app.profiler.timelineExpanded = Boolean(expanded);
  const button = $("#profiler-timeline-toggle");
  const body = $("#profiler-timeline-body");
  const labelKey = app.profiler.timelineExpanded
    ? "profiler.collapseTimeline"
    : "profiler.expandTimeline";
  button.setAttribute("aria-expanded", String(app.profiler.timelineExpanded));
  button.setAttribute("aria-label", t(labelKey));
  button.setAttribute("title", t(labelKey));
  body.hidden = !app.profiler.timelineExpanded;
}

function setProfilerTimelineExport(report) {
  const link = $("#export-profiler-timeline");
  if (!report?.report_id || !Array.isArray(report.timeline) || report.timeline.length === 0) {
    link.removeAttribute("href");
    link.removeAttribute("download");
    link.classList.add("disabled-link");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = `/api/profiler/reports/${encodeURIComponent(report.report_id)}/timeline/export`;
  link.setAttribute("download", "");
  link.classList.remove("disabled-link");
  link.setAttribute("aria-disabled", "false");
}

function renderProfilerDiagnostics(report) {
  const target = $("#profiler-diagnostics");
  const diagnostics = report.diagnostics ?? [];
  if (!diagnostics.length) {
    target.replaceChildren(element("div", "empty-state", t("profiler.noDiagnostics")));
    return;
  }
  target.replaceChildren(...diagnostics.map((item) => {
    const card = element("article", `diagnostic-card severity-${String(item.severity).toLowerCase()}`);
    const header = element("header");
    header.append(
      element("strong", "", item.category),
      element("span", `tag ${item.severity === "HIGH" ? "fail" : ""}`.trim(), item.severity),
    );
    card.append(
      header,
      element("p", "", item.fact),
      element("p", "diagnostic-metric", `${item.metric}: ${formatDiagnosticValue(item.value)} · ${item.evidence_level}`),
      element("p", "diagnostic-recommendation", item.recommendation),
    );
    return card;
  }));
}

function renderProfilerReportOptions() {
  for (const select of [$("#profiler-before"), $("#profiler-after")]) {
    const previous = select.value;
    select.replaceChildren(element("option", "", t("common.chooseReport")));
    select.firstElementChild.value = "";
    for (const report of app.profiler.reports) {
      const option = element(
        "option",
        "",
        `${shortHash(report.report_id)} · ${formatUiInteger(report.total_tokens)} ${t("common.tokens")}`,
      );
      option.value = report.report_id;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }
  const reports = app.profiler.reports;
  if (!$("#profiler-before").value && reports[1]) $("#profiler-before").value = reports[1].report_id;
  if (!$("#profiler-after").value && reports[0]) $("#profiler-after").value = reports[0].report_id;
  $("#compare-profiler").disabled = !$("#profiler-before").value || !$("#profiler-after").value;
}

function renderProfilerComparison(comparison) {
  $("#profiler-comparison-status").textContent = comparison.compatibility?.status ?? "COMPLETE";
  const rows = Object.entries(comparison.metrics ?? {}).map(([name, row]) => [
    name,
    formatDiagnosticValue(row.before),
    formatDiagnosticValue(row.after),
    formatDiagnosticValue(row.delta),
    formatUiPercent(row.percent_change),
  ]);
  $("#profiler-comparison").replaceChildren(dataTable(
    [
      t("profiler.table.metric"),
      t("profiler.table.before"),
      t("profiler.table.after"),
      t("profiler.table.delta"),
      t("profiler.table.percent"),
    ],
    rows,
    t("profiler.noMetrics"),
  ));
}

function setProfilerExport(reportId) {
  const link = $("#export-profiler");
  if (!reportId) {
    link.removeAttribute("href");
    link.classList.add("disabled-link");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = `/api/profiler/reports/${encodeURIComponent(reportId)}/export`;
  link.setAttribute("download", "");
  link.classList.remove("disabled-link");
  link.setAttribute("aria-disabled", "false");
}

function dataTable(headers, rows, emptyText) {
  if (!rows.length) return element("div", "empty-state", emptyText);
  const table = element("table", "data-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const header of headers) headRow.append(element("th", "", header));
  head.append(headRow);
  const body = element("tbody");
  for (const row of rows) {
    const rowNode = element("tr");
    for (const value of row) rowNode.append(element("td", "", value));
    body.append(rowNode);
  }
  table.append(head, body);
  return table;
}

function formatDiagnosticValue(value) {
  if (value === null || value === undefined) return "UNKNOWN";
  if (typeof value === "number") {
    return Number.isInteger(value) ? formatUiInteger(value) : value.toFixed(4);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatUiInteger(value) {
  return Number.isSafeInteger(value)
    ? value.toLocaleString(localeForLanguage(app.language))
    : "UNKNOWN";
}

function formatUiPercent(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "UNKNOWN";
}

function formatUiDuration(value) {
  if (!Number.isFinite(value)) return "UNKNOWN";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
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
    throw new Error(t("errors.httpNotJson", { status: response.status }));
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
  wrapper.append(
    element("small", "", label),
    element("strong", "", String(value ?? t("common.unknown"))),
  );
  return wrapper;
}

function exportLink(id) {
  const link = element("a", "text-link", t("common.exportRedacted"));
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
  return Number.isFinite(value) ? value.toFixed(digits) : t("common.unknown");
}

function formatExtraRatio(item, digits = 6) {
  return item?.billing_reconciliation === "PASS" && Number.isFinite(item.effective_extra_ratio)
    ? formatNumber(item.effective_extra_ratio, digits)
    : "INCONCLUSIVE";
}

function formatInteger(value) {
  return Number.isSafeInteger(value)
    ? value.toLocaleString(localeForLanguage(app.language))
    : t("common.unknown");
}

function displayInteger(value) {
  return Number.isSafeInteger(value)
    ? value.toLocaleString(localeForLanguage(app.language))
    : "—";
}

function signedInteger(value) {
  if (!Number.isSafeInteger(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toLocaleString(localeForLanguage(app.language))}`;
}

function formatDateTime(value) {
  if (!value) return t("common.unknown");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? t("common.unknown")
    : date.toLocaleString(localeForLanguage(app.language));
}

export {
  app as __costLabApp,
  refreshStartPlan as __refreshStartPlan,
  setLanguage as __setCostLabLanguage,
};

function setTranslatedText(node, key, parameters) {
  if (!node) return;
  app.transientTranslations.set(node, { key, parameters });
  node.dataset.i18n = key;
  node.textContent = t(key, parameters);
}

function applyTransientTranslations() {
  for (const [node, message] of app.transientTranslations) {
    if (!node.isConnected) {
      app.transientTranslations.delete(node);
      continue;
    }
    node.textContent = t(message.key, message.parameters);
  }
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
