# T3 Vibe Gateway — Product Requirements Document

**Version:** 0.1  
**Status:** Implementation-ready MVP PRD  
**Date:** 2026-09-12  
**Primary implementer:** Codex / coding agent  
**Working name:** `t3-vibe-gateway`

---

## 0. Agent Execution Contract

This document is not a discussion draft. Treat it as the implementation contract for the MVP.

When implementing:

1. Do not fork, patch, vendor, or modify T3Code.
2. Do not import any `@t3tools/*` package.
3. Do not require a T3Code source checkout at runtime.
4. Do not read or mutate T3Code SQLite databases, internal state files, cookies, private filesystem layout, or UI DOM.
5. Runtime integration with T3Code must happen only through externally reachable network interfaces exposed by a running T3 server: environment discovery, HTTP authentication endpoints, WebSocket RPC, and other public network endpoints discoverable from the running server.
6. Reading T3Code upstream source in CI or during protocol research is allowed. The source is a reference for discovering protocol behavior, not a runtime dependency.
7. Build the application around an internal stable `CodingBackend` abstraction. Telegram code must not call T3-specific RPC methods directly.
8. Implement only the minimum T3 protocol subset required by the MVP. Do not recreate the entire T3 contracts package.
9. Unknown fields from T3 responses must be tolerated wherever safe. Prefer additive-compatible decoding.
10. Every T3 capability must be represented as discoverable/supported/unsupported/degraded. Do not assume a feature merely from a version string.
11. The application must continue to start even when T3 is unreachable or incompatible; it should report environment status cleanly.
12. Security-sensitive operations, especially approvals and dangerous sandbox modes, must fail closed.

If implementation-time upstream behavior differs from assumptions in this PRD, preserve these architectural rules and adapt only the T3 adapter.

---

# 1. Product Summary

`t3-vibe-gateway` is an independent Telegram-native client/gateway for controlling T3Code remotely and performing vibe coding from Telegram.

The product connects to an already-running T3Code server as an external client. It maps Telegram conversations/topics to T3 projects and threads, allows the user to start or continue coding turns, streams agent output back into Telegram, exposes approval requests as Telegram buttons, supports interruption, and surfaces diffs and completion summaries.

The gateway is **not** a replacement for T3Code and is **not** a wrapper around Codex/Claude/OpenCode directly.

T3Code remains responsible for:

- provider orchestration;
- projects/workspaces;
- coding threads;
- provider sessions;
- checkpoints;
- file changes;
- diffs;
- coding-agent execution.

The gateway owns only:

- Telegram interaction and UX;
- T3 connection/auth/session management;
- Telegram ↔ T3 environment/project/thread bindings;
- normalization of T3 protocol events into a stable internal domain model;
- compatibility detection;
- upstream regression monitoring.

---

# 2. Problem Statement

T3Code already provides rich control surfaces, but Telegram is useful when the user wants to:

- continue an existing coding session from a phone;
- give an agent a short instruction without opening T3 UI;
- monitor an agent that is already working;
- approve or reject an action remotely;
- stop a runaway turn;
- inspect a compact diff;
- attach a desktop-created T3 thread to Telegram;
- continue the exact same thread from multiple client surfaces.

The primary engineering challenge is therefore not “how to call a coding agent”.

It is:

> How to build a durable external T3Code client that survives rapid upstream changes without maintaining a fork.

---

# 3. Product Goals

## 3.1 MVP goal

The MVP must implement the complete loop:

```text
Connect T3
    ↓
Choose project
    ↓
Create or attach thread
    ↓
Send prompt
    ↓
Receive streamed agent activity/output
    ↓
Approve / reject if required
    ↓
Interrupt if required
    ↓
Receive completion + diff summary
    ↓
Continue the same thread later
```

## 3.2 Product principles

### External companion, not plugin

T3Code is treated as an independent external service.

### Protocol isolation

All T3-specific implementation must live inside:

```text
adapter-t3
```

### Telegram-native UX

Use Telegram private-chat topics when supported instead of pretending a flat chat is an IDE.

### Shared T3 state

Telegram must attach to real T3 threads.

No transcript cloning.

No shadow thread system.

### Minimal persistence

Gateway persistence should contain only gateway-owned metadata.

### Forward-compatible parsing

Additive upstream changes should normally not break the gateway.

### Rapid compatibility detection

T3 upstream breakage should ideally be discovered by CI before production users report it.

---

# 4. Non-Goals

The MVP will not:

- recreate T3Code;
- recreate a full IDE;
- provide a Telegram terminal emulator;
- directly launch Codex CLI;
- directly launch Claude Code;
- directly launch OpenCode;
- directly manage provider sessions;
- directly own project workspaces;
- proxy every T3 RPC;
- copy T3's complete contract package;
- mirror complete T3 transcripts into SQLite;
- depend on DOM/UI automation;
- read T3 private databases;
- require a T3 source checkout;
- provide Telegram Mini App UI in MVP;
- implement organization/team RBAC;
- guarantee compatibility with every historical T3 version.

---

# 5. External Baseline

Runtime behavior must always be verified dynamically.

Current implementation assumptions include:

