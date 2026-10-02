# 更新日志

本文件记录面向用户的变更。版本号遵循语义化版本，并由 Release Please 根据 Conventional Commits 生成发布记录：`fix:` 升补丁号，`feat:` 升次版本号，`BREAKING CHANGE:` 升主版本号。

当前版本以 `package.json` 和 Release Please manifest 为准。提交推送到 `master` 后，Release Please 会在有待发布变更时创建发布 PR，并同步更新版本文件与本日志；合并发布 PR 后会生成对应 Git tag 和 GitHub Release。

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
