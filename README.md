# Bedrock Client

Interactive CLI client for AWS Bedrock with model selection, command menu, formatted terminal output and startup checks for AWS CLI connectivity.

## Requirements

- Node.js 20+
- AWS CLI installed and configured
- Access to AWS Bedrock in your AWS account/region

## What It Does

- Starts an interactive Bedrock chat in the terminal
- Lets you choose and switch models interactively
- Stores the last selected model for the next start
- Checks AWS CLI connectivity on startup with `aws sts get-caller-identity`
- Supports standalone CLI usage through `bedrock-chat`

## AWS Setup

Make sure your AWS CLI is configured before starting the client:

```bash
aws configure
aws sts get-caller-identity
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

Start directly with Node.js:

```bash
node app_aws.js
```

Start with a predefined model:

```bash
node app_aws.js -m claude-sonnet-4-6
```

If linked with `npm link`, start it as a CLI:

```bash
bedrock-chat
bedrock-chat -m claude-sonnet-4-6
```

## Add A Model

Add new models in [`models.json`](/home/damian/jsexample/client/models.json). Each entry needs an AWS Bedrock model ID in `id`. `label` is optional, but recommended because it is shown in the interactive selection and can also be used with `-m` / `--model`.

Example:

```json
[
  {
    "id": "global.anthropic.claude-sonnet-4-6",
    "label": "claude-sonnet-4-6"
  },
  {
    "id": "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "label": "claude-3-7-sonnet"
  }
]
```

Notes:

- `id` must match the exact Bedrock model ID.
- `label` should be short and readable.
- If `label` is omitted, the CLI derives one automatically from `id`.
- After changing [`models.json`](/home/damian/jsexample/client/models.json), restart the client.
- If you use the built version from `dist/`, run `npm run build` again so the updated `models.json` is copied.

## Build

```bash
npm run build
./dist/bedrock-chat
```

## Clean

```bash
npm run clean
```

## Commands

- `/` opens the command selection menu
- `/model` opens the model selection menu
- `/clear` clears chat history
- `/exit` exits the client