```text
/.well-known/t3/environment

HTTP authentication APIs

/api/auth/websocket-ticket

WebSocket RPC

thread/shell subscription

command dispatch

thread search/listing

diff retrieval
```

Telegram baseline:

```text
private-chat topics

message_thread_id

sendMessageDraft

stopped_message_generation

inline keyboard callbacks
```

These are external protocol assumptions only.

They must never translate into runtime T3 package dependencies.

---

# 6. Architecture

```text
                    Telegram Bot API
                           │
                           ▼
                ┌──────────────────────┐
                │ frontend-telegram    │
                │                      │
                │ commands             │
                │ callbacks            │
                │ topic routing        │
                │ draft streaming      │
                │ rendering            │
                └──────────┬───────────┘
                           │
                    stable domain API
                           │
                           ▼
                ┌──────────────────────┐
                │ gateway-core         │
                │                      │
                │ users                │
                │ environments         │
                │ thread bindings      │
                │ use cases            │
                │ event routing        │
                └──────────┬───────────┘
                           │
                      CodingBackend
                           │
                           ▼
                ┌──────────────────────┐
                │ adapter-t3           │
                │                      │
                │ discovery            │
                │ authentication       │
                │ RPC transport        │
                │ protocol schemas     │
                │ normalizers          │
                │ capability detection │
                └──────────┬───────────┘
                           │
                     HTTP + WebSocket
                           │
                           ▼
                    ┌──────────────┐
                    │ T3Code Server│
                    └──────┬───────┘
                           │
                 provider orchestration
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
      Codex            Claude Code          OpenCode
```

Compatibility monitoring runs independently:

```text
T3 upstream
     │
     ▼
compatibility-watcher
     │
     ├── source protocol diff
     ├── fingerprint
     ├── stable smoke test
     └── nightly/main smoke test
```

---

# 7. Repository Layout

Use a TypeScript monorepo.

```text
t3-vibe-gateway/
├── apps/
│   └── gateway/
│       ├── src/
│       │   ├── main.ts
│       │   ├── config.ts
│       │   └── bootstrap.ts
│       └── package.json
│
├── packages/
│   ├── core/
│   │   ├── src/domain/
│   │   ├── src/ports/
│   │   ├── src/usecases/
│   │   ├── src/events/
│   │   └── src/errors/
│   │
│   ├── adapter-t3/
│   │   ├── src/discovery/
│   │   ├── src/auth/
│   │   ├── src/rpc/
│   │   ├── src/protocol/
│   │   ├── src/normalizers/
│   │   ├── src/capabilities/
│   │   └── src/T3Backend.ts
│   │
│   ├── frontend-telegram/
│   │   ├── src/commands/
│   │   ├── src/callbacks/
│   │   ├── src/topics/
│   │   ├── src/renderers/
│   │   ├── src/streaming/
│   │   └── src/TelegramFrontend.ts
│   │
│   ├── persistence/
│   │   ├── src/schema/
│   │   ├── src/repositories/
│   │   └── src/migrations/
│   │
│   └── compatibility/
│       ├── src/fingerprint/
│       ├── src/report/
│       └── src/probes/
│
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   └── fixtures/
│
├── scripts/
│   ├── inspect-t3.ts
│   ├── inspect-t3-upstream.ts
│   └── smoke-t3.ts
│
├── .github/workflows/
│   ├── ci.yml
│   └── t3-compatibility.yml
│
├── Dockerfile
├── docker-compose.yml
├── README.md
└── docs/
    ├── protocol-notes.md
    ├── compatibility.md
    └── operations.md
```

Recommended stack:

```text
Node.js 24
TypeScript strict
pnpm workspace
grammY
fetch / undici
ws
zod
SQLite
better-sqlite3
pino
vitest
```

Do not introduce Effect simply because T3Code uses Effect internally.

---

# 8. Stable Backend Interface

Telegram must not depend directly on T3 RPC.

Create a gateway-owned port similar to:

```ts
export interface CodingBackend {
  connect(environmentId: string): Promise<BackendConnectionStatus>;

  disconnect(environmentId: string): Promise<void>;

  getInfo(
    environmentId: string
  ): Promise<BackendInfo>;

  getCapabilities(
    environmentId: string
  ): Promise<BackendCapabilities>;

  listProjects(
    environmentId: string
  ): Promise<ProjectSummary[]>;

  listThreads(
    input: ListThreadsInput
  ): Promise<ThreadSummary[]>;

  createThread(
    input: CreateThreadInput
  ): Promise<ThreadSummary>;

  renameThread(
    input: RenameThreadInput
  ): Promise<void>;

  archiveThread(
    input: ArchiveThreadInput
  ): Promise<void>;

  startTurn(
    input: StartTurnInput
  ): Promise<StartTurnResult>;

  interruptTurn(
    input: InterruptTurnInput
  ): Promise<void>;

  subscribeThread(
    input: SubscribeThreadInput
  ): AsyncIterable<ThreadEvent>;

  respondToApproval(
    input: ApprovalResponseInput
  ): Promise<void>;

  getTurnDiff(
    input: GetTurnDiffInput
  ): Promise<DiffSummary>;

  getThreadDiff(
    input: GetThreadDiffInput
  ): Promise<DiffSummary>;
}
```

