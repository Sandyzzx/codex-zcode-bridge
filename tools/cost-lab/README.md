# Cost Lab

Cost Lab is the local verification tool for the installed official ZCode runtime,
Coding Plan request usage, and official credit ledger. It separates runtime
identity, request success, Token accounting, and billing eligibility; a successful
task is not treated as proof of the `0.67` extra-credit multiplier.

## Start The Web UI

Prerequisites:

- Windows x64.
- Node.js `24.16.x`.
- Installed ZCode Desktop `3.18.2.10443`.
- A signed-in personal Coding Plan with available credits.
- A current Bridge build because real verification drives
  `dist/src/mcp/main.js`.

```powershell
npm run build
npm run cost-lab:web
```

The command prints a `http://127.0.0.1:<port>/` URL. The server always binds the
IPv4 loopback address and selects a free port unless `COST_LAB_PORT` is set.

Page load only reads the local environment and redacted history. It does not send
a model request or call the official billing RPC. Those actions require explicit
buttons:

- **Run environment check** performs local discovery and integrity checks.
- **Run deep protocol smoke** starts and stops the installed official AppServer,
  calls only `runtime/capabilities`, creates no Session, and sends no model
  request.
- **Read official snapshot** calls the existing official Usage Service accessor.
- **Authorize real verification** sends one real Coding Plan task only after the
  user checks the explicit consent control and the browser submits the fixed
  confirmation phrase `START REAL CODING PLAN VERIFICATION`.

Start Plan is intentionally offline-only in this version. The UI exposes no Start
Plan execution API or button.

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

## Local Data And Redaction

- History: `.run/cost-lab-web/history.json`
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
GET  /api/start-plan
```

There is no generic command, filesystem, URL, or shell endpoint. State-changing
requests require same-origin, CSRF, and same-site validation. Billing and
verification inputs are fixed; callers cannot supply a data root, provider,
endpoint, executable, or arbitrary model.

## Tests

```powershell
npm run cost-lab:test
```

The suite covers official billing normalization and reconciliation, the official
runtime vendor identity, the built MCP verification runner, local UI serving,
zero-model page load, CSRF/origin rejection, bounded protocol smoke, redaction,
history persistence, export, server shutdown, and loopback-only binding.

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
- Start Plan compatibility is offline research only. Live Start Plan E2E,
  entitlement, CAPTCHA behavior, and discount remain unverified.
