# Cost Lab

Cost Lab is the local verification tool for the installed official ZCode runtime,
Coding Plan request usage, and the independent Start Plan token balance. It
separates runtime identity, request success, Token accounting, and billing
eligibility; a successful task is not treated as proof of the `0.67`
extra-credit multiplier.

## Start The Web UI

Prerequisites:

- Windows x64.
- Node.js `24.16.x`.
- Installed ZCode Desktop `3.18.2.10443`.
- A signed-in personal Coding Plan with available credits when using the Coding
  Plan verification.
- A signed-in Start Plan when refreshing the Start Plan balance.
- A current Bridge build because real verification and Start Plan billing use
  compiled official runtime modules under `dist/src/`.

```powershell
npm run build
npm run cost-lab:web
```

The command prints a `http://127.0.0.1:<port>/` URL. The server always binds the
IPv4 loopback address and selects a free port unless `COST_LAB_PORT` is set.
The interface supports English and Simplified Chinese from the header switch.
The selection is stored only in browser-local storage; technical evidence
states such as `PASS`, `FAIL`, `UNKNOWN`, and `OBSERVED` remain unchanged.

Page load only reads the local environment and redacted history. It does not send
a model request or call the official billing RPC. Those actions require explicit
buttons:

- **Run environment check** performs local discovery and integrity checks.
- **Run deep protocol smoke** starts and stops the installed official AppServer,
  calls only `runtime/capabilities`, creates no Session, and sends no model
  request.
- **Read official snapshot** calls the existing official Usage Service accessor.
- **Refresh balance** in **Billing & Usage** performs one read-only official
  Start Plan `billing/balance` GET.
- **Authorize real verification** sends one real Coding Plan task only after the
  user checks the explicit consent control and the browser submits the fixed
  confirmation phrase `START REAL CODING PLAN VERIFICATION`.

Start Plan model execution is not exposed by Cost Lab. Its separate overview
shows the official token entitlement, usage progress, balance buckets, period,
expiry, and stored snapshot history. Coding Plan credits and Start Plan token
units are never combined.

## Verification Flow

1. The local UI obtains an origin-bound CSRF token.
2. The user explicitly authorizes the fixed provider/model/reasoning tuple.
3. The server captures a fresh official Coding Plan snapshot.
4. `production-verification-runner.mjs` starts the built Bridge MCP entry with an
   isolated HOME, Bridge data root, and harmless workspace.
5. The production Worker resolves the verified installed official AppServer and
   runs the task through the existing MCP/Worker/SQLite lifecycle.
6. Cost Lab records `zcode_task`, `zcode_status`, `zcode_result`, and
   `zcode_events` evidence.
7. The server captures a fresh after-snapshot and reconciles the exact hourly
   Token delta. Credit class is evaluated only when cached input, uncached input,
   output, and total Tokens all match.

Official settlement can lag the completed model turn. Cost Lab retries the same
hour bucket for a bounded window of about 2.5 minutes and stops as soon as a
Token delta is visible. A still-missing delta is reported as `INCONCLUSIVE`, not
as a zero-credit or free request.

The runner does not implement authentication, request signing, Provider routing,
or a second billing client. It uses the production MCP entry and the existing
`coding-plan-billing.mjs` official Usage Service accessor.

## Start Plan Billing

The Start Plan panel reuses the official
`StartPlanBillingEntitlement` and
`createOfficialStartPlanAuthenticationResolver` chain. The Web Server never
assembles its own JWT, decryption, device identity, or request headers.

The official endpoint is:

```text
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2
```

Refresh is an explicit local action:

- At most one official GET is made per refresh.
- Concurrent refresh clicks share one in-flight read.
- A cooldown prevents rapid repeated reads.
- 401, 403, 429, transport failure, and timeout are not retried.
- A failed refresh leaves the latest successful snapshot and history intact.
- Opening or reloading a page never calls the official billing endpoint.

The normalized snapshot keeps official token units and null/missing fields. It
does not translate Start Plan tokens into Coding Plan credits. A bucket with an
ended period or expiry is marked `EXPIRED`; it is not presented as a live
balance.

## Billing Semantics

```text
BASE_CREDITS =
  (uncached_input * 2.3
   + cached_input * 0.56
   + output * 8) / 10000

EXPECTED_NORMAL = BASE_CREDITS * time_multiplier
EXPECTED_WITH_0_67 = EXPECTED_NORMAL * 0.67
EFFECTIVE_EXTRA_RATIO = ACTUAL_CREDITS / EXPECTED_NORMAL
```

The time multiplier and extra campaign multiplier are reported separately.
Ordinary off-peak `0.5` is not evidence of an additional `0.67` discount. A mixed
bucket or mismatched request Usage remains `INCONCLUSIVE`.

## Agent Token Profiler

The **Token Profiler** reads local Codex rollout metadata and the Bridge SQLite
state without changing either source. It connects Codex Master and Subagent
threads to dispatched ZCode Workers, then reports token usage, tool and MCP
waiting, deterministic work-phase attribution, context/cache observations,
compactions, diagnostics, and historical comparisons.

The CLI and Web UI call the same analysis core. Stored artifacts stay under
`.run/cost-lab/profiler/`:

