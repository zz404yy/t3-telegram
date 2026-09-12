# T3 external protocol notes

Observed baseline: T3 `0.0.40`, upstream revision `efccda9ac9230db22b36990cffabdad218fa41b0`, 2026-09-12.

Evidence combines a read-only probe of the local server on port 3773 with the matching upstream server/client source. The environment descriptor and unauthenticated auth session are live captures, sanitized under `tests/fixtures/t3/0.0.40`. RPC framing was verified against Effect `4.0.0-rc.112` plus T3's matching patch and server route. An authenticated live RPC capture still requires a user-issued one-time pairing credential; `pnpm inspect:t3 -- --pairing-token ...` performs only a safe search probe.

Runtime code does not import T3 packages or Effect.

## 1. Environment descriptor

Operation: discovery. Transport: `GET /.well-known/t3/environment`, no authentication.

Consumed shape:

```json
{
  "environmentId": "uuid",
  "label": "host label",
  "platform": { "os": "linux", "arch": "x64", "machine": "cloud" },
  "serverVersion": "0.0.40",
  "capabilities": { "repositoryIdentity": true }
}
```

Both the top level and nested platform object allow unknown fields. Capability keys not understood by the gateway are retained but ignored.

## 2. External-client auth bootstrap

`GET /api/auth/session` without credentials returns `authenticated: false` plus an `auth` descriptor. The observed remote-reachable server advertises bootstrap method `one-time-token` and session methods `browser-session-cookie`, `bearer-access-token`, and `dpop-access-token`.

The gateway currently supports the Bearer branch. A user creates a one-time credential through T3's public pairing UX/CLI. The gateway exchanges it using:

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<one-time-token>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate
client_label=T3 Vibe Gateway
client_device_type=bot
```

The response contains `access_token`, `token_type`, `expires_in`, and `scope`. Only a `Bearer` response is accepted. DPoP is detected as unsupported rather than silently downgraded.

## 3. WebSocket ticket

```http
POST /api/auth/websocket-ticket
Authorization: Bearer <access-token>
Accept: application/json
```

Response:

```json
{ "ticket": "short-lived-opaque-ticket", "expiresAt": "2026-09-12T00:00:00.000Z" }
```

Tickets are never persisted or logged.

## 4. WebSocket URL

HTTP changes to WS and HTTPS to WSS. Path is exactly `/ws`:

```text
ws(s)://host/ws?wsTicket=<ticket>&clientSurface=web&clientAppVersion=0.1.0&clientDeviceType=unknown&connectionMethod=direct
```

Client presentation parameters are optional/additive. The ticket is mandatory for the observed remote-reachable policy.

## 5. WebSocket framing

Serialization is one JSON object per WebSocket message. It is not JSON-RPC 2.0.

Client request:

```json
{ "_tag": "Request", "id": 1, "tag": "method.name", "payload": {}, "headers": [] }
```

Unary success:

```json
{ "_tag": "Exit", "requestId": 1, "exit": { "_tag": "Success", "value": {} } }
```

Streams use `Chunk` with a `values` array. The client returns `Ack` for every chunk. Cancelling a stream sends `Interrupt`. Protocol heartbeat `Ping` is answered by `Pong`. `Defect` is connection-wide. Unknown envelope fields are ignored.

## 6. Safe read RPC

Operation: thread search.

```json
{
  "_tag": "Request",
  "id": 1,
  "tag": "orchestration.searchThreads",
  "payload": { "query": "gateway probe", "limit": 1 },
  "headers": []
}
```

Success value is `{ "matches": [...] }`. Each consumed match has `threadId`, `projectId`, `source`, `snippet`, and optionally `messageCreatedAt`.

Project/thread listing primarily uses authenticated HTTP `GET /api/orchestration/shell`, which returns `snapshotSequence`, `projects`, and `threads`. This avoids opening a permanent shell subscription merely to render a Telegram selection list.

## 7. Subscription RPC

Method: `orchestration.subscribeThread`.

```json
{
  "threadId": "thread-id",
  "afterSequence": 41,
  "requestCompletionMarker": true,
  "turnLimit": 10
}
```

Chunk values are `snapshot`, `event`, or `synchronized` items. Unknown item/event discriminators normalize to `unknown` and do not end the stream.

## 8. Create thread

Project creation uses the same dispatch method with this payload:

```json
{
  "type": "project.create",
  "commandId": "uuid",
  "projectId": "uuid",
  "title": "Telegram project",
  "workspaceRoot": "/path/on/the/t3-host/project",
  "createWorkspaceRootIfMissing": true,
  "createdAt": "ISO-8601"
}
```

The path is interpreted by the selected T3 host. T3 creates the native project and optionally its missing directory. The gateway does not invent a model selection. It reads the live provider catalog with `server.getConfig`, shows only ready and enabled provider instances, and saves the user's explicit choice with:

```json
{
  "type": "project.meta.update",
  "commandId": "uuid",
  "projectId": "project-id",
  "defaultModelSelection": { "instanceId": "provider-instance", "model": "model-id" }
}
```

The selected provider and model are revalidated against the live catalog immediately before dispatch.

### Create thread

Method: `orchestration.dispatchCommand`.

```json
{
  "type": "thread.create",
  "commandId": "uuid",
  "threadId": "uuid",
  "projectId": "project-id",
  "title": "Telegram 2026-09-12 12:00",
  "modelSelection": { "instanceId": "provider-instance", "model": "model-id" },
  "runtimeMode": "auto",
  "interactionMode": "default",
  "branch": null,
  "worktreePath": null,
  "createdAt": "ISO-8601"
}
```

The model selection is taken from the project's T3-owned default. The gateway does not invent a provider/model. It explicitly chooses `auto`, not `full-access`, as the safe runtime mode.

## 9. Start turn

Method: `orchestration.dispatchCommand`.

```json
{
  "type": "thread.turn.start",
  "commandId": "uuid",
  "threadId": "thread-id",
  "message": {
    "messageId": "uuid",
    "role": "user",
    "text": "user prompt",
    "attachments": []
  },
  "modelSelection": { "instanceId": "provider-instance", "model": "model-id" },
  "runtimeMode": "auto",
  "interactionMode": "default",
  "createdAt": "ISO-8601"
}
```

For an existing thread, model, runtime, and interaction selections come from the current T3 thread shell. The explicit `modelSelection` is required for a previously changed thread model to be applied to the provider turn. Dispatch success is `{ "sequence": number }`. The gateway only reports acceptance after this response. A timeout is ambiguous and is never blindly retried.

### Update thread model and runtime

The thread model is persisted with:

```json
{
  "type": "thread.meta.update",
  "commandId": "uuid",
  "threadId": "thread-id",
  "modelSelection": { "instanceId": "provider-instance", "model": "model-id" }
}
```

The selected model is revalidated against `server.getConfig`. If either the current or target provider advertises `requiresNewThreadForModelChange: true`, a started conversation cannot change models and the gateway asks the user to create a new thread.

Runtime permissions use a distinct command:

```json
{
  "type": "thread.runtime-mode.set",
  "commandId": "uuid",
  "threadId": "thread-id",
  "runtimeMode": "auto",
  "createdAt": "ISO-8601"
}
```

Observed runtime values are `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. T3 applies the desired mode when ensuring the provider session for the next turn and restarts that provider session when required.

