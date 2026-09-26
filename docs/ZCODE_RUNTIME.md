# ZCode Runtime Verification

Re-verified on 2026-09-26 (Asia/Shanghai) on the current Windows x64 machine. This revision supersedes the same-day earlier revision: the provider-configuration blocker was root-caused, a supported fix was found, and a real headless smoke task plus `--resume` now pass. Everything below was checked in this session unless marked otherwise.

Status labels used here:

- **VERIFIED** — reproduced on this machine in this session, with recorded command output, file evidence, or minified-source inspection as proof.
- **ASSUMED** — plausible from code inspection or reference material, but not exercised end-to-end here.
- **UNSUPPORTED** — confirmed absent or unavailable on this installation.
- **NOT VERIFIED** — not tested; unknown. Bridge work must not rely on these.

## Environment facts (VERIFIED)

| Item | Finding | Evidence |
|---|---|---|
| ZCode Desktop | **3.14.3.7762** at `C:\Users\Sandy\AppData\Local\Programs\ZCode` | `(Get-Item '...\ZCode.exe').VersionInfo` |
| Runtime CLI | **zcode 0.16.9** | `node <zcode.cjs> version` |
| Runtime entry | `C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs` (14.8 MB) | file listing |
| Node | **v24.16.0** at `C:\Program Files\nodejs\node.exe` | `node --version`, `where node` |
| doctor | `node: v24.16.0`, `platform: win32/x64`, `sea: no (optional)`, `default artifact: node-bundle` | `node <zcode.cjs> doctor` |
| Desktop data base dir | `D:\Program Files\.zcode` (injected as `ZCODE_DATA_BASE_DIR=D:\Program Files` by the Desktop); a user-profile data dir also exists at `C:\Users\Sandy\.zcode` | inherited environment of Desktop-spawned processes |
| CLI help | `--prompt/-p`, `--json`, `--mode <build\|edit\|plan\|yolo>` (default `yolo` for `--prompt`), `--cwd`, `--resume <sessionId>` (`sess_...`), `-c/--continue`, `--target`, `--target-replace`, `--attach`, `--surface`, `--browser-use`, `--disallowed-tools`, `--verbose`, `--no-browser`, `--no-color` | `node <zcode.cjs> --help` |
| Shipped provider config | `C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\config\provider\zcode-builtin.json` exists; top-level keys `schemaVersion`, `revision`, `config` (values not dumped) | file listing + key names only |

### Advertised vs. actually effective (kept separate as required)

| Switch | In help | Actually exercised in a successful task |
|---|---|---|
| `--prompt` | yes | **VERIFIED** (all smoke runs) |
| `--json` | yes | **VERIFIED** (single JSON object on stdout; see schema below) |
| `--mode yolo` | yes | **VERIFIED** as accepted and sufficient for an autonomous file write in the smoke task; per-tool permission semantics not separately probed |
| `--cwd` | yes | **VERIFIED**: with the driver spawning from a different cwd, the agent created the file inside `--cwd`, proven by independent directory listing of the workspace |
| `--resume <sessionId>` | yes | **VERIFIED** (see Resume section) |
| `-c/--continue` | yes | NOT VERIFIED (never run) |
| `--target`, `--attach`, `--surface`, `--browser-use`, `--disallowed-tools`, `--memory-bench`, `--verbose` | yes (`--verbose` was used once in a successful run without corrupting the JSON output) | otherwise NOT VERIFIED |

## Root cause of the earlier headless failure (VERIFIED)

