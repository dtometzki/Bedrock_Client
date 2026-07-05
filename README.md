# Bedrock Client by Damian Tometzki

Interactive CLI client for AWS Bedrock with model selection, command menu, formatted terminal output and startup checks for AWS CLI connectivity.

## Requirements

- Node.js 20+
- AWS CLI installed and configured
- Access to AWS Bedrock in your AWS account/region

## What It Does

- Starts an interactive Bedrock chat in the terminal
- Optionally serves the chat as a local web GUI with `--web` (streaming, Markdown rendering, model switching)
- Lets you choose and switch models interactively, including arrow-key navigation in `/model` and direct switching with `/model <name>`
- Stores the last selected model for the next start
- Shows the active AWS account and region with `/account`
- Shows current Amazon Bedrock billing costs and session token usage with `/usage`
- Limits retained chat history by default to keep context size predictable
- Optionally resumes the previous chat history with `--resume` (including the previously used model) and auto-saves the running session
- Resends the last prompt with `/retry` and exports the chat history as Markdown with `/export [file]`
- Lets you set the system prompt at startup (`--system`, `--system-file`) and change it live with `/system`
- Lets you interrupt a running response with `Esc` without leaving the chat
- Retries throttled or transient Bedrock errors automatically with exponential backoff
- Supports inline line editing (arrow keys, Home/End, Delete) and an input history via `Up`/`Down`
- Checks AWS CLI connectivity on startup with `aws sts get-caller-identity`
- Calls Bedrock through the official AWS SDK for JavaScript using the default credential provider chain, so SSO and role sessions refresh automatically
- Supports AWS profile selection at startup and during the running chat
- Supports overriding the AWS region with `-r, --region` independently of the active profile
- Streams extended-thinking (reasoning) content dimmed before the answer, without storing it in the history
- Lets you pick the adaptive-thinking effort level (`low`/`medium`/`high`, Opus also `max`) per reasoning model in the web GUI
- Supports configurable `maxTokens`, `temperature`, `topP` and stop sequences
- Supports a debug mode for Bedrock request and error diagnostics
- Supports standalone CLI usage through `bedrock-chat`

## AWS Setup

Make sure your AWS CLI is configured before starting the client:

```bash
aws configure
aws sts get-caller-identity
```

If your `default` profile assumes a role, sign in through the source profile instead:

```bash
aws login --profile Admins
```

## Install

Clone the repository and install dependencies:

```bash
npm install
```

Optional: link the CLI globally on your machine:

```bash
npm link
```

## Run

Show the installed version:

```bash
node app_aws.js --version
```

Start directly with Node.js:

```bash
node app_aws.js
```

Start with a predefined model:

```bash
node app_aws.js -m claude-sonnet-4-6
```

Start with a predefined AWS profile:

```bash
node app_aws.js -p bedrok
node app_aws.js --profile Admins
```

List available AWS profiles:

```bash
node app_aws.js -p -list
```

Set Bedrock inference parameters:

```bash
node app_aws.js --max-tokens 4096 --temperature 0.3
node app_aws.js --top-p 0.9
node app_aws.js --stop "###" --stop "Ende"
```

Set the system prompt, inline or from a file:

```bash
node app_aws.js --system "Antworte kurz und auf Deutsch."
node app_aws.js --system-file ./prompts/system.txt
```

Keep more or less local chat history:

```bash
node app_aws.js --max-turns 50
node app_aws.js --max-turns 0
```

Resume the previous session or disable auto-saving:

```bash
node app_aws.js --resume
node app_aws.js --no-save
```

Enable Bedrock request and error diagnostics:

```bash
node app_aws.js --debug
BEDROCK_CHAT_DEBUG=1 node app_aws.js
```

If linked with `npm link`, start it as a CLI:

```bash
bedrock-chat
bedrock-chat -m claude-sonnet-4-6
```

## Web GUI

Start the chat as a local web interface instead of the terminal UI:

```bash
node app_aws.js --web
node app_aws.js --web --port 8080
node app_aws.js --web --no-open
```

The default browser opens automatically with the GUI (default `http://127.0.0.1:3456`); `--no-open` disables that and only prints the URL.

The web GUI supports streaming responses with Markdown rendering, model switching, an effort selector for reasoning models (adaptive-thinking depth `low`/`medium`/`high`, Opus also `max`; disabled for models without effort support), collapsible reasoning output, interrupting a response (`Esc` or the stop button), clearing the history, changing the system prompt, per-response token/cost estimates, a usage panel with AWS Cost Explorer billing and session token statistics (the web equivalent of `/usage`), and file attachments via the "+" button or drag & drop (documents: pdf, csv, doc, docx, xls, xlsx, html, txt, md; images: png, jpg, gif, webp; max. 5 files, 4.5 MB each). CLI options like `--resume`, `--profile`, `--region`, `--system` and `--max-turns` apply to the web mode as well.

