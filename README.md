# Bedrock Client by Damian Tometzki

Interactive CLI client for AWS Bedrock with model selection, command menu, formatted terminal output and an optional encrypted AWS credential vault.

## Requirements

- Node.js 20+
- AWS credentials or a configured AWS role profile; the AWS CLI is needed only for managing external login/SSO sessions
- Access to AWS Bedrock in your AWS account/region

## What It Does

- Starts an interactive Bedrock chat in the terminal
- Optionally serves the chat as a local web GUI with `--web` (streaming, Markdown rendering, model switching)
- Lets you choose and switch models interactively, including arrow-key navigation in `/model` and direct switching with `/model <name>`
- Lets you pick the adaptive-thinking effort level (`low`/`medium`/`high`, Opus also `max`) directly in the `/model` picker for reasoning models: use the left/right arrow keys to change it
- Stores the last selected model and effort level for the next start
- Shows the active AWS account and region with `/account`
- Shows current Amazon Bedrock billing costs and session token usage with `/usage`
- Limits retained chat history by default to keep context size predictable
- Optionally resumes the previous chat history with `--resume` (including the previously used model) and auto-saves the running session
- Resends the last prompt with `/retry` and exports the chat history as Markdown with `/export [file]`
- Lets you set the system prompt at startup (`--system`, `--system-file`) and change it live with `/system`
- Lets you interrupt a running response with `Esc` without leaving the chat
- Retries throttled or transient Bedrock errors (including request timeouts) automatically with exponential backoff
- Supports inline line editing (arrow keys, Home/End, Delete) and an input history via `Up`/`Down`
- Checks AWS identity through the SDK with `/auth check` or the web settings, without blocking startup when credentials are missing
- Calls Bedrock, STS and Cost Explorer through the official AWS SDK using one credential provider; supports existing AWS credentials and a master-password-protected vault
- Supports AWS profile selection at startup and during the running chat
- Supports overriding the AWS region with `-r, --region` independently of the active profile
- Streams extended-thinking (reasoning) content dimmed before the answer, without storing it in the history
- Lets you pick the adaptive-thinking effort level (`low`/`medium`/`high`, Opus also `max`) per reasoning model in the web GUI
- Supports configurable `maxTokens`, `temperature`, `topP` and stop sequences
- Supports a debug mode for Bedrock request and error diagnostics
- Supports standalone CLI usage through `bedrock-chat`

## AWS Setup

For the existing AWS configuration mode, configure your AWS credentials before making requests:

```bash
aws configure
aws sts get-caller-identity
```

If your `default` profile assumes a role, sign in through the source profile instead:

```bash
aws login --profile Admins
```

## Encrypted AWS Credential Vault

Open **Einstellungen → AWS-Anmeldung** in the web GUI, or run the terminal setup:

```bash
node app_aws.js --web
node app_aws.js --auth-setup
```

Both interfaces use the same vault file. The GUI and terminal commands remain available even if credentials are missing, locked or expired. Setting up the vault needs no AWS request. Choose an existing **role profile**, enter a permanent Access Key ID and Secret Access Key, and choose a master password of at least 12 characters. Repeat the password to confirm it. Keys and passwords are entered in hidden fields; do not pass them in command arguments or environment variables.

For example, the local AWS config can contain the following non-secret role metadata (replace the example account and role):

```ini
[profile bedrock-role]
role_arn = arn:aws:iam::123456789012:role/BedrockChat
source_profile = base
region = eu-central-1

[profile base]
region = eu-central-1
```

The vault replaces the terminal credential source of the selected `source_profile` chain. It does not modify AWS config/credential files. The base key must be permitted to assume the configured role, and the role's trust policy must allow that identity. Role session names, external IDs and session durations are honored. Missing/cyclic role chains and MFA profiles are rejected. This first version stores one permanent key pair; temporary input keys requiring `AWS_SESSION_TOKEN`, MFA entry and multiple stored accounts are not supported.

