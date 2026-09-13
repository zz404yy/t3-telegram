import { randomUUID } from "node:crypto";
import type {
  ApprovalResponseInput,
  ArchiveThreadInput,
  BackendCapabilities,
  BackendConnectionStatus,
  BackendInfo,
  CodingBackend,
  CreateProjectInput,
  CreateThreadInput,
  DiffSummary,
  EnvironmentConnector,
  EnvironmentRecord,
  GatewayRepository,
  GetThreadDiffInput,
  GetThreadHistoryInput,
  GetTurnDiffInput,
  InterruptTurnInput,
  ListThreadsInput,
  ModelProviderSummary,
  PairEnvironmentInput,
  PairEnvironmentResult,
  ProjectSummary,
  RenameThreadInput,
  StartTurnInput,
  StartTurnResult,
  SetProjectDefaultModelInput,
  SetThreadModelInput,
  SetThreadRuntimeModeInput,
  SubscribeThreadInput,
  ThreadEvent,
  ThreadHistoryMessage,
  ThreadSummary,
  UserInputResponseInput,
} from "@t3-vibe/core";
import { GatewayError } from "@t3-vibe/core";
import { BearerAuthStrategy } from "./auth/BearerAuthStrategy.js";
import type { T3Credential } from "./auth/types.js";
import { T3DiscoveryClient } from "./discovery/T3DiscoveryClient.js";
import { summarizeUnifiedDiff } from "./normalizers/diff.js";
import { normalizeThreadStreamItem, threadStreamItemThreadId } from "./normalizers/events.js";
import {
  DispatchResultSchema,
  ShellSnapshotSchema,
  ThreadSnapshotSchema,
  type ShellSnapshot,
  type T3EnvironmentDescriptor,
} from "./protocol/schemas.js";
import { T3_PROTOCOL_FINGERPRINT } from "./protocol/profile.js";
import { EffectJsonRpcTransport } from "./rpc/EffectJsonRpcTransport.js";

const RPC = {
  dispatch: "orchestration.dispatchCommand",
  turnDiff: "orchestration.getTurnDiff",
  threadDiff: "orchestration.getFullThreadDiff",
  searchThreads: "orchestration.searchThreads",
  archivedShell: "orchestration.getArchivedShellSnapshot",
  subscribeThread: "orchestration.subscribeThread",
  serverConfig: "server.getConfig",
} as const;

interface Connection {
  descriptor: T3EnvironmentDescriptor;
  auth: BearerAuthStrategy;
  rpc: EffectJsonRpcTransport;
  status: BackendConnectionStatus;
  capabilities: BackendCapabilities;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function modelSelection(value: unknown): ProjectSummary["defaultModelSelection"] {
  if (value === null) return null;
  const item = record(value);
  const instanceId = string(item?.instanceId);
  const model = string(item?.model);
  if (!instanceId || !model) return undefined;
  return {
    instanceId,
    model,
    ...(record(item?.options) ? { options: record(item?.options)! } : {}),
  };
}

function projectSummary(value: Record<string, unknown>): ProjectSummary | undefined {
  const id = string(value.id);
  const title = string(value.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    ...(string(value.workspaceRoot) ? { workspaceRoot: string(value.workspaceRoot)! } : {}),
    ...(Object.hasOwn(value, "defaultModelSelection")
      ? { defaultModelSelection: modelSelection(value.defaultModelSelection) ?? null }
      : {}),
  };
}

function threadSummary(value: Record<string, unknown>): ThreadSummary | undefined {
  const id = string(value.id);
  const projectId = string(value.projectId);
  const title = string(value.title);
  if (!id || !projectId || !title) return undefined;
  const latest = record(value.latestTurn);
  const latestId = string(latest?.turnId);
  const latestState = string(latest?.state);
  const selection = modelSelection(value.modelSelection);
  return {
    id,
    projectId,
    title,
    archived: value.archivedAt !== null && value.archivedAt !== undefined,
    ...(string(value.updatedAt) ? { updatedAt: string(value.updatedAt)! } : {}),
    ...(string(value.runtimeMode) ? { runtimeMode: string(value.runtimeMode)! } : {}),
    ...(string(value.interactionMode) ? { interactionMode: string(value.interactionMode)! } : {}),
    ...(selection && selection !== null ? { modelSelection: selection } : {}),
    ...(latestId && latestState
      ? { latestTurn: { id: latestId, state: latestState } }
      : { latestTurn: null }),
  };
}

const supported = { state: "supported" } as const;
const unknown = (reason: string) => ({ state: "unknown" as const, reason });
const degradedMutation = {
  state: "degraded",
  reason: "RPC dispatch is available; this command is confirmed after its first success",
} as const;

export class T3Backend implements CodingBackend, EnvironmentConnector {
  private readonly connections = new Map<string, Connection>();
  private readonly connectionAttempts = new Map<string, Promise<BackendConnectionStatus>>();

