import assert from "node:assert/strict";
import test from "node:test";

const nodes = new Map();
const storage = new Map();

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.classList = {
      add: () => undefined,
      remove: () => undefined,
    };
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
    this.style = {};
    this.textContent = "";
    this.title = "";
    this.value = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

function node(id) {
  if (!nodes.has(id)) nodes.set(id, new FakeNode());
  return nodes.get(id);
}

globalThis.document = {
  addEventListener: () => undefined,
  createElement: (tag) => new FakeNode(tag),
  documentElement: { lang: "en" },
  querySelector: (selector) => selector.startsWith("#") ? node(selector.slice(1)) : null,
  querySelectorAll: () => [],
  title: "",
};

globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  },
  navigator: { language: "en-US" },
};

const {
  __costLabApp: app,
  __refreshStartPlan: refreshStartPlan,
  __setCostLabLanguage: setLanguage,
} = await import("../web/app.js");

function response(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => ok
      ? { ok: true, data }
      : {
          ok: false,
          error: { message: data?.message ?? "Request failed" },
        },
  };
}

function snapshot(capturedAt) {
  return {
    id: "snapshot-1",
    captured_at: capturedAt,
    plan_id: "plan-1",
    plan_type: "Start Plan",
    plan_status: "ACTIVE",
    total_balance: 100,
    used_balance: 20,
    remaining_balance: 80,
    unit_type: "tokens",
    entitlement_status: "ACTIVE",
    billing_period: null,
    expiry: null,
    buckets: [],
  };
}

test("Start Plan refresh transitions from Chinese LOADING to FRESH with locale-aware captured time", async () => {
  const capturedAt = new Date().toISOString();
  let releaseRefresh;
  globalThis.fetch = (url) => {
    if (url === "/api/billing/startplan/refresh") {
      return new Promise((resolve) => {
        releaseRefresh = () => resolve(response({
          snapshot: snapshot(capturedAt),
          deduplicated: false,
        }));
      });
    }
    if (url === "/api/billing/startplan/latest") {
      return Promise.resolve(response({ snapshot: snapshot(capturedAt) }));
    }
    if (url === "/api/billing/startplan/history?limit=25") {
      return Promise.resolve(response({ items: [] }));
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  app.csrfToken = "test-csrf";
  setLanguage("zh-CN", { persist: false, rerender: false });
  const pending = refreshStartPlan();
  await Promise.resolve();

  assert.equal(node("startplan-state").textContent, "正在读取官方 billing/balance...");
  assert.equal(node("startplan-freshness").textContent, "加载中");

  releaseRefresh();
  await pending;
  assert.equal(node("startplan-freshness").textContent, "FRESH");
  assert.equal(
    node("startplan-state").textContent,
    `官方快照已采集：${new Date(capturedAt).toLocaleString("zh-CN")}。`,
  );

  setLanguage("en", { persist: false });
  assert.equal(node("startplan-freshness").textContent, "FRESH");
  assert.equal(
    node("startplan-state").textContent,
    `Official snapshot captured ${new Date(capturedAt).toLocaleString("en-US")}.`,
  );
  clearTimeout(app.toastTimer);
});

test("a successful refresh preserves the load error when local Start Plan state cannot be read", async () => {
  globalThis.fetch = (url) => {
    if (url === "/api/billing/startplan/refresh") {
      return Promise.resolve(response({
        snapshot: snapshot(new Date().toISOString()),
        deduplicated: false,
      }));
    }
    if (url === "/api/billing/startplan/latest") {
      return Promise.resolve(response({ message: "latest unavailable" }, {
        ok: false,
        status: 503,
      }));
    }
    if (url === "/api/billing/startplan/history?limit=25") {
      return Promise.resolve(response({ items: [] }));
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  setLanguage("en", { persist: false });
  await refreshStartPlan();
  assert.equal(node("startplan-freshness").textContent, "ERROR");
  assert.equal(
    node("startplan-state").textContent,
    "Unable to load local Start Plan state: latest unavailable",
  );
  clearTimeout(app.toastTimer);
});
