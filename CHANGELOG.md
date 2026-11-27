# 更新日志

本文件记录面向用户的变更。版本号遵循语义化版本，并由 Release Please 根据 Conventional Commits 生成发布记录：`fix:` 升补丁号，`feat:` 升次版本号，`BREAKING CHANGE:` 升主版本号。

当前版本以 `package.json` 和 Release Please manifest 为准。提交推送到 `master` 后，Release Please 会在有待发布变更时创建发布 PR，并同步更新版本文件与本日志；合并发布 PR 后会生成对应 Git tag 和 GitHub Release。

## [1.3.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v2.0.0...codex-zcode-bridge-v1.3.0) (2026-11-27)


### Features

* add actionable executor wake acceptance ([7f54531](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7f54531acba0844937bc134609dae840090294ec))
* add async master handoff skill ([8a922a7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8a922a72d23f58e40821f79632302bb915280b41))
* add Codex rollout master token usage ([d91913a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d91913a2c1b4b04485ee2815bb3b9fb80be2f131))
* add Executor task CLI control surface ([ef5a996](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ef5a9964466eeed8dfc9bd79b5a0740868fed7c8))
* add independent executor control path ([6fa55d2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6fa55d2f4514c3da07fc6d8d837234729d6741e1))
* add local Executor web console ([94a15ba](https://github.com/Sandyzzx/codex-zcode-bridge/commit/94a15ba4bfc378b45b5f7575bde7add22df96a52))
* add stop-the-world SQLite authority candidate ([f27f7af](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f27f7afc2b73ac21e221ec6dcf69a171fdc9fd25))
* ADR-024 scoped hold recovery + unified attention thin waiter (M2 integration) ([c770345](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c7703451b51d6cb7d0922671a739e672bd690b7e))
* bind doctor to SQLite authority and add test impact gating ([ba9277d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ba9277df8ee1daef0434b1e8b26645f1e80e4044))
* bind doctor to SQLite authority and add test impact gating ([7b4dcaa](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7b4dcaa9a9e1dc5bc9b20c2aa9eead3d31f29cbd))
* clarify complete-task dispatch and acceptance ownership ([a66d612](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a66d612665ef5c2a9beb76f678092e0f5e44a7d9))
* **cost-lab:** integrate Start Plan billing dashboard ([cd7e22e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/cd7e22e9a2042b0e8c6f45f54101bdbc7ba25a16))
* **events:** bound default monitoring pages ([2b0ea9e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2b0ea9e509373f7c4bfa7935c9ca9062c9253c9e))
* **executor:** add fail-closed wake delivery ([5cb9073](https://github.com/Sandyzzx/codex-zcode-bridge/commit/5cb9073d55d888cf9a80b1d150b446ece658d645))
* **executor:** add trusted-local automatic wake ([ca10518](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca10518728c87b35c719b0293b48045946728932))
* **executor:** recover crashed lease and preserve release fact ([addd5cf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/addd5cf3b967e0d6b08b06ff241884dcf18f827d))
* **host:** reuse official ZCode Start Plan auth ([ff244f5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ff244f552ff710a9155833019a3a3647e7699dfc))
* integrate async executor and trusted-local wake for preview ([#131](https://github.com/Sandyzzx/codex-zcode-bridge/issues/131)) ([c7bfc28](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c7bfc28b1112dead95ae4179a00962de76051920))
* integrate installed official ZCode runtime ([20da3ca](https://github.com/Sandyzzx/codex-zcode-bridge/commit/20da3ca6e77220ec39ce6a47a49d7fb10c34a9b4))
* integrate official ZCode host into existing worker ([c6d40cf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c6d40cf8fb1b8038564a8a5a44b0da9d475b6747))
* integrate official ZCode host into the existing worker ([0027660](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0027660ecbd0cf4b853a7e1e97d628e9ae5dd9d6))
* **lifecycle:** P1 reliability — turn truthfulness, lease spawn fence, release-wake recovery, result readback (ADR-056) ([1a204b1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/1a204b1926537b6d25268e27ea3b92b47f714601))
* **mcp:** add opt-in task result and event projections ([6f814bf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6f814bf8736baa59295e686af8733c88d4202ca0))
* **p2:** status time truthfulness, prompt capacity contract, ADR-056 schema corrections, dead code removal ([8ba774a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8ba774a680bf69a833bb6c2cf177c9a3a293e0af))
* **policy:** decouple plan discount verification from execution eligibility (ADR-058) ([9fbae6f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9fbae6f60348c68f99f5a35cdbe2e779474924b6))
* **preview16:** bind trusted owner thread and retire wake authorization ([fba2e95](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fba2e957748c31cfef90be5a362d415c31689f2a))
* **preview18:** simplify executor recovery and authorized cleanup ([57e9519](https://github.com/Sandyzzx/codex-zcode-bridge/commit/57e9519b97fb41a1fdabb02de67590e135bd8363))
* **preview20:** use official runtime registry and separate session resume ([406bfc7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/406bfc758ad64fc2061148dff7890e48c494b146))
* **preview:** integrate SQLite-only runtime and Start Plan ([#67](https://github.com/Sandyzzx/codex-zcode-bridge/issues/67)) ([d9b9819](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d9b9819860320cbad6152a57a944604e5f70173e))
* **release:** prepare preview.6 signed runtime host ([6d15686](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6d15686438370d26d3ba76ebce83350e75891b23))
* require scoped Bridge authorization and progressively load Skill guidance ([83d3f13](https://github.com/Sandyzzx/codex-zcode-bridge/commit/83d3f13b7f9163bdb1e3d0decff630dde3e36164))
* restore SQLite runtime events and usage ([c7363fc](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c7363fcaf8571541bbdf8db9e0c77a0169c7adfa))
* restore SQLite runtime events and usage (R7) ([3a95e47](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3a95e47b2688d06e29f3bca441d1c9bcaaca2e4f))
* **routing:** Model Routing v1 and Desktop host compatibility ([#68](https://github.com/Sandyzzx/codex-zcode-bridge/issues/68)) ([064d23c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/064d23ce2d46aa7cda4519cc495f849e4fb60f22))
* **runtime:** adopt safe installed runtime without static version gate (ADR-054) ([15e7500](https://github.com/Sandyzzx/codex-zcode-bridge/commit/15e75001266635436e7846dfa8899328a8ae49d2))
* **runtime:** authorize fingerprint-bound experimental probes ([aa75523](https://github.com/Sandyzzx/codex-zcode-bridge/commit/aa755239645b355eb63288473567eb96de2bcd66))
* **runtime:** authorize fingerprint-bound ZCode 3.19.0 probes ([c1245a0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c1245a02f8f9d4b6e1102eabac230b657d85de9b))
* **runtime:** route models from live appserver catalog ([3d252ba](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3d252ba6d0d69b01dfe879c2efbcc25be0becee0))
* **runtime:** unify official AppServer for Start Plan ([b022673](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b022673a006fb191b011514bb26c3885314830a0))
* **skill:** close master acceptance rework loop ([806356f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/806356ff1005c7d4670bf6273eb52b70207743d6))
* **sqlite:** add administrative abandonment recovery ([71964e0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/71964e0fcd941b79a76c773048c8de7caeb10036))
* **sqlite:** finalize Stage 2 cutover candidate ([aae3abf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/aae3abfad17203a54da23f24037aa9ba7484b9ba))
* **sqlite:** preserve active operations in recoverable v13-v14 startup upgrade ([4425c6d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4425c6d6806ab82e212ee89fe29d5a1001f9a3de))
* **sqlite:** preserve local workspace workflow ([8ca84a1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8ca84a1ac251d0d8f49e4fbf93c0f7f4e4082bfb))
* **sqlite:** recover interrupted attempts inside host ([2e9241d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2e9241dbe5eb40b2f2a1a11246f514236454357b))
* **sqlite:** scope hold recovery to workspace per ADR-024 ([9b7b0c7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9b7b0c7a7f2ea5be0d7be70dc04ebec6fb64a24a))
* **sqlite:** wire seamless v13 upgrade into locked production bootstrap ([65fc438](https://github.com/Sandyzzx/codex-zcode-bridge/commit/65fc4380084820b46bad612fdae262b472200f24))
* streamline async dispatch and worker prompts ([555ae8d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/555ae8d2e74ad088cafee3fe1929b743372b73d8))
* streamline async handoff dispatch and worker prompts ([7d0e6f3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7d0e6f35fb3c42f614f0e7a39505731d72178af4))
* unify attention waiting with thin waiter ([785304d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/785304d359a61b9dc11aa1a438ca5780594766f5))
* unify operations console and cost lab ([0841d66](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0841d665b79e681c89543add010490733830affc))
* unify ZCode path discovery ([32ed22f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/32ed22fb743e97dd40d69f9e8c92ea912178c6b5))
* unify ZCode path discovery ([32ed22f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/32ed22fb743e97dd40d69f9e8c92ea912178c6b5))
* unify ZCode path discovery ([c39909a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c39909a5718396f463de08b1a812cf309f3a1616))
* use Owner-selected original E plugin artwork ([fb5c0a0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fb5c0a0a9bd55973d8e754aa55946aa04ac993eb))
* **web:** add console discovery and task deep links ([7142855](https://github.com/Sandyzzx/codex-zcode-bridge/commit/71428552e1ee1254a4991166a1a675a163e72afe))
* **web:** add durable single-page task console ([9aa19c1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9aa19c130c64e28476d6cb8201fdae4c37dbfb0f))
* **web:** finish task workspace information hierarchy ([adc15a8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/adc15a8f7ed0345857f07cb0c89eda665e0f6ceb))
* **web:** freeze simplified task workspace ([3ddc6f7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3ddc6f78a059bc5f52f2ebd07c19da83697742ac))
* **web:** simplify task workspace to four regions ([ca025e6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca025e62098023ebf4621fc887f9c358a652aa6f))
* **web:** turn task console into a task workspace ([37f8e82](https://github.com/Sandyzzx/codex-zcode-bridge/commit/37f8e8203bddd8cadd9447379fe54bfe93ab7e0e))
* **zcode:** use official Desktop host startup identity ([#71](https://github.com/Sandyzzx/codex-zcode-bridge/issues/71)) ([434d874](https://github.com/Sandyzzx/codex-zcode-bridge/commit/434d874c938adcaf2aad1956b21f0d160785f392))


### Bug Fixes

* **adapter:** fail-closed-on-runtime-provider-capability ([f19ab1d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f19ab1d75dcced7613bfe6e12c84d780d01f7127))
* **adapter:** gate held completions on the observed send ACK; fix mcp-result test contract ([bc773c5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bc773c502df6accd9c3775dc25c52170a3a74399))
* **adapter:** held completions publish turn_completed once; test harness typing ([641f97b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/641f97bfa221768539ba40cc134f49b3ac66f947))
* add optional headless browser host and handle large session payloads ([020c8a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/020c8a918d47bb5c6f94a2fa1b0a8049aae5c80c))
* address M2 attention waiter review findings ([b3ac540](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b3ac540e295994277d05881309d08231edcf5c17))
* align PowerShell UNC path classification ([df38f13](https://github.com/Sandyzzx/codex-zcode-bridge/commit/df38f13006f418d40a9f06461682e880cb8bb572))
* allow bounded startup time for Windows cleanup helper ([fc73947](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fc739471d0a566d19ec6d9a308c8b5c34b53d7da))
* allow host-authorized cancellation for queued launch-intent and cleanup-held operations ([06559a6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/06559a60bbe72fcd723aab2fbea96f4610eaf695))
* avoid duplicate turn-start events on coalesced ACKs ([a6ba76c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a6ba76c7a3ddb97e4c7f37754eb85c7eb9c9d82b))
* bind cancellation recovery to fresh tree proof ([ae4d479](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ae4d479e47e861891cf97ee7f8b813952f22ad5c))
* bind host cancellation recovery to fresh cleanup proof ([a1dae17](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a1dae175f736b0e1124614701d959d79dc76b8bc))
* bind terminal release to latest recovery hold ([c30e7ec](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c30e7ec88eb8a33ef4c3d1785c2aa4b3546640bc))
* **build:** make generated bundles worktree-stable ([b431bb8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b431bb8f091fb6ede13a5b4879a3dde685702ab4))
* **ci:** bound backpressure test event overhead ([6bb2b8c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6bb2b8caa47acb90f0be0f66aa256e72d85b5c8c))
* **ci:** complete ADR-054/retirement follow-through missed by local gates ([636de6e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/636de6e35afbe13a06fba6939638552d70ed2a98))
* **ci:** diagnose Windows worker identity probes ([23958d8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/23958d8098dfed4016d0a7c60895b6651f663898))
* **ci:** normalize shard workflow line endings ([d159d49](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d159d49832d3a52ef67d3b3e8a0fb9f4bf29ac58))
* **ci:** scope shard temp env to workflow steps ([a67fb20](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a67fb201ebcf757148c1b547d10f88817e45b527))
* classify dispatched full gates explicitly ([633659b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/633659bb43e0e6209e965f0e8753d98fb4ab2b51))
* classify doctor data directory access errors ([4282b8f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4282b8fc64c97399416d8a9a9d53e59bc799cb67))
* compare worker paths by platform rules ([8fad454](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8fad454b4d4f78d82b75fbbbdee3c049346fb26a))
* complete operations console and runtime auto learn ([3baf91c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3baf91c6570386e029406ec8063edfa157e21fee))
* **cost-lab:** allow lifecycle cleanup budget before release ([ab2d09a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ab2d09a2ef4260ccad5b58e7bd00f8fe064e9b8c))
* **cost-lab:** bound billing attribution and drain shutdown ([5a8bce9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/5a8bce919d91f9239aa34f17084aaaba054ba0a1))
* **cost-lab:** bound isolated SQLite paths ([63d5899](https://github.com/Sandyzzx/codex-zcode-bridge/commit/63d58994aab2232b30c00c923d8836e7fda1c8ab))
* **cost-lab:** canonicalize isolated executor root ([f8e6aa7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f8e6aa7f6158720aa329be21840d0529a7eb4100))
* **cost-lab:** distinguish unobserved billing from zero credits ([b4273b5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b4273b5ff8944edb294cb288b94d45f3180b4ee3))
* **cost-lab:** exercise installed production bridge ([30cff7e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/30cff7ec8d9afb31f5ac486f363b2ce25dcc4dea))
* **cost-lab:** preserve failed verification usage evidence ([657849f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/657849f0ccc082a4bcc22ef128b1f7d249539304))
* **cost-lab:** preserve validated failure facts ([2e87e3f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2e87e3f1f96140108615148bca5fafd267b107c0))
* **cost-lab:** stop headless verification from spawning a task console ([c84e9a5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c84e9a500ee130f55ffd6757f73da38fdb3a2ae2))
* cover executor control bundles in generated gates ([966af5f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/966af5f6952e76c5ea2d52437e263d9d10e6da3a))
* cover web console bundle in generated gates ([e7a595f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e7a595f63cf351bf46ed21b77d81f16b5d6fec20))
* **executor:** bypass live routing in synthetic adapter mode ([301b042](https://github.com/Sandyzzx/codex-zcode-bridge/commit/301b04297fdd6ff2849fbcd9f2bba1c15cfb11c0))
* **executor:** close PR 120 production lifecycle gaps ([f330b51](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f330b511270934fa40014006333aa7747dad684c))
* **executor:** close root-exit shutdown race ([c75c343](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c75c34330287266702cab5949662bf897b74ed5a))
* exit claim-only workers deterministically after result write ([7fbbfce](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7fbbfceca166eba7e51110c8c64727b8bceaf19f))
* expose execution observation in MCP status schema ([5527800](https://github.com/Sandyzzx/codex-zcode-bridge/commit/5527800ad1c31660ab53a44456d8e6f2dbef3aea))
* extend bounded Windows lock release retries ([bfab338](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bfab3386937f552d4c60761f32df9ea097fcb6f1))
* gate held completions on observed send ACK; ADR-056 test contract follow-through ([91fb449](https://github.com/Sandyzzx/codex-zcode-bridge/commit/91fb449705826c87c667d1cb9fafc377906fdfb9))
* harden CI dispatch and event summary pagination ([0afcdef](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0afcdefabdf0765b95d02c0e833d683859b0f933))
* harden runtime and Cost Lab for Preview 9 ([502045b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/502045b2b3945fc693ae46a0c2e64c8957dc22a5))
* harden Windows process ownership and cleanup ([628984c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/628984ca625a4d307b859d9f32d49e52e2d21ee6))
* harden Windows process ownership, lock cleanup and root validation ([73af9d6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73af9d60ff9bbcbbc1ae1d7b1f9b9fb9fca48bb0))
* honor POSIX data directory migrations ([82df987](https://github.com/Sandyzzx/codex-zcode-bridge/commit/82df9879a1b2b85fa7faaa94bc086e03ef30b061))
* **host:** resolve Start Plan host from worker assets ([6246e66](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6246e66b933f5c41944ee212627a430f5ed3cd59))
* **host:** ship official keyring closure ([cd3b74f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/cd3b74fec2992cce1f6340236265a6f87801298b))
* keep the MVP fake app-server alive in hosted CI ([78115c1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/78115c188c66233b4f83561d2fca1e5fec70b1da))
* keep worker alive through app-server and cleanup-helper teardown races ([4a3763e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4a3763ebbd61f8b9d12b9464e2e406df70d0ce88))
* keep Worker alive through app-server and cleanup-helper teardown races ([f8cfb51](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f8cfb510c9ba8a0be31b5887277a7ff7cf7c4dfa))
* **lifecycle:** allow hosted Windows process tree scans ([99d034b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/99d034bf561dcc8845037cd43fb83cc1f060b58f))
* **lifecycle:** bind user-authorized release evidence ([68461c2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/68461c28d399143db12cd9db0c1ac777528df758))
* **lifecycle:** protect user-authorized unverified release ([da48fad](https://github.com/Sandyzzx/codex-zcode-bridge/commit/da48fad515d57c963e5a6db3471b26b37fc01bd7))
* normalize generated SQL inputs ([265b705](https://github.com/Sandyzzx/codex-zcode-bridge/commit/265b705b4572a8352e7a955099054289a3f0dcfd))
* **P1:** make task-model routing idempotency content-aware and confirm-after-persist ([8e50db7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8e50db7fcbeb555a493621b7fe42ecd6a3add55a))
* **P1:** preserve first accepted task-model routing ([5688180](https://github.com/Sandyzzx/codex-zcode-bridge/commit/5688180f931cbbc4783347daa7c8286b77e0925e))
* **P1:** prevent task_id model-routing cache from masking TASK_ID_CONFLICT ([e444ad0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e444ad0d3ce5df342a7f4d104b19816f1af1dda5))
* **P1:** replay persisted tasks before Start Plan auth preflight ([2764597](https://github.com/Sandyzzx/codex-zcode-bridge/commit/276459757cbaddf5d753aa0fb9bb706f1e6e564a))
* **plugin:** bind branding through the top-level interface ([6775d8b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6775d8b13ccbf4c1d16a9ef2daa2fea44976870f))
* **plugin:** restore Original E source artwork ([73914a7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73914a7de9d405ede47599c962dc17577dd8c9c9))
* **plugin:** ship v14 administrative recovery CLI ([31aeb03](https://github.com/Sandyzzx/codex-zcode-bridge/commit/31aeb0398830883f94d95bfe8931f935c47d3ac4))
* **plugin:** ship v14 administrative recovery CLI ([f9afa8a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f9afa8ad866e0cd72a3a092c0a9a36e56fd9383f))
* **plugin:** ship v14 administrative recovery CLI ([b716ceb](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b716cebefbe867c7ef9b21a52a94a451316838ea))
* **plugin:** ship v14 administrative recovery CLI ([e153a61](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e153a61d6f9773bb1d14d8a7f03622e477d5996c))
* **plugin:** sync v14 administrative recovery CLI to preview ([3e565aa](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3e565aafb006065bb5e257fd45b6c6092a48357a))
* preserve browser environment and validate short repository roots ([f3576a2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f3576a266adb02f2c7e30428f304ccd34f29ea5f))
* preserve browser environment and validate short repository roots ([2bf434d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2bf434dc09ca8e4ab7e5df9195850647cc53882c))
* preserve claimant evidence across process generations ([73d4a73](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73d4a731c5e8d34e4ff6f8ec146eb07c8598778b))
* prevent live worker recovery latch ([cab82a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/cab82a918514c6329f4982477b7eb0e8ada6cc01))
* **preview20:** prefer usable runtime registry ([e859d45](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e859d452d5cd4b72c21366371e4d24595401b057))
* read Wake Results through native MCP tools ([42667cf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/42667cff0646fbdac907809ba546cb500362503b))
* release local trust and recovery fences ([ca0e19c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca0e19c437438d2bfcb9e79f5825893062aecd66))
* release terminal result cleanup holds ([69ebf76](https://github.com/Sandyzzx/codex-zcode-bridge/commit/69ebf76ef4d95a0eab434e15b88fbb8d2982b6d5))
* **release:** prepare Preview.10 recovery closeout ([660ccbb](https://github.com/Sandyzzx/codex-zcode-bridge/commit/660ccbb909f4d5992377b2e3c38a30c35c2289b2))
* **release:** publish v1.3.0-rc.2 preview ([f52096b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f52096b5b67cd16c97261a6dda9897ea5b74b2af))
* remove recovery observation limit and deduplicate unchanged holds ([61a1a87](https://github.com/Sandyzzx/codex-zcode-bridge/commit/61a1a87c201d2098eb3563b351c9acbe7ae360d4))
* repair operations console release gate ([1a7fcd8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/1a7fcd89f37e1259e1dc7b548041917d058a039e))
* repair path discovery validation and doctor diagnostics ([c505c24](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c505c240f8bb21d9b7417d8c7a8c4f3323e0b633))
* repair ZCode path discovery review findings ([c95b9c4](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c95b9c42ab9a236c9e723a4e63f9dae09cf1cacb))
* restore Preview.19 Cost Lab gate ([eac1bd5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/eac1bd5243ce19c61e69e5946851fca63d86ce3d))
* retry transient self identity probes ([f77a617](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f77a6176508f20bad73b8605b44a04703bacf231))
* **runtime-auth:** bind provider resolver after worker assembly ([bc03ac4](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bc03ac41c5d7211000d4765f9526948cf0e796d7))
* **runtime-auth:** restore Coding Plan resolver binding and document real plan billing evidence ([e7a8714](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e7a871488aaf88e77627e6b70c4ecae182d0d0ba))
* **runtime:** avoid PowerShell module lookup in identity probe ([21ffa75](https://github.com/Sandyzzx/codex-zcode-bridge/commit/21ffa7581aac7f3cc6cc9ef1234b1d896864df96))
* **runtime:** forward experimental authorization file to workers ([0e71347](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0e7134701d643c7b80def4e3cb80c95c63e34691))
* **runtime:** launch Windows identity probe directly ([2ee975d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2ee975df603aafe9b5246d831dbfd30aba761000))
* **runtime:** pin Windows PowerShell module discovery ([3925eab](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3925eabae634b3d4b7a48aa190ae3e4615875066))
* **runtime:** prefer the official runtime registry and separate Task Continue from Session Resume ([d264481](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d26448175917bee0ade3e32ba6943ab070dac9b0))
* **runtime:** resolve fixture assets on the host filesystem ([078014c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/078014c4ce5406e34b6a18bd3b499bbd6a885ec3))
* **runtime:** use host path semantics for authorization file ([f9ab317](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f9ab317a0f88f7d2d8f61c72dbfe8b70d03d9226))
* **runtime:** use official host product version context ([a754545](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a754545eb83d8e314c727c3ca0df0a2d3f47325d))
* scan full captured response for AgentReport ([98c37dc](https://github.com/Sandyzzx/codex-zcode-bridge/commit/98c37dc3c52704605f68ec6559378438252cc142))
* **sqlite-candidate:** bind provenance to shipped bridge bundle ([ca288fd](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca288fd386fc086410d8e1b0104196ad70d95165))
* **sqlite:** add Host-native Recovery hotfix for Stable 1.7.1 ([0c54a51](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0c54a510e346cf57ac32fe70da21ccd856c62987))
* **sqlite:** allow operation-local abandonment sequences ([77990f3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/77990f3a840e7b1f3a75afc151c58ca2cef5f28a))
* **sqlite:** defer corrupt database errors to existing authority validation ([1185c72](https://github.com/Sandyzzx/codex-zcode-bridge/commit/1185c72bba2097b8acd9273fb85cd5093da735ef))
* **sqlite:** fence recovery from unverified side effects ([a4b10f3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a4b10f349d7459eb8305aa243f0815b6d9b99ef9))
* **sqlite:** frame bootstrap lock handoff safely ([196eb17](https://github.com/Sandyzzx/codex-zcode-bridge/commit/196eb17165d2be42f1ebb4c364f2908b7da1d6bb))
* **sqlite:** harden fresh bootstrap lock and crash recovery ([0ebd983](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0ebd983048660332610690be5e3d28493cf5182b))
* **sqlite:** integrate Host-native interrupted Attempt recovery ([9bec5a2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9bec5a27d6182a83620c32105e80210f8731f514))
* **sqlite:** make admin abandon preflight read-only ([26f7173](https://github.com/Sandyzzx/codex-zcode-bridge/commit/26f71732fae591c16c1235a6824ccde078932afe))
* **sqlite:** make admin abandon preflight read-only ([de9f8d1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/de9f8d1c231d35502ebeb8d011a7bd9f456fc944))
* **sqlite:** recover interrupted v13 publication when main database path is absent ([47bc519](https://github.com/Sandyzzx/codex-zcode-bridge/commit/47bc519b4c0b433effee13224b744055e12889e3))
* **sqlite:** recover safe lifecycle facts while host is live ([d9e24a0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d9e24a0f242a4ca80be601c6727b053704c5109a))
* **sqlite:** retry transient self identity probes ([71394cd](https://github.com/Sandyzzx/codex-zcode-bridge/commit/71394cd6edd5d1f9c1ae965b4e9954e4523613bb))
* **sqlite:** seamless v13→v14 startup upgrade (Preview 2.0.0-preview.4) ([97dcedb](https://github.com/Sandyzzx/codex-zcode-bridge/commit/97dcedb982490928a54be7ee6bf92c0a8d2c4729))
* stabilize ADR-027 cleanup recovery probe ([1eaf2d8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/1eaf2d87662738b9a9c70dd21040a80b6aa41a7a))
* stabilize browser timeout fixtures on Node 22 ([34f26e8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34f26e893fcfffebdbf3f36e36912723e5a71656))
* stabilize generated artifact line endings ([19fd1d1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/19fd1d1bef878c230816f01104e1e38fcb7e1cfb))
* stabilize Windows release regression tests ([20661d4](https://github.com/Sandyzzx/codex-zcode-bridge/commit/20661d44c10337ae18636ec66b7850c1e365e102))
* **start-plan:** align billing product version ([843066e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/843066ec437f0f7776e682c5893f807b2aed90a4))
* **start-plan:** decode official encrypted credentials ([#65](https://github.com/Sandyzzx/codex-zcode-bridge/issues/65)) ([7df1a20](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7df1a205ce4308bc6c3b321fc92d1c1cb58f7367))
* **start-plan:** persist entitlement failure facts ([ed425f8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ed425f8368ac60a3f2af5f92d9ca085cdbd6b929))
* **start-plan:** repair provider registration contract ([#69](https://github.com/Sandyzzx/codex-zcode-bridge/issues/69)) ([003d508](https://github.com/Sandyzzx/codex-zcode-bridge/commit/003d508c9a7630c5355fcab6007453dd8e77c33d))
* stop work and report exhausted ZCode usage ([6756225](https://github.com/Sandyzzx/codex-zcode-bridge/commit/675622515db6475b095ce63b17c860fc8f549c89))
* **store:** widen bounded transient lock retries ([6050e1e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6050e1ecc0e3d5e11fba6c51a3365bcd0bdc03bf))
* support headless browser hosting and large session interactions ([66e81b1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/66e81b18577edc36c876faa03908ee4471ca6a89))
* **test:** create ignored token evidence parent ([b1e0167](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b1e01672aa7b0f8987e9dd3c06842c36ef2a6261))
* **test:** preserve compiled SQLite schema fixture ([d85f6ae](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d85f6ae92ba715ceaee7f9d593f3ba32ef16e70b))
* **test:** respect Windows-only SQLite lifecycle support on POSIX ([bf06f52](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bf06f5204723915ebfe3723c18a181736a292556))
* **tests:** isolate worker fixtures from host ZCode session env; complete ADR-054 descriptor contract ([4308ff9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4308ff9d553c328712debd6222d470c0414ff1a0))
* **tests:** single monotonic seq source in the mvp fixture event script ([2fc1990](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2fc19905a77e7ff708cdf38f25fe0a5251fa7aee))
* unify terminal result release evidence ([5776385](https://github.com/Sandyzzx/codex-zcode-bridge/commit/577638595324f949a9f9113ff5a95b845f31017e))


### Performance Improvements

* **ci:** promote verified Windows sharding ([4e189df](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4e189dff036c5e3a80e032f8e1c7e69f01792ef6))
* **ci:** reduce duplicate gates and split Windows tests ([e821436](https://github.com/Sandyzzx/codex-zcode-bridge/commit/e8214366bd4077983aec5641936031e97b804a3d))
* **ci:** reduce duplicate gates and tighten test impact ([8b2ba9e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8b2ba9e7124ae6b5d63b7c441ea73187febc83a2))


### Miscellaneous Chores

* **release:** request stable 1.3.0 ([663595c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/663595c4372e6a214826dc7ce11aded9f49d72d3))

## [2.0.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.7.2...codex-zcode-bridge-v2.0.0) (2026-11-27)

Stable 2.0.0 将已验证的 Preview.20 `d2644817` 提升为新的稳定基线。发布身份、README、作者维护说明、真实脱敏截图与 Marketplace 名称统一为 Stable；运行时代码基线保持不变。

### Features

* 独立 Executor 与 Lifetime Lease 持有任务 Authority；Thin MCP、Task CLI 和单页 Task Workspace 共享同一控制面。
* SQLite v14-only Authority，持久化 Task、Attempt、Operation、Result、Usage、Cleanup、Release 与 Wake 事实；旧 JSON Authority 与 v13 升级路径已退役。
* Worker 通过已安装的官方 ZCode AppServer 执行；模型目录、Provider 选择与运行期 Registry 从官方当前安装和账户配置动态发现。
* 持久 Owner Binding 与安装即生效 Auto Wake；Queue ACK、新 Turn、Master 验收和资源释放保持独立事实。
* Master 独立验收与验收驱动 `zcode_continue` 返工；任务续作与 ZCode Session 恢复分离，用户选择的 Provider、Model 和 Reasoning 不被静默改写。
* Task Workspace、Diagnostics、有界脱敏 RPC 失败诊断，以及精确身份、写者意图和用户授权清理保护。

### Validation

* Preview.20 的 Windows/Ubuntu Release Gate、SQLite 资源矩阵、Cost Lab、1199 项本地回归与真实 Coding Plan `GLM-5.4 / low` 任务通过。
* Stable 发布验证另行覆盖版本/制品一致性、Typecheck、Build、Plugin Validation、Generated Artifact、定向测试、Markdown 链接、`git diff --check`、PR Release Gate 与 master push CI；具体运行结果以发布报告为准。

### Compatibility

* 支持 Windows x64 与 Node.js `24.16.0`。ZCode Desktop `3.18.2.10443`、`3.19.0.10774` 和 `4.0.0.10870` 的验证范围不同；其他安全安装可尝试运行，但不保证兼容。
* 当前真实 Continue、Start Plan 权益与执行、Desktop 完全退出恢复、notLoaded Wake 和 Windows 重启恢复仍为 `NOT_RUN`，不得从离线测试或 CI 推断为已通过。

## [2.0.0-preview.15](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v2.0.0-preview.14...codex-zcode-bridge-preview-v2.0.0-preview.15) (2026-11-24)

Preview 2.0.0-preview.15（EXPERIMENTAL / PREVIEW ONLY；发布目标为 `preview` 分支）。

### Features

* Whole Task / Staged 派发与 Worker Prompt 合同（ADR-055，PR #135）：删除 Auto 派发，首派与 Continue 共用一份任务合同与 60k 容量界限，Continue 反馈有界投影，Report Repair 独立分流。
* ZCode Desktop 4.0.0 适配（ADR-054）：安装安全是唯一执行门禁；未验证版本不再阻断调用，Manifest/能力静态事实降为诊断（`officialProviderCapabilityWarning`），实验授权机制与环境变量退役。
* Turn Lifecycle 事实边界：仅原生 turn.started 建立 Started；ACK 发布 turn_accepted，不再伪造 Started；终态事件不再因等待绑定被丢弃，完成只结算一次。
* Executor Lease Spawn Fence：Lease 所有权未知时禁止一切新 Worker Spawn（pump/定时器/恢复重派同一围栏），在途 Result 与 Release 通知照常收尾。
* Release→Wake 恢复：启动 Recovery 为「已 Release 且无任何 Wake 观察」的 Operation 重跑一次通知；已有 Wake 事实的 Operation 保持去重合同。
* ADR-056 Result 回读合同：`view=summary` 投影下沉 Executor；`zcode_result` 新增 `offset_bytes`/`max_bytes` 分页（码点安全 next_offset，拼接页 SHA-256 等于 result_digest）；MCP 大响应文本通道有界引用。
* Status `updated_at` 读取最新持久事件（专用单行查询），超过 200 条事件的任务不再显示过期时间。

### Removed

* `LeaseGuardedTaskManager`（生产无调用者）、空 `#acceptRunOutcome`、`authorize-official-runtime` 工具、`ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE` 传递、`RUNTIME_PROBE_AUTHORIZATION_REQUIRED` 死错误码、冗余 windows-shard-experiment workflow。

### Validation

* 零模型 Protocol Smoke（安装版 4.0.0.10870 / build 3bc8a247）：PASS。
* 真实任务 E2E（随包制品、真实 Coding Plan/GLM-5.3 回合）：Result/Cleanup/Release 闭环与工程产物逐字节核对 PASS。
* 新增故障注入测试：Turn Lifecycle（8）、Lease Fence（4）、Wake Recovery（6）、Result 分页完整性（4）、Status 时间（1）、Prompt 容量与中段错误信号（17）、MCP 分页/有界通道（29）。
* 完整矩阵（Windows 双分片、Ubuntu、SQLite 资源矩阵、压力）由 Release Gate 承担，见发布记录。
## [2.0.0-preview.14](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v2.0.0-preview.13...codex-zcode-bridge-preview-v2.0.0-preview.14) (2026-11-23)

Preview 2.0.0-preview.14（EXPERIMENTAL / PREVIEW ONLY；发布目标为 `preview` 分支）。

### Features

* Independent Executor with Authority Root lifetime lease, exact process ownership, Idle-only Shutdown and bounded Named Pipe control IPC.
* Thin MCP, Control-only Task CLI and loopback Task Web Console reuse the same Executor Authority; MCP disconnect and Turn end do not cancel accepted Tasks.
* Trusted-local one-shot Queue Wake for loaded/idle Codex Threads, with Web Notify fallback, durable Wake evidence and no automatic retry.
* Async Master Handoff contract: report reliable acceptance, end the current Master Turn, and resume independent acceptance only after Wake.
* Operations Console includes Dashboard, Tasks, Cost Lab, Runtime and Settings on one loopback origin.

### Validation

* PR #131 merged to Preview as `c7bfc28b1112dead95ae4179a00962de76051920`.
* Post-merge CI `45124466655`: Ubuntu, both Windows shards, both SQLite resource matrices and Cost Lab passed.
* Isolated real Host E2E: Queue ACK, new Turn, native MCP Result readback, Result digest, Cleanup verified, Operation released, Master lifecycle acceptance and Desktop visibility passed once without duplicate Worker, Queue, Turn or Result.
* Synthetic Worker and real-process tests verify shipped MCP Host exit does not interrupt the original Attempt Result/Cleanup/Release.

### Compatibility

* SQLite v14 remains the only supported Schema; public MCP tool names and schema remain unchanged.
* Supported release boundary remains Windows x64, Node.js `24.16.0` and ZCode Desktop `3.18.2.10443`.

### Not verified

* Strict Wake C (`notLoaded`) and strict Wake D / Desktop fully exited remain `NOT_RUN`.
* Official Runtime provenance for the current installed `3.19.0.10774` remains `NOT_RUN`.
* A non-empty real engineering deliverable and real-model Async Master Skill adherence A/B remain `NOT_RUN`.

## [2.0.0-preview.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v2.0.0-preview.3...codex-zcode-bridge-preview-v2.0.0-preview.4) (2026-11-11)

SQLite v13 → v14 seamless startup migration (EXPERIMENTAL / PREVIEW ONLY; migration runs once on first startup after upgrade).

### Fixed

* Existing SQLite v13 Authority is automatically copied and upgraded to v14 during Bridge startup; users no longer need to run the offline upgrade command or edit the Authority path.
* Preserve unfinished Operations, Attempts, Holds, occupancy, lifecycle events, and Recovery evidence. Migration does not spawn Workers, release Holds, or silently clear active work.
* Retain the original v13 database as a sibling backup; verify the published v14 Authority before clearing the durable migration marker.
* Recover/retry interrupted publication on the next startup, and keep corrupt or non-v13 databases on the existing fail-closed validation path.

### Validation

* Windows and Ubuntu Node 24 full Verify jobs passed.
* Windows and Ubuntu SQLite resource matrix jobs passed.
* Isolated regression fixtures cover occupied Operations/Holds, v13 backup preservation, interrupted publication recovery, replay/idempotence, and blocked roots.

### Compatibility

* This is a one-way data migration to v14, not a guarantee that older v13 Bridge binaries can write to a v14 database. The retained v13 backup supports explicit rollback.
* Existing Recovery/Hold state remains intact and must be resolved through the normal Recovery workflow.

## [2.0.0-preview.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v2.0.0-preview.2...codex-zcode-bridge-preview-v2.0.0-preview.3) (2026-11-11)

Preview 2.0 Start Plan 多轮运行时认证与官方 Desktop Host 启动兼容性修复（EXPERIMENTAL / PREVIEW ONLY，仅面向开发者和测试用户；发布目标为 `preview` 分支，不经过 Release Please）。

### Fixed

* 官方 AppServer 统一使用已验证安装的 Desktop Host 启动身份：`--surface desktop`、`ZCODE_APP_VERSION` 和 `ZCODE_BUILD_COMMIT_ID`。
* ASAR 元数据结构损坏时 fail-closed，不再把无效 Desktop 安装误判为缺失元数据。
* Start Plan 私有凭据的一次性交付期限与 JWT 实际有效期分离，支持同一 Turn 内工具调用后的后续模型请求。
* 每个 Task 复用一次权威 Billing 权益判定，并发 Runtime Header 请求 single-flight，并保留取消、账户切换和 Worker 退出时的 fail-closed 撤销语义。
* JWT `exp` 继续被严格执行；无 `exp` 凭据仅在活动 Task 生命周期内缓存，并由父通道 EOF、取消和适配器完成撤销。

### Validation

* 真实 Start Plan E2E：`account:bigmodel-start-plan`、`GLM-5.3-Flash`、reasoning `max`，Windows + 官方 AppServer 0.17.1。
* Billing GET 恰好 1 次，HTTP 200；主 Turn 3 次模型 HTTP 请求均为 200，跨 `Write` / `Read` 工具调用完成并输出合法 AgentReport。
* Result Commit、Worker Exit、Process Tree Cleanup、Lease Release 全部通过，无 active lifecycle operation、无 Hold。
* Coding Plan 定向回归、677 项 affected tests、SQLite Stress 3/3、Typecheck、Build、Plugin Validation、Bundle Freshness 通过。
* Windows、Ubuntu Verify 与 SQLite resource matrix 通过。

### Not verified

* 真实 Start Plan E2E 仅在 Windows 上执行；Ubuntu 和其他部署目标仍为合成/CI 验证。
* 历史 HTTP 405 根因仍未确认；本轮真实 E2E 未观察到 HTTP 405、Provider code 3012 或 unusual activity。
* 一次辅助 `session_title` 请求在本地因 `Start Plan runtime identity is not verified.` 失败，`maxRetries=0`，不影响已完成的主动模型 Turn。

## [2.0.0-preview.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v2.0.0-preview.1...codex-zcode-bridge-preview-v2.0.0-preview.2) (2026-11-10)

Preview 2.0 Account Provider 注册兼容性修复（EXPERIMENTAL / PREVIEW ONLY，仅面向开发者和测试用户；发布目标为 `preview` 分支，不经过 Release Please）。

### Fixed

* AppServer 0.17.1 任务级 Account Provider Snapshot 现在为每个 Provider 发布明确的布尔 `current`，并仅将任务选中的 Provider 标记为当前。
* Start Plan Provider 注册失败继续阻止 Session 创建和模型 Turn，同时通过 ADR-011 保留经过白名单过滤的 RPC 诊断。
* 超时或请求前通道关闭不再被错误归类为已观察到 JSON-RPC Error Frame 的拒绝。

### Validation

* 官方 AppServer 0.17.1 原生合成注册测试。
* Start Plan 三模型目录与 `GLM-5.3-Flash` 模型选择测试。
* Built-in Revision 来源一致性验证。
* Coding Plan 兼容性回归。
* Windows、Ubuntu Verify 与 SQLite resource matrix 通过。

### Not verified

* 本版本发布时尚未完成真实 Start Plan 模型请求验收。
* 原始 HTTP 405 根因仍未确认。
* 3012 未在本轮历史证据中观察到。

## [2.0.0-preview.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-preview-v1.6.0-preview.3...codex-zcode-bridge-preview-v2.0.0-preview.1) (2026-11-08)

Preview 2.0 集成版本（EXPERIMENTAL / PREREVIEW ONLY，仅面向开发者和测试用户；发布目标为 `preview` 分支，不经过 Release Please）。

### Features

* SQLite-only 统一生产架构：单一 SQLite Authority 与单一 Lifecycle Manager，JSON TaskStore/Manager 与旧 CLI 执行链退役（PR #67）。
* Start Plan 实验性集成：官方加密凭据发现（`enc:v1:` AES-256-GCM）、实时模型级 Billing 权益门、Provider 注册前置校验、私有凭据一次性租约与 HANDLE 身份门禁（PR #62、#65、#67）。
* Windows 清理加速与锁发布重试预算修复：失败清理路径预启动 ADR-009 辅助进程；`state.lock` 发布 rename 重试与撤回路径对齐到 5 秒有界预算（PR #67）。

### BREAKING CHANGES

* 公共 Core 计划在下一主版本进行破坏性调整；Preview 渠道不承诺 Core API 兼容性。
* SQLite-only 架构退役 JSON/CLI 生产执行链：旧 JSON 任务历史不会被迁移或读取。
* SQLite v13 数据库不自动迁移：升级要求先停所有 Bridge host/Manager，再用 `dist/upgrade-sqlite-v14.mjs` 执行显式离线复制升级，然后切换 `authority.json` 的 `data_root`（见 README 与 `docs/ZCODE_RUNTIME.md`）。
* SQLite 模式要求 Node.js `>=24.16.0 <25`；旧 JSON 运行时的 Node `>=22.18` 要求不再适用。

## [1.6.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.5.0...codex-zcode-bridge-v1.6.0) (2026-11-05)


### Features

* ADR-024 scoped hold recovery + unified attention thin waiter (M2 integration) ([c770345](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c7703451b51d6cb7d0922671a739e672bd690b7e))
* **sqlite:** scope hold recovery to workspace per ADR-024 ([9b7b0c7](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9b7b0c7a7f2ea5be0d7be70dc04ebec6fb64a24a))
* unify attention waiting with thin waiter ([785304d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/785304d359a61b9dc11aa1a438ca5780594766f5))


### Bug Fixes

* address M2 attention waiter review findings ([b3ac540](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b3ac540e295994277d05881309d08231edcf5c17))
* allow bounded startup time for Windows cleanup helper ([fc73947](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fc739471d0a566d19ec6d9a308c8b5c34b53d7da))
* avoid duplicate turn-start events on coalesced ACKs ([a6ba76c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a6ba76c7a3ddb97e4c7f37754eb85c7eb9c9d82b))
* exit claim-only workers deterministically after result write ([7fbbfce](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7fbbfceca166eba7e51110c8c64727b8bceaf19f))
* keep the MVP fake app-server alive in hosted CI ([78115c1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/78115c188c66233b4f83561d2fca1e5fec70b1da))
* keep worker alive through app-server and cleanup-helper teardown races ([4a3763e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4a3763ebbd61f8b9d12b9464e2e406df70d0ce88))
* keep Worker alive through app-server and cleanup-helper teardown races ([f8cfb51](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f8cfb510c9ba8a0be31b5887277a7ff7cf7c4dfa))

## [1.5.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.4.0...codex-zcode-bridge-v1.5.0) (2026-11-03)


### Features

* bind doctor to SQLite authority and add test impact gating ([ba9277d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ba9277df8ee1daef0434b1e8b26645f1e80e4044))
* bind doctor to SQLite authority and add test impact gating ([7b4dcaa](https://github.com/Sandyzzx/codex-zcode-bridge/commit/7b4dcaa9a9e1dc5bc9b20c2aa9eead3d31f29cbd))


### Bug Fixes

* **ci:** diagnose Windows worker identity probes ([23958d8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/23958d8098dfed4016d0a7c60895b6651f663898))
* **runtime:** avoid PowerShell module lookup in identity probe ([21ffa75](https://github.com/Sandyzzx/codex-zcode-bridge/commit/21ffa7581aac7f3cc6cc9ef1234b1d896864df96))
* **runtime:** launch Windows identity probe directly ([2ee975d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2ee975df603aafe9b5246d831dbfd30aba761000))
* **runtime:** pin Windows PowerShell module discovery ([3925eab](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3925eabae634b3d4b7a48aa190ae3e4615875066))
* **store:** widen bounded transient lock retries ([6050e1e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6050e1ecc0e3d5e11fba6c51a3365bcd0bdc03bf))
* **test:** respect Windows-only SQLite lifecycle support on POSIX ([bf06f52](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bf06f5204723915ebfe3723c18a181736a292556))

## [1.4.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.3.0...codex-zcode-bridge-v1.4.0) (2026-11-03)


### Features

* unify ZCode path discovery ([32ed22f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/32ed22fb743e97dd40d69f9e8c92ea912178c6b5))
* unify ZCode path discovery ([32ed22f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/32ed22fb743e97dd40d69f9e8c92ea912178c6b5))
* unify ZCode path discovery ([c39909a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c39909a5718396f463de08b1a812cf309f3a1616))


### Bug Fixes

* align PowerShell UNC path classification ([df38f13](https://github.com/Sandyzzx/codex-zcode-bridge/commit/df38f13006f418d40a9f06461682e880cb8bb572))
* classify doctor data directory access errors ([4282b8f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4282b8fc64c97399416d8a9a9d53e59bc799cb67))
* compare worker paths by platform rules ([8fad454](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8fad454b4d4f78d82b75fbbbdee3c049346fb26a))
* honor POSIX data directory migrations ([82df987](https://github.com/Sandyzzx/codex-zcode-bridge/commit/82df9879a1b2b85fa7faaa94bc086e03ef30b061))
* repair path discovery validation and doctor diagnostics ([c505c24](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c505c240f8bb21d9b7417d8c7a8c4f3323e0b633))
* repair ZCode path discovery review findings ([c95b9c4](https://github.com/Sandyzzx/codex-zcode-bridge/commit/c95b9c42ab9a236c9e723a4e63f9dae09cf1cacb))

## [1.3.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.3.0-rc.4...codex-zcode-bridge-v1.3.0) (2026-11-02)


### Features

* add Codex rollout master token usage ([d91913a](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d91913a2c1b4b04485ee2815bb3b9fb80be2f131))
* add model catalog controls and refresh plugin branding ([9ac27e2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9ac27e2b654bd6cc11dd99981e134ae9671d838f))
* add native task feedback snapshots ([b6f4385](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b6f43859c5301e6e10f1aa48035c171edb91e5b8))
* add project task ledger and structured ZCode run reporting ([a814f01](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a814f015921d89c02efdd5021ed8e6dcc86bd98a))
* add provenance-aware task feedback snapshot ([fcd9b6f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fcd9b6f9cc8f077d8cae6a21fdc954bf1e67459a))
* add provenance-aware task feedback snapshot ([f1f6b12](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f1f6b12ffe84c42db491e59fb34096a1569489b6))
* add setup diagnostics and task reliability coverage ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))
* add setup diagnostics and task reliability coverage ([14a8654](https://github.com/Sandyzzx/codex-zcode-bridge/commit/14a865485c33eb78964f6350a783636e8ba57a00))
* add setup diagnostics and task reliability coverage ([#3](https://github.com/Sandyzzx/codex-zcode-bridge/issues/3)) ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))
* add stop-the-world SQLite authority candidate ([f27f7af](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f27f7afc2b73ac21e221ec6dcf69a171fdc9fd25))
* add task ledger and structured run reporting ([79082a6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/79082a6711441e09b7310fc0c58c6f64fcd342fb))
* clarify complete-task dispatch and acceptance ownership ([a66d612](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a66d612665ef5c2a9beb76f678092e0f5e44a7d9))
* configure marketplace plugin icons ([b0fbf0b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b0fbf0b80181c8adbead69c57b596025b21156bf))
* relay ZCode interaction requests to Codex ([fd6b1b3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fd6b1b35d86acfe43591e769900dbd75ba5ef5a5))
* report active reasoning level at task startup ([2697c58](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2697c582c7c86bf1eaf25a14c1a0f27345cf9374))
* require scoped Bridge authorization and progressively load Skill guidance ([83d3f13](https://github.com/Sandyzzx/codex-zcode-bridge/commit/83d3f13b7f9163bdb1e3d0decff630dde3e36164))
* save runtime settings and automate releases ([4f09416](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4f094167bee3e8924a03458347e4d30437c8432e))
* **sqlite:** add administrative abandonment recovery ([71964e0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/71964e0fcd941b79a76c773048c8de7caeb10036))
* **sqlite:** finalize Stage 2 cutover candidate ([aae3abf](https://github.com/Sandyzzx/codex-zcode-bridge/commit/aae3abfad17203a54da23f24037aa9ba7484b9ba))
* **sqlite:** preserve local workspace workflow ([8ca84a1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8ca84a1ac251d0d8f49e4fbf93c0f7f4e4082bfb))
* use Owner-selected original E plugin artwork ([fb5c0a0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fb5c0a0a9bd55973d8e754aa55946aa04ac993eb))


### Bug Fixes

* add optional headless browser host and handle large session payloads ([020c8a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/020c8a918d47bb5c6f94a2fa1b0a8049aae5c80c))
* avoid double-prefixing account provider IDs ([6175e45](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6175e45f2c8dc9825d08d109517cf23aa6f59f15))
* **ci:** verify committed bridge bundle ([ed4dead](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ed4deadf7719682fcc534ce38d003ef4c1619143))
* compare worktree roots independent of path aliases ([d25739c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d25739c9bbf49baef124cda334aaf033360c78fb))
* expose execution observation in MCP status schema ([5527800](https://github.com/Sandyzzx/codex-zcode-bridge/commit/5527800ad1c31660ab53a44456d8e6f2dbef3aea))
* extend bounded Windows lock release retries ([bfab338](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bfab3386937f552d4c60761f32df9ea097fcb6f1))
* handle cancellation in active detached workers ([bf23b8b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bf23b8b97bc8beb3016413da2a322d3d155690aa))
* harden task execution and extract shared host core ([3427555](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34275551780df766810d97127a60b45ad4af655c))
* harden Windows process ownership and cleanup ([628984c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/628984ca625a4d307b859d9f32d49e52e2d21ee6))
* harden Windows process ownership, lock cleanup and root validation ([73af9d6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73af9d60ff9bbcbbc1ae1d7b1f9b9fb9fca48bb0))
* improve bridge reliability for long sessions ([ae8aa66](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ae8aa6692802b3af3426e20741db3719184680e5))
* include loader asset in test build ([28cfb72](https://github.com/Sandyzzx/codex-zcode-bridge/commit/28cfb7201c9174a0907667eee80be0995e9ba444))
* launch Bridge from portable plugin manifest ([6c455ac](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6c455acf1cfeda358462f010afda04623cf7605f))
* make task retries idempotent and status reads responsive ([34134b6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34134b6a20481bbab9786e70ceeb3d50e468819f))
* **manager:** cold-start grace window and one-shot worker respawn ([db8cab5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/db8cab50e4af1091dd775d23ca0327503a2150bb))
* **plugin:** avoid false shell injection finding ([909a428](https://github.com/Sandyzzx/codex-zcode-bridge/commit/909a4285fce9df26816c8071abf9b95d274fe379))
* **plugin:** prepare scanner-ready marketplace bundle ([26d18ff](https://github.com/Sandyzzx/codex-zcode-bridge/commit/26d18ffa8e7ec528693eb1830332acb46c33aeb0))
* preserve browser environment and validate short repository roots ([f3576a2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f3576a266adb02f2c7e30428f304ccd34f29ea5f))
* preserve browser environment and validate short repository roots ([2bf434d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2bf434dc09ca8e4ab7e5df9195850647cc53882c))
* preserve claimant evidence across process generations ([73d4a73](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73d4a731c5e8d34e4ff6f8ec146eb07c8598778b))
* preserve completed results through cleanup ([3c5b916](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3c5b9168867986fe15894e5723015b3e1e775efe))
* prevent live worker recovery latch ([cab82a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/cab82a918514c6329f4982477b7eb0e8ada6cc01))
* reconcile verified worker exits during cancellation ([b09a391](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b09a3914d6baa5c56721b6aea77aa8ae0a8cc2a7))
* recover terminal cleanup holds safely ([0c2d834](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0c2d834b783e542abb0f1fc282b162c739d63bf5))
* recover terminal cleanup holds safely ([8044fda](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8044fda49616c44c900c2dae954a8ce141167825))
* release local trust and recovery fences ([ca0e19c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca0e19c437438d2bfcb9e79f5825893062aecd66))
* **release:** publish v1.3.0-rc.2 preview ([f52096b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f52096b5b67cd16c97261a6dda9897ea5b74b2af))
* render concise task feedback ([a8af97e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a8af97ea105e7f15dbeb12b3ca2eb20ad2134d3f))
* render concise task feedback ([842404b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/842404bf6b43c48d15a97a68e0b07f850d0c92d7))
* replay missed ZCode session events ([f36b885](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f36b8857e765df06900d289aed44e1f6539a6355))
* retry transient Windows lock publication races ([#30](https://github.com/Sandyzzx/codex-zcode-bridge/issues/30)) ([62205f0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/62205f07f6277ff68e30b85d00e81e1431c02a64))
* **sqlite-candidate:** bind provenance to shipped bridge bundle ([ca288fd](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ca288fd386fc086410d8e1b0104196ad70d95165))
* **sqlite:** frame bootstrap lock handoff safely ([196eb17](https://github.com/Sandyzzx/codex-zcode-bridge/commit/196eb17165d2be42f1ebb4c364f2908b7da1d6bb))
* **sqlite:** harden fresh bootstrap lock and crash recovery ([0ebd983](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0ebd983048660332610690be5e3d28493cf5182b))
* stabilize browser timeout fixtures on Node 22 ([34f26e8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34f26e893fcfffebdbf3f36e36912723e5a71656))
* stabilize Windows release regression tests ([20661d4](https://github.com/Sandyzzx/codex-zcode-bridge/commit/20661d44c10337ae18636ec66b7850c1e365e102))
* stop work and report exhausted ZCode usage ([6756225](https://github.com/Sandyzzx/codex-zcode-bridge/commit/675622515db6475b095ce63b17c860fc8f549c89))
* support headless browser hosting and large session interactions ([66e81b1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/66e81b18577edc36c876faa03908ee4471ca6a89))
* sync plugin version for 0.7.0 release ([2a76674](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2a76674e6af90dd489e570549a32ea7095d3a35a))
* **test:** create ignored token evidence parent ([b1e0167](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b1e01672aa7b0f8987e9dd3c06842c36ef2a6261))
* **test:** preserve compiled SQLite schema fixture ([d85f6ae](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d85f6ae92ba715ceaee7f9d593f3ba32ef16e70b))
* update codex plugin manifest on release ([f2af48c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f2af48c3b425376fd3d66490b06ab34190c07c7e))


### Miscellaneous Chores

* **release:** request stable 1.3.0 ([663595c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/663595c4372e6a214826dc7ce11aded9f49d72d3))

## [1.3.0-rc.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.3.0-rc.3...codex-zcode-bridge-v1.3.0-rc.4) (2026-11-02)

Preview local-trust hotfix.

### Bug Fixes

* keep a transiently unknown Worker probe scoped to the scanning Manager instead of latching a global Recovery Hold
* use the single-user local `yolo` execution profile for SQLite so ordinary coding work can run unattended like the JSON path
* preserve explicit Owner boundaries for publishing, production Authority changes, credentials, and destructive operations outside task scope

## [1.3.0-rc.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.3.0-rc.2...codex-zcode-bridge-v1.3.0-rc.3) (2026-11-02)

Preview hotfix.

### Bug Fixes

* prevent a second SQLite Manager from turning an exact, still-running Worker into a persistent global Recovery Hold
* keep the non-owning Manager read-only without blocking the owning Worker's interaction channel

## [1.3.0-rc.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.3.0-rc.1...codex-zcode-bridge-v1.3.0-rc.2) (2026-11-01)

Preview hotfix.

### Bug Fixes

* accept line-ending-equivalent SQLite schema text on Windows while preserving fail-closed schema validation

## [1.3.0-rc.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.7...codex-zcode-bridge-v1.3.0-rc.1) (2026-11-01)

Preview release.

### Features

* add SQLite lifecycle authority, archive-first cutover, restart recovery, and audited cleanup-hold administration
* preserve JSON-compatible local workspace behavior without a new trusted-directory allowlist
* report a bounded Codex Master-token window from an explicit local Thread rollout
* retain progressive Skill guidance, dispatch policies, and the Owner-selected Original E artwork

## [1.2.7](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.6...codex-zcode-bridge-v1.2.7) (2026-10-19)


### Bug Fixes

* harden Windows process ownership and cleanup ([628984c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/628984ca625a4d307b859d9f32d49e52e2d21ee6))
* harden Windows process ownership, lock cleanup and root validation ([73af9d6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73af9d60ff9bbcbbc1ae1d7b1f9b9fb9fca48bb0))
* preserve claimant evidence across process generations ([73d4a73](https://github.com/Sandyzzx/codex-zcode-bridge/commit/73d4a731c5e8d34e4ff6f8ec146eb07c8598778b))

## [1.2.6](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.5...codex-zcode-bridge-v1.2.6) (2026-10-16)


### Bug Fixes

* preserve browser environment and validate short repository roots ([f3576a2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f3576a266adb02f2c7e30428f304ccd34f29ea5f))
* preserve browser environment and validate short repository roots ([2bf434d](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2bf434dc09ca8e4ab7e5df9195850647cc53882c))

## [1.2.5](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.4...codex-zcode-bridge-v1.2.5) (2026-10-16)


### Bug Fixes

* add optional headless browser host and handle large session payloads ([020c8a9](https://github.com/Sandyzzx/codex-zcode-bridge/commit/020c8a918d47bb5c6f94a2fa1b0a8049aae5c80c))
* stabilize browser timeout fixtures on Node 22 ([34f26e8](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34f26e893fcfffebdbf3f36e36912723e5a71656))
* support headless browser hosting and large session interactions ([66e81b1](https://github.com/Sandyzzx/codex-zcode-bridge/commit/66e81b18577edc36c876faa03908ee4471ca6a89))

## [1.2.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.3...codex-zcode-bridge-v1.2.4) (2026-10-14)


### Bug Fixes

* stop work and report exhausted ZCode usage ([6756225](https://github.com/Sandyzzx/codex-zcode-bridge/commit/675622515db6475b095ce63b17c860fc8f549c89))

## [1.2.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.2...codex-zcode-bridge-v1.2.3) (2026-10-08)


### Bug Fixes

* improve bridge reliability for long sessions ([ae8aa66](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ae8aa6692802b3af3426e20741db3719184680e5))

## [1.2.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.1...codex-zcode-bridge-v1.2.2) (2026-10-07)


### Bug Fixes

* render concise task feedback ([a8af97e](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a8af97ea105e7f15dbeb12b3ca2eb20ad2134d3f))
* render concise task feedback ([842404b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/842404bf6b43c48d15a97a68e0b07f850d0c92d7))

## [1.2.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.2.0...codex-zcode-bridge-v1.2.1) (2026-10-06)


### Bug Fixes

* recover terminal cleanup holds safely ([0c2d834](https://github.com/Sandyzzx/codex-zcode-bridge/commit/0c2d834b783e542abb0f1fc282b162c739d63bf5))
* recover terminal cleanup holds safely ([8044fda](https://github.com/Sandyzzx/codex-zcode-bridge/commit/8044fda49616c44c900c2dae954a8ce141167825))
* retry transient Windows lock publication races ([#30](https://github.com/Sandyzzx/codex-zcode-bridge/issues/30)) ([62205f0](https://github.com/Sandyzzx/codex-zcode-bridge/commit/62205f07f6277ff68e30b85d00e81e1431c02a64))

## [1.2.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.1.0...codex-zcode-bridge-v1.2.0) (2026-10-05)


### Features

* add provenance-aware task feedback snapshot ([fcd9b6f](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fcd9b6f9cc8f077d8cae6a21fdc954bf1e67459a))
* add provenance-aware task feedback snapshot ([f1f6b12](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f1f6b12ffe84c42db491e59fb34096a1569489b6))

## [1.1.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.5...codex-zcode-bridge-v1.1.0) (2026-10-05)


### Features

* add project task ledger and structured ZCode run reporting ([a814f01](https://github.com/Sandyzzx/codex-zcode-bridge/commit/a814f015921d89c02efdd5021ed8e6dcc86bd98a))
* add task ledger and structured run reporting ([79082a6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/79082a6711441e09b7310fc0c58c6f64fcd342fb))

## [1.0.5](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.4...codex-zcode-bridge-v1.0.5) (2026-10-03)


### Bug Fixes

* preserve completed results through cleanup ([3c5b916](https://github.com/Sandyzzx/codex-zcode-bridge/commit/3c5b9168867986fe15894e5723015b3e1e775efe))
* replay missed ZCode session events ([f36b885](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f36b8857e765df06900d289aed44e1f6539a6355))

## [1.0.4](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.3...codex-zcode-bridge-v1.0.4) (2026-10-03)


### Bug Fixes

* handle cancellation in active detached workers ([bf23b8b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/bf23b8b97bc8beb3016413da2a322d3d155690aa))
* make task retries idempotent and status reads responsive ([34134b6](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34134b6a20481bbab9786e70ceeb3d50e468819f))
* reconcile verified worker exits during cancellation ([b09a391](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b09a3914d6baa5c56721b6aea77aa8ae0a8cc2a7))

## [1.0.3](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.2...codex-zcode-bridge-v1.0.3) (2026-10-02)


### Bug Fixes

* harden task execution and extract shared host core ([3427555](https://github.com/Sandyzzx/codex-zcode-bridge/commit/34275551780df766810d97127a60b45ad4af655c))

## [1.0.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.1...codex-zcode-bridge-v1.0.2) (2026-10-02)


### Bug Fixes

* **manager:** cold-start grace window and one-shot worker respawn ([db8cab5](https://github.com/Sandyzzx/codex-zcode-bridge/commit/db8cab50e4af1091dd775d23ca0327503a2150bb))

## [1.0.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v1.0.0...codex-zcode-bridge-v1.0.1) (2026-10-01)


### Bug Fixes

* launch Bridge from portable plugin manifest ([6c455ac](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6c455acf1cfeda358462f010afda04623cf7605f))

## [1.0.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.10.1...codex-zcode-bridge-v1.0.0) (2026-09-30)


### Bug Fixes

* **ci:** verify committed bridge bundle ([ed4dead](https://github.com/Sandyzzx/codex-zcode-bridge/commit/ed4deadf7719682fcc534ce38d003ef4c1619143))
* **plugin:** avoid false shell injection finding ([909a428](https://github.com/Sandyzzx/codex-zcode-bridge/commit/909a4285fce9df26816c8071abf9b95d274fe379))

## [0.10.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.10.0...codex-zcode-bridge-v0.10.1) (2026-09-30)


### Bug Fixes

* **plugin:** prepare scanner-ready marketplace bundle ([26d18ff](https://github.com/Sandyzzx/codex-zcode-bridge/commit/26d18ffa8e7ec528693eb1830332acb46c33aeb0))

## [0.10.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.9.0...codex-zcode-bridge-v0.10.0) (2026-09-30)


### Features

* configure marketplace plugin icons ([b0fbf0b](https://github.com/Sandyzzx/codex-zcode-bridge/commit/b0fbf0b80181c8adbead69c57b596025b21156bf))

## [0.9.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.8.0...codex-zcode-bridge-v0.9.0) (2026-09-30)


### Features

* report active reasoning level at task startup ([2697c58](https://github.com/Sandyzzx/codex-zcode-bridge/commit/2697c582c7c86bf1eaf25a14c1a0f27345cf9374))

## [0.8.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.2...codex-zcode-bridge-v0.8.0) (2026-09-30)


### Features

* add model catalog controls and refresh plugin branding ([9ac27e2](https://github.com/Sandyzzx/codex-zcode-bridge/commit/9ac27e2b654bd6cc11dd99981e134ae9671d838f))

## [0.7.2](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.1...codex-zcode-bridge-v0.7.2) (2026-09-29)


### Bug Fixes

* update codex plugin manifest on release ([f2af48c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/f2af48c3b425376fd3d66490b06ab34190c07c7e))

## [0.7.1](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.7.0...codex-zcode-bridge-v0.7.1) (2026-09-29)


### Bug Fixes

* avoid double-prefixing account provider IDs ([6175e45](https://github.com/Sandyzzx/codex-zcode-bridge/commit/6175e45f2c8dc9825d08d109517cf23aa6f59f15))

## [0.7.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.6.0...codex-zcode-bridge-v0.7.0) (2026-09-29)


### Features

* add setup diagnostics and task reliability coverage ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))
* add setup diagnostics and task reliability coverage ([14a8654](https://github.com/Sandyzzx/codex-zcode-bridge/commit/14a865485c33eb78964f6350a783636e8ba57a00))
* add setup diagnostics and task reliability coverage ([#3](https://github.com/Sandyzzx/codex-zcode-bridge/issues/3)) ([fbcf756](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fbcf75663811e2a59aabdb49b6feaf224b3d8448))


### Bug Fixes

* compare worktree roots independent of path aliases ([d25739c](https://github.com/Sandyzzx/codex-zcode-bridge/commit/d25739c9bbf49baef124cda334aaf033360c78fb))
* include loader asset in test build ([28cfb72](https://github.com/Sandyzzx/codex-zcode-bridge/commit/28cfb7201c9174a0907667eee80be0995e9ba444))

## [0.6.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.5.0...codex-zcode-bridge-v0.6.0) (2026-09-28)


### Features

* relay ZCode interaction requests to Codex ([fd6b1b3](https://github.com/Sandyzzx/codex-zcode-bridge/commit/fd6b1b35d86acfe43591e769900dbd75ba5ef5a5))

## [0.5.0](https://github.com/Sandyzzx/codex-zcode-bridge/compare/codex-zcode-bridge-v0.4.0...codex-zcode-bridge-v0.5.0) (2026-09-28)


### Features

* save runtime settings and automate releases ([4f09416](https://github.com/Sandyzzx/codex-zcode-bridge/commit/4f094167bee3e8924a03458347e4d30437c8432e))

## [Unreleased]