  constructor(
    private readonly repository: GatewayRepository,
    private readonly discovery: T3DiscoveryClient,
  ) {}

  async pair(input: PairEnvironmentInput): Promise<PairEnvironmentResult> {
    const discovered = await this.discovery.discover(input.baseUrl);
    const methods = discovered.auth.auth?.sessionMethods ?? [];
    if (!methods.includes("bearer-access-token")) {
      throw new GatewayError(
        "T3 does not advertise bearer access tokens",
        "unsupported_auth_strategy",
        "该 T3 环境未提供网关支持的 Bearer 外部客户端认证。",
      );
    }
    const auth = new BearerAuthStrategy();
    const credential = await auth.authenticate({
      baseUrl: discovered.baseUrl,
      credential: input.bootstrapCredential,
    });
    const environment = this.repository.saveEnvironment({
      userId: input.userId,
      name: input.name ?? discovered.descriptor.label,
      baseUrl: discovered.baseUrl,
      credential: credential.accessToken,
      credentialType: credential.type,
      ...(credential.expiresAt ? { credentialExpiresAt: credential.expiresAt } : {}),
      serverVersion: discovered.descriptor.serverVersion,
      protocolFingerprint: T3_PROTOCOL_FINGERPRINT,
      status: "disconnected",
    });
    const status = await this.connect(environment.id);
    return { environment: this.repository.getEnvironment(environment.id) ?? environment, status };
  }

  async connect(environmentId: string): Promise<BackendConnectionStatus> {
    const inFlight = this.connectionAttempts.get(environmentId);
    if (inFlight) return inFlight;
    const attempt = this.connectOnce(environmentId);
    this.connectionAttempts.set(environmentId, attempt);
    try {
      return await attempt;
    } finally {
      this.connectionAttempts.delete(environmentId);
    }
  }