## 10. Interrupt

Method: `orchestration.dispatchCommand`.

```json
{
  "type": "thread.turn.interrupt",
  "commandId": "uuid",
  "threadId": "thread-id",
  "turnId": "optional-active-turn-id",
  "createdAt": "ISO-8601"
}
```

`/stop` first reads thread state. If the latest turn is no longer running, no interrupt command is sent.

## 11. Approval request

Approval is carried by a `thread.activity-appended` orchestration event. Its activity has kind `approval.requested` and an opaque payload:

```json
{
  "requestId": "provider-request-id",
  "requestKind": "command",
  "requestType": "command_execution_approval",
  "detail": "npm install",
  "options": [
    { "decision": "accept", "label": "Allow once" },
    { "decision": "acceptForSession", "label": "Allow session" },
    { "decision": "decline", "label": "Deny" }
  ]
}
```

Valid observed decision values are `accept`, `acceptForSession`, `acceptAlways`, `decline`, and `cancel`. Telegram buttons are created only from options actually supplied by T3. Missing/unrecognized options fail closed.

## 12. Approval response

Method: `orchestration.dispatchCommand`.

```json
{
  "type": "thread.approval.respond",
  "commandId": "uuid",
  "threadId": "thread-id",
  "requestId": "provider-request-id",
  "decision": "accept",
  "createdAt": "ISO-8601"
}
```

Telegram callback data contains a gateway approval UUID and option index only. Owner, pending status, binding, request, and option are revalidated before dispatch.

## 13. Diff

Turn diff method: `orchestration.getTurnDiff`, payload `{ threadId, fromTurnCount, toTurnCount, ignoreWhitespace }`.

Full thread diff method: `orchestration.getFullThreadDiff`, payload `{ threadId, toTurnCount, ignoreWhitespace }`.

Both return `{ threadId, fromTurnCount, toTurnCount, diff }`. The current checkpoint count is read from authenticated `GET /api/orchestration/threads/:threadId`. Telegram receives a parsed file/stat summary instead of the full potentially huge patch.

## 14. Sequence and resume

Thread subscriptions accept `afterSequence`. When present, the server replays thread events after that cursor and then streams live events. If the cursor cannot be replayed, the server sends a replacement snapshot. `requestCompletionMarker: true` yields `synchronized` after initial replay/snapshot. The gateway subscribes from `dispatch.sequence - 1` to close the dispatch/subscribe race.

## 15. Unknown RPC behavior

For an unknown method tag, Effect RPC returns a request-scoped failed `Exit` whose defect indicates `Unknown request tag`. The adapter converts this to a typed gateway transport error. It does not crash Telegram or treat the feature as supported. Unknown event types normalize to `{ type: "unknown" }`.

## 16. Insufficient scope

The server maps RPC methods to scopes. Read/search/diff/subscriptions require `orchestration:read`; command dispatch requires `orchestration:operate`. An authenticated session missing a required scope is rejected by RPC authorization. The gateway asks for exactly these two scopes at token exchange and does not request terminal/admin scopes. Authorization failures never trigger approval or a mutating retry.