```powershell
node tools/cost-lab/cli.mjs profiler sessions
node tools/cost-lab/cli.mjs profiler analyze --thread <thread-id>
node tools/cost-lab/cli.mjs profiler analyze --goal <goal-id>
node tools/cost-lab/cli.mjs profiler analyze --from <time> --to <time>
node tools/cost-lab/cli.mjs profiler report --id <report-id>
node tools/cost-lab/cli.mjs profiler reports
node tools/cost-lab/cli.mjs profiler compare --before <report-id> --after <report-id>
```

Use `--json` for machine-readable output. Incremental collection is the default.
Use `--full` for a complete rescan, and repeat `--rollout`, `--bridge-sqlite`,
or `--history` to analyze an explicit local source. `--only-explicit-sources`
and `--no-default-bridge` prevent the default source roots from being added.

Profiler evidence is deliberately split:

- `OBSERVED`: response or worker usage reported by Codex or Bridge.
- `ATTRIBUTED`: phase and MCP relationships derived from timestamps, tool names,
  parent IDs, and dispatch IDs.
- `ESTIMATED`: byte-to-token estimates for locally observable tool/context
  content. These values are never treated as provider-reported Usage.
- `UNKNOWN`: missing usage or attribution that cannot be established from the
  local records.

Cached input remains a subset of input, response-level Usage is not added to an
observed cumulative total, and Master, Subagent, and Worker usage remain separate.
Pure MCP wait time is wall-clock evidence only; it does not create model tokens.
Provider and model totals are not combined into one billing unit.

The Web UI keeps the Session timeline collapsed by default. Its disclosure
state is accessible through `aria-expanded`, survives language changes for the
same report, and resets to collapsed when a different report is loaded. The
timeline export is a sanitized JSON document containing report metadata, agent
scope, timeline metadata, and only the known timeline fields. It does not
export retained prompt, tool-result, reasoning, credential, or arbitrary
content fields.

## Local Data And Redaction

- History: `.run/cost-lab-web/history.json`
- Start Plan history: `.run/cost-lab-web/startplan-history.json`
- Verification workspaces and Bridge profiles:
  `.run/cost-lab-web/verifications/<verification-id>/`
- Protocol-smoke temporary roots are removed after cleanup.
- Raw billing snapshots written by the CLI default to `.run/cost-lab-billing/`.

History and exports redact credential-shaped fields and absolute user paths. The
server never returns credential contents and does not put API keys, JWTs, OAuth
tokens, Project Tokens, cookies, or Authorization headers in browser storage.

## API Surface

The server has a fixed allowlist:

```text
GET  /api/session
GET  /api/health
GET  /api/environment
POST /api/environment/check
POST /api/billing/snapshot
POST /api/verifications
GET  /api/verifications/:id
GET  /api/history
GET  /api/history/:id/export
GET  /api/billing/startplan/latest
GET  /api/billing/startplan/history?from=&to=&limit=
POST /api/billing/startplan/refresh
GET  /api/billing/startplan/history/:id/export
GET  /api/start-plan
GET  /api/profiler/latest
GET  /api/profiler/reports
GET  /api/profiler/reports/:id
GET  /api/profiler/reports/:id/export
GET  /api/profiler/reports/:id/timeline/export
POST /api/profiler/collect
POST /api/profiler/analyze
POST /api/profiler/compare
```

There is no generic command, filesystem, URL, or shell endpoint. State-changing
requests require same-origin, CSRF, and same-site validation. Billing and
verification inputs are fixed; callers cannot supply a data root, provider,
endpoint, executable, or arbitrary model.

Start Plan history stores the sanitized official response and normalized
snapshot. Credential fields, Authorization headers, cookies, device MID values,
and raw opaque account/bucket/entitlement identifiers are removed or replaced
with stable hashes. Browser responses and exports also omit absolute user paths.

Profiler snapshots and reports retain IDs, timestamps, token metadata, tool
metadata, and byte counts. They do not retain prompt bodies, source code,
reasoning text, MCP arguments, or tool-result content. Model-specific token
groups remain separate and do not imply billing credits.

## Tests

```powershell
npm run cost-lab:test
```

The suite covers official billing normalization and reconciliation, Start Plan
parsing and sanitization, exact official GET guard, freshness/expiry, bucket
comparison, concurrent refresh deduplication, failure retention, history,
export, frontend view states, the official runtime vendor identity, the built MCP
verification runner, local UI serving, zero-model page load, CSRF/origin
rejection, bounded protocol smoke, redaction, server shutdown, and loopback-only
binding.

## Known Limits

- Billing uses the official hourly aggregate. A request is attributable only when
  the before/after Token delta exactly matches the local request evidence and no
  parallel activity is present.
- Settlement may arrive after the bounded after-snapshot retry window. A missing
  delta remains inconclusive and must not be interpreted as zero credits.
- Auxiliary model requests may not expose individual Usage. Missing Usage is kept
  as missing and can make the result `INCONCLUSIVE`.
- The MCP event surface does not expose a complete wire capture of the official
  signing handshake. The verification evidence records installed-bundle identity
  and the official runtime path; it does not claim to observe every wire frame.
- Start Plan support here is read-only billing. A successful balance response
  does not verify model execution, CAPTCHA behavior, or any discount.
- Start Plan is refreshed from the currently signed-in official account. A
  changed account, bucket, entitlement, unit, or billing period is explicitly
  marked non-comparable instead of being treated as consumption.