Telegram frontend may import:

```text
core/domain
core/ports
core/usecases
```

It must not import:

```text
adapter-t3/protocol/*
adapter-t3/rpc/*
```

---

# 9. Normalized Events

The gateway owns its own event model.

Minimum target:

```ts
type ThreadEvent =
  | {
      type: "turn.started";
      threadId: string;
      turnId?: string;
    }
  | {
      type: "assistant.delta";
      text: string;
    }
  | {
      type: "assistant.message";
      text: string;
    }
  | {
      type: "activity";
      title: string;
      detail?: string;
    }
  | {
      type: "tool.started";
      label: string;
      detail?: string;
    }
  | {
      type: "tool.finished";
      label: string;
      ok: boolean;
      detail?: string;
    }
  | {
      type: "approval.requested";
      request: ApprovalRequest;
    }
  | {
      type: "files.changed";
      files: ChangedFileSummary[];
    }
  | {
      type: "turn.completed";
      status:
        | "success"
        | "failed"
        | "cancelled";
    }
  | {
      type: "usage.updated";
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: "warning";
      message: string;
    }
  | {
      type: "unknown";
      rawType?: string;
    };
```

An unknown upstream T3 event should normally become:

```ts
{
  type: "unknown"
}
```

rather than crashing the connection.

---

# 10. T3 Adapter

## 10.1 Discovery

Connection begins with environment discovery.

At minimum collect:

```text
base URL
server version
auth/session methods
advertised capabilities
last discovery time
protocol fingerprint
```

Unknown descriptor fields must be tolerated.

---

## 10.2 Authentication abstraction

T3 authentication is expected to evolve.

Implement:

```ts
interface T3AuthStrategy {
  canHandle(
    descriptor: T3EnvironmentDescriptor
  ): boolean;

  authenticate(
    input: AuthInput
  ): Promise<T3Credential>;

  authorizeHttp(
    request: RequestInit
  ): Promise<RequestInit>;

  issueWebSocketTicket(): Promise<string>;
}
```

Telegram must never know whether the implementation is:

```text
Bearer
DPoP
pairing
code exchange
future strategy
```

The adapter determines it.

Never read:

```text
~/.t3/
T3 database
browser cookies
private auth state
```

unless T3 someday explicitly documents such a mechanism as a public external-client API.

---

# 11. Credential Storage

Long-lived T3 credentials must be encrypted at rest.

MVP target:

```text
AES-256-GCM
```

Configuration:

```env
GATEWAY_MASTER_KEY=
```

Use:

```text
random nonce
ciphertext version
authentication tag
```

Never persist:

```text
WebSocket tickets
temporary auth codes
```

Never log:

```text
Authorization
Bearer token
DPoP private key
bot token
```

---

# 12. WebSocket / RPC Transport

Do not expose Effect concepts outside `adapter-t3`.

Create something like:

```ts
interface RpcTransport {
  request<T>(
    method: string,
    payload: unknown
  ): Promise<T>;

  stream<T>(
    method: string,
    payload: unknown
  ): AsyncIterable<T>;

  close(): Promise<void>;
}
```

Transport responsibilities:

```text
ticket acquisition
WebSocket creation
request IDs
request correlation
stream handling
server errors
timeout
close
reconnect
resubscribe/recovery
```

Do **not** guess the Effect RPC format.

Codex must observe the current actual wire protocol.

---

# 13. Minimal T3 Protocol Surface

Implement only what is required for:

```text
environment discovery

authentication

project discovery/list

thread list/search

thread create

thread rename

thread archive

turn start

turn interrupt

thread subscribe

approval response

turn diff

full thread diff
```

Current upstream method names may include things such as:

```text
orchestration.dispatchCommand

orchestration.subscribeShell

orchestration.subscribeThread

orchestration.searchThreads

orchestration.getTurnDiff

orchestration.getFullThreadDiff
```

These names belong only to:

```text
adapter-t3
```

They are not domain API names.

---

# 14. Protocol Schemas

Use small schemas covering the fields actually consumed.

Example policy:

```ts
const ThreadSchema = z.object({
  id: z.string(),
  // gateway-used fields
}).passthrough();
```

Do not mirror 2000+ lines of T3 schemas.

For expanding upstream enum fields:

Bad:

```ts
z.enum(["a", "b"])
```

when an unknown value would crash the entire connection.

Prefer safe normalization where possible:

```text
known → normalized value
unknown → unknown/raw value
```

---

# 15. Capability Model

Every T3 environment needs an explicit capability set.

```ts
interface BackendCapabilities {
  projectsList: CapabilityState;
  threadsList: CapabilityState;

  threadCreate: CapabilityState;
  threadAttach: CapabilityState;

  turnStart: CapabilityState;
  turnInterrupt: CapabilityState;

  streaming: CapabilityState;
  approval: CapabilityState;

  diffTurn: CapabilityState;
  diffThread: CapabilityState;

  renameThread: CapabilityState;
  archiveThread: CapabilityState;

  resumeSubscription: CapabilityState;
}

type CapabilityState =
  | {
      state: "supported";
    }
  | {
      state: "unsupported";
      reason?: string;
    }
  | {
      state: "degraded";
      reason: string;
    }
  | {
      state: "unknown";
      reason?: string;
    };
```