The web profile picker shows all local profiles. In vault mode, profiles without `role_arn` remain visible with an **AWS-Konfiguration** label and cannot be selected as role profiles. To use a login/SSO profile such as `Admins`, choose **Anmeldeart wechseln → AWS-Konfiguration des Rechners**, select that profile and apply the change. **AWS-Profil wechseln** also remains available in AWS mode. This uses the existing profile session and keeps the encrypted vault unchanged; renew an expired AWS login separately (for example, `aws login --profile Admins`). The profile selection applies to the running client; use `--auth aws --profile Admins` to select it explicitly on startup.

After unlocking, select **AWS-Verbindung prüfen** or run `/auth check`. Unlocking decrypts the vault locally; the connection check calls AWS STS and shows the resulting identity. A failed AWS connection keeps the stored credentials. Bedrock and billing use the same role provider, and temporary role sessions refresh in the background while the vault is unlocked. Vault mode never silently falls back to environment credentials, SSO or unrelated AWS profiles.

### Terminal commands and mode selection

| Command | Effect |
| --- | --- |
| `/auth` | Show vault and connection status plus available commands |
| `/auth setup` | Create the vault with hidden prompts |
| `/auth unlock` / `/auth lock` | Unlock or immediately lock |
| `/auth update` | Replace the stored keys and role profile |
| `/profile <name>` | Select another profile; in vault mode, persist the role profile encrypted |
| `/auth password` | Change the master password using the old password and confirmation |
| `/auth delete` | Delete/reset after typing `TRESOR LOESCHEN` |
| `/auth check` | Check the AWS identity through STS |
| `/auth aws` / `/auth vault` | Save the preferred authentication mode |

`--auth aws` and `--auth vault` override the mode for a start. Without a configured vault, the existing AWS provider chain is the default. Successful vault setup/unlock saves vault mode as the preference. An explicit `--profile` without `--auth` retains the existing AWS-profile meaning; use `--auth vault --profile bedrock-role` to override the role profile for that vault process. `--region` continues to override the profile region. Authentication changes preserve the chat history; use `/clear` or **Verlauf leeren** when starting a separate conversation.

### Locking and storage

The master password is required after every process restart and after 15 minutes of inactivity. Typing/clicking in the client counts as activity; background status polling does not. Running AWS requests count as use, with a fresh idle period after completion. Manual locking aborts active AWS requests and discards clients, cached role credentials and the unlocked keys. Browser tabs of one server share that state; reloading a tab does not lock the running server. Separate terminal/web processes unlock independently.

The encrypted file is `credentials.enc.json` in `~/.config/bedrock-chat`, or the directory selected by `BEDROCK_CHAT_CONFIG_DIR` / `XDG_CONFIG_HOME`. It uses AES-256-GCM with a fresh random IV per write and a key derived by scrypt (`N=131072`, `r=8`, `p=1`, 16-byte salt). Password changes also generate a new salt. Files are written atomically with POSIX mode `0600`; new config directories use `0700`. The password is never stored. Saved AWS keys are never sent back to the browser; form fields are cleared after submission. Only encrypted data is written to the vault, while `settings.json` stores the non-secret preferred mode.

Concurrent writes detect stale versions rather than overwriting another client's change: lock and unlock again to reload the current vault. If a crash leaves `credentials.enc.json.lock`, stop all clients before removing that empty lock directory. Storage errors are shown and do not silently discard the previous vault. If the master password is lost, the credentials cannot be recovered; explicitly reset the vault and enter the AWS keys again. Locking drops references and clears writable key buffers, but JavaScript cannot guarantee erasure of every prior in-memory copy. Chat histories retain their existing storage format and are not encrypted by this feature.

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

