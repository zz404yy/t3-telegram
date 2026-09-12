export type CapabilityState =
  | { state: "supported" }
  | { state: "unsupported"; reason?: string }
  | { state: "degraded"; reason: string }
  | { state: "unknown"; reason?: string };

export interface BackendCapabilities {
  projectsList: CapabilityState;
  projectCreate: CapabilityState;
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

export type BackendConnectionState =
  | "disconnected"
  | "connecting"
  | "auth_required"
  | "connected"
  | "degraded"
  | "incompatible"
  | "offline";

export interface BackendConnectionStatus {
  state: BackendConnectionState;
  message?: string;
  connectedAt?: string;
}

export interface BackendInfo {
  environmentId: string;
  label: string;
  baseUrl: string;
  serverVersion?: string;
  protocolFingerprint?: string;
  status: BackendConnectionStatus;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface ProjectSummary {
  id: string;
  title: string;
  workspaceRoot?: string;
  defaultModelSelection?: ModelSelection | null;
}

export interface CreateProjectInput {
  environmentId: string;
  title: string;
  workspaceRoot: string;
  createWorkspaceRootIfMissing?: boolean;
}

export interface ProviderModelSummary {
  slug: string;
  name: string;
  isDefault?: boolean;
  isLegacy?: boolean;
}

export interface ModelProviderSummary {
  instanceId: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  status: string;
  requiresNewThreadForModelChange?: boolean;
  models: ProviderModelSummary[];
}

export interface SetProjectDefaultModelInput {
  environmentId: string;
  projectId: string;
  modelSelection: ModelSelection;
}

export type SupportedThreadRuntimeMode =
  "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type ThreadRuntimeMode = SupportedThreadRuntimeMode | (string & {});
export type ThreadInteractionMode = "default" | "plan" | string;

export interface SetThreadModelInput {
  environmentId: string;
  threadId: string;
  modelSelection: ModelSelection;
}

export interface SetThreadRuntimeModeInput {
  environmentId: string;
  threadId: string;
  runtimeMode: SupportedThreadRuntimeMode;
}

export interface ThreadSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt?: string;
  archived: boolean;
  runtimeMode?: ThreadRuntimeMode;
  interactionMode?: ThreadInteractionMode;
  modelSelection?: ModelSelection;
  latestTurn?: {
    id: string;
    state: "running" | "interrupted" | "completed" | "error" | string;
  } | null;
}

export interface ThreadHistoryMessage {
  id?: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
}

export interface GetThreadHistoryInput {
  environmentId: string;
  threadId: string;
}

export interface ApprovalOption {
  decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";
  label: string;
  warning?: string;
}

export interface ApprovalRequest {
  requestId: string;
  kind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "unknown";
  title: string;
  detail?: string;
  appName?: string;
  options: ApprovalOption[];
}

export interface ChangedFileSummary {
  path: string;
  kind?: string;
  additions: number;
  deletions: number;
}

type ThreadEventPayload =
  | { type: "subscription.synchronized" }
  | { type: "turn.started"; threadId: string; turnId?: string; sequence?: number }
  | { type: "assistant.delta"; text: string; messageId?: string; sequence?: number }
  | { type: "assistant.message"; text: string; messageId?: string; sequence?: number }
  | { type: "activity"; title: string; detail?: string; sequence?: number }
  | { type: "tool.started"; label: string; detail?: string; sequence?: number }
  | { type: "tool.finished"; label: string; ok: boolean; detail?: string; sequence?: number }
  | { type: "approval.requested"; request: ApprovalRequest; sequence?: number }
  | { type: "files.changed"; files: ChangedFileSummary[]; sequence?: number }
  | {
      type: "turn.completed";
      status: "success" | "failed" | "cancelled";
      turnId?: string;
      sequence?: number;
    }
  | { type: "usage.updated"; inputTokens?: number; outputTokens?: number; sequence?: number }
  | { type: "warning"; message: string; sequence?: number }
  | { type: "unknown"; rawType?: string; sequence?: number };

export type ThreadEvent = ThreadEventPayload & {
  /** Monotonic upstream event cursor. */
  sequence?: number;
  /** Present when the event was reconstructed from a recovery snapshot. */
  snapshotSequence?: number;
};

export interface DiffSummary {
  diff: string;
  files: ChangedFileSummary[];
  additions: number;
  deletions: number;
  fromTurnCount?: number;
  toTurnCount?: number;
}

export interface ListThreadsInput {
  environmentId: string;
  projectId?: string;
  query?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface CreateThreadInput {
  environmentId: string;
  projectId: string;
  title: string;
  modelSelection?: ModelSelection;
  runtimeMode?: ThreadRuntimeMode;
  interactionMode?: ThreadInteractionMode;
}

export interface RenameThreadInput {
  environmentId: string;
  threadId: string;
  title: string;
}

export interface ArchiveThreadInput {
  environmentId: string;
  threadId: string;
}

export interface StartTurnInput {
  environmentId: string;
  threadId: string;
  text: string;
  idempotencyKey: string;
}

export interface StartTurnResult {
  accepted: true;
  sequence: number;
  commandId: string;
  messageId: string;
}

export interface InterruptTurnInput {
  environmentId: string;
  threadId: string;
  turnId?: string;
}

export interface SubscribeThreadInput {
  environmentId: string;
  threadId: string;
  afterSequence?: number;
  signal?: AbortSignal;
}

export interface ApprovalResponseInput {
  environmentId: string;
  threadId: string;
  requestId: string;
  decision: ApprovalOption["decision"];
}

export interface GetTurnDiffInput {
  environmentId: string;
  threadId: string;
  fromTurnCount: number;
  toTurnCount: number;
}

export interface GetThreadDiffInput {
  environmentId: string;
  threadId: string;
  toTurnCount?: number;
}

export interface EnvironmentRecord {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  credential?: string;
  credentialType?: string;
  credentialExpiresAt?: string;
  serverVersion?: string;
  protocolFingerprint?: string;
  status: BackendConnectionState;
  lastSeenAt?: string;
}

export interface BindingRecord {
  id: string;
  userId: string;
  telegramChatId: string;
  telegramThreadId?: string;
  environmentId: string;
  t3ProjectId?: string;
  t3ThreadId: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSubscriptionState {
  environmentId: string;
  t3ThreadId: string;
  lastSequence?: number;
  lastCompletedTurnId?: string;
  updatedAt: string;
}

export interface PendingApprovalRecord {
  id: string;
  bindingId: string;
  t3RequestId: string;
  telegramMessageId?: string;
  status: "pending" | "processing" | "resolved" | "expired";
  options: ApprovalOption[];
  expiresAt?: string;
  createdAt: string;
}

export type AuthStep =
  | { type: "open_url"; url: string; label: string }
  | { type: "enter_code"; prompt: string }
  | { type: "enter_token"; prompt: string }
  | { type: "completed" }
  | { type: "failed"; reason: string };