  private async connectOnce(environmentId: string): Promise<BackendConnectionStatus> {
    const existing = this.connections.get(environmentId);
    if (existing?.rpc.isOpen()) return existing.status;
    const environment = this.requireEnvironment(environmentId);
    if (!environment.credential || environment.credentialType !== "bearer") {
      return this.setStatus(environment, {
        state: "auth_required",
        message: "Pairing credential required",
      });
    }
    if (
      environment.credentialExpiresAt &&
      Date.parse(environment.credentialExpiresAt) <= Date.now()
    ) {
      return this.setStatus(environment, {
        state: "auth_required",
        message: "Access token expired",
      });
    }
    this.setStatus(environment, { state: "connecting" });
    let attemptedRpc: EffectJsonRpcTransport | undefined;
    try {
      const discovered = await this.discovery.discover(environment.baseUrl);
      const credential: T3Credential = {
        type: "bearer",
        accessToken: environment.credential,
        scopes: ["orchestration:read", "orchestration:operate"],
        ...(environment.credentialExpiresAt ? { expiresAt: environment.credentialExpiresAt } : {}),
      };
      const auth = new BearerAuthStrategy(credential);
      const ticket = await auth.issueWebSocketTicket(environment.baseUrl);
      const socketUrl = new URL(environment.baseUrl);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.pathname = "/ws";
      socketUrl.searchParams.set("wsTicket", ticket);
      socketUrl.searchParams.set("clientSurface", "web");
      socketUrl.searchParams.set("clientAppVersion", "0.1.0");
      socketUrl.searchParams.set("clientDeviceType", "unknown");
      socketUrl.searchParams.set("connectionMethod", "direct");
      const rpc = new EffectJsonRpcTransport(socketUrl.toString());
      attemptedRpc = rpc;
      await rpc.open();
      await rpc.request(RPC.searchThreads, { query: "__t3_gateway_probe__", limit: 1 }, 10_000);
      const candidate: Connection = {
        descriptor: discovered.descriptor,
        auth,
        rpc,
        status: { state: "connecting" },
        capabilities: this.unknownCapabilities("Capability probe has not completed"),
      };
      ShellSnapshotSchema.parse(
        await this.authorizedFetch(
          candidate,
          new URL("/api/orchestration/shell", environment.baseUrl),
        ),
      );
      const [dispatch, diffTurn, diffThread, streaming] = await Promise.all([
        this.probeUnaryMethod(rpc, RPC.dispatch, {}),
        this.probeUnaryMethod(rpc, RPC.turnDiff, {}),
        this.probeUnaryMethod(rpc, RPC.threadDiff, {}),
        this.probeStreamMethod(rpc, RPC.subscribeThread, {}),
      ]);
      const mutableCapability = dispatch
        ? degradedMutation
        : unknown("The command dispatch RPC was not detected");
      candidate.capabilities = {
        projectsList: supported,
        projectCreate: mutableCapability,
        threadsList: supported,
        threadCreate: mutableCapability,
        threadAttach: supported,
        turnStart: mutableCapability,
        turnInterrupt: mutableCapability,
        streaming: streaming ? supported : unknown("The thread subscription RPC was not detected"),
        approval: mutableCapability,
        diffTurn: diffTurn ? supported : unknown("The turn diff RPC was not detected"),
        diffThread: diffThread ? supported : unknown("The thread diff RPC was not detected"),
        renameThread: mutableCapability,
        archiveThread: mutableCapability,
        resumeSubscription: streaming
          ? {
              state: "degraded",
              reason: "Subscription is available; cursor resume is confirmed after first use",
            }
          : unknown("The thread subscription RPC was not detected"),
      };
      const degradationReasons = [
        ...(discovered.descriptor.serverVersion.startsWith("0.0.40")
          ? []
          : [`unverified T3 version ${discovered.descriptor.serverVersion}`]),
        ...(dispatch ? [] : ["command dispatch RPC not detected"]),
        ...(streaming ? [] : ["thread subscription RPC not detected"]),
      ];
      const status: BackendConnectionStatus = {
        state: degradationReasons.length === 0 ? "connected" : "degraded",
        ...(degradationReasons.length ? { message: degradationReasons.join("; ") } : {}),
        connectedAt: new Date().toISOString(),
      };
      candidate.status = status;
      this.connections.set(environmentId, candidate);
      environment.serverVersion = discovered.descriptor.serverVersion;
      environment.protocolFingerprint = T3_PROTOCOL_FINGERPRINT;
      environment.lastSeenAt = new Date().toISOString();
      this.setStatus(environment, status);
      return status;
    } catch (cause) {
      await attemptedRpc?.close();
      this.connections.delete(environmentId);
      const status: BackendConnectionStatus =
        cause instanceof GatewayError && ["t3_auth_failed", "auth_required"].includes(cause.code)
          ? { state: "auth_required", message: cause.safeMessage }
          : {
              state: "offline",
              message: cause instanceof Error ? cause.message : "Connection failed",
            };
      this.setStatus(environment, status);
      return status;
    }
  }