- The server binds to `127.0.0.1` only and uses AWS credentials on the server side. Vault setup transmits the entered keys to this local server; saved keys are never returned to the browser.
- Requests are rejected unless their `Host` header is a localhost name (protection against DNS rebinding); a present `Origin` header must match the host (CSRF protection).
- The HTML response carries a strict `Content-Security-Policy` (`script-src 'self'` — no inline scripts, no remote images), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` headers; a 60 s request timeout prevents stalled clients from holding connections open.
- Markdown rendering uses `marked` and `DOMPurify`, bundled with the package under `src/web/vendor/` and served by the local server itself — no CDN access at runtime, works offline. If a file is missing, the GUI falls back to plain text.
- One response streams at a time; a second parallel request is rejected until the first finishes or is aborted.

## Add A Model

Add new models in [`models.json`](./models.json). Each entry needs an AWS Bedrock model ID in `id`. `label` is optional, but recommended because it is shown in the interactive selection and can also be used with `-m` / `--model`.

You can also keep a personal model list outside the package: if `models.json` exists in the user config directory (`~/.config/bedrock-chat/models.json`, or `$BEDROCK_CHAT_CONFIG_DIR/models.json`), it completely replaces the bundled file. This is the recommended place for account-specific entries such as `profileArn` values, so they never end up in a published package or repository.

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
- `profileArn` is optional. If set, the client sends that ARN to Bedrock while keeping `id` and `label` for selection. A full inference-profile ARN is region-bound (`arn:aws:bedrock:<region>:<account>:…`), so the client automatically calls that ARN's region instead of the active profile/region for the request. This prevents a `ValidationException: The provided model identifier is invalid.` when the ARN region differs from your configured region. The `<account>` in the ARN must be **your own AWS account**: pointing at a different account fails with `AccessDeniedException: … is not authorized to perform: bedrock:InvokeModelWithResponseStream`. For system-defined cross-Region inference profiles you usually don't need an ARN at all — just use the bare profile `id` (e.g. `us.anthropic.claude-sonnet-5`), which resolves in your own account. Its geographic prefix (`us.`/`eu.`/`apac.`) selects the source Region automatically (a matching Region if your configured one already fits, otherwise a sensible default such as `us-east-1`); `global.` and plain model IDs use your configured Region. Reserve `profileArn` for account-specific application inference profiles, and keep those in your personal `~/.config/bedrock-chat/models.json` rather than the bundled file.
- `pricingUsdPer1M` is optional and powers the `/usage` cost estimate. If it is omitted, the client falls back to a small built-in price table (see [`src/usage.js`](./src/usage.js), current as of 2026-06); models without a match show `n/a` instead of an estimate. Prefer setting `pricingUsdPer1M` per model so estimates stay accurate.
- `inferenceConfig` is optional and can set Bedrock Converse parameters per model.
- `disabledInferenceConfigFields` is optional and can omit unsupported Converse parameters for a model, for example `["temperature"]`.
- `effort` is optional and enables the effort selector (in both the web GUI and the terminal `/model` picker) for adaptive-thinking (reasoning) models. It takes `levels` (e.g. `["low", "medium", "high"]`, Opus also `"max"`), a `default` level, and an optional `style`: omit it (or use `"thinking"`) for Claude Opus 4.6 / Sonnet 4.6, which expect `thinking.effort`; use `"style": "output_config"` for Claude Opus 4.8 / Sonnet 5 / Fable 5, which expect a separate `output_config.effort`. Models without `effort` hide/disable the selector and send no thinking fields. The chosen level is stored in `settings.json` and restored on the next start. Example: `"effort": { "levels": ["low", "medium", "high"], "default": "high", "style": "output_config" }`.
- If `label` is omitted, the CLI derives one automatically from `id`.
- After changing [`models.json`](./models.json), restart the client.

The last selected model is stored outside the repository in the user config directory. Set `BEDROCK_CHAT_CONFIG_DIR` if you want to override that location.
CLI overrides for `--max-tokens` and `--temperature` are stored there too and reused on the next start.

## Check

```bash
npm test
```

The test suite runs syntax checks and unit tests. It does not call your real AWS account.

Optional style linting with the locally pinned ESLint version:

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
- `/model` opens the model selection menu; use `Up`/`Down` and `Enter` to switch, and `Left`/`Right` to change the effort level (adaptive-thinking depth) for reasoning models
- `/system` shows the active system prompt; `/system <text>` sets it, `/system reset` restores the default
- `/debug` toggles request and error diagnostics; `/debug on` and `/debug off` set it explicitly
- `/usage` shows current Amazon Bedrock billing costs from AWS Cost Explorer plus current session token usage
- `/history` shows the retained chat history and configured limit
- `/clear` clears chat history and the saved session
- `/exit` exits the client
