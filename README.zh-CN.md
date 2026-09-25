# Mimo Desktop Proxy _(mimo-proxy)_

[English](README.md) | [简体中文](README.zh-CN.md)

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

Xiaomi MiMo reverse proxy

Mimo Desktop Proxy 是一个面向局域网自用场景的小米 MiMo 反向代理。它把 MiMo 的私有聊天接口转换为 OpenAI 兼容的 Chat Completions 与 Responses API，并提供多账号、Cookie 自动续期、流式输出、推理内容、工具调用和用量信息转发。

项目使用 Node.js 内置模块实现，不依赖第三方运行时库。每个 `config/auth-<userId>.json` 对应一个账号和一个监听端口，便于在同一台主机上隔离不同账号的会话与额度。

GitHub 仓库名使用 `Mimo-Desktop-Proxy`，而 npm 包名和 CLI 仍为 `mimo-proxy`，以保持现有脚本和镜像名称兼容。

## 目录

- [安全](#安全)
- [背景](#背景)
- [安装](#安装)
- [用法](#用法)
- [多账号与凭据](#多账号与凭据)
- [配置](#配置)
- [Docker](#docker)
- [运行与维护](#运行与维护)
- [开发与测试](#开发与测试)
- [API](#api)
- [维护者](#维护者)
- [如何贡献](#如何贡献)
- [许可证](#许可证)

## 安全

默认配置以可信局域网为前提，不应直接暴露到公网：

- 默认监听 `0.0.0.0:3000`，且 `apiKey` 为空。此时同一网络内任何能够访问端口的主机都可调用 `/v1/*`。
- 单个账号凭据位于 `config/auth-<userId>.json`。该文件包含 `cookie` 与 `passToken`，必须限制权限并加入 `.gitignore`。
- `GET /health` 与 `GET /auth/status` 不受 `apiKey` 保护。`/auth/status` 会返回账号 ID、凭据文件路径、上游地址、Cookie 名称和 token 到期状态，但不会返回密钥明文。
- 服务启用 `Access-Control-Allow-Origin: *`。不要将管理端口、MiMo 调试端口 `9222` 或代理端口暴露到不可信网络。
- 请求体和 Responses 累计输出默认不设上限。若服务可能接收不可信请求，应在外层网关限制请求大小、速率和来源。
- 远程凭据更新接口已移除。凭据只允许通过本机文件维护或由本机 SSO 自动续期。

生产或多人共享环境建议至少设置：

```toml
apiKey = "replace-with-a-long-random-secret"
```

## 背景

MiMo 桌面客户端的聊天接口使用专用 Cookie、请求头和 SSE 数据结构，不能直接作为标准 OpenAI 后端使用。本项目位于客户端与 MiMo 上游之间，完成协议转换、账号隔离和凭据生命周期管理。

主要设计目标：

- 提供 OpenAI SDK 可直接使用的 Chat Completions 与 Responses 接口。
- 让一个账号对应一个端口，避免在请求中传递账号选择参数。
- 使用 `passToken` 自动换取聊天 `serviceToken`，并在 Cookie 失效或临近过期时刷新。
- 保留流式响应、推理文本、工具调用、refusal 和 usage 等 MiMo 上游信息。
- 在没有第三方依赖的前提下运行，便于直接使用 Node.js 或 Docker 部署。

抽象依赖如下：

- Node.js `>= 18.0.0`。
- 访问 MiMo 官方上游、小米 SSO 和桌面端版本清单的网络环境。
- 可选：已登录的 MiMo 桌面客户端，用于通过 CDP 导出根凭据。
- 可选：Docker 或 Docker Compose，用于容器部署。

## 安装

### 依赖

运行代理只需要 Node.js 18 或更高版本。项目没有 npm 运行时依赖，因此不需要执行 `npm install`。

```sh
git clone https://github.com/NooAcc/Mimo-Desktop-Proxy.git
cd Mimo-Desktop-Proxy
```

准备配置目录：

```sh
# Windows PowerShell
New-Item -ItemType Directory -Force config | Out-Null
Copy-Item config/config.toml.example config/config.toml
```

```sh
# Linux / macOS
mkdir -p config
cp config/config.toml.example config/config.toml
```

推荐的目录结构：

```text
config/
  config.toml
  auth-<userId>.json
  auth-<another-userId>.json
```

### 更新

普通安装使用 Git 更新：

```sh
git pull
npm test
```

`config/` 不在项目源码内管理，更新前仍应自行备份。Docker 部署使用 `docker pull` 或 `docker compose pull` 更新镜像。

## 用法

### 1. 从 MiMo 桌面客户端导出凭据

首次运行时，需要从已登录的 MiMo 桌面客户端导出 `passToken`、`userId` 和聊天 Cookie。

先退出 MiMo，再通过 Windows 的“运行”窗口或终端以调试模式启动：

```text
"<MiMo 安装路径>\Xiaomi MiMo.exe" --inspect=127.0.0.1:9222
```

确认客户端已登录目标小米账号，然后在项目根目录执行：

```sh
npm run pass-token -- --save
```

成功后生成：

```text
config/auth-<userId>.json
```

脚本只会打印脱敏摘要。不要将生成的凭据文件提交到 Git。

### 2. 启动代理

```sh
npm start
```

启动时会扫描 `config/auth-*.json`，按 `userId` 排序，然后从 `config.toml` 的 `port` 开始依次分配端口。没有凭据文件时，进程会启动失败并给出提示。

常用检查命令：

```sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/auth/status
curl -s http://127.0.0.1:3000/v1/models
```

### 3. 接入 OpenAI 客户端

每个账号使用自己的端口：

| 设置 | 值 |
| --- | --- |
| Base URL | `http://<代理主机>:<账号端口>/v1` |
| API Key | 未设置 `apiKey` 时可填任意值；设置后必须匹配 |
| 模型 | `mimo-v2.6-pro` 或 `mimo-v2.6-flash` |

端口分配规则：

```text
config.toml: port = 3000
auth-100.json -> http://127.0.0.1:3000/v1
auth-200.json -> http://127.0.0.1:3001/v1
```

常用请求示例：

```sh
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

```sh
curl -s http://127.0.0.1:3000/v1/responses \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.6-pro",
    "input": "你好",
    "stream": false
  }'
```

### CLI

项目通过 `npm` scripts 提供以下命令：

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动代理，自动发现多账号并监听多个端口 |
| `npm test` | 运行 Node.js 内置测试套件 |
| `npm run pass-token -- --save` | 通过 CDP 导出 `passToken` 并写入 `config/auth-<userId>.json` |
| `npm run cookie` | 导出聊天 Cookie 和 `passToken` |
| `npm run cookie -- --verify-only` | 校验 `config/` 中第一个凭据文件并测试上游 |
| `npm run capture` | 采集 MiMo 客户端真实请求，默认写入 `captures/` |
| `npm run verify:live` | 发起真实上游请求，验证当前凭据 |
| `npm run test:auto-refresh` | 运行自动刷新专项测试脚本 |

`capture` 和 `verify:live` 会访问真实上游并消耗账号额度。

## 多账号与凭据

### 账号规划

`config.toml` 中的 `port` 是多账号的基准端口。账号按 `userId` 稳定排序后依次使用：

```text
账号 0 -> port
账号 1 -> port + 1
账号 2 -> port + 2
```

启动日志中的 `multi_account.planned` 会列出账号、文件和端口。`GET /health` 会返回当前监听端口对应的 `account.userId`，可用于确认端口归属。

### 文件职责

| 文件 | 内容 |
| --- | --- |
| `config/config.toml` | 监听地址、basePort、模型、API Key、日志、共享身份和上游参数 |
| `config/auth-<userId>.json` | `cookie`、`passToken`、`userId`、`cUserId` 和刷新时间 |

`sid`、`clientVersion` 和 `source` 属于账号无关身份，写在 `config.toml` 的 `[auth]` 中。旧版 `auth.json`、`cookie.txt` 和 `pass-token.json` 不再加载。

### 手动凭据包

如果已有可用聊天 Cookie，可以手工创建 `config/auth-<userId>.json`：

```json
{
  "cookie": "serviceToken=...; userId=...; mimopc_slh=...; mimopc_ph=...",
  "userId": "2386469077"
}
```

若需要自动续期，同时提供根凭据：

```json
{
  "cookie": "serviceToken=...; userId=...; mimopc_slh=...; mimopc_ph=...",
  "passToken": "V1:...",
  "userId": "2386469077",
  "cUserId": "...",
  "passTokenExpiresAt": "2026-10-21T04:07:04.000Z"
}
```

凭据文件采用 `0600` 权限写入。运行中修改凭据文件后，建议重启代理，确保内存状态与文件内容一致。

### 自动续期流程

```text
客户端请求账号端口
  -> 读取当前账号的 Cookie
  -> Cookie 可用时直接请求 MiMo
  -> Cookie 缺失或上游返回 401 时执行 SSO 刷新
  -> passToken 临近过期时执行滑动续期
  -> 更新内存状态并写回 auth-<userId>.json
```

自动续期依赖有效的 `passToken` 和 `userId`。账号退出登录、修改密码、触发风控或长期无请求时，仍可能需要重新登录 MiMo 并再次导出凭据。

## 配置

配置查找顺序：

1. `config/config.toml`
2. 项目根目录的 `config.toml`
3. 内置默认值

凭据文件始终从最终配置目录下扫描。修改 `config.toml` 后需要重启代理。

### 基础配置

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

### 常用配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `3000` | 多账号 basePort |
| `models` | `["mimo-v2.6-pro", "mimo-v2.6-flash"]` | 暴露给客户端的模型列表 |
| `apiKey` | 空 | 设置后 `/v1/*` 需要 Bearer 认证 |
| `auth.autoRefresh` | `true` | 启用 SSO Cookie 自动续期 |
| `auth.passTokenRenewBeforeMs` | `604800000` | passToken 过期前 7 天触发续期 |
| `auth.refreshIntervalMs` | `0` | 强制 SSO 间隔，`0` 表示按需刷新 |
| `auth.clientVersionRefresh` | `true` | 从云端清单同步 clientVersion |
| `auth.clientVersionRefreshIntervalMs` | `7200000` | 清单检查基准间隔，2 小时 |
| `auth.clientVersionRefreshJitterMs` | `3600000` | 清单检查随机抖动，最多正负 1 小时 |
| `upstream.timeoutMs` | `0` | 上游超时，`0` 表示不限时 |
| `logging.level` | `info` | `debug`、`info`、`warn`、`error` 或 `silent` |
| `logging.format` | `json` | `json` 或 `text` |
| `logging.file` | 空 | 日志文件路径 |
| `logging.maxBytes` | `10485760` | 单个日志文件大小上限 |
| `logging.maxFiles` | `5` | 轮转保留数量 |

完整示例见 [config.toml.example](config/config.toml.example)。

### clientVersion 同步

代理默认每 2 小时正负 1 小时检查一次桌面端版本清单：

```text
https://mimocode-cdn.xiaomimimo.com/mimocode/mimodesktop/manifest.json
```

当平台版本发生变化时，新的 `clientVersion` 会写入 `config.toml` 的 `[auth]`。当前状态可从 `GET /auth/status` 的以下字段查看：

- `clientVersion`
- `identitySource`
- `lastClientVersionCheckAt`
- `clientVersionSource`

## Docker

仓库提供 [Dockerfile](Dockerfile) 和 [compose.yaml](compose.yaml)。GitHub Actions 构建的镜像发布到 GitHub Container Registry（GHCR），运行时只包含 Node.js 内置模块，不执行依赖安装。

准备宿主机目录：

```text
config/
  config.toml
  auth-<userId>.json
```

直接运行：

```sh
docker run -d \
  --name mimo-proxy \
  --network host \
  -v "./config:/app/config" \
  --restart unless-stopped \
  ghcr.io/nooacc/mimo-desktop-proxy:latest
```

使用 Compose：

```sh
docker compose up -d
```

部署注意事项：

- Compose 使用 host 网络，端口由 `config/config.toml` 的 `port` 决定。
- Compose 固定使用 `ghcr.io/nooacc/mimo-desktop-proxy:latest`。
- 配置固定从仓库根目录的 `./config` 挂载，不需要环境变量。
- GHCR 包若保持私有，拉取前需要执行 `docker login ghcr.io`；公开包可直接拉取。
- 容器用户为 `node`，UID 为 `1000`，需要能够读取和写入挂载的 `config/`。
- 健康检查默认访问第一个账号的 `port`。

GHCR 使用说明见 [GHCR.md](GHCR.md)。

## 运行与维护

### 健康检查

```sh
curl -s http://127.0.0.1:3000/health
```

响应包含服务状态和当前账号摘要。该接口不访问 MiMo，可用于容器健康检查和端口识别。

### 身份与凭据状态

```sh
curl -s http://127.0.0.1:3000/auth/status
```

重点字段：

| 字段 | 说明 |
| --- | --- |
| `accountId` / `accountUserId` | 当前账号标识 |
| `port` | 当前监听端口 |
| `authFile` | 当前账号凭据文件 |
| `hasRuntimeCookie` | 内存中是否存在聊天 Cookie |
| `hasServiceToken` | Cookie 是否包含 `serviceToken` |
| `hasPassToken` | 是否存在可用的根凭据 |
| `passTokenExpiresAt` | passToken 到期时间 |
| `passTokenDaysLeft` | passToken 剩余天数 |
| `cookieRefreshedAt` | 最近 Cookie 刷新时间 |
| `lastSsoAt` | 最近 SSO 成功时间 |
| `clientVersion` | 当前使用的客户端版本 |
| `lastClientVersionCheckAt` | 最近版本清单检查时间 |

### 端口排障

启动日志中的 `multi_account.planned` 会输出文件、userId 与端口对照表。若不知道某个端口属于哪个账号，可执行：

```sh
curl -s http://127.0.0.1:<端口>/health
```

### 常见故障

| 现象 | 处理 |
| --- | --- |
| 启动提示找不到凭据 | 运行 `npm run pass-token -- --save`，或把 `auth-<userId>.json` 放入 `config/` |
| `passTokenDaysLeft` 很小并持续 401 | 重新登录 MiMo，再次导出凭据 |
| 上游连接失败 | 检查网络、`upstream.url` 和上游是否支持 HTTP/2 |
| 客户端收到 401 | 检查代理 `apiKey` 与请求头中的 Bearer 值是否一致 |
| Docker 无法写入凭据 | 检查宿主机 `config/` 对容器 UID 1000 的写权限 |

## 开发与测试

测试使用 Node.js 内置测试运行器，不依赖第三方测试框架：

```sh
npm test
```

测试覆盖协议转换、多账号端口、SSO 刷新、HTTP/2、SSE、工具调用修复、日志脱敏、鉴权和连接中断等路径。

开发时建议遵守以下约定：

- 保持零运行时依赖。
- 修改行为时同步补充 `test/` 下的测试。
- 不在日志、测试夹具或提交内容中写入真实 Cookie、passToken 或聊天正文。
- 修改协议行为后，同时验证 Chat Completions 与 Responses 两条入口。

## API

### HTTP 接口

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/`、`/health` | 否 | 返回进程和当前账号健康信息 |
| `GET` | `/auth/status` | 否 | 返回脱敏后的账号与凭据状态 |
| `GET` | `/v1/models` | 受 `apiKey` 保护 | 返回 OpenAI 风格模型列表 |
| `POST` | `/v1/chat/completions` | 受 `apiKey` 保护 | Chat Completions |
| `POST` | `/v1/responses` | 受 `apiKey` 保护 | Responses |

同时接受不带 `/v1` 的 `/chat/completions` 和 `/responses`。服务支持 CORS 预检，并通过 `X-Request-Id` 关联请求日志。

### Chat Completions

请求会保留 OpenAI Chat Completions 的常用字段，并在转发上游时强制启用流式模式。客户端请求 `stream: false` 时，代理会在本地聚合并返回普通 JSON。

支持：

- `messages`
- `model`
- `stream`
- `reasoning_effort`
- `thinking`
- `tools`、`functions`、`tool_choice`
- `response_format`
- usage、reasoning content、tool calls 和 refusal

`mimo-auto` 会转换为 `mimo-pro`。未指定模型时使用 `models` 中的第一项。

### Responses

Responses 请求会转换为内部 Chat Completions 请求，再转换为 OpenAI Responses JSON 或 SSE 事件。

支持：

- 字符串或消息数组形式的 `input`
- `instructions`
- `temperature`、`top_p`、`seed`、`stop`
- `max_output_tokens` 与 `max_tokens`
- `reasoning.effort`
- `text.format`
- function、custom、namespace 和 additional tools
- 忽略 `tool_search` 声明，并直接转发客户端工具
- `parallel_tool_calls`
- 图片、工具输出媒体和 refusal

该实现是无状态的，并固定使用 `store: false`。以下能力不支持：

- `previous_response_id`
- `conversation`
- `prompt`
- `background`
- `context_management`
- `n > 1`
- 服务端托管 Web Search
- 由代理执行客户端工具

客户端必须发送完整历史。函数调用由客户端执行，再把完整调用结果传回下一轮请求。

### Node.js 导出

[mimo_server.js](mimo_server.js) 导出以下主要入口，便于测试或嵌入：

```js
import {
  createProxyServer,
  createAuthHeaders,
  getAuthHeaders,
  buildUpstreamBody
} from "./mimo_server.js";
```

`createProxyServer(options)` 返回一个尚未监听的 `http.Server`。调用方需要自行调用 `listen()`，并可通过 `fetchImpl`、`authRuntime`、`logger` 等选项注入测试或自定义实现。

其余导出包括配置读取、账号发现、端口规划、自动认证、SSO 刷新和 clientVersion 刷新工具。具体签名可直接查看 [lib/](lib/) 下的模块。

## 维护者

[@NooAcc](https://github.com/NooAcc)

## 如何贡献

问题、兼容性反馈和功能建议请提交到 [GitHub Issues](https://github.com/NooAcc/Mimo-Desktop-Proxy/issues)。欢迎提交 Pull Request。

提交前请满足以下要求：

- 说明问题、复现步骤和预期行为。
- 保持改动范围聚焦，并同步更新测试或文档。
- 运行 `npm test`，确保现有行为没有回归。
- 不要提交 `config/auth-*.json`、Cookie、passToken、聊天正文、抓包中的真实凭据或其他隐私数据。
- 不要提交运行日志、构建产物或本地账号配置。

当前仓库没有独立的 `CONTRIBUTING.md` 或行为守则文件。

## 许可证

MIT

Copyright (c) 2026 [@NooAcc](https://github.com/NooAcc)

完整许可证文本见 [LICENSE](LICENSE)。