  async disconnect(environmentId: string): Promise<void> {
    const connection = this.connections.get(environmentId);
    this.connections.delete(environmentId);
    await connection?.rpc.close();
    const environment = this.repository.getEnvironment(environmentId);
    if (environment) this.setStatus(environment, { state: "disconnected" });
  }

  async getInfo(environmentId: string): Promise<BackendInfo> {
    const environment = this.requireEnvironment(environmentId);
    return {
      environmentId,
      label: environment.name,
      baseUrl: environment.baseUrl,
      status: this.connections.get(environmentId)?.status ?? { state: environment.status },
      ...(environment.serverVersion ? { serverVersion: environment.serverVersion } : {}),
      ...(environment.protocolFingerprint
        ? { protocolFingerprint: environment.protocolFingerprint }
        : {}),
    };
  }

  async getCapabilities(environmentId: string): Promise<BackendCapabilities> {
    const connection = this.connections.get(environmentId);
    if (!connection?.rpc.isOpen()) {
      return this.unknownCapabilities("T3 environment is not connected");
    }
    return connection.capabilities;
  }

  async listProjects(environmentId: string): Promise<ProjectSummary[]> {
    const shell = await this.getShell(environmentId);
    return shell.projects.flatMap((item) => {
      const project = projectSummary(item);
      return project ? [project] : [];
    });
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSummary> {
    const connection = await this.requireConnection(input.environmentId);
    const title = input.title.trim();
    const workspaceRoot = input.workspaceRoot.trim();
    if (!title || !workspaceRoot) {
      throw new GatewayError(
        "Project title and workspace root are required",
        "invalid_project_input",
        "项目名称和工作区路径不能为空。",
      );
    }
    const projectId = randomUUID();
    await connection.rpc.request(RPC.dispatch, {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing ?? true,
      createdAt: new Date().toISOString(),
    });
    connection.capabilities.projectCreate = supported;
    return { id: projectId, title, workspaceRoot, defaultModelSelection: null };
  }

  async listModelProviders(environmentId: string): Promise<ModelProviderSummary[]> {
    const connection = await this.requireConnection(environmentId);
    const result = record(await connection.rpc.request(RPC.serverConfig, {}));
    const providers = Array.isArray(result?.providers) ? result.providers : [];
    return providers.flatMap((value) => {
      const provider = record(value);
      const instanceId = string(provider?.instanceId);
      if (!provider || !instanceId) return [];
      const displayName = string(provider.displayName) ?? string(provider.driver) ?? instanceId;
      const models = Array.isArray(provider.models)
        ? provider.models.flatMap((entry) => {
            const model = record(entry);
            const slug = string(model?.slug);
            const name = string(model?.name);
            if (!slug || !name) return [];
            return [
              {
                slug,
                name,
                ...(model?.isDefault === true ? { isDefault: true } : {}),
                ...(model?.isLegacy === true ? { isLegacy: true } : {}),
              },
            ];
          })
        : [];
      return [
        {
          instanceId,
          displayName,
          enabled: provider.enabled === true,
          installed: provider.installed === true,
          status: string(provider.status) ?? "unknown",
          ...(provider.requiresNewThreadForModelChange === true
            ? { requiresNewThreadForModelChange: true }
            : {}),
          models,
        },
      ];
    });
  }

  async setProjectDefaultModel(input: SetProjectDefaultModelInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    const provider = (await this.listModelProviders(input.environmentId)).find(
      (item) => item.instanceId === input.modelSelection.instanceId,
    );
    if (
      !provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      !provider.models.some((model) => model.slug === input.modelSelection.model)
    ) {
      throw new GatewayError(
        "Selected model is unavailable",
        "model_unavailable",
        "所选模型当前不可用，请刷新模型列表后重试。",
      );
    }
    DispatchResultSchema.parse(
      await connection.rpc.request(RPC.dispatch, {
        type: "project.meta.update",
        commandId: randomUUID(),
        projectId: input.projectId,
        defaultModelSelection: input.modelSelection,
      }),
    );
  }

  async setThreadModel(input: SetThreadModelInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    const thread = await this.getThread(input.environmentId, input.threadId);
    if (!thread) {
      throw new GatewayError(
        "Thread not found",
        "thread_not_found",
        "绑定的 T3 线程不存在或已归档。",
      );
    }
    const providers = await this.listModelProviders(input.environmentId);
    const provider = providers.find((item) => item.instanceId === input.modelSelection.instanceId);
    if (
      !provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.status !== "ready" ||
      !provider.models.some((model) => model.slug === input.modelSelection.model)
    ) {
      throw new GatewayError(
        "Selected model is unavailable",
        "model_unavailable",
        "所选模型当前不可用，请刷新模型列表后重试。",
      );
    }
    const currentProvider = providers.find(
      (item) => item.instanceId === thread.modelSelection?.instanceId,
    );
    const changed =
      thread.modelSelection?.instanceId !== input.modelSelection.instanceId ||
      thread.modelSelection.model !== input.modelSelection.model;
    if (
      changed &&
      thread.latestTurn !== null &&
      (currentProvider?.requiresNewThreadForModelChange === true ||
        provider.requiresNewThreadForModelChange === true)
    ) {
      throw new GatewayError(
        "Provider requires a new thread for model changes",
        "thread_model_change_requires_new_thread",
        "这个 Provider 不支持在已有会话中切换模型。请新建线程后选择该模型。",
      );
    }
    DispatchResultSchema.parse(
      await connection.rpc.request(RPC.dispatch, {
        type: "thread.meta.update",
        commandId: randomUUID(),
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      }),
    );
  }

  async setThreadRuntimeMode(input: SetThreadRuntimeModeInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    const supportedModes = new Set([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    if (!supportedModes.has(input.runtimeMode)) {
      throw new GatewayError(
        `Unsupported runtime mode: ${input.runtimeMode}`,
        "invalid_runtime_mode",
        "不支持该权限模式，请刷新线程设置后重试。",
      );
    }
    DispatchResultSchema.parse(
      await connection.rpc.request(RPC.dispatch, {
        type: "thread.runtime-mode.set",
        commandId: randomUUID(),
        threadId: input.threadId,
        runtimeMode: input.runtimeMode,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async listThreads(input: ListThreadsInput): Promise<ThreadSummary[]> {
    const connection = await this.requireConnection(input.environmentId);
    const shell = await this.getShell(input.environmentId);
    const rawThreads = [...shell.threads];
    if (input.includeArchived) {
      const archived = ShellSnapshotSchema.parse(
        await connection.rpc.request(RPC.archivedShell, {}),
      );
      rawThreads.push(...archived.threads);
    }
    let threads = rawThreads.flatMap((item) => {
      const thread = threadSummary(item);
      return thread ? [thread] : [];
    });
    if (input.projectId) threads = threads.filter((thread) => thread.projectId === input.projectId);
    if (input.query && input.query.trim().length >= 2) {
      const result = record(
        await connection.rpc.request(RPC.searchThreads, {
          query: input.query.trim(),
          limit: Math.min(input.limit ?? 20, 50),
        }),
      );
      const ids = new Set(
        (Array.isArray(result?.matches) ? result.matches : []).flatMap((match) => {
          const id = string(record(match)?.threadId);
          return id ? [id] : [];
        }),
      );
      threads = threads.filter((thread) => ids.has(thread.id));
    }
    threads.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return threads.slice(0, input.limit ?? 20);
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const connection = await this.requireConnection(input.environmentId);
    const projects = await this.listProjects(input.environmentId);
    const project = projects.find((item) => item.id === input.projectId);
    if (!project)
      throw new GatewayError("Project not found", "project_not_found", "找不到该 T3 项目。");
    const selection = input.modelSelection ?? project.defaultModelSelection;
    if (!selection) {
      throw new GatewayError(
        "Project has no default model",
        "model_selection_required",
        "该项目没有默认模型；请先在 T3 中设置项目默认模型。",
      );
    }
    const threadId = randomUUID();
    const now = new Date().toISOString();
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.create",
      commandId: randomUUID(),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: selection,
      runtimeMode: input.runtimeMode ?? "auto",
      interactionMode: input.interactionMode ?? "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
    connection.capabilities.threadCreate = supported;
    return {
      id: threadId,
      projectId: input.projectId,
      title: input.title,
      archived: false,
      updatedAt: now,
      modelSelection: selection,
      runtimeMode: input.runtimeMode ?? "auto",
      interactionMode: input.interactionMode ?? "default",
      latestTurn: null,
    };
  }

  async renameThread(input: RenameThreadInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.meta.update",
      commandId: randomUUID(),
      threadId: input.threadId,
      title: input.title,
    });
    connection.capabilities.renameThread = supported;
  }

  async archiveThread(input: ArchiveThreadInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.archive",
      commandId: randomUUID(),
      threadId: input.threadId,
    });
    connection.capabilities.archiveThread = supported;
  }

  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    const connection = await this.requireConnection(input.environmentId);
    const thread = await this.getThread(input.environmentId, input.threadId);
    if (!thread)
      throw new GatewayError(
        "Thread not found",
        "thread_not_found",
        "绑定的 T3 线程不存在或已归档。",
      );
    const commandId = randomUUID();
    const messageId = randomUUID();
    const result = DispatchResultSchema.parse(
      await connection.rpc.request(RPC.dispatch, {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: { messageId, role: "user", text: input.text, attachments: [] },
        ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
        runtimeMode: thread.runtimeMode ?? "auto",
        interactionMode: thread.interactionMode ?? "default",
        createdAt: new Date().toISOString(),
      }),
    );
    connection.capabilities.turnStart = supported;
    return { accepted: true, sequence: result.sequence, commandId, messageId };
  }

  async interruptTurn(input: InterruptTurnInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.turn.interrupt",
      commandId: randomUUID(),
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: new Date().toISOString(),
    });
    connection.capabilities.turnInterrupt = supported;
  }

