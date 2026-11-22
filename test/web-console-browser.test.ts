import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import type { TaskStatusRecord } from "../src/interfaces.js";
import type { ListTasksInput, TaskListPage } from "../src/task-list.js";
import {
  createTaskConsoleServer,
  type CostLabConsoleApplication,
  type RuntimeCompatibilityConsoleApplication,
  type TaskConsoleManager,
} from "../src/web/server.js";

const chromePath = resolveChromeExecutable();

function resolveChromeExecutable(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

interface BrowserFixture extends TaskConsoleManager {
  state: "running" | "completed";
  statusCalls: number;
  cancelCalls: number;
}

function browserFixture(): BrowserFixture {
  const fixture: BrowserFixture = {
    state: "running",
    statusCalls: 0,
    cancelCalls: 0,
    async listTasks(input: ListTasksInput): Promise<TaskListPage> {
      if (input.after_task_id === undefined) {
        return {
          tasks: [{
            task_id: "task-a",
            status: "running",
            attempt: 1,
            created_at: "2026-01-01T00:00:00Z",
            workspace: "C:\\work",
            objective: "First-page task",
          }],
          next_task_id: "task-a",
          has_more: true,
        };
      }
      if (input.after_task_id === "task-a") {
        return {
          tasks: [{
            task_id: "task-deep",
            status: fixture.state,
            attempt: 2,
            created_at: "2026-01-01T00:00:00Z",
            workspace: "C:\\work",
            objective: "Deep-linked task",
            wake: {
              state: "web_notify",
              reason_code: "policy_missing",
              at: "2026-01-01T00:02:30Z",
            },
          }],
          next_task_id: null,
          has_more: false,
        };
      }
      return { tasks: [], next_task_id: null, has_more: false };
    },
    async getStatus(taskId): Promise<TaskStatusRecord> {
      fixture.statusCalls += 1;
      return {
        task_id: taskId,
        status: fixture.state,
        attempt: taskId === "task-deep" ? 2 : 1,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:02:00Z",
        started_at: "2026-01-01T00:00:10Z",
        finished_at: fixture.state === "completed" ? "2026-01-01T00:02:00Z" : null,
        worker_pid: 4242,
        zcode_session_id: "session-browser",
        exit_code: fixture.state === "completed" ? 0 : null,
      };
    },
    async getEvents(input) {
      return {
        task_id: input.task_id,
        status: fixture.state,
        events: [{
          seq: 1,
          at: "2026-01-01T00:00:10Z",
          type: "turn_started",
          summary: "Browser fixture started",
        }],
        next_seq: 1,
        has_more: false,
      };
    },
    async getResult(taskId) {
      if (fixture.state !== "completed") {
        throw Object.assign(new Error("task is not finished"), { code: "TASK_NOT_FINISHED" });
      }
      return {
        task_id: taskId,
        status: "completed",
        summary: "Synthetic browser result",
        files_changed: [],
        tests: [],
        issues: [],
        needs_master_decision: false,
        zcode_output: "browser evidence",
        exit_code: 0,
        session_id: "session-browser",
        attempt: taskId === "task-deep" ? 2 : 1,
        started_at: "2026-01-01T00:00:10Z",
        finished_at: "2026-01-01T00:02:00Z",
      };
    },
    async getAttention(taskId) {
      return {
        task_id: taskId,
        attempt: taskId === "task-deep" ? 2 : 1,
        status: fixture.state,
        pending_requests: [],
      };
    },
    async cancelTask(taskId) {
      fixture.cancelCalls += 1;
      return this.getStatus(taskId);
    },
    async replyToInteraction() {
      throw new Error("not used");
    },
  };
  return fixture;
}

function browserCostLab(calls: string[]): CostLabConsoleApplication {
  return {
    async mountEndpoints() {},
    async handleRequest(request: IncomingMessage, response: ServerResponse) {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      calls.push(`${request.method} ${pathname}`);
      request.resume();
      const data = (() => {
        if (pathname === "/api/cost-lab/session") {
          return {
            csrf_token: "browser-cost-token",
            provider: "account:bigmodel-individual-coding-plan",
            model: "GLM-5.3-Flash",
            confirmation_phrase: "not used",
          };
        }
        if (pathname === "/api/cost-lab/environment") {
          return {
            zcode: {
              runtime_status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
              version: "3.19.0.10774",
              installation_safety: "OFFICIAL_INSTALLATION_SAFE",
              discount_status: "OFFICIAL_DISCOUNT_NOT_VERIFIED",
            },
            billing_reader: { status: "NOT_RUN" },
          };
        }
        if (pathname === "/api/cost-lab/history") return { items: [] };
        if (pathname === "/api/cost-lab/billing/startplan/latest") return { snapshot: null };
        if (pathname === "/api/cost-lab/billing/startplan/history") return { items: [] };
        return { items: [] };
      })();
      const body = `${JSON.stringify({ ok: true, data })}\n`;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      response.end(body);
    },
    async close() {},
  };
}

function browserRuntime(calls: string[]): RuntimeCompatibilityConsoleApplication {
  return {
    async inspect() {
      calls.push("inspect");
      return {
        fingerprint: "a".repeat(64),
        runtime_changed: true,
        previous_fingerprint: "b".repeat(64),
        changed_assets: ["bundle"],
        manifest_modified: false,
        model_requests: 0,
        installation: {
          desktop_version: "3.19.0.10774",
          desktop_app_version: "3.19.0",
          desktop_build_commit_id: "abc123",
          node_version: "24.16.0",
          installation_safety: "OFFICIAL_INSTALLATION_SAFE",
          runtime_status: "OFFICIAL_RUNTIME_EXPERIMENTAL",
          manifest_status: "EXPERIMENTAL",
          experimental_authorization: { state: "authorized", scopes: ["coding_plan_probe"] },
          assets: {
            bundle: { bytes: 1, sha256: "1".repeat(64) },
            runtime_host: { bytes: 2, sha256: "2".repeat(64) },
            builtin_provider_config: { bytes: 3, sha256: "3".repeat(64) },
            desktop_executable: { bytes: 4, sha256: "4".repeat(64) },
            desktop_archive: { bytes: 5, sha256: "5".repeat(64) },
          },
        },
        capabilities: {
          installation_safety: { status: "SAFE", source: "static", limitation: null },
          manifest_compatibility: { status: "EXPERIMENTAL", source: "manifest", limitation: null },
          protocol: { status: "PASS", source: "zero-model probe", limitation: null },
          coding_plan_execution: { status: "NOT_RUN", source: "none", limitation: "Not authorized" },
        },
        evidence: [],
      };
    },
    async runAuthorizedProtocolProbe() {
      calls.push("probe");
      throw new Error("browser fixture must not run a protocol probe");
    },
    async candidateReport() {
      calls.push("candidate");
      return { kind: "runtime_compatibility_candidate" };
    },
  };
}

async function waitForText(page: import("playwright-core").Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector: target, text: expected }) =>
      document.querySelector(target)?.textContent?.includes(expected) === true,
    { selector, text },
    { timeout: 10_000 },
  );
}