Notes:

- The server binds to `127.0.0.1` only and keeps AWS credentials on the server side; the browser never sees them.
- Requests are rejected unless their `Host` header is a localhost name (protection against DNS rebinding); a present `Origin` header must match the host (CSRF protection).
- Markdown rendering loads `marked` and `DOMPurify` from a CDN; without internet access the GUI falls back to plain text.
- One response streams at a time; a second parallel request is rejected until the first finishes or is aborted.

## Add A Model

Add new models in [`models.json`](./models.json). Each entry needs an AWS Bedrock model ID in `id`. `label` is optional, but recommended because it is shown in the interactive selection and can also be used with `-m` / `--model`.

Example:

```json
[
  {
    "id": "global.anthropic.claude-sonnet-4-6",
    "label": "claude-sonnet-4-6"
  },
  {
    "id": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "label": "claude-3-7-sonnet",
    "inferenceConfig": {
      "maxTokens": 4096,
      "temperature": 0.4
    }
  },
  {
    "id": "eu.anthropic.claude-fable-5",
    "label": "claude-fable-5",
    "disabledInferenceConfigFields": ["temperature"],
    "aliases": ["global.anthropic.claude-fable-5"],
    "profileArn": "arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-fable-5"
  }
]
```

Notes:

- `id` must match the exact Bedrock model ID.
- `label` should be short and readable.
- `disabled` is optional. Set it to `true` to keep a model configured but hide it from selection.
- `aliases` is optional and lets old saved IDs or alternative names resolve to the same model.
- `profileArn` is optional. If set, the client sends that ARN to Bedrock while keeping `id` and `label` for selection.
- `pricingUsdPer1M` is optional and powers the `/usage` cost estimate. If it is omitted, the client falls back to a small built-in price table (see [`src/usage.js`](./src/usage.js), current as of 2026-06); models without a match show `n/a` instead of an estimate. Prefer setting `pricingUsdPer1M` per model so estimates stay accurate.
- `inferenceConfig` is optional and can set Bedrock Converse parameters per model.
- `disabledInferenceConfigFields` is optional and can omit unsupported Converse parameters for a model, for example `["temperature"]`.
- `effort` is optional and enables the web GUI effort selector for adaptive-thinking (reasoning) models. It takes `levels` (e.g. `["low", "medium", "high"]`, Opus also `"max"`), a `default` level, and an optional `style`: omit it (or use `"thinking"`) for Claude Opus 4.6 / Sonnet 4.6, which expect `thinking.effort`; use `"style": "output_config"` for Claude Opus 4.8 / Sonnet 5 / Fable 5, which expect a separate `output_config.effort`. Models without `effort` show the selector as disabled and send no thinking fields. Example: `"effort": { "levels": ["low", "medium", "high"], "default": "high", "style": "output_config" }`.
- If `label` is omitted, the CLI derives one automatically from `id`.
- After changing [`models.json`](./models.json), restart the client.

The last selected model is stored outside the repository in the user config directory. Set `BEDROCK_CHAT_CONFIG_DIR` if you want to override that location.
CLI overrides for `--max-tokens` and `--temperature` are stored there too and reused on the next start.

## Check

```bash
npm test
```

The test suite runs syntax checks and unit tests. It does not call your real AWS account.

Optional style linting (downloads ESLint on demand, no dev dependency required):

```bash
npm run lint
```

Continuous integration runs `npm test` on Node 20 and 22 plus the lint step via GitHub Actions (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

## Release Notes

See [`CHANGELOG.md`](./CHANGELOG.md).

## Commands

- `/` opens the command selection menu
- `Tab` autocompletes slash commands while typing
- `Up`/`Down` selects slash commands from the command menu
- `/help` opens the command selection menu
- `/account` shows the active AWS account and region
- `/profile` lists AWS profiles
- `/profile <profile>` switches the active AWS profile for the running chat
- `Left`/`Right`, `Home`/`End` and `Delete` edit the current input line; `Up`/`Down` recall previous inputs
- `Esc` interrupts a running response without leaving the chat
- `/model` opens the model selection menu; use `Up`/`Down` and `Enter` to switch
- `/system` shows the active system prompt; `/system <text>` sets it, `/system reset` restores the default
- `/debug` toggles request and error diagnostics; `/debug on` and `/debug off` set it explicitly
- `/usage` shows current Amazon Bedrock billing costs from AWS Cost Explorer plus current session token usage
- `/history` shows the retained chat history and configured limit
- `/clear` clears chat history and the saved session
- `/exit` exits the client
