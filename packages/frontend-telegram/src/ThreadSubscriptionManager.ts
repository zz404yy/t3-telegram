import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Logger } from "pino";
import type {
  ApprovalRequest,
  BindingRecord,
  BotLocale,
  ChangedFileSummary,
  CodingBackend,
  GatewayRepository,
  ThreadEvent,
  ThreadSubscriptionState,
  UserInputRequest,
} from "@t3-vibe/core";
import { renderDiffSummary } from "./renderers/text.js";
import { TelegramDraftStreamer } from "./streaming/TelegramDraftStreamer.js";
import { buildUserInputView } from "./userInput.js";

interface ThreadSubscriptionManagerOptions {
  api: Api;
  backend: CodingBackend;
  repository: GatewayRepository;
  logger: Logger;
  allowedUserIds: Set<string>;
  localeForUser?: (userId: string) => BotLocale;
  resubscribeDelayMs?: number;
}

interface Worker {
  environmentId: string;
  t3ThreadId: string;
  bindingSignature: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface DeliverySession {
  streamer: TelegramDraftStreamer;
  messages: Map<string, string>;
  finalMessageIds: Set<string>;
  fallback: string;
  finalFallback: string;
  files: ChangedFileSummary[];
  finalizing: boolean;
  completed: boolean;
}

function workerKey(environmentId: string, t3ThreadId: string): string {
  return `${environmentId}\u0000${t3ThreadId}`;
}

function signature(bindings: BindingRecord[]): string {
  return bindings
    .map((binding) => `${binding.id}:${binding.telegramChatId}:${binding.telegramThreadId ?? ""}`)
    .sort()
    .join("|");
}

function chatTarget(id: string): number | string {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : id;
}

function threadOptions(binding: BindingRecord): { message_thread_id?: number } {
  return binding.telegramThreadId ? { message_thread_id: Number(binding.telegramThreadId) } : {};
}

export class ThreadSubscriptionManager {
  private readonly workers = new Map<string, Worker>();
  private readonly sessions = new Map<string, DeliverySession>();
  private stopping = false;

  constructor(private readonly options: ThreadSubscriptionManagerOptions) {}

  /** Restore durable listeners without replaying a fresh snapshot to every destination. */
  start(): void {
    this.stopping = false;
    this.reconcile(false);
  }

  /** Reconcile after a binding mutation and snapshot an already-running newly attached thread. */
  sync(): void {
    if (this.stopping) return;
    this.reconcile(true);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const workers = [...this.workers.values()];
    workers.forEach((worker) => worker.controller.abort());
    await Promise.allSettled(workers.map((worker) => worker.promise));
    this.workers.clear();
    this.sessions.clear();
  }

  activeCount(): number {
    return this.workers.size;
  }

  private reconcile(forceSnapshotForChanges: boolean): void {
    const desired = new Map<
      string,
      { environmentId: string; t3ThreadId: string; bindingSignature: string }
    >();
    for (const binding of this.options.repository
      .listBindings()
      .filter((item) => this.options.allowedUserIds.has(item.telegramChatId))) {
      const key = workerKey(binding.environmentId, binding.t3ThreadId);
      const bindings = this.bindingsForThread(binding.environmentId, binding.t3ThreadId);
      desired.set(key, {
        environmentId: binding.environmentId,
        t3ThreadId: binding.t3ThreadId,
        bindingSignature: signature(bindings),
      });
    }

    for (const [key, worker] of this.workers) {
      const target = desired.get(key);
      if (!target || target.bindingSignature !== worker.bindingSignature) {
        worker.controller.abort();
        this.workers.delete(key);
      }
    }

    for (const [key, target] of desired) {
      if (this.workers.has(key)) continue;
      this.startWorker(
        key,
        target.environmentId,
        target.t3ThreadId,
        target.bindingSignature,
        forceSnapshotForChanges,
      );
    }
  }

