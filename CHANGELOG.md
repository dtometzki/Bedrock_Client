# Changelog

## 1.12.6 - 2026-08-01

Security release (findings from a code review of the web GUI and the dependency tree):

- Remove the unused `@openai/codex-security` dependency (added with 1.12.5). It was never imported anywhere but pulled a ~300 MB tree — including a vendored Codex CLI binary — into every `npm install`, and required Node >= 22 while this package supports >= 20.
- Bundle `marked` 12.0.2 and DOMPurify 3.4.12 under `src/web/vendor/` and serve them from the client's own server instead of cdnjs. The CDN pinned DOMPurify 3.1.6, which is affected by a known sanitizer bypass (CVE-2026-0540, fixed in 3.3.2). Independently, the CDN scripts never actually loaded: the CSP HTTP header and the meta CSP disagreed, and with two policies both are enforced — so the GUI silently always ran in the plain-text fallback and showed the "Formatierung eingeschraenkt" notice.
- Move the GUI's inline script into `src/web/app.js` and make the HTTP header the single Content-Security-Policy (the meta tag is gone). `script-src 'self'` without `'unsafe-inline'` now blocks injected inline scripts and event handlers even if a future sanitizer bypass smuggles markup into a rendered answer; `img-src 'self' data:` keeps remote images out (a prompt-injection exfiltration channel); `frame-ancestors 'none'` plus `X-Frame-Options: DENY` prevent embedding, `Referrer-Policy: no-referrer` leaking URLs.
- Write config and session files with mode `0600` and create the config directory with `0700`: `last-session.json` contains entire conversations and was world-readable before. Existing files are tightened on their next write (`rename` adopts the temp file's mode).
- `npm audit fix` for the `brace-expansion` ReDoS advisory in the dev-only eslint dependency chain.
- Extend `npm run check` to parse `src/web/app.js`, and add tests for the strict CSP header, the locally served `/app.js` and `/vendor/*` scripts (including a DOMPurify >= 3.3.2 version guard), token-free access being limited to static GUI files, and the private session file permissions.

## 1.12.5 - 2026-08-01

- Extract the shared `tryPersist` helper into `src/config.js` and reuse it in both the CLI and the web server instead of keeping separate, near-identical copies.
- Add `pricingUsdPer1M` entries for `claude-sonnet-5` ($3/$15) and `claude-fable-5` ($10/$50) in the bundled `models.json`, and extend the built-in fallback price table with those models plus Opus 5 so session cost estimates no longer show "n/a" for the latest generation.
- Collapse the two separate `content` iterations in `toPublicMessages` into a single pass.
- Trim the CLI prompt history only every 250 excess entries (`1.5 × MAX_PROMPT_HISTORY`) instead of on every push past the cap, cutting splice allocations by ~99%.

## 1.12.4 - 2026-07-25

- Harden the stream interrupt controller: `dispose()` now wraps stdin cleanup in try/catch so a broken or closed stdin no longer crashes the process after a successful stream.
- Destroy the Bedrock client on `SIGTERM` so process managers (systemd, Docker) shut down cleanly without leaking open sockets.
- Add `Content-Security-Policy` and `X-Content-Type-Options` headers to the web GUI HTML response.
- Set a 60 s `requestTimeout` on the web server so slow or stalled clients can no longer hold a connection open indefinitely.
- Replace the per-request route dispatch object with a `Map` allocated once at server creation.
- Remove the `existsSync` TOCTOU check in `readLastModelId`; a plain `readFileSync` with try/catch is sufficient.
- Fix the import ordering in `src/usage.js` (all imports at the top).

## 1.12.3 - 2026-07-25

- Fall back to the built-in price table when `pricingUsdPer1M` in `models.json` contains invalid values (e.g. `"3$"`): `getModelPricing` now validates with `Number.isFinite` instead of silently producing `NaN` cost estimates.
- Cap the CLI prompt history at 500 entries so very long sessions no longer grow it unboundedly.
- Add `test/usage.test.js` covering configured prices, numeric strings, invalid values, the built-in fallback table and unknown models.

## 1.12.2 - 2026-07-25

- Stop re-uploading web GUI attachments on every follow-up turn: binary image/document blocks are kept for the most recent user turn only (`limitAttachmentHistory`, `ATTACHMENT_HISTORY_TURNS`) and older ones are reduced to a `[Anhang: name]` text placeholder. Previously a 4.5 MB PDF was sent to Bedrock again — and billed as input tokens again — with every further question. Attachment names stay in the history, so the GUI still shows them.
- Write `last-session.json`, `settings.json` and `last_model` atomically via a shared `writeFileAtomic` (temp file plus `rename`). A crash or a full disk mid-write previously left a truncated file; `readSession` swallowed the resulting JSON error and the whole conversation was silently gone on `--resume`.
- Add a 15 s timeout to every non-interactive `aws` CLI call in `src/aws-context.js` and route them all through `execFileSync` instead of a mix with shell-based `execSync`. Without it a stalled SSO flow or proxy could hang startup indefinitely; the interactive `aws login` deliberately keeps no timeout.
- Destroy the previous `BedrockRuntimeClient` on `/profile` switches instead of leaking its open sockets.
- Cache the web GUI `index.html` after the first request instead of reading it from disk synchronously on every page load.
- Reuse the existing `throwIfAborted` helper in `streamConverse` instead of constructing the abort error inline.
- Add `test/attachment-history.test.js` covering attachment retention, untouched plain messages and `keepTurns: 0`.

## 1.12.1 - 2026-07-24

- Retry SDK request timeouts (`TimeoutError`) with exponential backoff instead of misclassifying them as a user abort — they no longer surface as "Antwort abgebrochen" without an error message.
- Extract the shared Converse stream consumption into `src/stream-consumer.js` (`consumeConverseStream`), used by both the CLI and the web server: event classification, abort-vs-error distinction and usage accounting now live in one place and can no longer drift apart.
- Compare the web auth token with Node's vetted `crypto.timingSafeEqual` instead of a hand-rolled constant-time loop.
- Memoize slash-command completions instead of rebuilding them on every prompt keystroke.
- Remove the unused `lib/interactiveSelect.js` (dead code that was never imported nor shipped in the package).
- Add `test/stream-consumer.test.js` and update the abort/retry classification tests.

## 1.12.0 - 2026-07-14

- Support a user-level `models.json` in the config directory (`~/.config/bedrock-chat/models.json` or `$BEDROCK_CHAT_CONFIG_DIR/models.json`) that overrides the bundled file, so account-specific entries like `profileArn` stay out of the package.
- Keep the CLI effort preference sticky across models without effort support: switching to such a model no longer deletes the saved effort, and switching back restores the previous choice (matching the web GUI behavior).
- Handle bracketed paste in the terminal prompt: multi-line pasted text is inserted as one prompt (newlines shown as `⏎`) instead of submitting on the first line break.
- Serve the web GUI index page without the auth token and keep the token in `sessionStorage`, so a browser reload works after the token is stripped from the URL; all `/api/*` routes still require the token.
- Deduplicate model matching (`modelMatches` shared by `findModel` and the model picker) and the inference defaults (single source in `src/bedrock.js`).
- Keep attachment-only turns resumable by persisting a text placeholder and attachment names without binary data.
- Make retry backoff abortable immediately via `Esc`/stop instead of waiting for the next attempt.
- Roll back `AWS_PROFILE` when an in-session profile switch fails.
- Restore and persist the web GUI effort preference consistently across compatible model switches.
- Roll back optimistic web messages after request failures and restore their prompt and attachments.
- Strip terminal control sequences from streamed model output and pin ESLint as a local development dependency.

## 1.11.0 - 2026-07-06

- Bring the "Effort" (adaptive-thinking depth) control from the web GUI to the terminal client: the `/model` picker now shows an inline effort row for reasoning models that is changed with the left/right arrow keys, so model and effort are chosen in one menu.
- Send the selected effort to Bedrock from the CLI as `additionalModelRequestFields` (via the existing `buildAdaptiveThinkingFields`), so terminal requests now honor the effort level just like the web; models without an `effort` config send no thinking fields.
- Persist the chosen effort in `settings.json` (`readSavedEffort`/`writeSavedEffort`) and restore it on startup; the effort preference is kept across model switches when the target model supports it, otherwise it falls back to the model default.
- Add `resolveEffortLevel(model, preferred)` to `src/models.js` to centralize "keep a valid preference, else use the model default".
- Show the active effort in the startup banner (e.g. `Effort: Hoch`) and in `/debug` request output (effort level plus the resulting `additionalModelRequestFields`).
- Add tests for `resolveEffortLevel`, effort persistence and the picker's effort row.

## 1.10.0 - 2026-07-05

- Add an "Effort" dropdown to the web GUI (next to the model selector) that controls adaptive-thinking depth for reasoning models via `low`/`medium`/`high` (Opus additionally `max`).
- Send the effort level to Bedrock as `additionalModelRequestFields` with two request shapes depending on the model generation: `thinking.effort` for Claude Opus 4.6 / Sonnet 4.6, and a separate `output_config.effort` (with `thinking.type: "adaptive"`) for Claude Opus 4.8 / Sonnet 5 / Fable 5.
- Configure effort per model in [`models.json`](./models.json) via an `effort` object (`levels`, `default`, optional `style: "output_config"`); models without it hide the dropdown and send no thinking fields.
- Add `POST /api/effort`, expose per-model effort options and the current selection in `GET /api/state`, and reset the effort to the model default on model switch.
- Refactor `src/app.js`: extract `streamModelResponse`/`rememberPrompt` helpers and drive debug toggles from shared truthy/falsy sets.
- Add tests for the effort endpoint, both request shapes, `normalizeEffort` and the `additionalModelRequestFields` passthrough.

## 1.9.1 - 2026-07-05

- Harden the web GUI against DNS rebinding and cross-origin (CSRF) requests: reject requests whose `Host` header is not a localhost name and, when an `Origin` header is present, require it to match the host.
- Fix a web server lockup where an unexpected error during a chat request could leave the `busy` flag set, rejecting all later requests with `409`; the busy state and abort controller are now always reset via `try/finally`.
- Deduplicate the assistant-response finalization (abort marker plus history trimming) into a shared `appendAssistantResponse` helper used by both the CLI and the web server.
- Drive the CLI help text from a single option list in `cli-args.js` so it can no longer drift from the actual parsed options.
- Match the premium Opus pricing tier for two-digit model versions (e.g. `opus-4-10`) and compute history turns in a single pass.
- Add tests for the localhost host/origin guard.

## 1.9.0 - 2026-07-04

- Add a "Usage" button to the web GUI that opens a panel with current Amazon Bedrock billing costs from AWS Cost Explorer plus session token usage, per-response stats and a per-model breakdown — the web equivalent of `/usage`.
- Add a `GET /api/usage` endpoint; Cost Explorer errors (e.g. expired AWS session) are reported in the panel instead of failing the request.
- Close the usage panel with `Esc`, the close button or a click outside.
- Add tests for the usage endpoint including billing error handling.

## 1.8.0 - 2026-07-04

- Add file attachments to the web GUI via a "+" button or drag & drop: documents (pdf, csv, doc, docx, xls, xlsx, html, txt, md) and images (png, jpg, gif, webp) are sent to Bedrock as Converse document/image blocks.
- Show pending attachments as removable chips in the prompt and attached file names in the chat history; a message can also be sent with attachments only.
- Enforce Converse limits server-side (max. 5 attachments, 4.5 MB each, supported formats, sanitized document names) with clear error messages.
- Strip attachment binary data when persisting the session; the message text is kept.
- Add tests for attachment block building, validation and the chat endpoint with attachments.

## 1.7.0 - 2026-07-04

- Add a local web GUI started with `--web` (optional `--port`, default 3456): browser chat with streamed responses, Markdown rendering, collapsible reasoning, model switching, system-prompt editing, history clearing and per-response token/cost estimates.
- Open the default browser automatically when the web GUI starts (macOS, Windows, Linux); `--no-open` disables this.
- Serve the GUI from a built-in HTTP server bound to `127.0.0.1` that reuses the existing Bedrock streaming, retry, session and usage modules; credentials stay server-side.
- Support `Esc`/stop button to abort a streaming response in the browser; aborted answers are marked incomplete like in the CLI.
- Apply `--resume`, `--profile`, `--region`, `--system`, `--max-turns` and `--no-save` to the web mode as well.
- Add tests for the web server endpoints, SSE streaming, error handling, model switching and history trimming.

## 1.6.0 - 2026-07-03

- Restore the previously used model automatically when resuming a session with `--resume`.
- Add `/model <name>` for switching the model directly by name, label or alias without the interactive menu.
- Add `/retry` to resend the last prompt; a directly preceding answer to the same prompt is replaced in the history.
- Add `/export [file]` to export the chat history as a Markdown file.
- Mark responses interrupted with `Esc` as incomplete in the saved history.
- Run the `/usage` Cost Explorer queries asynchronously so the CLI no longer blocks while AWS billing data loads.
- Stream extended-thinking (reasoning) content dimmed instead of discarding it; reasoning is not stored in the chat history.
- Add `-r, --region <name>` to override the AWS region independently of the active profile, persisting across `/profile` switches.
- Add tests for the Markdown export module, reasoning stream events and region parsing.

## 1.5.0 - 2026-07-01

- Interrupt a running Bedrock response with `Esc` without leaving the chat, backed by an `AbortController` on the Converse stream.
- Retry throttled and transient Bedrock errors automatically with exponential backoff and jitter, before any output is streamed.
- Change the system prompt at runtime with `/system` and load it from a file at startup with `--system-file`.
- Add configurable `--top-p` and repeatable `--stop` inference parameters; persist `topP` across restarts.
- Persist the running chat to the user config directory and restore it with `--resume`; `--no-save` disables auto-saving and `/clear` also removes the saved session.
- Add inline line editing (`Left`/`Right`, `Home`/`End`, `Delete`, `Ctrl+A`/`Ctrl+E`) and an input history via `Up`/`Down`.
- Resolve Bedrock credentials through the AWS SDK default provider chain so SSO and role sessions refresh automatically instead of holding statically extracted keys.
- Date and document the built-in fallback pricing table; models without a price now surface `n/a`.
- Add `license`, `author`, `repository` and `keywords` metadata plus an MIT `LICENSE` file.
- Add a GitHub Actions CI workflow (Node 20 and 22), an ESLint flat config and an `npm run lint` script.
- Expand the test suite for retry logic, abort handling, inference overrides, system-file parsing and session persistence.

## 1.4.1 - 2026-06-28

- Enable the `eu.anthropic.claude-fable-5` Bedrock inference profile while omitting unsupported `temperature` inference config.
- Add `--debug`, `BEDROCK_CHAT_DEBUG=1` and `/debug` for Bedrock request and error diagnostics.
- Preserve and display detailed Bedrock error metadata, including error type, fault, HTTP status, request ID and original stream error details.
- Document Fable 5 model configuration and debug-mode usage.

## 1.4.0 - 2026-06-24

- Add arrow-key navigation to the `/model` selection menu.
- Add `profileArn`, `aliases` and `disabled` support for `models.json` entries.
- Add the `eu.anthropic.claude-fable-5` Bedrock inference profile as a disabled model entry.
- Use configured inference profile ARNs for Bedrock Converse calls while keeping model labels and IDs for selection.
- Add tests for model profile ARN resolution, disabled models and model selection rendering.

## 1.3.0 - 2026-06-17

- Add arrow-key selection for the slash command menu.
- Add `Tab` completion and highlighted command suggestions while typing slash commands.
- Add `/usage` for session token usage and estimated Bedrock costs.
- Add strict CLI argument parsing and validation for unknown or missing options.
- Add configurable `--max-tokens`, `--temperature` and `--max-turns` options.
- Add per-model `inferenceConfig` support in `models.json`.
- Add `/history` and automatic retained-history trimming.
- Show active max token and temperature settings in the startup banner.
- Persist `--max-tokens` and `--temperature` overrides across restarts.
- Move last-model persistence to the user config directory.
- Surface Bedrock stream exception events as API errors.
- Add unit tests for CLI parsing, model resolution, history trimming, config storage and Bedrock streaming.
- Split the CLI implementation into focused modules under `src/`.

## 1.2.0 - 2026-06-14

- Use the official AWS SDK for JavaScript Bedrock Runtime client for Converse streaming.
- Add AWS profile support at startup with `-p` / `--profile`.
- Add AWS profile listing with `-p -list`.
- Add in-session profile switching with `/profile <profile>`.
- Add CLI version output with `-v` / `--version`.
- Add Node test coverage for version output, profile listing, and profile startup behavior.
- Handle piped input and EOF cleanly.

## 1.1.0 - 2026-06-14

- Add AWS profile switching commands.
- Add CLI version output.

## 1.0.0 - 2026-06-14

- Initial interactive AWS Bedrock chat client.
