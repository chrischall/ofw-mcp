# Changelog

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