  private startWorker(
    key: string,
    environmentId: string,
    t3ThreadId: string,
    bindingSignature: string,
    forceSnapshot: boolean,
  ): void {
    const controller = new AbortController();
    const worker: Worker = {
      environmentId,
      t3ThreadId,
      bindingSignature,
      controller,
      promise: Promise.resolve(),
    };
    worker.promise = this.runWorker(worker, forceSnapshot)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          this.options.logger.error(
            { err: error, environment_id: environmentId, t3_thread_id: t3ThreadId },
            "thread subscription stopped unexpectedly",
          );
      })
      .finally(() => {
        if (this.workers.get(key) === worker) this.workers.delete(key);
      });
    this.workers.set(key, worker);
  }

  private async runWorker(worker: Worker, forceSnapshot: boolean): Promise<void> {
    let checkpoint = this.options.repository.getThreadSubscriptionState(
      worker.environmentId,
      worker.t3ThreadId,
    );
    let firstObservation = checkpoint === undefined;
    let useCursor = !forceSnapshot;
    let retry = 0;

    while (!worker.controller.signal.aborted) {
      if (this.bindingsForThread(worker.environmentId, worker.t3ThreadId).length === 0) return;

      let snapshotEvents: ThreadEvent[] = [];
      let snapshotSequence: number | undefined;
      const flushSnapshot = async (): Promise<void> => {
        if (snapshotSequence === undefined) return;
        checkpoint = await this.processSnapshot(
          worker,
          snapshotEvents,
          snapshotSequence,
          checkpoint,
          firstObservation,
        );
        firstObservation = false;
        snapshotEvents = [];
        snapshotSequence = undefined;
      };

      try {
        for await (const event of this.options.backend.subscribeThread({
          environmentId: worker.environmentId,
          threadId: worker.t3ThreadId,
          ...(useCursor && checkpoint?.lastSequence !== undefined
            ? { afterSequence: checkpoint.lastSequence }
            : {}),
          signal: worker.controller.signal,
        })) {
          if (worker.controller.signal.aborted) return;
          if (event.snapshotSequence !== undefined) {
            if (snapshotSequence !== undefined && snapshotSequence !== event.snapshotSequence)
              await flushSnapshot();
            snapshotSequence = event.snapshotSequence;
            snapshotEvents.push(event);
            continue;
          }

          await flushSnapshot();
          if (event.type === "subscription.synchronized") {
            checkpoint = this.options.repository.saveThreadSubscriptionState({
              environmentId: worker.environmentId,
              t3ThreadId: worker.t3ThreadId,
              ...(event.sequence === undefined ? {} : { lastSequence: event.sequence }),
            });
            firstObservation = false;
            continue;
          }
          if (
            event.type === "turn.completed" &&
            event.turnId &&
            event.turnId === checkpoint?.lastCompletedTurnId
          ) {
            checkpoint = this.saveCheckpoint(worker, event, checkpoint);
            continue;
          }
          await this.deliverEvent(worker, event);
          checkpoint = this.saveCheckpoint(worker, event, checkpoint);
          retry = 0;
        }
        await flushSnapshot();
        useCursor = true;
        await this.delay(this.options.resubscribeDelayMs ?? 2_000, worker.controller.signal);
      } catch (error) {
        if (worker.controller.signal.aborted) return;
        this.options.logger.warn(
          {
            err: error,
            environment_id: worker.environmentId,
            t3_thread_id: worker.t3ThreadId,
          },
          "thread subscription failed; retrying",
        );
        useCursor = true;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retry++, 5));
        await this.delay(delay + Math.floor(Math.random() * 250), worker.controller.signal);
      }
    }
  }

  private async processSnapshot(
    worker: Worker,
    events: ThreadEvent[],
    snapshotSequence: number,
    checkpoint: ThreadSubscriptionState | undefined,
    firstObservation: boolean,
  ): Promise<ThreadSubscriptionState> {
    const completion = [...events]
      .reverse()
      .find(
        (event): event is Extract<ThreadEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
    const isAlreadyDelivered = Boolean(
      completion?.turnId && completion.turnId === checkpoint?.lastCompletedTurnId,
    );

    // A first completed snapshot is history, not a new notification. Running snapshots are
    // reconciled so attaching/restarting mid-turn still reconstructs the current response.
    if (!(isAlreadyDelivered || (firstObservation && completion))) {
      for (const event of events) await this.deliverEvent(worker, event);
    }

    return this.options.repository.saveThreadSubscriptionState({
      environmentId: worker.environmentId,
      t3ThreadId: worker.t3ThreadId,
      lastSequence: snapshotSequence,
      ...(completion?.turnId ? { lastCompletedTurnId: completion.turnId } : {}),
    });
  }

  private saveCheckpoint(
    worker: Worker,
    event: ThreadEvent,
    checkpoint: ThreadSubscriptionState | undefined,
  ): ThreadSubscriptionState | undefined {
    if (event.sequence === undefined && event.type !== "turn.completed") return checkpoint;
    return this.options.repository.saveThreadSubscriptionState({
      environmentId: worker.environmentId,
      t3ThreadId: worker.t3ThreadId,
      ...(event.sequence === undefined ? {} : { lastSequence: event.sequence }),
      ...(event.type === "turn.completed" && event.turnId
        ? { lastCompletedTurnId: event.turnId }
        : {}),
    });
  }

  private async deliverEvent(worker: Worker, event: ThreadEvent): Promise<void> {
    if (event.type === "subscription.synchronized" || event.type === "unknown") return;
    if (event.type === "warning") {
      this.options.logger.warn(
        {
          environment_id: worker.environmentId,
          t3_thread_id: worker.t3ThreadId,
          warning: event.message,
        },
        "T3 thread subscription warning",
      );
      return;
    }

    const bindings = this.bindingsForThread(worker.environmentId, worker.t3ThreadId);
    const activeIds = new Set(bindings.map((binding) => binding.id));
    for (const id of this.sessions.keys()) {
      if (id.startsWith(`${worker.environmentId}\u0000${worker.t3ThreadId}\u0000`)) {
        const bindingId = id.slice(id.lastIndexOf("\u0000") + 1);
        if (!activeIds.has(bindingId)) this.sessions.delete(id);
      }
    }
    for (const binding of bindings) {
      try {
        await this.deliverToBinding(worker, binding, event);
        this.logCompletedDelivery(worker, binding, event);
      } catch (error) {
        if (!binding.telegramThreadId || !this.isInvalidTopicError(error)) throw error;
        if (worker.controller.signal.aborted || !this.options.repository.findBinding(binding.id)) {
          continue;
        }
        const repaired = await this.repairBindingTopic(worker, binding);
        await this.deliverToBinding(worker, repaired, event);
        this.logCompletedDelivery(worker, repaired, event);
      }
    }
  }

  private logCompletedDelivery(
    worker: Worker,
    binding: BindingRecord,
    event: Exclude<ThreadEvent, { type: "subscription.synchronized" }>,
  ): void {
    if (event.type !== "turn.completed") return;
    this.options.logger.info(
      {
        event_type: event.type,
        event_sequence: event.sequence,
        turn_id: event.turnId,
        t3_thread_id: worker.t3ThreadId,
        binding_id: binding.id,
        telegram_chat_id: binding.telegramChatId,
        telegram_thread_id: binding.telegramThreadId,
      },
      "delivered completed T3 turn to Telegram topic",
    );
  }

  private async deliverToBinding(
    worker: Worker,
    binding: BindingRecord,
    event: Exclude<ThreadEvent, { type: "subscription.synchronized" }>,
  ): Promise<void> {
    if (event.type === "approval.requested") {
      await this.sendApproval(binding, event.request);
      return;
    }
    if (event.type === "user-input.requested") {
      await this.sendUserInput(binding, event.request);
      return;
    }
    if (event.type === "user-input.resolved") {
      const pending = this.options.repository.findPendingUserInputByRequest(
        binding.id,
        event.requestId,
      );
      if (pending && pending.status !== "resolved") {
        this.options.repository.resolvePendingUserInput(pending.id);
        if (pending.telegramMessageId)
          await this.options.api
            .editMessageReplyMarkup(
              chatTarget(binding.telegramChatId),
              Number(pending.telegramMessageId),
              { reply_markup: { inline_keyboard: [] } },
            )
            .catch(() => undefined);
      }
      return;
    }
    if (event.type === "usage.updated" || event.type === "tool.finished") return;

    const key = `${worker.environmentId}\u0000${worker.t3ThreadId}\u0000${binding.id}`;
    if (event.type === "turn.started") {
      this.sessions.set(key, this.newSession(binding));
      return;
    }
    let session = this.sessions.get(key);
    if (!session || (session.completed && event.type !== "turn.completed")) {
      session = this.newSession(binding);
      this.sessions.set(key, session);
    }

    if (event.type === "response.finalizing") {
      session.finalizing = true;
      await session.streamer.update(
        this.withRouteLabel(binding, this.inProgressOutput(session, this.locale(binding))),
        true,
      );
      return;
    }

    if (event.type === "assistant.delta") {
      if (event.messageId) {
        if (session.finalizing) session.finalMessageIds.add(event.messageId);
        session.messages.set(
          event.messageId,
          `${session.messages.get(event.messageId) ?? ""}${event.text}`,
        );
      } else if (session.finalizing) session.finalFallback += event.text;
      else session.fallback += event.text;
      await session.streamer.update(
        this.withRouteLabel(binding, this.inProgressOutput(session, this.locale(binding))),
      );
      return;
    }
    if (event.type === "assistant.message" && event.text) {
      if (event.messageId) {
        if (session.finalizing) session.finalMessageIds.add(event.messageId);
        const current = session.messages.get(event.messageId) ?? "";
        if (event.text.length >= current.length) session.messages.set(event.messageId, event.text);
      } else if (session.finalizing) session.finalFallback = event.text;
      else if (!session.fallback) session.fallback = event.text;
      await session.streamer.update(
        this.withRouteLabel(binding, this.inProgressOutput(session, this.locale(binding))),
        true,
      );
      return;
    }
    if (event.type === "activity" || event.type === "tool.started") {
      const output = this.inProgressOutput(session, this.locale(binding));
      const status = event.type === "activity" ? event.title : event.label;
      await session.streamer.update(
        this.withRouteLabel(binding, `${output}${output ? "\n\n" : ""}⏳ ${status}`),
      );
      return;
    }
    if (event.type === "files.changed") {
      session.files = event.files;
      return;
    }
    if (event.type === "turn.completed") {
      if (session.completed) return;
      const additions = session.files.reduce((total, file) => total + file.additions, 0);
      const deletions = session.files.reduce((total, file) => total + file.deletions, 0);
      const diffSummary = session.files.length
        ? renderDiffSummary(
            {
              diff: "",
              files: session.files,
              additions,
              deletions,
            },
            this.locale(binding),
          )
        : "";
      const locale = this.locale(binding);
      await session.streamer.finalize(
        this.withRouteLabel(
          binding,
          this.completedOutput(session, event.status, locale, diffSummary),
        ),
      );
      session.completed = true;
    }
  }

  private newSession(binding: BindingRecord): DeliverySession {
    return {
      streamer: new TelegramDraftStreamer(
        this.options.api,
        chatTarget(binding.telegramChatId),
        binding.telegramThreadId ? Number(binding.telegramThreadId) : undefined,
      ),
      messages: new Map(),
      finalMessageIds: new Set(),
      fallback: "",
      finalFallback: "",
      files: [],
      finalizing: false,
      completed: false,
    };
  }

  private outputGroups(
    session: DeliverySession,
    completed: boolean,
  ): { intermediate: string[]; final: string[] } {
    const intermediate: string[] = [];
    const final: string[] = [];
    for (const [id, text] of session.messages) {
      if (!text) continue;
      (session.finalMessageIds.has(id) ? final : intermediate).push(text);
    }
    if (session.fallback) intermediate.push(session.fallback);
    if (session.finalFallback) final.push(session.finalFallback);
    if (completed && final.length === 0 && intermediate.length > 0) final.push(intermediate.pop()!);
    return { intermediate, final };
  }

  private inProgressOutput(session: DeliverySession, locale: BotLocale): string {
    const { intermediate, final } = this.outputGroups(session, false);
    const sections: string[] = [];
    if (intermediate.length)
      sections.push(
        `${locale === "zh" ? "🧭 中间过程 · 进行中" : "🧭 Progress · working"}\n\n${intermediate.join("\n\n")}`,
      );
    if (final.length || session.finalizing)
      sections.push(
        `${locale === "zh" ? "✍️ 最终结果 · 生成中" : "✍️ Final answer · writing"}\n\n${final.join("\n\n") || (locale === "zh" ? "正在整理最终回答…" : "Preparing the final answer…")}`,
      );
    return sections.join("\n\n━━━━━━━━━━━━\n\n");
  }

  private completedOutput(
    session: DeliverySession,
    status: "success" | "failed" | "cancelled",
    locale: BotLocale,
    diffSummary: string,
  ): string {
    const { intermediate, final } = this.outputGroups(session, true);
    const sections: string[] = [];
    if (intermediate.length)
      sections.push(
        `${locale === "zh" ? "🧭 中间过程" : "🧭 Progress"}\n\n${intermediate.join("\n\n")}`,
      );
    sections.push(
      `${locale === "zh" ? "🎯 最终结果" : "🎯 Final result"}\n\n${final.join("\n\n") || (locale === "zh" ? "任务结束，但没有文本输出。" : "The turn ended without text output.")}`,
    );
    const statusLine =
      status === "success"
        ? locale === "zh"
          ? "✅ 任务已完成"
          : "✅ Turn completed"
        : status === "cancelled"
          ? locale === "zh"
            ? "⏹ 任务已取消"
            : "⏹ Turn cancelled"
          : locale === "zh"
            ? "❌ 任务执行失败"
            : "❌ Turn failed";
    sections.push(`${statusLine}${diffSummary ? `\n\n${diffSummary}` : ""}`);
    return sections.join("\n\n━━━━━━━━━━━━\n\n");
  }

  private withRouteLabel(binding: BindingRecord, text: string): string {
    if (binding.telegramThreadId) return text;
    return `[${binding.displayName ?? binding.t3ThreadId.slice(0, 8)}]\n${text}`;
  }

  private locale(binding: BindingRecord): BotLocale {
    return (
      this.options.localeForUser?.(binding.userId) ??
      this.options.repository.getUserLocale(binding.userId) ??
      "zh"
    );
  }

  private async sendApproval(binding: BindingRecord, request: ApprovalRequest): Promise<void> {
    const locale = this.locale(binding);
    if (request.options.length === 0) {
      await this.options.api.sendMessage(
        chatTarget(binding.telegramChatId),
        this.withRouteLabel(
          binding,
          `${locale === "zh" ? "⚠️ T3 请求审批，但没有提供可安全识别的选项。网关不会猜测，请在 T3 官方客户端处理。" : "⚠️ T3 requested approval without any safely identifiable options. The gateway will not guess; handle it in the official T3 client."}\n\n${request.title}${request.detail ? `\n${request.detail}` : ""}`,
        ),
        threadOptions(binding),
      );
      return;
    }

    const pending = this.options.repository.savePendingApproval({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      options: request.options,
    });
    if (pending.telegramMessageId) return;

    const keyboard = new InlineKeyboard();
    request.options.forEach((option, index) =>
      keyboard.text(option.label, `ap:${pending.id}:${index}`).row(),
    );
    const sent = await this.options.api.sendMessage(
      chatTarget(binding.telegramChatId),
      this.withRouteLabel(
        binding,
        [
          locale === "zh" ? "⚠️ 需要审批" : "⚠️ Approval required",
          "",
          request.title,
          request.detail ?? "",
          request.appName ? `${locale === "zh" ? "应用" : "App"}: ${request.appName}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
      { ...threadOptions(binding), reply_markup: keyboard },
    );
    this.options.repository.savePendingApproval({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      telegramMessageId: String(sent.message_id),
      options: request.options,
    });
  }

  private async sendUserInput(binding: BindingRecord, request: UserInputRequest): Promise<void> {
    const existing = this.options.repository.findPendingUserInputByRequest(
      binding.id,
      request.requestId,
    );
    if (existing?.telegramMessageId || existing?.status === "resolved") return;
    const pending = this.options.repository.savePendingUserInput({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      request,
    });
    const view = buildUserInputView(pending, this.locale(binding));
    const sent = await this.options.api.sendMessage(
      chatTarget(binding.telegramChatId),
      this.withRouteLabel(binding, view.text),
      { ...threadOptions(binding), reply_markup: view.keyboard },
    );
    this.options.repository.savePendingUserInput({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      request,
      telegramMessageId: String(sent.message_id),
    });
  }

  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private bindingsForThread(environmentId: string, t3ThreadId: string): BindingRecord[] {
    return this.options.repository
      .listBindingsForThread(environmentId, t3ThreadId)
      .filter((binding) => this.options.allowedUserIds.has(binding.telegramChatId));
  }

  private async repairBindingTopic(worker: Worker, binding: BindingRecord): Promise<BindingRecord> {
    const topic = await this.options.api.createForumTopic(
      chatTarget(binding.telegramChatId),
      (binding.displayName ?? `T3 ${binding.t3ThreadId.slice(0, 8)}`).slice(0, 128),
    );
    const repaired = this.options.repository.saveBinding({
      userId: binding.userId,
      telegramChatId: binding.telegramChatId,
      telegramThreadId: String(topic.message_thread_id),
      environmentId: binding.environmentId,
      ...(binding.t3ProjectId ? { t3ProjectId: binding.t3ProjectId } : {}),
      t3ThreadId: binding.t3ThreadId,
      ...(binding.displayName ? { displayName: binding.displayName } : {}),
    });
    const session = this.sessions.get(
      `${worker.environmentId}\u0000${worker.t3ThreadId}\u0000${binding.id}`,
    );
    if (session)
      session.streamer = new TelegramDraftStreamer(
        this.options.api,
        chatTarget(repaired.telegramChatId),
        Number(repaired.telegramThreadId),
      );
    this.options.logger.info(
      {
        binding_id: binding.id,
        telegram_chat_id: binding.telegramChatId,
        telegram_thread_id: repaired.telegramThreadId,
      },
      "recreated missing Telegram topic for active subscription",
    );
    return repaired;
  }

  private isInvalidTopicError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { error_code?: unknown; description?: unknown };
    const description = String(value.description).toLowerCase();
    return (
      value.error_code === 400 &&
      (description.includes("topic_id_invalid") || description.includes("message thread not found"))
    );
  }
}
