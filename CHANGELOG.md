# Changelog

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
