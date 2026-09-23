# Mimo Desktop Proxy _(mimo-proxy)_

[English](README.md) | [简体中文](README.zh-CN.md)

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

Xiaomi MiMo reverse proxy

Mimo Desktop Proxy is a local-network reverse proxy for Xiaomi MiMo. It converts
MiMo's private chat protocol into OpenAI-compatible Chat Completions and
Responses APIs, with multi-account support, automatic Cookie renewal, streaming,
reasoning content, tool calls, and usage forwarding.

The project uses only built-in Node.js modules and has no third-party runtime
dependencies. Each `config/auth-<userId>.json` file represents one account and
one listening port, which keeps sessions and quotas isolated when multiple
accounts run on the same host.

The GitHub repository is named `Mimo-Desktop-Proxy`, while the npm package and
CLI remain `mimo-proxy` for compatibility with existing scripts and image names.

## Table of Contents

- [Security](#security)
- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Multi-Account and Credentials](#multi-account-and-credentials)
- [Configuration](#configuration)
- [Docker](#docker)
- [Operations and Maintenance](#operations-and-maintenance)
- [Development and Testing](#development-and-testing)
- [API](#api)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Security

The default configuration assumes a trusted local network. Do not expose the
proxy directly to the public internet.

- The default listener is `0.0.0.0:3000`, and `apiKey` is empty. Any host that
  can reach the port can call `/v1/*`.
- Account credentials are stored in `config/auth-<userId>.json`. These files
  contain `cookie` and `passToken`, so their permissions must be restricted and
  they must not be committed to Git.
- `GET /health` and `GET /auth/status` are not protected by `apiKey`.
  `/auth/status` returns the account ID, credential file path, upstream URL,
  Cookie names, and token expiry state, but never returns secret values.
- The service sends `Access-Control-Allow-Origin: *`. Do not expose
  administrative ports, the MiMo debugging port `9222`, or proxy ports to an
  untrusted network.
- Request bodies and accumulated Responses output have no default size limit.
  If the service may receive untrusted requests, enforce request size, rate, and
  source restrictions in a fronting gateway.
- The remote credential update endpoint has been removed. Credentials can only
  be maintained through local files or local SSO renewal.

For production or shared environments, set at least:

```toml
apiKey = "replace-with-a-long-random-secret"
```

## Background

The MiMo desktop client uses private Cookies, request headers, and SSE payloads
for chat. Those interfaces are not directly compatible with standard OpenAI
clients. This project sits between the client and MiMo upstream and handles
protocol translation, account isolation, and credential lifecycle management.

The main design goals are:

- Provide Chat Completions and Responses APIs that OpenAI SDKs can use directly.
- Map one account to one port so account selection is not passed in each request.
- Exchange `passToken` for a chat `serviceToken` automatically and refresh it
  when the Cookie expires or is close to expiry.
- Preserve MiMo upstream streaming, reasoning text, tool calls, refusals, and
  usage information.
- Run without third-party dependencies so the service can be deployed with
  Node.js or Docker alone.

Abstract dependencies are:

- Node.js `>= 18.0.0`.
- Network access to the MiMo upstream, Xiaomi SSO, and the desktop version
  manifest.
- Optional: a signed-in MiMo desktop client to export root credentials through
  CDP.
- Optional: Docker or Docker Compose for container deployment.

## Install

### Dependencies

The proxy only requires Node.js 18 or later. It has no npm runtime
dependencies, so `npm install` is not required.

```sh
git clone https://github.com/NooAcc/Mimo-Desktop-Proxy.git
cd Mimo-Desktop-Proxy
```

Prepare the configuration directory:

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force config | Out-Null
Copy-Item config/config.toml.example config/config.toml
```

```sh
# Linux / macOS
mkdir -p config
cp config/config.toml.example config/config.toml
```

The recommended directory layout is:

```text
config/
  config.toml
  auth-<userId>.json
  auth-<another-userId>.json
```

### Updating

For a normal Git installation:

```sh
git pull
npm test
```

Files under `config/` are not managed by the source repository. Back them up
before updating. Docker deployments should be updated with `docker pull` or
`docker compose pull`.

## Usage

### 1. Export Credentials from the MiMo Desktop Client

On first run, export `passToken`, `userId`, and the chat Cookie from a
signed-in MiMo desktop client.

Exit MiMo first, then start it in debugging mode from the Windows Run dialog or
a terminal:

```text
"<MiMo installation path>\Xiaomi MiMo.exe" --inspect=127.0.0.1:9222
```

Confirm that the client is signed in to the intended Xiaomi account, then run
the following command from the repository root:

```sh
npm run pass-token -- --save
```

A successful run creates:

```text
config/auth-<userId>.json
```

The script only prints redacted summaries. Do not commit generated credential
files to Git.

### 2. Start the Proxy

```sh
npm start
```

At startup, the proxy scans `config/auth-*.json`, sorts accounts by `userId`,
and assigns ports sequentially starting at `port` from `config.toml`. If no
credential files are found, startup fails with an explanatory message.

Common checks:

```sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/auth/status
curl -s http://127.0.0.1:3000/v1/models
```

### 3. Connect an OpenAI Client

Each account uses its own port:

| Setting | Value |
| --- | --- |
| Base URL | `http://<proxy-host>:<account-port>/v1` |
| API Key | Any value when `apiKey` is unset; it must match when configured |
| Model | `mimo-v2.6-pro` or `mimo-v2.6-flash` |

Port assignment example:

```text
config.toml: port = 3000
auth-100.json -> http://127.0.0.1:3000/v1
auth-200.json -> http://127.0.0.1:3001/v1
```

Chat Completions example:

```sh
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-pro",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

Responses example:

```sh
curl -s http://127.0.0.1:3000/v1/responses \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-pro",
    "input": "Hello",
    "stream": false
  }'
```

### CLI

The project exposes the following commands through npm scripts:

| Command | Description |
| --- | --- |
| `npm start` | Start the proxy, discover accounts, and listen on multiple ports |
| `npm test` | Run the Node.js built-in test suite |
| `npm run pass-token -- --save` | Export `passToken` through CDP and write `config/auth-<userId>.json` |
| `npm run cookie` | Export the chat Cookie and `passToken` |
| `npm run cookie -- --verify-only` | Verify the first credential file in `config/` and test upstream access |
| `npm run capture` | Capture a real MiMo client request; output defaults to `captures/` |
| `npm run verify:live` | Make real upstream requests to verify the current credentials |
| `npm run test:auto-refresh` | Run the dedicated automatic-refresh test script |

`capture` and `verify:live` contact the real upstream and consume account quota.

## Multi-Account and Credentials

### Account Planning

`port` in `config.toml` is the base port for multi-account mode. After a stable
sort by `userId`, accounts use ports in this order:

```text
account 0 -> port
account 1 -> port + 1
account 2 -> port + 2
```

The `multi_account.planned` startup log lists each account, file, and port.
`GET /health` returns the `account.userId` for the current listening port,
which can be used to confirm port ownership.

### File Responsibilities

| File | Contents |
| --- | --- |
| `config/config.toml` | Listen address, basePort, models, API key, logging, shared identity, and upstream settings |
| `config/auth-<userId>.json` | `cookie`, `passToken`, `userId`, `cUserId`, and refresh timestamps |

`sid`, `clientVersion`, and `source` are account-independent identity fields and
belong in the `[auth]` table in `config.toml`. Legacy `auth.json`,
`cookie.txt`, and `pass-token.json` files are no longer loaded.

### Manual Credential Files

If a valid chat Cookie is already available, create
`config/auth-<userId>.json` manually:

```json
{
  "cookie": "serviceToken=...; userId=...; mimopc_slh=...; mimopc_ph=...",
  "userId": "2386469077"
}
```

To enable automatic renewal, also provide the root credentials:

```json
{
  "cookie": "serviceToken=...; userId=...; mimopc_slh=...; mimopc_ph=...",
  "passToken": "V1:...",
  "userId": "2386469077",
  "cUserId": "...",
  "passTokenExpiresAt": "2026-10-21T04:07:04.000Z"
}
```

Credential files are written with `0600` permissions. After modifying a
credential file while the proxy is running, restart it so in-memory state and
the file content stay consistent.

### Automatic Renewal Flow

```text
client requests an account port
  -> read the current account Cookie
  -> use MiMo directly when the Cookie is valid
  -> perform SSO renewal when the Cookie is missing or upstream returns 401
  -> perform sliding renewal when passToken is close to expiry
  -> update memory state and write auth-<userId>.json
```

Automatic renewal requires a valid `passToken` and `userId`. Signing out,
changing a password, triggering risk controls, or long periods without
requests may still require signing in to MiMo again and exporting new
credentials.

## Configuration

Configuration is resolved in this order:

1. `config/config.toml`
2. `config.toml` in the project root
3. Built-in defaults

Credential files are always scanned from the final configuration directory.
Restart the proxy after changing `config.toml`.

### Basic Configuration

```toml
host = "0.0.0.0"
port = 3000
models = ["mimo-v2.6-pro", "mimo-v2.6-flash"]

[auth]
sid = "mimopc"
clientVersion = "26.914.142245"
source = "mimocode-cli-free"
autoRefresh = true

[upstream]
url = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions"
timeoutMs = 0

[logging]
level = "info"
format = "json"
file = ""
```

### Common Settings

| Key | Default | Description |
| --- | --- | --- |
| `host` | `0.0.0.0` | Listen address |
| `port` | `3000` | Multi-account base port |
| `models` | `["mimo-v2.6-pro", "mimo-v2.6-flash"]` | Models exposed to clients |
| `apiKey` | Empty | When set, `/v1/*` requires Bearer authentication |
| `auth.autoRefresh` | `true` | Enable automatic SSO Cookie renewal |
| `auth.passTokenRenewBeforeMs` | `604800000` | Renew passToken 7 days before expiry |
| `auth.refreshIntervalMs` | `0` | Forced SSO interval; `0` refreshes on demand |
| `auth.clientVersionRefresh` | `true` | Sync clientVersion from the cloud manifest |
| `auth.clientVersionRefreshIntervalMs` | `7200000` | Base manifest check interval, 2 hours |
| `auth.clientVersionRefreshJitterMs` | `3600000` | Manifest check jitter, up to plus or minus 1 hour |
| `upstream.timeoutMs` | `0` | Upstream timeout; `0` disables the timeout |
| `logging.level` | `info` | `debug`, `info`, `warn`, `error`, or `silent` |
| `logging.format` | `json` | `json` or `text` |
| `logging.file` | Empty | Log file path |
| `logging.maxBytes` | `10485760` | Maximum size per log file |
| `logging.maxFiles` | `5` | Number of rotated files to retain |

See [config/config.toml.example](config/config.toml.example) for the complete
example.

### clientVersion Synchronization

By default, the proxy checks the desktop version manifest every 2 hours with up
to 1 hour of jitter:

```text
https://mimocode-cdn.xiaomimimo.com/mimocode/mimodesktop/manifest.json
```

When the platform version changes, the new `clientVersion` is written back to
the `[auth]` table in `config.toml`. The following fields from
`GET /auth/status` show the current state:

- `clientVersion`
- `identitySource`
- `lastClientVersionCheckAt`
- `clientVersionSource`

## Docker

The repository includes [Dockerfile](Dockerfile) and
[compose.yaml](compose.yaml). Images built by GitHub Actions are published to
the GitHub Container Registry (GHCR). The runtime image contains only built-in
Node.js modules and does not install dependencies.

Prepare the host directory:

```text
config/
  config.toml
  auth-<userId>.json
```

Run directly:

```sh
docker run -d \
  --name mimo-proxy \
  --network host \
  -v "./config:/app/config" \
  --restart unless-stopped \
  ghcr.io/nooacc/mimo-desktop-proxy:latest
```

Run with Compose:

```sh
docker compose up -d
```

Deployment notes:

- Compose uses host networking. The listening port comes from
  `config/config.toml`.
- Compose pins `ghcr.io/nooacc/mimo-desktop-proxy:latest`.
- Configuration is always mounted from the repository's `./config` directory;
  no environment variables are required.
- If the GHCR package remains private, run `docker login ghcr.io` before
  pulling it. Public packages can be pulled directly.
- The container runs as the `node` user with UID `1000`, which must be able to
  read and write the mounted `config/` directory.
- The health check uses the first account's `port` by default.

See [GHCR.md](GHCR.md) for GHCR-specific instructions.

## Operations and Maintenance

### Health Check

```sh
curl -s http://127.0.0.1:3000/health
```

The response contains service health and a summary of the current account. It
does not contact MiMo, so it is suitable for container health checks and port
identification.

### Identity and Credential Status

```sh
curl -s http://127.0.0.1:3000/auth/status
```

Key fields:

| Field | Description |
| --- | --- |
| `accountId` / `accountUserId` | Current account identifier |
| `port` | Current listening port |
| `authFile` | Credential file for the current account |
| `hasRuntimeCookie` | Whether a chat Cookie exists in memory |
| `hasServiceToken` | Whether the Cookie contains `serviceToken` |
| `hasPassToken` | Whether root credentials are available |
| `passTokenExpiresAt` | passToken expiry time |
| `passTokenDaysLeft` | Days remaining before passToken expiry |
| `cookieRefreshedAt` | Most recent Cookie refresh time |
| `lastSsoAt` | Most recent successful SSO time |
| `clientVersion` | Client version currently in use |
| `lastClientVersionCheckAt` | Most recent manifest check time |

### Port Troubleshooting

The `multi_account.planned` startup log prints a mapping of files, user IDs, and
ports. If the owner of a port is unclear, run:

```sh
curl -s http://127.0.0.1:<port>/health
```

### Common Failures

| Symptom | Resolution |
| --- | --- |
| Startup reports that no credentials were found | Run `npm run pass-token -- --save`, or place `auth-<userId>.json` in `config/` |
| `passTokenDaysLeft` is very small and 401 responses continue | Sign in to MiMo again and export new credentials |
| Upstream connection fails | Check network access, `upstream.url`, and HTTP/2 support |
| Client receives 401 | Check that the proxy `apiKey` and Bearer value match |
| Docker cannot write credentials | Check that host `config/` is writable by container UID 1000 |

## Development and Testing

Tests use the Node.js built-in test runner and do not require a third-party
framework:

```sh
npm test
```

Coverage includes protocol translation, multi-account ports, SSO refresh,
HTTP/2, SSE, tool-call repair, log redaction, authentication, and aborted
connections.

Development guidelines:

- Keep the runtime dependency-free.
- Add or update tests under `test/` when behavior changes.
- Never put real Cookies, passTokens, or chat content in logs, fixtures, or
  commits.
- After changing protocol behavior, verify both Chat Completions and Responses.

## API

### HTTP Endpoints

| Method | Path | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/`, `/health` | No | Return process and current-account health information |
| `GET` | `/auth/status` | No | Return redacted account and credential status |
| `GET` | `/v1/models` | Protected by `apiKey` | Return an OpenAI-style model list |
| `POST` | `/v1/chat/completions` | Protected by `apiKey` | Chat Completions |
| `POST` | `/v1/responses` | Protected by `apiKey` | Responses |

The `/chat/completions` and `/responses` paths without `/v1` are also accepted.
The service supports CORS preflight and correlates request logs with
`X-Request-Id`.

### Chat Completions

Requests preserve common OpenAI Chat Completions fields and force streaming when
forwarding upstream. When a client requests `stream: false`, the proxy
aggregates the response locally and returns regular JSON.

Supported features include:

- `messages`
- `model`
- `stream`
- `reasoning_effort`
- `thinking`
- `tools`, `functions`, and `tool_choice`
- `response_format`
- usage, reasoning content, tool calls, and refusals

`mimo-auto` is translated to `mimo-pro`. If no model is specified, the first
entry in `models` is used.

### Responses

Responses requests are converted to internal Chat Completions requests and then
converted back to OpenAI Responses JSON or SSE events.

Supported features include:

- `input` as a string or an array of messages
- `instructions`
- `temperature`, `top_p`, `seed`, and `stop`
- `max_output_tokens` and `max_tokens`
- `reasoning.effort`
- `text.format`
- function, custom, namespace, and additional tools
- `parallel_tool_calls`
- image inputs, tool-output media, and refusals

The implementation is stateless and always uses `store: false`. The following
capabilities are not supported:

- `previous_response_id`
- `conversation`
- `prompt`
- `background`
- `context_management`
- `n > 1`
- server-hosted Web Search
- client tool execution by the proxy

Clients must send the full history. Function calls are executed by the client,
which then sends the complete tool results in the next request.

### Node.js Exports

[mimo_server.js](mimo_server.js) exports the main entry points for tests or
embedding:

```js
import {
  createProxyServer,
  createAuthHeaders,
  getAuthHeaders,
  buildUpstreamBody
} from "./mimo_server.js";
```

`createProxyServer(options)` returns an `http.Server` that has not started
listening. The caller must call `listen()` and can inject test or custom
implementations through options such as `fetchImpl`, `authRuntime`, and
`logger`.

Additional exports cover configuration loading, account discovery, port
planning, automatic authentication, SSO refresh, and clientVersion refresh. See
the modules under [lib/](lib/) for exact signatures.

## Maintainers

[@NooAcc](https://github.com/NooAcc)

## Contributing

Submit questions, compatibility reports, and feature requests through
[GitHub Issues](https://github.com/NooAcc/Mimo-Desktop-Proxy/issues). Pull
requests are welcome.

Before submitting a change:

- Describe the problem, reproduction steps, and expected behavior.
- Keep the change focused and update tests or documentation as needed.
- Run `npm test` and confirm that existing behavior has not regressed.
- Do not submit `config/auth-*.json`, Cookies, passTokens, chat content, real
  credentials from packet captures, or other private data.
- Do not submit runtime logs, build output, or local account configuration.

Commit messages must follow the
[Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/).
Use the form:

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types include `feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
`build`, `ci`, and `chore`. Mark breaking changes with `!` after the type or
scope, or add a `BREAKING CHANGE:` footer. For example:

```text
docs: add English README as default
```

The repository does not currently have a separate `CONTRIBUTING.md` or code of
conduct.

## License

MIT

Copyright (c) 2026 [@NooAcc](https://github.com/NooAcc)

See [LICENSE](LICENSE) for the full license text.