Resolution priority:

```text
descriptor-advertised capability
        ↓
known fingerprint compatibility
        ↓
known version compatibility hint
        ↓
safe non-mutating probe
        ↓
observed successful operation
```

Never run a mutating operation only to determine whether it exists.

---

# 16. Version Handling

Do not design:

```ts
if (serverVersion === "0.0.x") {}
```

as the primary strategy.

Use version only as compatibility metadata/hint.

Primary strategy:

```text
capabilities
+
protocol fingerprint
+
observed behavior
```

Version-specific compatibility shims are allowed inside:

```text
adapter-t3/compatibility
```

Example:

```text
protocol profile A
protocol profile B
```

Both should normalize into the same `CodingBackend` behavior.

---

# 17. Telegram Model

Primary relationship:

```text
Telegram user
    │
    ├── T3 environment A
    │
    └── T3 environment B
```

When Telegram topic mode is available:

```text
Telegram private topic
          ↕
      T3 thread
```

A topic binding consists of:

```text
telegram_chat_id
telegram_thread_id

environment_id
t3_project_id
t3_thread_id
```

---

# 18. Topic Fallback

Telegram topic support cannot be mandatory.

If private topics are disabled:

```text
private chat
     │
active binding
     │
 T3 thread
```

Commands:

```text
/attach
/new
```

change the active binding.

Every major response in fallback mode should display a compact thread name to prevent accidental actions against the wrong coding session.

---

# 19. Telegram Commands

MVP commands:

| Command | Purpose |
|---|---|
| `/start` | onboarding/status |
| `/connect` | connect a T3 environment |
| `/environments` | list environments |
| `/projects` | project selection/list |
| `/new` | create T3 thread |
| `/attach` | bind to existing T3 thread |
| `/status` | environment/thread/capability status |
| `/stop` | interrupt current turn |
| `/diff` | current/last turn diff |
| `/detach` | remove Telegram binding only |
| `/help` | concise usage help |

Avoid command explosion.

Normal text in a bound coding topic/chat should become a coding turn.

---

# 20. `/connect`

Do not hardcode Telegram UI around one T3 auth strategy.

Core should expose generic auth UI steps:

```ts
type AuthStep =
  | {
      type: "open_url";
      url: string;
      label: string;
    }
  | {
      type: "enter_code";
      prompt: string;
    }
  | {
      type: "enter_token";
      prompt: string;
    }
  | {
      type: "completed";
    }
  | {
      type: "failed";
      reason: string;
    };
```

This allows:

```text
T3 auth changes
```

without changing Telegram business logic.

---

# 21. `/new`

Expected flow:

```text
/new

if multiple environments:
    select environment

select project

optionally select provider/model
only if current T3 external protocol requires/exposes it

create T3 thread

create Telegram topic if appropriate

persist binding

return Ready
```

Do not invent provider/model defaults.

If T3 supports native default behavior, use T3's own defaults.

---

# 22. `/attach`

This is a P0 feature.

Expected:

```text
/attach

select environment

select project

show recent/searchable T3 threads

select thread

bind Telegram topic/chat
```

No new T3 thread should be created.

This is one of the core product differentiators:

```text
T3 Desktop
     ↓
existing thread #123

Telegram /attach
     ↓
same thread #123

T3 Web
     ↓
same thread #123
```

---

# 23. Starting a Turn

Normal text in a bound topic:

```text
Telegram message
     ↓
resolve binding
     ↓
verify T3 environment
     ↓
verify capability
     ↓
CodingBackend.startTurn()
     ↓
T3Adapter
     ↓
T3
```

Only report the turn as accepted after T3 confirms dispatch acceptance.

Do not blindly retry a turn start after an ambiguous network failure.

First reconcile thread state.

---

# 24. Thread Subscription

Every active Telegram-bound T3 thread may have a subscription.

Subscription should deliver:

```text
agent text
activity
tool activity
approval request
completion
errors
usage
file change indication
```

Connection manager should avoid multiple unnecessary subscriptions to the same T3 thread inside one process.

---

# 25. Streaming Telegram Output

Use:

```text
sendMessageDraft
```

when supported.

Recommended cadence:

```text
300–700 ms
```

Do not send one API request per token.

Maintain a local assembled output buffer.

At completion:

```text
send persistent final message
```

because streamed draft content is ephemeral.

If draft streaming breaks:

```text
fallback to final message
```

The coding result must not be lost.

---

# 26. Telegram Length Handling

Telegram message size limits must be respected.

Implement a renderer/chunker that understands:

```text
Markdown entities
code blocks
plain text
```

Avoid splitting halfway through malformed formatting where practical.

Large diffs should be summarized rather than dumped into a giant chat response.

---

# 27. Stop Generation

Both:

```text
/stop
```

and Telegram:

```text
stopped_message_generation
```

must call the same gateway-core use case.

Flow:

```text
Telegram
   ↓
InterruptTurnUseCase
   ↓
CodingBackend.interruptTurn
   ↓
T3Adapter
   ↓
T3 interrupt
```