Deterministic reproduction: spawning the CLI with every `ZCODE_*` key removed from the child environment (verified by inspecting the child's env keys) exits 1 in ~0.8 s with no stdout and stderr exactly:

```text
无法定位 CLI ZCode Built-in Provider Config：C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\provider\zcode-builtin.json, C:\Users\Sandy\AppData\config\provider\zcode-builtin.json
```

Inspection of the minified CLI (`resolveBundledZCodeBuiltinProviderConfig`): outside a SEA binary the CLI probes two candidate paths derived from its entrypoint directory — `<entrypoint dir>\provider\zcode-builtin.json`, then `resolve(dir, "../../../../../config/provider/zcode-builtin.json")`. From `...\ZCode\resources\glm`, five levels up lands in `C:\Users\Sandy\AppData`, so the fallback misses the shipped `resources\config\provider\zcode-builtin.json` by three directory levels. This is the same lookup drift Reference B documented for Linux, now confirmed in this Windows build's code path. Neither candidate exists on this machine, so a bare environment cannot start.

### Supported fix: environment variables, no file copying (VERIFIED)

Inspection of `prepareCliProviderRuntimeEnv` (called at CLI startup, result merged into `process.env`):

- If **both** `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` are set in the environment, the function returns them as-is and the broken probe never runs.
- When the Desktop app spawns the CLI it injects these variables (plus others); that is why headless runs launched from a Desktop-attached shell worked all along. A Bridge spawned outside that context must set them itself.
- No files were copied and the ZCode installation was not modified at any point. The earlier idea of copying the shipped config into the expected path is unnecessary and was not done.

Verified working values on this machine:

- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` → the shipped `C:\...\ZCode\resources\config\provider\zcode-builtin.json` (VERIFIED in successful runs), or the Desktop-refreshed active copy `D:\Program Files\.zcode\v2\runtime\provider\windows-x86_64\3.14.3\endpoint-78d7c3bef4024722642626fe3669a799\zcode-builtin.json` (VERIFIED). Both work.
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` → an **existing, real** personal config. On this machine only `D:\Program Files\.zcode\v2\provider_config.json` (1073 bytes, dated 2026-09-17) qualifies:
  - pointing the variable at a **missing** file, or at the 206-byte stub the CLI auto-created at `C:\Users\Sandy\.zcode\v2\provider_config.json`, reliably failed with `Error: Model creation failed (traceId: ...)` exit 1 (3/3 attempts, occurring both before and after transient network issues cleared, while other configs succeeded in the same windows);
  - pointing it at the real `D:\Program Files\.zcode\v2\provider_config.json` succeeded in every attempt once transient issues cleared.
- The minimal set that passed: **only these two variables**, with every other `ZCODE_*` key removed and no proxy variables (3/3 plus additional runs). Passing runs with the full Desktop-injected environment also occurred, so extra variables are harmless but not required.

### Transient failure mode (VERIFIED as intermittent; cause NOT VERIFIED)

`Error: Bundled 与 Active ZCode Built-in Release 均不可用` (exit 1, no stdout) appeared in a burst of runs over several minutes across *different* environment configurations — including the full Desktop-inherited environment — and then stopped recurring; identical configurations passed repeatedly afterwards. Suspected remote release-refresh flakiness or rate limiting under rapid successive model calls; not root-caused. Consequence for the Bridge: distinguish configuration failures (`无法定位 ... Provider Config`, `Model creation failed`) from this retryable class, and retry the latter before reporting task failure.

## Smoke task (VERIFIED)

Command shape (argv array via Node `spawn`, `shell: false`, run from an isolated directory under the system temp):

```text
node <zcode.cjs> --prompt <prompt> --json --mode yolo --cwd <temp workspace>
```

with the two provider environment variables set as above. Prompt: create exactly one file `bridge-smoke.txt` containing the single line `ZCODE_HEADLESS_SMOKE_OK`, touch nothing else.

Observed:

- Exit code **0**, duration ~6.8 s, stderr empty.
- stdout is **one parseable JSON object** (whole-stdout parse succeeded; no interleaved lines).
- Independent file check (not trusting the agent's own response): workspace contains exactly one file, `bridge-smoke.txt`, content exactly `ZCODE_HEADLESS_SMOKE_OK\n`. This proves `--cwd` took effect and the agent stayed in scope for this task.

### JSON result schema as observed (VERIFIED for CLI 0.16.9 on this machine; treat as version-specific)

Top-level keys exactly: `sessionId`, `traceId`, `turnId`, `response` (string), `usage` (object), `eventCount` (number), `projection` (object).

- `sessionId` format `sess_<uuid>`.
- `usage` keys: `source` (`"provider"`), `modelRequestCount`, `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `webFetchRequests`, `webSearchRequests`.
- `projection` keys: `status` (`"idle"`), `turnCount`, `totalTokenCount`, `contextUsed`, `contextWindow` (200000).
- On config/startup failures the process exited 1 with an **empty stdout** and a one-line plain-text error on stderr — Bridge must parse JSON only for exit 0 (and still validate required fields), keeping raw stderr for diagnosis.

## Resume (VERIFIED)

`--resume sess_c7862fca-...` with the session ID returned by the smoke run, same command shape and same `--cwd`:

- Exit 0; the returned `sessionId` was **identical** to the requested one; `traceId`/`turnId` were new, consistent with a new turn inside the same session.
- Independent evidence of genuine continuity: the same workspace file gained the requested appended line (`ZCODE_HEADLESS_SMOKE_OK` + `RESUME_CONTINUATION_OK`), and `usage.cacheReadTokens` (~39.8k) shows conversation-cache reuse. Still exactly one file in the workspace.
- Cross-`--cwd` resume was not tested and is NOT VERIFIED.

## Assumed / NOT VERIFIED

- Whether a freshly logged-in machine (no prior Desktop use) can run headless with only the two env vars pointing at the shipped builtin plus a CLI-created personal config. The CLI did auto-create a stub personal config during this session, but that stub did **not** support model creation (see above); the repair path for an insufficient personal config is NOT VERIFIED.
- Exit-code taxonomy beyond 0 (success) and 1 (all observed failures — config discovery, model creation, transient refresh). Timeout and cancellation codes are NOT VERIFIED; hard-timeout kill behavior (process tree on Windows) is NOT VERIFIED.
- Long-running task behavior: the smoke task took ~7 s; streaming output, partial JSON, and behavior when output exceeds pipe buffers are NOT VERIFIED.
- Concurrent sessions and concurrent `--resume` of one session: NOT VERIFIED.
- Whether `--json` shape, `usage`, `projection`, or `sess_` ID format change across CLI versions: NOT VERIFIED (schema recorded above is version-specific evidence, not a contract).
- Network-dependence details: all successful minimal runs had direct connectivity; behavior behind proxies/firewalls other than the observed transient refresh error is NOT VERIFIED.

## Unsupported / not available (VERIFIED)

- No `zcode` command on PATH (`where.exe zcode` finds nothing); invoke the verified full `zcode.cjs` path through Node after a preflight.
- `--max-turns` does not exist in this CLI's help (0 matches); Reference B's adapter uses it — do not pass it to this runtime.
- Bare-environment invocation without the two provider env vars: deterministically exits during provider discovery on this machine/build.
- Unattended repair of the provider lookup by copying files into the installation: unnecessary (env vars suffice) and was intentionally not done.

## Bridge preflight requirements derived from this verification

1. Resolve Node and `zcode.cjs`; require the two provider env vars to be settable by the Bridge itself: builtin = shipped `resources\config\provider\zcode-builtin.json` under the discovered install root; personal = an **existing** real personal config (resolve via `ZCODE_DATA_BASE_DIR` when present, else known data-dir candidates). Fail fast with a distinct configuration error if either file is missing.
2. Spawn with an argv array, `shell: false`, explicit child cwd, captured stdout/stderr, and a hard timeout whose behavior still needs its own verification.
3. Parse stdout as JSON only when exit code is 0, then require `sessionId` (and validate shape) before treating the task as successful; retain raw stdout/stderr otherwise.
4. Retry the `Bundled 与 Active ... 均不可用` error class; treat probe/model-creation errors as non-retryable configuration failures.
5. Re-run this verification after any ZCode upgrade: paths, env-var names, and the JSON schema are all version-specific observations.

## Evidence and disclosures

- Test drivers and raw result logs (no secrets, no credentials, no provider-file copies): `C:\Users\Sandy\AppData\Local\Temp\zcode-bridge-smoke-PivivJoJ\` (`run-smoke.mjs`, `run-diag.mjs`, `run-envbisect.mjs`, `run-minimal.mjs`, `smoke-result.json`, `resume-result.json`, `diag-*.json`, `envbisect-*.json`, `minimal-*.json`).
- During diagnosis the CLI itself created `C:\Users\Sandy\.zcode\v2\provider_config.json` (206-byte stub) and normal session state under the ZCode data directories; no ZCode configuration was edited manually and no login/logout/upgrade was performed. Roughly two dozen small model calls were made for diagnosis, consuming a small amount of model quota.
- The working directory `D:\codex-zcode-bridge` is not a Git repository (no `.git`), so no remote is configured locally and nothing was committed or pushed.
