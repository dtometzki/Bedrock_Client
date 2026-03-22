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