Final user-visible state must be one of:

```text
Interrupted
Already finished
Unsupported
Failed
```

---

# 28. Approval UX

When T3 produces an approval request:

```text
⚠️ Approval required

Action:
Run command

Command:
npm install

Workspace:
/project

[ Allow once ]
[ Allow session ]
[ Deny ]
```

Actual buttons must be generated from currently supported upstream semantics.

Never assume provider-specific approval options globally.

---

# 29. Approval Security

Callback payload must contain:

```text
opaque gateway approval ID
```

not:

```text
raw command
path
token
T3 credential
```

Before dispatch:

```text
validate Telegram user

validate binding owner

validate approval still pending

validate environment

validate request identity
```

Approval handling must be idempotent.

If the approval mode cannot be understood:

```text
fail closed
```

Never auto-approve unknown requests.

---

# 30. Completion Summary

When possible:

```text
✅ Turn completed

Changed: 5 files
+182 / -41

src/auth.ts       +72 -10
src/session.ts    +44 -18
src/api.ts        +36 -8
...

[View diff] [Continue]
```

If no diff capability exists:

```text
Turn completed
Diff unavailable on this T3 environment
```

Do not treat diff capability as required for sending prompts.

---

# 31. Attachments

Attachments are P1 unless the protocol work turns out trivial.

Potential flow:

```text
Telegram image/document
        ↓
temporary gateway file
        ↓
T3 attachment API / turn payload
        ↓
coding agent
```

Rules:

```text
respect Telegram limits
respect T3 limits
validate MIME/size
delete temp file
do not retain indefinitely
```

Attachments must not block initial MVP release.

---

# 32. Persistence

Gateway persistence contains only gateway-owned data.

Suggested SQLite schema:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,

  encrypted_credential BLOB,
  credential_type TEXT,

  server_version TEXT,
  protocol_fingerprint TEXT,

  status TEXT NOT NULL,
  last_seen_at TEXT,

  created_at TEXT NOT NULL,

  FOREIGN KEY(user_id)
    REFERENCES users(id)
);

CREATE TABLE bindings (
  id TEXT PRIMARY KEY,

  user_id TEXT NOT NULL,

  telegram_chat_id TEXT NOT NULL,
  telegram_thread_id TEXT,

  environment_id TEXT NOT NULL,

  t3_project_id TEXT,
  t3_thread_id TEXT NOT NULL,

  display_name TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(
    telegram_chat_id,
    telegram_thread_id
  ),

  FOREIGN KEY(user_id)
    REFERENCES users(id),

  FOREIGN KEY(environment_id)
    REFERENCES environments(id)
);

CREATE TABLE active_chat_bindings (
  telegram_chat_id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,

  FOREIGN KEY(binding_id)
    REFERENCES bindings(id)
);

CREATE TABLE pending_approvals (
  id TEXT PRIMARY KEY,

  binding_id TEXT NOT NULL,
  t3_request_id TEXT NOT NULL,

  telegram_message_id TEXT,

  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,

  UNIQUE(
    binding_id,
    t3_request_id
  )
);

CREATE TABLE compatibility_observations (
  id TEXT PRIMARY KEY,

  environment_id TEXT NOT NULL,

  server_version TEXT,
  protocol_fingerprint TEXT,

  capabilities_json TEXT NOT NULL,

  observed_at TEXT NOT NULL,

  FOREIGN KEY(environment_id)
    REFERENCES environments(id)
);
```

No full transcript table in MVP.

---

# 33. Connection Manager

One environment should have one logical connection supervisor per gateway process.

States:

```text
disconnected

connecting

auth_required

connected

degraded

incompatible

offline
```

Requirements:

```text
capped exponential backoff

jitter

auth failures stop blind reconnect

network failures retry

bindings survive disconnect

descriptor refreshed after reconnect/upgrade

subscription recovery

no competing reconnect loops
```

---

# 34. Subscription Recovery

If T3 supports sequence-based resume:

```text
afterSequence / equivalent
```

use it.

If not:

```text
reconnect
   ↓
fetch current thread state
   ↓
reconcile
   ↓
resume subscription
```

Never silently assume no events occurred while disconnected.

---

# 35. Compatibility Fingerprint

Create a CI-only upstream analyzer.

It may inspect a T3 source checkout for:

```text
orchestration method names

command discriminators

event discriminators

environment descriptor fields

auth endpoints

approval values

request schemas

response schemas
```

Normalize relevant values:

```json
{
  "methods": [],
  "commands": [],
  "events": [],
  "auth": {},
  "approvals": []
}
```

Canonicalize.

Hash:

```text
SHA-256
```

Example metadata:

```text
T3 revision:
abc123

server version:
...

protocol fingerprint:
sha256:...

auth fingerprint:
sha256:...
```

This tooling may depend on source layout because it is CI analysis.

The actual gateway runtime may not.

---

# 36. Upstream Watcher

GitHub Actions scheduled workflow:

```text
fetch T3 latest upstream
        ↓
identify current revision
        ↓
compare watched protocol/auth files
        ↓
extract compatibility fingerprint
        ↓
