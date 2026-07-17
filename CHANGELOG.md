# Changelog

## [2.6.2](https://github.com/chrischall/ofw-mcp/compare/v2.6.1...v2.6.2) (2026-07-17)


### Bug Fixes

* ofw_sync_messages: always sync the newest messages, never starve them behind a backfill ([#144](https://github.com/chrischall/ofw-mcp/issues/144)) ([f2079e1](https://github.com/chrischall/ofw-mcp/commit/f2079e192983cbc5de9e23238e83374df1dc324b))

## [2.6.1](https://github.com/chrischall/ofw-mcp/compare/v2.6.0...v2.6.1) (2026-07-15)


### Bug Fixes

* label a live-fetched sent message as sent, not inbox ([#141](https://github.com/chrischall/ofw-mcp/issues/141)) ([9df8f10](https://github.com/chrischall/ofw-mcp/commit/9df8f10d4cc4a2b7da399c52c7eeb9d2ed1200ee))
* resume bounded non-deep sync instead of falsely reporting done ([#140](https://github.com/chrischall/ofw-mcp/issues/140)) ([8893649](https://github.com/chrischall/ofw-mcp/commit/889364981cc8b26bc92af6b10f9a293be206b0d6))

## [2.6.0](https://github.com/chrischall/ofw-mcp/compare/v2.5.0...v2.6.0) (2026-07-14)


### Features

* bound and resume ofw_sync_messages for the Workers subrequest limit ([#137](https://github.com/chrischall/ofw-mcp/issues/137)) ([b650a38](https://github.com/chrischall/ofw-mcp/commit/b650a3808e0406add6b72ad2c9d297c8a65f44ac))
* host ofw-mcp as a Cloudflare Worker remote connector for claude.ai ([#130](https://github.com/chrischall/ofw-mcp/issues/130)) ([3c79036](https://github.com/chrischall/ofw-mcp/commit/3c79036f4f56f64569043538a05f96fc4d79cbe8))
* serve connector at connector.ofw.nullnet.app custom domain ([#133](https://github.com/chrischall/ofw-mcp/issues/133)) ([52481b3](https://github.com/chrischall/ofw-mcp/commit/52481b33898ce8fe08b08ab07bc313c2bddbb188))


### Bug Fixes

* guard client.ts .env load so the Worker starts ([#135](https://github.com/chrischall/ofw-mcp/issues/135)) ([0736940](https://github.com/chrischall/ofw-mcp/commit/0736940d9facf626b3e92b5f2ad6bd98bf391ead))
* show a clean message when OFW rejects login credentials ([#136](https://github.com/chrischall/ofw-mcp/issues/136)) ([0f523a4](https://github.com/chrischall/ofw-mcp/commit/0f523a4204c1807621f047b59c8d26ad3142cb51))

## [2.5.0](https://github.com/chrischall/ofw-mcp/compare/v2.4.4...v2.5.0) (2026-07-13)


### Features

* OFW_CALENDAR_WRITES opt-in enables calendar writes in drafts mode ([#122](https://github.com/chrischall/ofw-mcp/issues/122)) ([c885bb9](https://github.com/chrischall/ofw-mcp/commit/c885bb993d93f4ae7d2567dd7ca70e0e6d024d07))
* **skill:** add OurFamilyWizard fpx access skill ([#126](https://github.com/chrischall/ofw-mcp/issues/126)) ([3a5da32](https://github.com/chrischall/ofw-mcp/commit/3a5da326f1874bcdfac5f30764fe974b38359815))


### Bug Fixes

* **skill:** correct requests.md retry-recipe temp file and id/entityId precedence ([#129](https://github.com/chrischall/ofw-mcp/issues/129)) ([24d550a](https://github.com/chrischall/ofw-mcp/commit/24d550ad916c2ac71d7f9fe9ea8e4ff05ee52582))

## [2.4.4](https://github.com/chrischall/ofw-mcp/compare/v2.4.3...v2.4.4) (2026-07-07)


### Bug Fixes

* bump @chrischall/mcp-utils to 0.12.0 ([#120](https://github.com/chrischall/ofw-mcp/issues/120)) ([6420871](https://github.com/chrischall/ofw-mcp/commit/6420871101d7658fddda1b65558c61943d475e51))
* sanitize co-parent-controlled attachment filename on download (path traversal) ([#115](https://github.com/chrischall/ofw-mcp/issues/115)) ([82232d6](https://github.com/chrischall/ofw-mcp/commit/82232d639b24b78a494ff6a4300f2e564c18a760))


### Refactor

* adopt mcp-utils parseLenient ([#117](https://github.com/chrischall/ofw-mcp/issues/117)) ([ffd8183](https://github.com/chrischall/ofw-mcp/commit/ffd818310779c3b9f41be08499bfa17054bfc5c7))
* tighten parseLenient generic call site in ofw _shared ([#119](https://github.com/chrischall/ofw-mcp/issues/119)) ([51836de](https://github.com/chrischall/ofw-mcp/commit/51836de1e84f535b56d1fd5d8d6ce4b698b2f2b3))


### Documentation

* document first-party dependency-bump label exception ([#121](https://github.com/chrischall/ofw-mcp/issues/121)) ([4fd8948](https://github.com/chrischall/ofw-mcp/commit/4fd894886f00cffe723c294bed7ba2965910462b))

## [2.4.3](https://github.com/chrischall/ofw-mcp/compare/v2.4.2...v2.4.3) (2026-06-15)


### Refactor

* remove drifted root plugin.json cruft ([#104](https://github.com/chrischall/ofw-mcp/issues/104)) ([f5d5c0f](https://github.com/chrischall/ofw-mcp/commit/f5d5c0f6ffce52fffff1f84fca2f841d1e5ec8fb))


### Documentation

* correct inverted merge-model guidance (repo is squash-only) ([#99](https://github.com/chrischall/ofw-mcp/issues/99)) ([0673060](https://github.com/chrischall/ofw-mcp/commit/0673060e3eac79b7e85ded3d473cb94193c72d37))
* refresh CLAUDE.md architecture + auto-review follow-up convention ([#103](https://github.com/chrischall/ofw-mcp/issues/103)) ([ab92c37](https://github.com/chrischall/ofw-mcp/commit/ab92c3747b5c39b3d8ed0ee90d4ae57385777d81))

## [2.4.2](https://github.com/chrischall/ofw-mcp/compare/v2.4.1...v2.4.2) (2026-06-13)


### Bug Fixes

* revert userConfig migration, realign .mcp.json with the fleet ([#97](https://github.com/chrischall/ofw-mcp/issues/97)) ([6319764](https://github.com/chrischall/ofw-mcp/commit/6319764ec2a8babcdd758405d36f08576821793a))

## [2.4.1](https://github.com/chrischall/ofw-mcp/compare/v2.4.0...v2.4.1) (2026-06-13)


### Bug Fixes

* make OFW credentials editable in the plugin/Connectors UI via userConfig ([#95](https://github.com/chrischall/ofw-mcp/issues/95)) ([26a2f15](https://github.com/chrischall/ofw-mcp/commit/26a2f154be228520db02f689f7ec0f4313f08250))

## [2.4.0](https://github.com/chrischall/ofw-mcp/compare/v2.3.2...v2.4.0) (2026-06-12)


### Features

* OFW_WRITE_MODE gate (none/drafts/all) for structural write protection ([#90](https://github.com/chrischall/ofw-mcp/issues/90)) ([383adec](https://github.com/chrischall/ofw-mcp/commit/383adecb7d5b3fad2e99fd986a03c8291ded1ce4))
* runtime validation of OFW API responses at the client boundary ([#92](https://github.com/chrischall/ofw-mcp/issues/92)) ([a9caead](https://github.com/chrischall/ofw-mcp/commit/a9caeadbb29f64b328dfe81afb56460a5e4ad29d))


### Bug Fixes

* bot PRs bypass the CI gate unconditionally (upstream curtaincall[#86](https://github.com/chrischall/ofw-mcp/issues/86) review) ([#86](https://github.com/chrischall/ofw-mcp/issues/86)) ([f02c04a](https://github.com/chrischall/ofw-mcp/commit/f02c04a12c9fb25d9dfd1bdc2ab71a4c24738b5e))
* verify send/draft writes landed, paginate drafts sync, validate pagination inputs ([#81](https://github.com/chrischall/ofw-mcp/issues/81)) ([63804e6](https://github.com/chrischall/ofw-mcp/commit/63804e6ac7aa078c795cc2b403dc8be1a3c7265f))


### Documentation

* add missing tools to the README table (sync, unread-sent, attachments) ([#91](https://github.com/chrischall/ofw-mcp/issues/91)) ([eefb2c9](https://github.com/chrischall/ofw-mcp/commit/eefb2c9b5522e8d57bec3580db8c8c3b1880869c))
* declare MIT license and add README badges ([#88](https://github.com/chrischall/ofw-mcp/issues/88)) ([adfc3ea](https://github.com/chrischall/ofw-mcp/commit/adfc3ea6eccb7c0cb1ce099a8ed95f6c327a0104))

## [2.3.2](https://github.com/chrischall/ofw-mcp/compare/v2.3.1...v2.3.2) (2026-06-10)


### Bug Fixes

* restrict cache dir/db permissions to owner-only (0700/0600) ([#78](https://github.com/chrischall/ofw-mcp/issues/78)) ([5328567](https://github.com/chrischall/ofw-mcp/commit/53285674e4c835de6eb23f640c67d4f7670ba0c7))


### Refactor

* adopt shared TokenManager for the OFW bearer lifecycle ([#80](https://github.com/chrischall/ofw-mcp/issues/80)) ([d70cce2](https://github.com/chrischall/ofw-mcp/commit/d70cce20f0780f82492cd4c77332d2502cb8715d))

## [2.3.1](https://github.com/chrischall/ofw-mcp/compare/v2.3.0...v2.3.1) (2026-06-02)


### Performance

* stream attachment upload from disk instead of buffering it ([#69](https://github.com/chrischall/ofw-mcp/issues/69)) ([83006be](https://github.com/chrischall/ofw-mcp/commit/83006be10ef094ab0c98b5e63b6a279c453ca458))


### Refactor

* adopt mcp-utils 0.4.0 fileBlob for attachment upload ([#72](https://github.com/chrischall/ofw-mcp/issues/72)) ([7b55342](https://github.com/chrischall/ofw-mcp/commit/7b55342dfef9e69cb5e8861b0a5498eb667a6cfb))

## [2.3.0](https://github.com/chrischall/ofw-mcp/compare/v2.2.0...v2.3.0) (2026-05-29)


### Features

* adopt @fetchproxy/server 0.11.0 ([#61](https://github.com/chrischall/ofw-mcp/issues/61)) ([062d412](https://github.com/chrischall/ofw-mcp/commit/062d41200c36852bfe33d08df27f4d88a455cfc7))


### Bug Fixes

* **ci:** arm auto-merge from verdict comment when structured_output is empty ([#60](https://github.com/chrischall/ofw-mcp/issues/60)) ([3eed592](https://github.com/chrischall/ofw-mcp/commit/3eed592c769a8a8951e22e0533db0c770a6ff43a))
* **ci:** treat instant-merge race as success in auto-merge arm ([#58](https://github.com/chrischall/ofw-mcp/issues/58)) ([f3ce06b](https://github.com/chrischall/ofw-mcp/commit/f3ce06bbf075581d84d28947c24e999715d751d4))

## [2.2.0](https://github.com/chrischall/ofw-mcp/compare/v2.1.0...v2.2.0) (2026-05-28)


### Features

* **send-message:** accept messageId to send an existing draft ([#55](https://github.com/chrischall/ofw-mcp/issues/55)) ([c8c20cb](https://github.com/chrischall/ofw-mcp/commit/c8c20cba6fa7f3d81eaf120a2ccdf7203dee8fcc))


### Bug Fixes

* **client:** add per-request timeout to prevent multi-minute hangs ([#54](https://github.com/chrischall/ofw-mcp/issues/54)) ([77376fe](https://github.com/chrischall/ofw-mcp/commit/77376fe737695eb038a38b42ab12efee206ebac2))

## [2.1.0](https://github.com/chrischall/ofw-mcp/compare/v2.0.19...v2.1.0) (2026-05-27)


### Features

* **deps:** adopt @fetchproxy/bootstrap 0.8.0 for SW-eviction-resilient startup capture ([#52](https://github.com/chrischall/ofw-mcp/issues/52)) ([9f01ebf](https://github.com/chrischall/ofw-mcp/commit/9f01ebf9a47cdd07109c023aa81e65dc53856b67))

## [2.0.19](https://github.com/chrischall/ofw-mcp/compare/v2.0.18...v2.0.19) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#48](https://github.com/chrischall/ofw-mcp/issues/48)) ([025c3d1](https://github.com/chrischall/ofw-mcp/commit/025c3d1e5a8f8517f270bbf4f717be70ba6309f9))

## [2.0.18](https://github.com/chrischall/ofw-mcp/compare/v2.0.17...v2.0.18) (2026-05-23)


### Documentation

* add Acknowledgement of Terms section to README ([#43](https://github.com/chrischall/ofw-mcp/issues/43)) ([7163909](https://github.com/chrischall/ofw-mcp/commit/71639092d6b313d07407e072ad2ff1c9c3298ddf))
* **claude-md:** call out 100-char limit on server.json description ([a3a02e7](https://github.com/chrischall/ofw-mcp/commit/a3a02e773991e8112b7b68f2f531de46b5d5a72a))
* **claude-md:** call out 100-char limit on server.json description ([02c10a6](https://github.com/chrischall/ofw-mcp/commit/02c10a6e9c3740d5320748e77fce227f371e185a))

## [2.0.17](https://github.com/chrischall/ofw-mcp/compare/v2.0.16...v2.0.17) (2026-05-22)


### Bug Fixes

* **calendar:** mark ofw_update_event as destructive ([bddb81b](https://github.com/chrischall/ofw-mcp/commit/bddb81b7e63d24ee2d86e3001b912c7dd56692d0))
* **messages:** ofw_save_draft replaces via create+delete; ofw_get_message routes drafts ([f79bd25](https://github.com/chrischall/ofw-mcp/commit/f79bd259a747a026ac05b1f7a99dce153a985c9a))
* ofw_save_draft create-then-delete (Bug 1); ofw_get_message drafts routing (Bug 2) ([b8fb221](https://github.com/chrischall/ofw-mcp/commit/b8fb22149b66ec19b1076579ed1acb3e21b32882))
* **pr-auto-review:** drop id-token:write to avoid OIDC token exchange failure ([1e10203](https://github.com/chrischall/ofw-mcp/commit/1e10203109d5399dccf22ee54ee56c2b2487e351))
* **pr-auto-review:** drop id-token:write to fix OIDC 401 ([b2f340c](https://github.com/chrischall/ofw-mcp/commit/b2f340ca37398bee5341bd1e917a4442613bbb69))
* **pr-auto-review:** pass github_token to skip OIDC App exchange ([f046f68](https://github.com/chrischall/ofw-mcp/commit/f046f6846ef17ed1364640cffebf005584cd6664))


### Performance

* **sync:** parallelize attachment metadata fetches ([b71bff7](https://github.com/chrischall/ofw-mcp/commit/b71bff7c444eec34e6692e558098cc316158e8d8))


### Refactor

* dedupe BASE_URL and OFW_PROTOCOL_HEADERS into src/protocol.ts ([b56f2bb](https://github.com/chrischall/ofw-mcp/commit/b56f2bb5d26ffd4855f29efcaaabe12fd3ade342))
* export ApiRecipient and reuse across 5 call sites ([9cff708](https://github.com/chrischall/ofw-mcp/commit/9cff708961639e0696fdd27b05106da851c6eb43))
* extract parseBoolEnv helper, dedupe across three call sites ([073d3bd](https://github.com/chrischall/ofw-mcp/commit/073d3bd99ce45de2ed43b1a8e928f8e9bd1ca6de))
* **messages:** extract postMessageAndRefetch helper ([064b6f1](https://github.com/chrischall/ofw-mcp/commit/064b6f13339466dbfbef7f72af66e684812143ec))
* name token TTL and expiry-skew constants ([04e08f4](https://github.com/chrischall/ofw-mcp/commit/04e08f4e2b629e989f9e2ddaa14a5173a8288272))


### Documentation

* **claude,skill:** document create-then-delete and drafts-routing behaviors ([0f19b8f](https://github.com/chrischall/ofw-mcp/commit/0f19b8fedd741e439a6b58bc9f92f3ec94c7248a))
* **claude:** add OFW_DEBUG_LOG to env-var table ([da7e3bb](https://github.com/chrischall/ofw-mcp/commit/da7e3bbab8cf09ed7e9d755e0b91013ffe36ba99))
* **claude:** replace stale cache-write-through wording with GET-after-POST ([06d2a1c](https://github.com/chrischall/ofw-mcp/commit/06d2a1cb8850f03f47288044e59e02a30c5cc7c7))
* **claude:** rewrite Release workflow section to match current zero-touch loop ([969d1e4](https://github.com/chrischall/ofw-mcp/commit/969d1e4cceb32280cb07036ab68c026611b5e044))
* correct merge-method claim and document the new rulesets ([02e7274](https://github.com/chrischall/ofw-mcp/commit/02e72744e6d32e4a8fbb6fea45572ae6782b0188))
* correct merge-method claim; document the new rulesets ([b93bf4b](https://github.com/chrischall/ofw-mcp/commit/b93bf4b77cf7f4369c6351053b096dbd91f3e30a))
* **manifest,server:** mark OFW creds as optional to reflect fetchproxy fallback ([a52e127](https://github.com/chrischall/ofw-mcp/commit/a52e12726bc23d577d99b8a150ef57ba1def3ecf))
* **readme:** correct Node version requirement to &gt;=22.5 ([e03ff22](https://github.com/chrischall/ofw-mcp/commit/e03ff222e16f6c6fba13f2c49ebdd9189729d471))
* **readme:** refresh project structure and dev workflow sections ([61cce90](https://github.com/chrischall/ofw-mcp/commit/61cce90cccd198dbfb0d621ccf8a6f2e1f19d4e5))
* **skill:** add missing tools to the Messages inventory ([1c72311](https://github.com/chrischall/ofw-mcp/commit/1c723111e7419bf2dd385fe2d4ec0c5bb92313fb))
