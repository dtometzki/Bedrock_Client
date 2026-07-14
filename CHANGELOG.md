# Changelog

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