run fixture/contract tests
        ↓
launch real T3 if possible
        ↓
run black-box smoke tests
        ↓
generate report
```

Test separately:

```text
latest stable

previous tested stable

nightly/current main
```

Stable breakage:

```text
release blocker
```

Nightly/main breakage:

```text
early warning
```

---

# 37. Watched Upstream Areas

Initial upstream inspection should include the current equivalents of:

```text
packages/contracts/src/orchestration.ts

environment descriptor contracts

environment authentication

RPC authorization

WebSocket RPC setup

client connection/runtime behavior

remote environment documentation
```

Do not hardcode these source paths throughout the implementation.

Define them in the compatibility tool configuration so upstream refactors are easy to adjust.

---

# 38. Black-Box Smoke Test

Create:

```text
scripts/smoke-t3.ts
```

Flow:

```text
1 discovery

2 authentication

3 WebSocket ticket

4 open RPC

5 safe shell/project read

6 list/search threads

7 create disposable thread

8 subscribe thread

9 start harmless disposable turn

10 observe normalized event

11 retrieve diff if supported

12 interrupt a deliberate long turn if tested

13 archive/cleanup disposable thread

14 disconnect
```

Use a disposable temp Git project.

Never run compatibility mutation tests against a real user's repository.

---

# 39. Compatibility Error Classification

CI/reporting should distinguish:

```text
Gateway implementation bug

T3 server failed to start

Authentication setup failure

Provider unavailable

T3 protocol breaking change

Feature unsupported

Network infrastructure failure
```

A provider authentication problem is not automatically a T3 protocol regression.

---

# 40. Telegram Access Security

MVP defaults to explicit allowlisting:

```env
TELEGRAM_ALLOWED_USER_IDS=12345678,98765432
```

Unknown users must receive no privileged environment information.

Do not expose:

```text
server URLs

project names

thread names

errors containing credentials
```

to unauthorized Telegram users.

---

# 41. SSRF Protection

`/connect` accepts a network endpoint, creating SSRF risk.

But private IPs are legitimate because common deployments may use:

```text
localhost
LAN
RFC1918
Tailscale
VPN
```

Therefore do not simply ban private networks.

Provide policy configuration:

```env
T3_ALLOWED_HOSTS=
T3_ALLOW_PRIVATE_NETWORKS=true
```

Restrictions:

```text
HTTP/HTTPS only

no file://

no gopher://

no arbitrary protocols

redirect limit

DNS resolution validation

optional hostname/CIDR allowlist
```

---

# 42. Idempotency

Telegram may redeliver updates.

Gateway restarts may occur.

Requirements:

```text
Telegram callback idempotency

approval idempotency

turn-start deduplication

final-message deduplication
```

Mutating RPC timeout is special:

```text
request sent
     ↓
network dies
     ↓
unknown outcome
```

Do not automatically send the same coding turn again.

Reconcile first.

---

# 43. Logging

Use structured logs.

Useful fields:

```text
request_id

telegram_update_id

telegram_user_id

environment_id

server_version

binding_id

t3_project_id

t3_thread_id

turn_id

rpc_method

latency_ms

error_code
```

Do not log prompt content by default.

Do not log code output by default.

Debug logging of content, if ever implemented, must be explicitly enabled.

---

# 44. Health Endpoints

Gateway process should expose:

```text
GET /healthz
```

Meaning:

```text
process is alive
```

And:

```text
GET /readyz
```

Meaning:

```text
database initialized
Telegram client initialized
core startup complete
```

Do not require every T3 environment to be online for gateway readiness.

---

# 45. Configuration

Example:

```env
TELEGRAM_BOT_TOKEN=

TELEGRAM_ALLOWED_USER_IDS=

DATABASE_URL=file:./data/gateway.db

GATEWAY_MASTER_KEY=

LOG_LEVEL=info

TELEGRAM_MODE=polling

PUBLIC_BASE_URL=

WEBHOOK_SECRET=

T3_ALLOWED_HOSTS=

T3_ALLOW_PRIVATE_NETWORKS=true
```

Long polling should be the default MVP mode.

It works nicely for:

```text
private T3 host
+
outbound-only Telegram connectivity
```

---

# 46. Deployment

Preferred topology:

```text
┌─────────────────────────────────┐
│ Developer machine / server      │
│                                 │
│ T3Code Server                   │
│ :3773                           │
│      ▲                          │
│      │ localhost/private net    │
│      ▼                          │
│ t3-vibe-gateway                 │
│      │                          │
└──────┼──────────────────────────┘
       │
       │ outbound HTTPS
       ▼
 Telegram
```

No public T3 port required in common deployment.

Also support:

```text
Gateway
   │
   ├── T3 laptop
   ├── T3 workstation
   └── T3 remote server
```

provided those environments are reachable through the network.

---

# 47. Packaging

Provide:

```text
Dockerfile

docker-compose.yml

Node.js launch documentation

SQLite volume documentation

environment variable example

restart policy documentation
```

Do not package T3Code inside the gateway image.

T3 remains separately managed.

---

# 48. P0 Requirements

P0 includes:

```text
Telegram long-polling startup

Telegram user allowlist

