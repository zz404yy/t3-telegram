# T3 Telegram Gateway

一个独立、非官方的 Telegram 客户端，用于远程操作已经运行的
[T3 Code](https://github.com/pingdotgg/t3code) 环境、项目与编码线程。

网关不嵌入或修改 T3 Code，也不直接连接 Codex、Claude 或 OpenCode。所有项目、线程、
模型、审批和代码操作均通过 T3 的外部客户端协议完成。

> 当前协议适配基线为 T3 `0.0.40`。T3 的外部接口仍可能变化，升级 T3 后建议先运行兼容性检查。

## 功能

- 通过 T3 一次性配对令牌换取受限 Bearer 凭据
- 创建真实 T3 项目和工作区目录
- 设置项目默认 Provider/模型
- 创建新线程或绑定已有 T3 线程
- 在已有线程中修改模型，并识别“仅新线程可换模型”的 Provider
- 修改线程权限：每次审批、自动批准编辑、自动审批、完全访问
- 一个持久化的 **🎛 T3 控制台**，每个 T3 线程使用独立 Telegram Topic
- 所有已绑定线程在后台并行监听，网关重启后自动恢复
- 流式回复、完成消息、审批按钮、中断 turn 和 Diff 摘要
- 分页查看 T3 线程历史记录
- 从后台线程列表定位或解除单个绑定
- 安全清除所有线程 Topic 和 Telegram 绑定，同时保留控制台与 T3 数据
- Telegram Topic 不可用时自动回退到带线程标识的普通私聊模式
- SQLite 持久化、AES-256-GCM 凭据加密、用户白名单和 SSRF 防护
- 协议指纹、契约测试和定时 T3 上游兼容性检查

## 工作方式

```text
Telegram 私聊
├── 🎛 T3 控制台        项目、绑定、环境和全局管理
├── Topic: Thread A    输入 ↔ T3 Thread A
├── Topic: Thread B    输入 ↔ T3 Thread B
└── Topic: Thread C    输入 ↔ T3 Thread C
                            │
                     后台同时监听全部绑定
```

Telegram 的回复键盘在私聊 Topics 中偶尔不会携带 Topic ID。网关不依赖该字段判断控制操作：
精确匹配的控制菜单按钮始终路由到持久化控制台；普通编码文本仍必须具有匹配的线程 Topic，
否则拒绝发送，以避免串线。

## 快速开始

要求：

- Node.js 22+（推荐 Node.js 24）
- pnpm
- Telegram Bot Token 和你的 Telegram 数字用户 ID
- 一台可由网关访问、已经运行的 T3 Code 主机

```bash
cp .env.example .env
openssl rand -base64 32
# 将输出填入 .env 的 GATEWAY_MASTER_KEY

pnpm install
pnpm test
pnpm start
```

也可以使用 Docker Compose：

```bash
docker compose up -d --build
curl http://127.0.0.1:8787/readyz
```

在 BotFather 的 **Bot Settings → Topics** 中开启私聊 Topics，然后向机器人发送 `/start`。
点击 **🔌 连接 T3**，在 T3 主机生成一次性令牌：

```bash
npx t3 pair
```

按照机器人提示发送：

```text
http://127.0.0.1:3773 PAIRING_TOKEN
```

地址必须是网关进程能够访问的 T3 地址；Docker Compose 默认使用 Linux host networking，
因此同机运行时可直接访问 `127.0.0.1:3773`。

## Telegram 菜单

| 菜单        | 作用                                          |
| ----------- | --------------------------------------------- |
| 🗂 新建项目  | 在 T3 主机创建项目和工作区目录                |
| ⚙️ 项目模型 | 设置项目默认 Provider/模型                    |
| ➕ 新建线程 | 创建真实 T3 线程并建立 Topic                  |
| 🔗 绑定线程 | 绑定已有 T3 线程，不克隆会话                  |
| 🧵 后台线程 | 查看所有监听，定位 Topic 或解除单个绑定       |
| 📜 历史记录 | 分页查看当前线程的用户与助手消息              |
| 🛠 线程设置  | 修改当前线程模型和运行权限                    |
| 📊 状态     | 查看环境、绑定和协议能力状态                  |
| ⏹ 停止      | 中断当前正在运行的 turn                       |
| 🧾 Diff     | 查看当前线程文件变更摘要                      |
| 🌐 环境     | 查看已经配对的 T3 环境                        |
| 🔌 连接 T3  | 使用一次性令牌配对 T3 环境                    |
| 🔓 解除绑定 | 仅解除当前 Telegram 绑定，保留 T3 线程        |
| 🧹 清除会话 | 删除全部线程 Topic/绑定，保留控制台与 T3 数据 |
| ❓ 帮助     | 显示简明使用说明                              |

斜杠命令仍作为备用入口。发送 `/menu` 可以重新显示按钮菜单。

## 权限模式

| 模式         | T3/Codex 行为                                    |
| ------------ | ------------------------------------------------ |
| 每次审批     | 只读沙箱，写入和操作通常需要确认                 |
| 自动批准编辑 | 允许工作区写入，敏感命令仍可能申请审批           |
| 自动审批     | 允许工作区写入，由 T3 自动审查审批请求           |
| 完全访问     | 不询问审批且绕过文件系统沙箱；启用前需要二次确认 |

新线程默认使用 `auto`，网关不会静默选择 `full-access`。权限或模型变更从下一条指令生效，
T3 会在需要时重启底层 Provider 会话，而不会删除线程历史。

## 清理与数据边界

机器人菜单中的 **🧹 清除会话** 会逐个删除线程 Topic 并解除网关绑定，但会保留：

- 🎛 T3 控制台
- T3 真实线程及其历史
- T3 项目、工作区和代码
- 已配对环境

Telegram 客户端自身的“删除聊天”或“删除并停止机器人”属于不同操作，可能重新显示 Start
按钮，甚至阻止 Bot。机器人无法绕过 Telegram 的阻止状态；需要恢复时点击 Start，控制台和
菜单会自动重建。

## 配置

主要环境变量见 [.env.example](.env.example)：

| 变量                          | 说明                                       |
| ----------------------------- | ------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`          | BotFather 提供的 Token                     |
| `TELEGRAM_ALLOWED_USER_IDS`   | 允许访问的数字用户 ID，逗号分隔            |
| `GATEWAY_MASTER_KEY`          | 用于加密 T3 凭据的 32 字节 Base64 密钥     |
| `DATABASE_URL`                | SQLite 地址，默认 `file:./data/gateway.db` |
| `T3_ALLOWED_HOSTS`            | 允许连接的 T3 主机名白名单                 |
| `T3_ALLOW_PRIVATE_NETWORKS`   | 是否允许私网/回环地址                      |
| `HEALTH_HOST` / `HEALTH_PORT` | 健康检查监听地址，默认 `127.0.0.1:8787`    |

请同时备份数据库和 `GATEWAY_MASTER_KEY`；缺少任意一个都无法恢复已加密凭据。

## 开发与验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm inspect:t3 -- --url http://127.0.0.1:3773
```

真实冒烟测试会创建线程并运行 Provider turn，必须显式允许，建议只针对可丢弃项目执行。
参见 [兼容性说明](docs/compatibility.md)。

## 文档

- [部署与操作](docs/operations.md)
- [安全说明](docs/security.md)
- [协议证据与命令结构](docs/protocol-notes.md)
- [T3 兼容性策略](docs/compatibility.md)
- [初始产品需求](T3%20Vibe%20Gateway%20PRD%20v0.1.md)

## 免责声明

本项目是非官方外部客户端，与 T3 Code 项目维护者无隶属关系。请仅将网关暴露给可信的
Telegram 账号，并谨慎使用“完全访问”权限。
