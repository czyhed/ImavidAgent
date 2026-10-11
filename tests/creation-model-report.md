# Model center / provider implementation handoff

Date: 2026-10-22. Branch: leifengyang/creation-models, based on main@18d2a00. No deployment, push, real provider key, or paid request was used.

## Public API and integration

`new ModelHub(store, channels, {transport})` implements the shared contract: `catalog`, `sync`, `configure`, `setDefault`, `resolve`, `complete`, `submitGeneration`, `pollGeneration`, and `cancelGeneration`. Optional `init({channels})` performs explicit, one-time audited bootstrap; `usage(workspaceId)` reads scoped completion usage. `catalog()` adds channels and an ETag. Generation results carry status, upstreamId, server-side bytes/mime, usage, and provider errors as applicable. Unknown/no-upstream recovery does not submit a new request or choose another model.

`routes()` in `server/routes/model-hub.mjs` exports GET `/api/model-hub`, POST `/api/model-hub/defaults`, POST `/api/model-hub/channels`, PATCH/DELETE `/api/model-hub/channels/:id`, POST `/api/model-hub/channels/:id/sync`, and POST `/api/model-hub/channels/:id/models`. Reads require viewer, writes require admin plus If-Match. Missing and stale versions return 428 and 409. The host HTTP layer supplies session/workspace context and CSRF enforcement. Configuration transactions use one PostgreSQL client and an advisory lock.

`CreationModels` accepts `{backend, notify}` and uses real APIs, admin controls, four stage defaults, manually selected capabilities, model disabling and manual IDs, channel CRUD/key rotation, protocol/video executor/edit transport settings, and an input-preserving conflict dialog. Independent CSS contains mobile table scrolling. Root owns App/http/index integration and migration 0019; this branch does not change them. `ChannelStore.init()` idempotently adds executor configuration/revision columns for isolated test databases.

## Behavior and safety

OpenAI-compatible and Anthropic directory synchronization fetches all pages before changing rows. New discoveries are disabled with no inferred capabilities; failed sync preserves the prior catalog, disappeared models become unavailable without silently changing defaults, and explicit manual IDs persist. Defaults and execution validate manual capability plus protocol/executor compatibility. Stored keys remain AES-256-GCM encrypted and public output exposes masks only.

Text and vision use OpenAI chat completions or Anthropic messages once per call and record usage without prompts or credentials. Images support generation and edits via multipart or explicit OMYAI JSON data URLs. MiniMax H3 supports submit/poll/cancel, first-frame bytes and documented validation; successful media is downloaded by the server. A task-id-only create response is queued. Provider points/tokens/seconds are not converted to money: costMicros and currency remain null unless both normalized monetary fields are explicitly supplied and valid.

External media requires public HTTPS, checked/pinned DNS, redirect validation on each hop, bounded body streams, and byte signature checks. Image results are limited to 10 MiB and videos to 100 MiB to match CreationMedia. Configured loopback HTTP API endpoints are supported for local development/tests, never as arbitrary result links. No raw upstream error body or key is exposed. Frozen protocol/executor snapshots are retained; a changed channel base URL blocks reuse rather than sending a rotated key to the old endpoint.

## Official source review

Reviewed on 2026-10-22 using official docs and SDK source (cached source files under TEMP/sj-creation-docs):

- CompShare MiniMax H3: https://www.compshare.cn/docs/minimax-h3/api/minimax-h3-video-api — POST /minimax/v2/video_generation, GET /minimax/v2/query/video_generation/{id}, DELETE /minimax/v2/video_generation/{id}; Bearer auth, Idempotency-Key, task_id, status/content.url, duration 4–30, documented resolutions/ratios, first-frame data URL up to 30 MiB.
- OpenAI official SDK models resource: https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts — official /models uses Page; compatible has_more/after extensions are additionally supported. Official chat and image API pages were reviewed through cached official page content.
- Anthropic model API: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/models.ts and https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/core/pagination.ts — after_id/last_id cursor pagination.
- Anthropic messages API: https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/src/resources/messages/messages.ts — messages, system content, base64 image blocks, and usage.

## Verification

- tests/creation-model.test.mjs: 25 real disposable-PostgreSQL tests; mocked provider HTTP only. Covers complete catalogs/failure retention, manual capabilities/defaults, protocol encryption/masking, text/vision/image/H3 execution, unknown outcomes, SSRF/redirect/size defenses, usage, optimistic conflicts and 12 competing stale mutations without pool starvation.
- tests/creation-model-browser.mjs: real React component plus routes/PostgreSQL, mocked external provider; persistence/defaults, visible conflict with preserved inputs, H3 masked channel, viewer permissions, and 390px viewport.
- Final gates passed: npm run check, npm run build, npm test (278/278), node --test tests/creation-model.test.mjs tests/creation.integration.mjs (26/26), and node tests/creation-model-browser.mjs.
- Nine meaningful mutation checks failed for the expected behavior and were restored: channel protocol, model availability, Anthropic cursor parameter, text content, image n, H3 task-id queued mapping, route admin requirement, React viewer controls, and CSS overflow. Temporary evidence is in TEMP/sj-model-mutations-hwds8ywu/{provider,hub,browser}.log. An additional logically equivalent mutation remained green and is not counted.

## Integration limits

No live paid provider verification was performed. Root must register routes/components, inject modelHub, and include the agreed migration. New transport deliberately does not use MODEL_HTTPS_PROXY: a generic forward proxy would resolve DNS outside the pinned public-address lookup, so proxy support needs a separately reviewed safe design. Result download limits are application limits and can reject a larger otherwise-valid provider output.