test("real Chromium preserves Task deep links, UI preferences, and zero-cost console views", {
  timeout: 60_000,
  skip: chromePath === null ? "Google Chrome is not installed for the browser E2E" : false,
}, async () => {
  const fixture = browserFixture();
  const costCalls: string[] = [];
  const runtimeCalls: string[] = [];
  const server = createTaskConsoleServer({
    manager: fixture,
    costLab: browserCostLab(costCalls),
    runtimeCompatibility: browserRuntime(runtimeCalls),
    executorStatus: async () => ({ state: "active", lease_id: "lease-browser" }),
  });
  const profileBase = path.join(process.env.LOCALAPPDATA ?? tmpdir(), "Temp");
  mkdirSync(profileBase, { recursive: true });
  const profile = mkdtempSync(path.join(profileBase, `bridge-web-console-${process.pid}-`));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath!,
    headless: true,
    locale: "en-US",
    args: ["--disable-background-networking", "--no-first-run"],
    // The isolated runner relocates HOME/USERPROFILE; Chrome still needs the
    // real OS home to initialize its path service. The browser data stays in
    // the short-lived profile above.
    env: { ...process.env, HOME: userInfo().homedir, USERPROFILE: userInfo().homedir },
  });
  const page = context.pages()[0] ?? await context.newPage();
  const pageErrors: string[] = [];
  const pageRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => pageRequests.push(request.url()));
  try {
    const address = await server.start();
    await page.goto(`${address.origin}/?task_id=task-deep#tasks`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#task-detail h3")?.textContent === "task-deep",
    );
    await waitForText(page, "#task-detail", "Result pending");
    assert.equal(new URL(page.url()).searchParams.get("task_id"), "task-deep");

    fixture.state = "completed";
    await page.waitForFunction(
      () => document.querySelector("#task-detail")?.textContent?.includes("Synthetic browser result") === true,
      undefined,
      { timeout: 12_000 },
    );
    assert.ok(fixture.statusCalls >= 2, "the selected Task must be refreshed by the existing polling loop");

    await page.locator(".task-row").filter({ hasText: "task-a" }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("task_id") === "task-a");
    assert.equal(
      await page.locator("#task-detail h3").textContent(),
      "task-a",
      "manual Task selection must update both the detail and the URL",
    );

    for (const theme of ["light", "dark", "system"]) {
      await page.selectOption("#theme", theme);
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    }
    await page.selectOption("#theme", "dark");
    await page.selectOption("#language", "zh-CN");
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("bridge.ui.theme")),
      "dark",
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("bridge.ui.language")),
      "zh-CN",
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => document.querySelector("#task-detail h3")?.textContent === "task-a",
    );
    assert.equal(new URL(page.url()).searchParams.get("task_id"), "task-a");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    assert.equal(
      await page.locator(".task-row.selected .task-id").textContent(),
      "task-a",
      "a deep link restored after refresh must retain its selected row",
    );

    await page.locator('.tab[data-page="cost-lab"]').click();
    await page.waitForFunction(
      () => document.querySelector("#cost-runtime")?.textContent === "OFFICIAL_RUNTIME_EXPERIMENTAL",
    );
    await waitForText(page, "#page-cost-lab", "Coding Plan");
    assert.ok(costCalls.some((call) => call === "GET /api/cost-lab/environment"));
    assert.equal(costCalls.some((call) =>
      call.includes("/verifications") ||
      call.includes("/billing/snapshot") ||
      call.includes("/billing/startplan/refresh")), false);

    await page.locator('.tab[data-page="runtime"]').click();
    await page.waitForFunction(
      () => document.querySelector("#runtime-fingerprint")?.textContent === "aaaaaaaaaaaa…aaaaaaaa",
    );
    await waitForText(page, "#page-runtime", "RUNTIME_CHANGED");
    assert.deepEqual(runtimeCalls, ["inspect"]);
    assert.equal(pageRequests.some((url) =>
      url.includes("/api/runtime/protocol-probe") ||
      url.includes("/api/cost-lab/verifications") ||
      url.includes("/api/cost-lab/billing/snapshot")), false);

    const evidenceDirectory = process.env.BRIDGE_BROWSER_EVIDENCE_DIR;
    if (evidenceDirectory) {
      mkdirSync(evidenceDirectory, { recursive: true });
      await page.screenshot({
        path: path.join(evidenceDirectory, "operations-console-runtime.png"),
        fullPage: true,
      });
    }

    await page.close();
    assert.equal(fixture.cancelCalls, 0, "closing the browser must not cancel an Executor-owned Task");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await server.close().catch(() => undefined);
  }
});
