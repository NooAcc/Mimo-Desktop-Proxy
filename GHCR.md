# Mimo-Desktop-Proxy on GHCR

局域网自用的 Xiaomi MiMo 反向代理，提供 OpenAI 兼容的 Chat Completions / Responses 接口。无第三方依赖。

## 快速启动

在宿主机准备配置目录：

```text
config/
  config.toml   # 可从仓库 config/config.toml.example 复制（仅运行参数）
  auth-<userId>.json  # 账号凭据（可多个）：cookie/passToken/userId/cUserId
                    # sid/clientVersion/source 在 config.toml [auth]
```

运行容器（镜像由 GitHub Actions 构建并推送到 GHCR；默认 host 网络，端口以 `config.toml` 的 `port` 为准）：

```sh
docker run -d \
  --name mimo-proxy \
  --network host \
  -v "./config:/app/config" \
  --restart unless-stopped \
  ghcr.io/nooacc/mimo-desktop-proxy:latest
```

或使用 Compose（仓库内 `compose.yaml`，默认 GHCR 镜像 + host 网络）：

```sh
docker compose up -d
```

## 说明

| 项目 | 说明 |
| --- | --- |
| 网络 | `host`：直接使用宿主机网络，无需 `-p` / `ports` 映射 |
| 监听端口 | `config.toml` 中的 `port`（例：`23456` → `http://<宿主机IP>:23456`） |
| 配置挂载 | 宿主机 `config/` → 容器 `/app/config`（`config.toml` + 多个 `auth-*.json`） |
| 健康检查 | `GET /health` |
| 凭据状态 | `GET /auth/status`（只读，无明文） |

如果 GHCR 包是私有可见性，请先登录：

```sh
docker login ghcr.io -u NooAcc
```

完整文档见 [GitHub 仓库 README](https://github.com/NooAcc/Mimo-Desktop-Proxy)。
