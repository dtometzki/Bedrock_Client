# Changelog

## Unreleased

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
