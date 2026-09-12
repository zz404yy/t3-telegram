# Security

- Access is denied unless the Telegram user ID is in `TELEGRAM_ALLOWED_USER_IDS`.
- Configure `T3_ALLOWED_HOSTS` in shared deployments. Empty means any hostname; `T3_ALLOW_PRIVATE_NETWORKS` controls resolved private/loopback addresses.
- Only HTTP and HTTPS endpoints without URL credentials are accepted. Redirects are rejected.
- T3 access tokens are encrypted with AES-256-GCM. WebSocket tickets and one-time pairing tokens are not persisted.
- The requested T3 scopes are only `orchestration:read orchestration:operate`.
- Approval callbacks carry no command, path, or credential. Unknown approval choices fail closed.
- New threads use T3's project default model and `runtimeMode: auto`. Thread model changes are validated against the live provider catalog. The gateway never silently selects `full-access`.
- Runtime permissions map to T3's native `approval-required`, `auto-accept-edits`, `auto`, and `full-access` modes. `full-access` disables approval prompts and the filesystem sandbox, so the Telegram UI requires an explicit second confirmation.
- Exact reply-keyboard control actions are forced into the durable control Topic because Telegram may omit private Topic metadata. Free-form text has no such fallback and fails closed when its Topic cannot be resolved.
- Bulk Telegram conversation cleanup snapshots its exact binding IDs, stops listeners before deleting Topics, excludes the durable control Topic, and never archives or deletes upstream T3 threads.
- Prompt and code output are not logged. Pino redaction covers known secret field names.

Anyone controlling an allowed Telegram account can operate its bound T3 threads. Protect the Telegram account with two-step verification and keep the bot in private chats.
