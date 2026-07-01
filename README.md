# Bedrock Client by Damian Tometzki

Interactive CLI client for AWS Bedrock with model selection, command menu, formatted terminal output and startup checks for AWS CLI connectivity.

## Requirements

- Node.js 20+
- AWS CLI installed and configured
- Access to AWS Bedrock in your AWS account/region

## What It Does

- Starts an interactive Bedrock chat in the terminal
- Lets you choose and switch models interactively, including arrow-key navigation in `/model`
- Stores the last selected model for the next start
- Shows the active AWS account and region with `/account`
- Shows current Amazon Bedrock billing costs and session token usage with `/usage`
- Limits retained chat history by default to keep context size predictable
- Optionally resumes the previous chat history with `--resume` and auto-saves the running session
- Lets you set the system prompt at startup (`--system`, `--system-file`) and change it live with `/system`
- Lets you interrupt a running response with `Esc` without leaving the chat
- Retries throttled or transient Bedrock errors automatically with exponential backoff
- Supports inline line editing (arrow keys, Home/End, Delete) and an input history via `Up`/`Down`
- Checks AWS CLI connectivity on startup with `aws sts get-caller-identity`
- Calls Bedrock through the official AWS SDK for JavaScript using the default credential provider chain, so SSO and role sessions refresh automatically
- Supports AWS profile selection at startup and during the running chat
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
    "profileArn": "arn:aws:bedrock:eu-central-1:841986542603:inference-profile/eu.anthropic.claude-fable-5"
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