T3 environment add/connect

environment descriptor discovery

external T3 authentication

authenticated WebSocket RPC

project listing

thread list/search

thread creation

attach to existing thread

Telegram topic mapping

non-topic fallback

turn start

thread subscription

assistant streaming

persistent final response

stop/interruption

approval buttons

diff summary

reconnection

/status capability display

SQLite state

unit tests

protocol fixtures

real T3 smoke tests

upstream compatibility watcher
```

---

# 49. P1

Immediately after MVP:

```text
Telegram image attachment

Telegram document attachment

large .diff uploads

better multi-environment UX

thread rename UI

thread archive UI

webhook mode

pagination/search improvements

additional streaming renderers
```

---

# 50. P2

Later:

```text
Telegram Mini App

rich diff viewer

file viewer

Discord frontend

Slack frontend

other CodingBackend adapters

team/RBAC support

provider/model rich configuration
```

---

# 51. Acceptance Scenario A

## New coding session

Given:

```text
working T3 environment

selected project
```

When:

```text
user executes /new
```

Then:

```text
a real T3 thread is created

Telegram becomes bound to it

plain Telegram text starts a turn
```

Pass condition:

The thread and Telegram-created turn are visible from an official T3 client.

---

# 52. Acceptance Scenario B

## Attach an existing T3 thread

Given a thread created previously through T3 Desktop/Web/Mobile.

When:

```text
/attach
```

and user selects the thread.

Then:

Telegram continues that exact thread.

Pass:

```text
no cloned thread
no duplicated transcript
```

---

# 53. Acceptance Scenario C

## Streaming

When agent output arrives progressively:

```text
Telegram displays draft progress
```

At completion:

```text
persistent final Telegram message
```

Pass:

A draft API failure does not lose the final result.

---

# 54. Acceptance Scenario D

## Approval

When T3 emits an approval request:

```text
Telegram inline keyboard appears
```

Only the owning Telegram user can resolve it.

Pass:

```text
one user action
    ↓
one T3 approval response
```

Duplicate callback:

```text
no duplicate approval action
```

---

# 55. Acceptance Scenario E

## Stop

During a running turn:

```text
/stop
```

or Telegram stop-generation event.

Then:

```text
T3 interrupt is dispatched
```

Pass:

No extra turn is accidentally created.

---

# 56. Acceptance Scenario F

## Additive T3 upgrade

Given a newer T3 adds:

```text
new JSON fields

new event types

new enum values
```

that are irrelevant to this gateway.

Pass:

Gateway continues working.

---

# 57. Acceptance Scenario G

## Breaking T3 change

Given a required RPC payload changes incompatibly.

Pass:

Scheduled compatibility CI produces a focused failure identifying:

```text
affected method

old observed shape

new observed shape

affected adapter feature
```

Telegram frontend should not need changes unless the actual product semantics changed.

---

# 58. Unit Tests

Focus on:

```text
binding resolution

topic routing

capability resolver

T3 normalizers

unknown event handling

unknown enum handling

credential encryption

stream text buffering

Telegram chunking

approval ownership

approval idempotency

turn deduplication
```

---

# 59. Protocol Fixture Tests

Store sanitized fixtures:

```text
tests/fixtures/t3/<version-or-revision>/
```

Each fixture should document:

```text
T3 version

commit if known

capture date

RPC/event purpose

raw vs normalized
```

Never store secrets.

---

# 60. Integration Tests

Compatibility testing must include a real T3 server when practical.

Do not claim:

```text
MockT3Backend passes
```

therefore:

```text
T3 compatibility passes
```

These are different test classes.

---

# 61. Milestone M0 — Repository Foundation

Deliver:

```text
monorepo

TypeScript strict

pnpm

lint

format

vitest

config loader

SQLite migration

logger

baseline GitHub CI
```

Acceptance:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

all succeed.

---

# 62. Milestone M1 — Protocol Reconnaissance

This milestone happens **before Telegram coding implementation**.

Deliver:

```text
T3DiscoveryClient

descriptor schema

docs/protocol-notes.md

sanitized live fixtures

