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
- Checks AWS CLI connectivity on startup with `aws sts get-caller-identity`
- Calls Bedrock through the official AWS SDK for JavaScript
- Supports AWS profile selection at startup and during the running chat
- Supports configurable `maxTokens`, `temperature` and history size
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
```

Keep more or less local chat history:

```bash
node app_aws.js --max-turns 50
node app_aws.js --max-turns 0
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
    "disabled": true,
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
- `pricingUsdPer1M` is optional and powers the `/usage` cost estimate.
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
- `/model` opens the model selection menu; use `Up`/`Down` and `Enter` to switch
- `/usage` shows current Amazon Bedrock billing costs from AWS Cost Explorer plus current session token usage
- `/history` shows the retained chat history and configured limit
- `/clear` clears chat history
- `/exit` exits the client