  async *subscribeThread(input: SubscribeThreadInput): AsyncIterable<ThreadEvent> {
    let cursor = input.afterSequence;
    let retry = 0;
    while (!input.signal?.aborted) {
      try {
        const connection = await this.requireConnection(input.environmentId);
        const resumedFromCursor = cursor !== undefined;
        const stream = connection.rpc.stream(
          RPC.subscribeThread,
          {
            threadId: input.threadId,
            ...(cursor === undefined ? {} : { afterSequence: cursor }),
            requestCompletionMarker: true,
            turnLimit: 10,
          },
          input.signal,
        );
        for await (const item of stream) {
          connection.capabilities.streaming = supported;
          if (resumedFromCursor) connection.capabilities.resumeSubscription = supported;
          const sourceThreadId = threadStreamItemThreadId(item);
          if (sourceThreadId && sourceThreadId !== input.threadId) continue;
          const snapshotSequence = record(record(item)?.snapshot)?.snapshotSequence;
          for (const event of normalizeThreadStreamItem(item)) {
            if (event.sequence !== undefined) {
              if (cursor !== undefined && event.sequence <= cursor) continue;
              cursor = event.sequence;
            }
            retry = 0;
            yield event.type === "subscription.synchronized" && cursor !== undefined
              ? { ...event, sequence: cursor }
              : event;
          }
          if (
            typeof snapshotSequence === "number" &&
            (cursor === undefined || snapshotSequence > cursor)
          ) {
            cursor = snapshotSequence;
          }
        }
        return;
      } catch (error) {
        if (input.signal?.aborted) return;
        if (
          error instanceof GatewayError &&
          ["t3_auth_failed", "auth_required", "t3_rpc_failure"].includes(error.code)
        ) {
          throw error;
        }
        const connection = this.connections.get(input.environmentId);
        this.connections.delete(input.environmentId);
        await connection?.rpc.close();
        yield {
          type: "warning",
          message: "T3 连接中断，正在从已确认的事件序号恢复…",
          ...(cursor === undefined ? {} : { sequence: cursor }),
        };
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retry++, 5));
        await this.abortableDelay(delay + Math.floor(Math.random() * 250), input.signal);
      }
    }
  }

  async respondToApproval(input: ApprovalResponseInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.approval.respond",
      commandId: randomUUID(),
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
      createdAt: new Date().toISOString(),
    });
    connection.capabilities.approval = supported;
  }

  async respondToUserInput(input: UserInputResponseInput): Promise<void> {
    const connection = await this.requireConnection(input.environmentId);
    await connection.rpc.request(RPC.dispatch, {
      type: "thread.user-input.respond",
      commandId: randomUUID(),
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
      createdAt: new Date().toISOString(),
    });
  }

  async getTurnDiff(input: GetTurnDiffInput): Promise<DiffSummary> {
    const connection = await this.requireConnection(input.environmentId);
    const result = record(
      await connection.rpc.request(RPC.turnDiff, {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        ignoreWhitespace: true,
      }),
    );
    return summarizeUnifiedDiff(string(result?.diff) ?? "", {
      fromTurnCount: input.fromTurnCount,
      toTurnCount: input.toTurnCount,
    });
  }

  async getThreadDiff(input: GetThreadDiffInput): Promise<DiffSummary> {
    const connection = await this.requireConnection(input.environmentId);
    const toTurnCount =
      input.toTurnCount ??
      (await this.latestCheckpointTurnCount(input.environmentId, input.threadId));
    if (toTurnCount === undefined) {
      return summarizeUnifiedDiff("");
    }
    const result = record(
      await connection.rpc.request(RPC.threadDiff, {
        threadId: input.threadId,
        toTurnCount,
        ignoreWhitespace: true,
      }),
    );
    return summarizeUnifiedDiff(string(result?.diff) ?? "", {
      fromTurnCount: 0,
      toTurnCount,
    });
  }

  async getThreadHistory(input: GetThreadHistoryInput): Promise<ThreadHistoryMessage[]> {
    const connection = await this.requireConnection(input.environmentId);
    const snapshot = ThreadSnapshotSchema.parse(
      await this.authorizedFetch(
        connection,
        new URL(
          `/api/orchestration/threads/${encodeURIComponent(input.threadId)}`,
          this.requireEnvironment(input.environmentId).baseUrl,
        ),
      ),
    );
    const messages = record(snapshot.thread)?.messages;
    if (!Array.isArray(messages)) return [];
    return messages.flatMap((value) => {
      const message = record(value);
      if (!message) return [];
      const role = message?.role;
      const text = string(message?.text);
      if ((role !== "user" && role !== "assistant") || !text) return [];
      return [
        {
          role,
          text,
          ...(string(message.id) ? { id: string(message.id)! } : {}),
          ...(string(message.turnId) ? { turnId: string(message.turnId)! } : {}),
          ...(string(message.createdAt)
            ? { createdAt: string(message.createdAt)! }
            : string(message.timestamp)
              ? { createdAt: string(message.timestamp)! }
              : {}),
        } satisfies ThreadHistoryMessage,
      ];
    });
  }

  async latestCheckpointTurnCount(
    environmentId: string,
    threadId: string,
  ): Promise<number | undefined> {
    const connection = await this.requireConnection(environmentId);
    const snapshot = ThreadSnapshotSchema.parse(
      await this.authorizedFetch(
        connection,
        new URL(
          `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
          this.requireEnvironment(environmentId).baseUrl,
        ),
      ),
    );
    const checkpoints = record(snapshot.thread)?.checkpoints;
    if (!Array.isArray(checkpoints)) return undefined;
    return checkpoints.reduce<number | undefined>((max, checkpoint) => {
      const count = record(checkpoint)?.checkpointTurnCount;
      return typeof count === "number" && (max === undefined || count > max) ? count : max;
    }, undefined);
  }

  private async getThread(
    environmentId: string,
    threadId: string,
  ): Promise<ThreadSummary | undefined> {
    const threads = await this.listThreads({ environmentId, limit: 50 });
    return threads.find((thread) => thread.id === threadId);
  }

  private async getShell(environmentId: string): Promise<ShellSnapshot> {
    const connection = await this.requireConnection(environmentId);
    const environment = this.requireEnvironment(environmentId);
    return ShellSnapshotSchema.parse(
      await this.authorizedFetch(
        connection,
        new URL("/api/orchestration/shell", environment.baseUrl),
      ),
    );
  }

  private async authorizedFetch(connection: Connection, url: URL): Promise<unknown> {
    const init = await connection.auth.authorizeHttp({
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json", "user-agent": "t3-vibe-gateway/0.1" },
    });
    const response = await fetch(url, init);
    if (!response.ok)
      throw new GatewayError(
        `T3 HTTP ${response.status}`,
        "t3_http_error",
        `T3 请求失败（HTTP ${response.status}）。`,
      );
    return response.json();
  }

  private async requireConnection(environmentId: string): Promise<Connection> {
    let connection = this.connections.get(environmentId);
    if (!connection?.rpc.isOpen()) {
      const status = await this.connect(environmentId);
      if (status.state !== "connected" && status.state !== "degraded") {
        throw new GatewayError(
          status.message ?? "T3 unavailable",
          "t3_unavailable",
          "T3 环境当前不可用，请用 /status 检查。",
        );
      }
      connection = this.connections.get(environmentId);
    }
    if (!connection)
      throw new GatewayError("T3 connection unavailable", "t3_unavailable", "T3 环境当前不可用。");
    return connection;
  }

  private requireEnvironment(environmentId: string): EnvironmentRecord {
    const environment = this.repository.getEnvironment(environmentId);
    if (!environment)
      throw new GatewayError(
        "Environment not found",
        "environment_not_found",
        "找不到该 T3 环境。",
      );
    return environment;
  }

  private setStatus(
    environment: EnvironmentRecord,
    status: BackendConnectionStatus,
  ): BackendConnectionStatus {
    environment.status = status.state;
    if (status.state === "connected" || status.state === "degraded")
      environment.lastSeenAt = new Date().toISOString();
    this.repository.updateEnvironment(environment);
    return status;
  }

  private unknownCapabilities(reason: string): BackendCapabilities {
    const state = unknown(reason);
    return {
      projectsList: state,
      projectCreate: state,
      threadsList: state,
      threadCreate: state,
      threadAttach: state,
      turnStart: state,
      turnInterrupt: state,
      streaming: state,
      approval: state,
      diffTurn: state,
      diffThread: state,
      renameThread: state,
      archiveThread: state,
      resumeSubscription: state,
    };
  }

  private async probeUnaryMethod(
    rpc: EffectJsonRpcTransport,
    method: string,
    payload: unknown,
  ): Promise<boolean> {
    try {
      await rpc.request(method, payload, 3_000);
      return true;
    } catch (error) {
      return this.isRecognizedProbeFailure(error);
    }
  }

  private async probeStreamMethod(
    rpc: EffectJsonRpcTransport,
    method: string,
    payload: unknown,
  ): Promise<boolean> {
    const controller = new AbortController();
    const iterator = rpc.stream(method, payload, controller.signal)[Symbol.asyncIterator]();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        iterator.next().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
    } catch (error) {
      return this.isRecognizedProbeFailure(error);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      await iterator.return?.();
    }
  }

  private isRecognizedProbeFailure(error: unknown): boolean {
    return (
      error instanceof GatewayError &&
      error.code === "t3_rpc_failure" &&
      !error.message.toLowerCase().includes("unknown request tag")
    );
  }

  private async abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => done();
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