scripts/inspect-t3.ts
```

Runtime dependencies:

```text
NO @t3tools/*
```

Acceptance:

Against the current T3 server:

```text
inspect-t3
```

prints:

```text
server version

descriptor

auth/session methods

discovered capabilities
```

---

# 63. Milestone M2 — T3 Authentication + RPC

Deliver:

```text
auth strategy abstraction

compatible auth implementation

WebSocket ticket handling

RPC request transport

stream transport

timeouts

transport errors

reconnect primitives
```

Acceptance:

A black-box script authenticates and successfully performs one safe read RPC against live T3.

---

# 64. Milestone M3 — Native T3Backend

Deliver:

```text
projects

threads

create thread

rename/archive where available

start turn

subscribe thread

interrupt

approval response

diff

normalizers

capability resolver
```

Acceptance:

```bash
pnpm smoke:t3
```

successfully executes the supported disposable smoke flow.

No T3 package import exists.

---

# 65. Milestone M4 — Telegram Baseline

Deliver:

```text
grammY frontend

allowlist

/start

/connect

/environments

/projects

/status

/help

SQLite environment state
```

Acceptance:

Telegram can connect to T3 and display environment/capability status.

---

# 66. Milestone M5 — Complete Telegram Coding Loop

Deliver:

```text
/new

/attach

topic binding

fallback active binding

plain text → T3 turn

streaming

final response

/stop

approval buttons

/diff
```

Acceptance:

Scenarios A–E pass against a disposable real repository.

---

# 67. Milestone M6 — Upstream Compatibility Automation

Deliver:

```text
source fingerprint

scheduled workflow

stable compatibility job

current-main/nightly warning job

compatibility report

automatic regression issue
```

Acceptance:

An intentionally incompatible protocol fixture causes a focused compatibility failure.

---

# 68. Milestone M7 — Packaging

Deliver:

```text
Dockerfile

docker-compose

README

operations guide

security guide

release workflow
```

Acceptance:

A clean machine can run the gateway with only:

```text
Node/container runtime

Telegram bot token

reachable T3 server

supported T3 authentication
```

---

# 69. Definition of Done

MVP is complete only when:

1. Runtime dependencies contain no `@t3tools/*`.
2. Gateway can run in a completely separate directory/container from T3Code.
3. Gateway does not require a T3 source checkout.
4. Existing desktop-created T3 threads can be attached.
5. Telegram can create a new real T3 thread.
6. Multiple consecutive coding turns work.
7. Streaming works.
8. Stop works.
9. Approval works when supported.
10. Diff works when supported.
11. Gateway restart preserves bindings.
12. Temporary T3 disconnect recovers.
13. Unknown additive T3 events do not crash normal operation.
14. Credentials never appear in logs.
15. Compatibility CI detects protocol regression.
16. Telegram package contains no raw T3 RPC business logic.
17. README clearly describes the project as an independent unofficial external T3Code client/gateway.

---

# 70. Engineering Red Lines

Codex must reject shortcuts violating:

```text
NO T3Code fork

NO T3Code patch

NO @t3tools/* import

NO complete T3 contracts copy

NO T3 SQLite/database access

NO T3 private filesystem dependency

NO T3 UI/DOM automation

NO direct Codex/Claude/OpenCode control

NO raw T3 RPC calls from Telegram handlers

NO unconditional auto-approval

NO blind retry of ambiguous mutating RPC
```

Allowed:

```text
YES inspect T3 source

YES inspect T3 docs

YES clone upstream in CI

YES reverse/document current external wire protocol

YES small adapter-owned schemas

YES compatibility shims

YES fixture captures

YES real black-box T3 tests
```

---

# 71. First Codex Task

Do **not** begin by implementing Telegram commands.

First create:

```text
docs/protocol-notes.md

packages/adapter-t3/src/discovery/*

packages/adapter-t3/src/auth/*

packages/adapter-t3/src/rpc/*

tests/fixtures/t3/<observed-version>/*

scripts/inspect-t3.ts
```

`docs/protocol-notes.md` must answer, using captured/sanitized evidence:

```text
1. exact environment descriptor shape used

2. current external-client auth bootstrap flow

3. WebSocket ticket request

4. exact WebSocket URL

5. WebSocket framing

6. safe read RPC framing

7. subscription RPC framing

8. create-thread payload

9. start-turn payload

10. interrupt payload

11. approval request representation

12. approval response representation

13. diff request/response representation

14. sequence/resume semantics

15. unknown RPC behavior

16. insufficient-scope behavior
```

Do not infer or guess Effect RPC framing.

Observe:

```text
current upstream source
+
live disposable T3 server
```

Capture fixtures.

Then implement the native gateway protocol subset from those observations.

---

# 72. Protocol Research Method

Codex should use upstream source only as documentation/reference.

Recommended process:

```text
locate descriptor implementation
       ↓
locate environment auth implementation
       ↓
locate WebSocket ticket implementation
       ↓
locate RPC server declaration
       ↓
locate current orchestration methods
       ↓
locate command schemas
       ↓
locate thread event schemas
       ↓
run disposable T3 server
       ↓
observe traffic/requests
       ↓
capture sanitized fixtures
       ↓
implement gateway-owned narrow schemas
```

Do not automatically copy upstream TypeScript definitions.

---

# 73. Desired Protocol Notes Style

For each operation document:

```text
Operation:
Create thread

Observed T3:
<version / commit>

Transport:
WebSocket RPC

Method:
<current wire method>

Request:
<sanitized JSON/frame>

Response:
<sanitized JSON/frame>

Gateway normalization:
CreateThreadInput
→
ThreadSummary

Compatibility concerns:
<notes>
```

This file becomes the maintainer reference when upstream changes.

---

# 74. Product Direction After MVP

Internal architecture should make this possible:

```text
                  gateway-core
                       │
         ┌─────────────┴─────────────┐
         │                           │
     frontends                   backends
         │                           │
 Telegram                       T3Code
 Discord                        future adapter
 Slack
 Web
```

But do not prematurely build a generic platform.

The product being shipped now is:

> A reliable Telegram-native remote vibe-coding client for existing T3Code environments and threads, implemented entirely as an external companion that tracks T3Code upstream without carrying a fork.