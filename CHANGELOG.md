# Changelog

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
