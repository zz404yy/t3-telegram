# T3 Telegram Gateway

通过 Telegram 远程操作正在运行的 [T3 Code](https://github.com/pingdotgg/t3code)。机器人支持中文和 English，可在底部菜单中随时切换，语言选择会持久保存。

Control a running [T3 Code](https://github.com/pingdotgg/t3code) instance from Telegram. The bot supports English and Chinese; switch languages from the persistent menu at any time.

## 部署运行 / Deploy and run

需要 Node.js 22+、pnpm、Telegram Bot Token、你的 Telegram 数字用户 ID，以及网关可以访问的 T3 Code 主机。

Requirements: Node.js 22+, pnpm, a Telegram Bot Token, your numeric Telegram user ID, and a T3 Code host reachable by the gateway.

### 1. 配置 / Configure

```bash
git clone https://github.com/markzhy/t3-telegram.git
cd t3-telegram
cp .env.example .env
openssl rand -base64 32
```

编辑 `.env` / Edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=BotFather 提供的 token
TELEGRAM_ALLOWED_USER_IDS=你的 Telegram 数字用户 ID
GATEWAY_MASTER_KEY=上一步生成的 Base64 密钥
DATABASE_URL=file:./data/gateway.db
T3_ALLOWED_HOSTS=127.0.0.1,localhost,host.docker.internal
T3_ALLOW_PRIVATE_NETWORKS=true
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8787
```

`TELEGRAM_ALLOWED_USER_IDS` 可用逗号分隔多个 ID。请同时备份 `data/gateway.db` 和 `GATEWAY_MASTER_KEY`。

Multiple Telegram IDs can be comma-separated. Back up both `data/gateway.db` and `GATEWAY_MASTER_KEY`.

### 2. Docker Compose（推荐 / Recommended）

```bash
docker compose up -d --build
docker compose logs -f gateway
curl http://127.0.0.1:8787/readyz
```

Compose 在 Linux 上使用 host networking，因此同机 T3 Code 可使用 `127.0.0.1:3773`。

Compose uses host networking on Linux, so T3 Code on the same host is reachable at `127.0.0.1:3773`.

### 3. 本地运行 / Run locally

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm start
```

开发模式 / Development mode:

```bash
pnpm dev
```

## Telegram 与 T3 首次连接 / First connection

中文：

1. 在 `@BotFather` 打开 **Bot Settings → Topics**，启用私聊 Topics。
2. 给机器人发送 `/start`。
3. 点击 **🔌 连接 T3 / Connect T3**。
4. 在 T3 主机运行 `npx t3 pair`，然后按机器人提示发送：

English:

1. In `@BotFather`, open **Bot Settings → Topics** and enable private-chat Topics.
2. Send `/start` to the bot.
3. Tap **🔌 Connect T3**.
4. Run `npx t3 pair` on the T3 host, then send:

```text
http://127.0.0.1:3773 PAIRING_TOKEN
```

这里的地址必须从网关进程所在主机可访问。首次进入时会按 Telegram 客户端语言选择中文或英文；使用菜单中的 **🌐 English / 🌐 中文** 可随时切换。

The address must be reachable from the gateway process. The initial language follows the Telegram client; use **🌐 English / 🌐 中文** in the menu to switch at any time.

## 更新与停止 / Update and stop

Docker:

```bash
git pull --ff-only
docker compose up -d --build
docker compose down
```

Local:

```bash
git pull --ff-only
pnpm install
pnpm test
pnpm start
```

本项目是非官方 T3 Code 外部客户端。只允许可信 Telegram 用户访问，并谨慎使用“完全访问 / Full access”权限。

This is an unofficial external client for T3 Code. Allow only trusted Telegram users and use Full access carefully.
