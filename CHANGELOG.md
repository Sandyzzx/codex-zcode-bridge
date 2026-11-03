# 更新日志

本文件记录面向用户的变更。版本号遵循语义化版本，并由 Release Please 根据 Conventional Commits 生成发布记录：`fix:` 升补丁号，`feat:` 升次版本号，`BREAKING CHANGE:` 升主版本号。

当前版本以 `package.json` 和 Release Please manifest 为准。提交推送到 `master` 后，Release Please 会在有待发布变更时创建发布 PR，并同步更新版本文件与本日志；合并发布 PR 后会生成对应 Git tag 和 GitHub Release。

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
