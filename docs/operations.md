# Operations

The gateway is an unofficial external T3Code client. Run T3Code separately and keep its HTTP endpoint reachable from the gateway. Long polling requires only outbound Telegram HTTPS access; T3 does not need to be public.

1. Create a Telegram bot with BotFather, enable **Bot Settings → Topics**, and obtain your numeric Telegram user ID. Topics are recommended but not required.
2. Generate a 32-byte key: `openssl rand -base64 32`.
3. Copy `.env.example` to `.env` and fill the bot token, allowlist, and master key.
4. Start with `pnpm install && pnpm start`, or `docker compose up -d --build`.
5. In T3's public pairing UI/CLI, create a one-time pairing token.
6. In the bot's private chat, send `/start`, click **🔌 连接 T3**, then send `http://127.0.0.1:3773 TOKEN` (substitute the address reachable from the gateway container).

The bot attempts to delete the `/connect` message immediately. The one-time token is exchanged and never stored; only the resulting scoped access token is AES-256-GCM encrypted in SQLite.

Every saved binding has a durable background listener. At startup the gateway reloads bindings and resumes each T3 subscription from its last persisted event sequence. Changing the current binding changes only where new Telegram input is sent; it does not unsubscribe older bindings. `/detach` removes the current topic binding (or the current flat-chat binding) without modifying the T3 thread.

**🧵 后台线程** is also the binding management screen. Each row has a navigation button and a separate detach button. Detach requires confirmation, stops that Telegram destination's listener, and leaves the real T3 thread untouched so it can be attached again later.

Inside a bound thread Topic, use **📜 历史记录** or `/history` to read the latest user and assistant messages. History is shown six messages per page with older/newer navigation, and callback routing is checked against the current binding so records cannot be opened in another thread Topic.

Use **⚙️ 项目模型** or `/models` in the control Topic to set a project's default model. Creating a project opens the same provider/model picker automatically. The picker uses the T3 server's live catalog, paginates large model lists, and does not guess a provider or model.

Inside a bound Topic, use **🛠 线程设置** or `/threadsettings` to inspect and change the thread model or runtime permission mode. Model choices are revalidated against the live provider catalog. Providers marked `requiresNewThreadForModelChange` are rejected for conversations that have already started. Runtime changes use T3's native `thread.runtime-mode.set` command and take effect on the next turn; `full-access` requires a separate confirmation screen.

With Telegram private-chat Topics enabled, the gateway keeps one persistent **🎛 T3 控制台** Topic for menus and one independent Topic per T3 thread. The route is `T3 thread → message_thread_id`. Binding operations never rename or delete the Topic currently displayed by the user; a new target Topic is created when needed. If Topics are disabled or topic creation fails, multiple T3 bindings share the private chat, output is prefixed with the thread name, and `active_chat_bindings` records which thread receives new input. The gateway checks Telegram's `has_topics_enabled` flag at startup and gives an actionable BotFather hint when it must fall back.

Telegram reply-keyboard updates in a private Topic may arrive without either `message_thread_id` or `direct_messages_topic.topic_id`. Exact control-menu labels are therefore routed explicitly to the saved control Topic instead of trusting the inbound Topic field. Free-form coding text never uses that fallback: it must resolve to an exact thread binding or it is refused. Inline callbacks for history, model, runtime, and detach operations validate their owning user/chat and, where relevant, the bound Topic.

When Topics become enabled after flat-chat bindings already exist, the next gateway startup creates one Topic per old binding and migrates each binding in place. Binding IDs, pending approvals, and subscription cursors are retained, and the new Topic receives a migration notice.

**🧹 清除会话** freezes the current list of binding IDs in a ten-minute confirmation, removes those bindings, stops their listeners, and then deletes their Telegram thread Topics one at a time. The control Topic, T3 threads/history, projects, workspaces, code, and paired environments are retained. Bindings created after the confirmation screen was opened are not included. Telegram's native **Delete chat / Delete and Stop** action is outside the gateway: it may reset the client to a Start button or block the bot, and a blocked bot cannot reactivate itself.

SQLite lives at `./data/gateway.db` by default. Back up both this database and `GATEWAY_MASTER_KEY`; neither is useful alone. Changing the master key makes stored credentials unreadable, requiring re-pairing.

Health endpoints default to port 8787: `/healthz` checks process liveness and `/readyz` checks database/core/Telegram initialization. T3 environments may be offline without making the gateway unready.

The provided Compose file uses Linux host networking so a T3 server bound to `127.0.0.1:3773` remains reachable from the gateway. Health endpoints stay bound to `127.0.0.1` by default. For a bridge-network deployment, remove `network_mode: host`, set `HEALTH_HOST=0.0.0.0`, publish port 8787, and connect to a T3 address reachable from that bridge (commonly `host.docker.internal` on Docker Desktop).
