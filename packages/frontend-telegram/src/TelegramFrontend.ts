import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import type {
  BackendCapabilities,
  BindingRecord,
  CodingBackend,
  EnvironmentConnector,
  GatewayRepository,
  ModelProviderSummary,
  ProjectSummary,
  SupportedThreadRuntimeMode,
  ThreadSummary,
} from "@t3-vibe/core";
import {
  CapabilityUnsupportedError,
  GatewayError,
  interruptBoundTurn,
  safeErrorMessage,
} from "@t3-vibe/core";
import { compactThreadName, renderCapabilities, renderDiffSummary } from "./renderers/text.js";
import { ThreadSubscriptionManager } from "./ThreadSubscriptionManager.js";

export interface TelegramFrontendOptions {
  token: string;
  allowedUserIds: Set<string>;
  backend: CodingBackend;
  connector: EnvironmentConnector;
  repository: GatewayRepository;
  logger: Logger;
}

function messageThreadId(ctx: Context): string | undefined {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const value =
    message?.message_thread_id ??
    message?.direct_messages_topic?.topic_id ??
    ctx.message?.reply_to_message?.message_thread_id ??
    ctx.message?.reply_to_message?.direct_messages_topic?.topic_id ??
    ctx.stoppedMessageGeneration?.message_thread_id;
  return value === undefined ? undefined : String(value);
}

interface MutableTelegramTopicMessage {
  message_thread_id?: number;
  is_topic_message?: boolean;
  direct_messages_topic?: { topic_id: number };
}

/** Reply-keyboard updates may lose their private Topic identity; control actions are exact labels. */
export function routeControlMenuMessage(
  message: MutableTelegramTopicMessage,
  controlTopicId: string,
): void {
  const topicId = Number(controlTopicId);
  message.message_thread_id = topicId;
  message.is_topic_message = true;
  if (message.direct_messages_topic) message.direct_messages_topic.topic_id = topicId;
}

function commandArgument(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function chatTarget(id: string): number | string {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : id;
}

const MENU = {
  newProject: "🗂 新建项目",
  projectModel: "⚙️ 项目模型",
  newThread: "➕ 新建线程",
  attach: "🔗 绑定线程",
  backgroundThreads: "🧵 后台线程",
  history: "📜 历史记录",
  threadSettings: "🛠 线程设置",
  clearSessions: "🧹 清除会话",
  status: "📊 状态",
  stop: "⏹ 停止",
  diff: "🧾 Diff",
  environments: "🌐 环境",
  connect: "🔌 连接 T3",
  detach: "🔓 解除绑定",
  help: "❓ 帮助",
} as const;

const CONTROL_MENU_ACTIONS = [
  MENU.newProject,
  MENU.projectModel,
  MENU.newThread,
  MENU.attach,
  MENU.backgroundThreads,
  MENU.clearSessions,
  MENU.status,
  MENU.environments,
  MENU.connect,
  MENU.help,
] as const;

const HISTORY_PAGE_SIZE = 6;
const MODEL_PAGE_SIZE = 8;

const RUNTIME_MODES: ReadonlyArray<{
  value: SupportedThreadRuntimeMode;
  label: string;
  detail: string;
}> = [
  {
    value: "approval-required",
    label: "🔒 每次审批",
    detail: "只读沙箱；写文件和执行操作通常需要你确认。",
  },
  {
    value: "auto-accept-edits",
    label: "✍️ 自动批准编辑",
    detail: "允许工作区写入；敏感命令仍会向你申请。",
  },
  {
    value: "auto",
    label: "🤖 自动审批",
    detail: "允许工作区写入，并由 T3 自动审查审批请求。",
  },
  {
    value: "full-access",
    label: "⚠️ 完全访问",
    detail: "不询问审批，且不使用文件系统沙箱。风险最高。",
  },
];

type PendingMenuAction =
  | { type: "connect" }
  | { type: "project_title" }
  | { type: "project_workspace"; title: string }
  | { type: "project_environment"; title: string; workspaceRoot: string };

interface PendingSessionClear {
  userId: string;
  chatId: string;
  bindingIds: string[];
  expiresAt: number;
}

export class TelegramFrontend {
  readonly bot: Bot;
  private initialized = false;
  private topicsEnabled = false;
  private readonly subscriptionManager: ThreadSubscriptionManager;
  private readonly pendingMenuActions = new Map<string, PendingMenuAction>();
  private readonly pendingSessionClears = new Map<string, PendingSessionClear>();

  constructor(private readonly options: TelegramFrontendOptions) {
    this.bot = new Bot(options.token);
    this.subscriptionManager = new ThreadSubscriptionManager({
      api: this.bot.api,
      backend: options.backend,
      repository: options.repository,
      logger: options.logger,
      allowedUserIds: options.allowedUserIds,
    });
    this.registerHandlers();
  }

  async initialize(): Promise<void> {
    await this.bot.init();
    await this.bot.api.setMyCommands([
      { command: "start", description: "开始与连接状态" },
      { command: "menu", description: "重新显示按钮菜单" },
      { command: "connect", description: "连接 T3 环境" },
      { command: "environments", description: "列出 T3 环境" },
      { command: "projects", description: "列出项目" },
      { command: "newproject", description: "新建 T3 项目" },
      { command: "models", description: "设置项目默认模型" },
      { command: "new", description: "新建并绑定 T3 线程" },
      { command: "attach", description: "绑定已有 T3 线程" },
      { command: "threads", description: "管理后台监听线程" },
      { command: "history", description: "查看当前线程历史记录" },
      { command: "threadsettings", description: "修改当前线程模型与权限" },
      { command: "status", description: "连接与能力状态" },
      { command: "stop", description: "停止当前 turn" },
      { command: "diff", description: "查看当前线程 diff" },
      { command: "detach", description: "仅解除 Telegram 绑定" },
      { command: "help", description: "使用帮助" },
    ]);
    await this.bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
    this.topicsEnabled = this.bot.botInfo.has_topics_enabled === true;
    if (!this.topicsEnabled)
      this.options.logger.warn(
        "Telegram private-chat topics are disabled; using labeled flat-chat routing",
      );
    else {
      await this.migrateFlatBindingsToTopics();
      await this.syncBindingTopicNames();
    }
    this.ensureDefaultBindings();
    await this.restoreMainMenus();
    this.subscriptionManager.start();
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async start(): Promise<void> {
    await this.bot.start({
      allowed_updates: ["message", "callback_query", "stopped_message_generation"],
      onStart: () => this.options.logger.info("telegram polling started"),
    });
  }

  async stop(): Promise<void> {
    if (this.initialized) {
      try {
        this.bot.stop();
      } catch {
        // Polling may not have started yet.
      }
    }
    await this.subscriptionManager.stop();
  }

  private registerHandlers(): void {
    this.bot.use(async (ctx, next) => {
      const chat = ctx.chat ?? ctx.stoppedMessageGeneration?.chat;
      if (chat?.type !== "private") {
        if (ctx.message) await ctx.reply("请在与机器人的私聊中使用 T3 网关。");
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({ text: "仅支持私聊", show_alert: true });
        return;
      }
      // Telegram emits forum-topic service updates with the bot itself as the actor when a
      // topic is created. They are transport notifications, not user attempts, and must not be
      // answered with an authorization error.
      if (ctx.from?.is_bot) {
        this.options.logger.debug(
          { telegram_update_id: ctx.update.update_id, telegram_actor_id: ctx.from.id },
          "ignoring bot-originated Telegram service update",
        );
        return;
      }
      const sourceId = ctx.from?.id ?? ctx.stoppedMessageGeneration?.chat.id;
      if (sourceId === undefined) return;
      const userId = String(sourceId);
      if (!this.options.allowedUserIds.has(userId)) {
        if (ctx.message) await ctx.reply("无权使用此机器人。");
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({ text: "无权操作", show_alert: true });
        return;
      }
      if (this.options.repository.hasProcessedUpdate(ctx.update.update_id)) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "该操作已处理" });
        return;
      }
      await next();
      this.options.repository.markUpdateProcessed(ctx.update.update_id);
    });

    this.bot.command("start", async (ctx) => {
      this.clearPendingMenuAction(ctx);
      const userId = this.userId(ctx);
      const environments = this.options.repository.listEnvironments(userId);
      await this.sendControlPanel(
        String(ctx.chat!.id),
        environments.length === 0
          ? "T3 Vibe Gateway 已就绪。\n\n点击“🔌 连接 T3”开始配置。"
          : `T3 Vibe Gateway 已就绪，已配置 ${environments.length} 个环境。\n请直接使用下方菜单，或发送编码指令。`,
      );
    });

    this.bot.command("help", async (ctx) => this.showHelp(ctx));
    this.bot.command("menu", async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.sendControlPanel(String(ctx.chat!.id), "按钮菜单已恢复。");
    });

    this.bot.command("connect", async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.connectEnvironment(ctx, commandArgument(ctx));
    });

    this.bot.command("environments", async (ctx) => this.showEnvironments(ctx));

    this.bot.command("projects", async (ctx) => this.showProjects(ctx));
    this.bot.command("newproject", async (ctx) => this.beginProjectCreation(ctx));
    this.bot.command("models", async (ctx) => this.showModelProjects(ctx));
    this.bot.command("new", async (ctx) => {
      const projectId = commandArgument(ctx);
      await this.deleteNavigationMessage(ctx);
      if (!projectId) return this.showProjects(ctx);
      await this.createAndBind(ctx, projectId);
    });
    this.bot.callbackQuery(/^np:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.createAndBind(ctx, ctx.match[1]!);
    });
    this.bot.callbackQuery(/^mp:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showProjectModelProviders(ctx, ctx.match[1]!);
    });
    this.bot.callbackQuery(/^mpp:(.+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showProviderModels(ctx, ctx.match[1]!, Number(ctx.match[2]), 0, true);
    });
    this.bot.callbackQuery(/^mpl:(.+):(\d+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showProviderModels(
        ctx,
        ctx.match[1]!,
        Number(ctx.match[2]),
        Number(ctx.match[3]),
        true,
      );
    });
    this.bot.callbackQuery(/^mps:(.+):(\d+):(\d+)$/, async (ctx) => {
      await this.setProjectModel(ctx, ctx.match[1]!, Number(ctx.match[2]), Number(ctx.match[3]));
    });

    this.bot.command("attach", async (ctx) => {
      const query = commandArgument(ctx);
      await this.deleteNavigationMessage(ctx);
      await this.showThreads(ctx, query);
    });
    this.bot.callbackQuery(/^at:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.attachThread(ctx, ctx.match[1]!);
    });

    this.bot.command("status", async (ctx) => this.showStatus(ctx));
    this.bot.command("threads", async (ctx) => this.showBackgroundThreads(ctx));
    this.bot.command("history", async (ctx) => {
      const page = Math.max(1, Number.parseInt(commandArgument(ctx), 10) || 1);
      await this.showHistory(ctx, (page - 1) * HISTORY_PAGE_SIZE);
    });
    this.bot.command("threadsettings", async (ctx) => this.showThreadSettings(ctx));
    this.bot.command("detach", async (ctx) => this.detachBinding(ctx));

    this.bot.command("stop", async (ctx) => this.stopTurn(ctx));
    this.bot.command("diff", async (ctx) => this.showDiff(ctx));

    this.bot.hears([...CONTROL_MENU_ACTIONS], async (ctx, next) => {
      if (await this.keepMenuActionInControlTopic(ctx)) await next();
    });

    this.bot.hears(MENU.newProject, async (ctx) => this.beginProjectCreation(ctx));
    this.bot.hears(MENU.projectModel, async (ctx) => this.showModelProjects(ctx));
    this.bot.hears(MENU.newThread, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.deleteNavigationMessage(ctx);
      await this.showProjects(ctx);
    });
    this.bot.hears(MENU.attach, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.deleteNavigationMessage(ctx);
      await this.showThreads(ctx, "");
    });
    this.bot.hears(MENU.status, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showStatus(ctx);
    });
    this.bot.hears(MENU.backgroundThreads, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showBackgroundThreads(ctx);
    });
    this.bot.hears(MENU.history, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showHistory(ctx, 0);
    });
    this.bot.hears(MENU.threadSettings, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showThreadSettings(ctx);
    });
    this.bot.hears(MENU.clearSessions, async (ctx) => this.beginClearSessions(ctx));
    this.bot.hears(MENU.stop, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.stopTurn(ctx);
    });
    this.bot.hears(MENU.diff, async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showDiff(ctx);
    });
    this.bot.hears(MENU.environments, async (ctx) => this.showEnvironments(ctx));
    this.bot.hears(MENU.connect, async (ctx) => {
      this.pendingMenuActions.set(this.pendingMenuKey(ctx), { type: "connect" });
      await ctx.reply(
        [
          "请在 T3 主机运行 `npx t3 pair` 获取一次性 token。",
          "然后发送一条消息：",
          "http://T3主机:3773 PAIRING_TOKEN",
          "",
          "同机运行可使用：http://127.0.0.1:3773 PAIRING_TOKEN",
        ].join("\n"),
      );
    });
    this.bot.hears(MENU.detach, async (ctx) => this.detachBinding(ctx));
    this.bot.hears(MENU.help, async (ctx) => this.showHelp(ctx));

    this.bot.callbackQuery(/^pc:(.+)$/, async (ctx) => {
      const pending = this.pendingMenuActions.get(this.pendingMenuKey(ctx));
      if (pending?.type !== "project_environment") {
        await ctx.answerCallbackQuery({ text: "创建流程已失效，请重新点击新建项目。" });
        return;
      }
      const environmentId = ctx.match[1]!;
      const environment = this.options.repository
        .listEnvironments(this.userId(ctx))
        .find((item) => item.id === environmentId);
      if (!environment) {
        await ctx.answerCallbackQuery({ text: "环境不存在或无权使用。", show_alert: true });
        return;
      }
      this.clearPendingMenuAction(ctx);
      await ctx.answerCallbackQuery();
      await this.createProject(ctx, environment.id, pending.title, pending.workspaceRoot);
    });

    this.bot.callbackQuery(/^ap:([0-9a-f-]+):(\d+)$/, async (ctx) => {
      const approvalId = ctx.match[1]!;
      const optionIndex = Number(ctx.match[2]);
      const pending = this.options.repository.findPendingApproval(approvalId);
      if (!pending || pending.status !== "pending") {
        await ctx.answerCallbackQuery({ text: "该审批已处理或已失效", show_alert: true });
        return;
      }
      const binding = this.options.repository.findBinding(pending.bindingId);
      if (!binding || binding.userId !== this.userId(ctx)) {
        await ctx.answerCallbackQuery({ text: "无权处理此审批", show_alert: true });
        return;
      }
      const option = pending.options[optionIndex];
      if (!option || !this.options.repository.claimPendingApproval(approvalId)) {
        await ctx.answerCallbackQuery({ text: "审批选项无效或已处理", show_alert: true });
        return;
      }
      try {
        await this.requireCapability(binding.environmentId, "approval", "审批");
        await this.options.backend.respondToApproval({
          environmentId: binding.environmentId,
          threadId: binding.t3ThreadId,
          requestId: pending.t3RequestId,
          decision: option.decision,
        });
        this.options.repository.resolvePendingApproval(approvalId);
        await ctx.answerCallbackQuery({ text: `已提交：${option.label}` });
        await ctx
          .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
          .catch(() => undefined);
      } catch (error) {
        this.options.repository.releasePendingApproval(approvalId);
        this.logError(ctx, error, "approval");
        await ctx.answerCallbackQuery({ text: safeErrorMessage(error), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^sb:([0-9a-f-]+)$/, async (ctx) => {
      const bindingId = ctx.match[1]!;
      const binding = this.options.repository.findBinding(bindingId);
      if (
        !binding ||
        binding.userId !== this.userId(ctx) ||
        binding.telegramChatId !== String(ctx.chat!.id)
      ) {
        await ctx.answerCallbackQuery({ text: "绑定已不存在或无权访问。", show_alert: true });
        return;
      }
      if (this.topicsEnabled && binding.telegramThreadId) {
        await ctx.answerCallbackQuery({ text: "已在目标 Topic 发送定位消息" });
        await ctx.api.sendMessage(
          chatTarget(binding.telegramChatId),
          `📍 ${binding.displayName ?? shortId(binding.t3ThreadId)}\n请进入这个 Topic 后发送编码指令。`,
          {
            message_thread_id: Number(binding.telegramThreadId),
            reply_markup: this.mainMenu(),
          },
        );
        return;
      }
      if (
        !this.options.repository.setActiveBinding(
          binding.userId,
          binding.telegramChatId,
          binding.id,
        )
      ) {
        await ctx.answerCallbackQuery({ text: "绑定已不存在或无权访问。", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "已切换默认输入线程" });
      await ctx.reply(
        `✅ 默认输入线程已切换为：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
        { reply_markup: this.mainMenu() },
      );
    });

    this.bot.callbackQuery(/^bd:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireManagedBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        [
          "🔓 确认解除 Telegram 绑定？",
          "",
          `线程：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
          "",
          "这会停止该绑定的后台监听，但不会归档或删除 T3 线程，之后仍可重新绑定。",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text("确认解除", `bdc:${binding.id}`)
            .row()
            .text("取消", "bdb"),
        },
      );
    });
    this.bot.callbackQuery(/^bdc:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireManagedBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      const removed = this.options.repository.removeBindingById(
        binding.userId,
        binding.telegramChatId,
        binding.id,
      );
      if (!removed) {
        await ctx.answerCallbackQuery({ text: "绑定已不存在。", show_alert: true });
        return;
      }
      this.subscriptionManager.sync();
      await ctx.answerCallbackQuery({ text: "已解除 Telegram 绑定" });
      if (binding.telegramThreadId) {
        await ctx.api
          .sendMessage(
            chatTarget(binding.telegramChatId),
            "🔓 此 Topic 已解除 T3 线程绑定；T3 线程本身未被修改，可从“绑定线程”重新绑定。",
            { message_thread_id: Number(binding.telegramThreadId) },
          )
          .catch((error: unknown) =>
            this.options.logger.debug(
              { err: error, binding_id: binding.id },
              "could not notify detached Telegram topic",
            ),
          );
      }
      await this.showBackgroundThreads(
        ctx,
        true,
        `✅ 已解除：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
      );
    });
    this.bot.callbackQuery(/^bdb$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.showBackgroundThreads(ctx, true);
    });

    this.bot.callbackQuery(/^cac:([0-9a-f-]+)$/, async (ctx) => {
      await this.clearAllSessions(ctx, ctx.match[1]!);
    });
    this.bot.callbackQuery(/^cax:([0-9a-f-]+)$/, async (ctx) => {
      const confirmationId = ctx.match[1]!;
      const pending = this.pendingSessionClears.get(confirmationId);
      if (
        !pending ||
        pending.userId !== this.userId(ctx) ||
        pending.chatId !== String(ctx.chat!.id)
      ) {
        await ctx.answerCallbackQuery({ text: "清理确认已失效。", show_alert: true });
        return;
      }
      this.pendingSessionClears.delete(confirmationId);
      await ctx.answerCallbackQuery({ text: "已取消" });
      await ctx.editMessageText("已取消清除，会话和绑定均未修改。");
    });

    this.bot.callbackQuery(/^hi:([0-9a-f-]+):(\d+)$/, async (ctx) => {
      const binding = this.options.repository.findBinding(ctx.match[1]!);
      if (
        !binding ||
        binding.userId !== this.userId(ctx) ||
        binding.telegramChatId !== String(ctx.chat!.id) ||
        binding.telegramThreadId !== messageThreadId(ctx)
      ) {
        await ctx.answerCallbackQuery({
          text: "历史记录绑定已失效或 Topic 不匹配。",
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.showHistory(ctx, Number(ctx.match[2]), binding, true);
    });

    this.bot.callbackQuery(/^ts:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await this.showThreadSettings(ctx, binding, true);
    });
    this.bot.callbackQuery(/^tm:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await this.showThreadModelProviders(ctx, binding, true);
    });
    this.bot.callbackQuery(/^tmp:([0-9a-f-]+):(\d+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await this.showThreadProviderModels(ctx, binding, Number(ctx.match[2]), 0, true);
    });
    this.bot.callbackQuery(/^tml:([0-9a-f-]+):(\d+):(\d+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await this.showThreadProviderModels(
        ctx,
        binding,
        Number(ctx.match[2]),
        Number(ctx.match[3]),
        true,
      );
    });
    this.bot.callbackQuery(/^tms:([0-9a-f-]+):(\d+):(\d+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await this.setThreadModel(ctx, binding, Number(ctx.match[2]), Number(ctx.match[3]));
    });
    this.bot.callbackQuery(/^tr:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await this.showThreadRuntimeModes(ctx, binding, true);
    });
    this.bot.callbackQuery(/^trs:([0-9a-f-]+):(\d+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      const modeIndex = Number(ctx.match[2]);
      if (RUNTIME_MODES[modeIndex]?.value === "full-access") {
        await ctx.answerCallbackQuery();
        await this.confirmFullAccess(ctx, binding);
        return;
      }
      await this.setThreadRuntimeMode(ctx, binding, modeIndex);
    });
    this.bot.callbackQuery(/^trf:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireSettingsBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await this.setThreadRuntimeMode(ctx, binding, 3);
    });

    this.bot.on("message:text", async (ctx) => {
      const pending = this.pendingMenuActions.get(this.pendingMenuKey(ctx));
      if (pending) return this.handlePendingMenuInput(ctx, pending);
      await this.startBoundTurn(ctx);
    });
    this.bot.on("stopped_message_generation", async (ctx) => this.stopTurn(ctx));

    this.bot.catch((error) => {
      this.options.logger.error(
        { err: error.error, update_id: error.ctx.update.update_id },
        "telegram update failed",
      );
    });
  }

  private mainMenu(): Keyboard {
    return new Keyboard()
      .text(MENU.newProject)
      .text(MENU.projectModel)
      .row()
      .text(MENU.newThread)
      .text(MENU.attach)
      .row()
      .text(MENU.backgroundThreads)
      .row()
      .text(MENU.history)
      .text(MENU.threadSettings)
      .row()
      .text(MENU.status)
      .row()
      .text(MENU.stop)
      .text(MENU.diff)
      .row()
      .text(MENU.environments)
      .text(MENU.connect)
      .row()
      .text(MENU.detach)
      .text(MENU.clearSessions)
      .row()
      .text(MENU.help)
      .resized()
      .persistent();
  }

  private async restoreMainMenus(): Promise<void> {
    for (const telegramId of this.options.allowedUserIds) {
      try {
        await this.sendControlPanel(
          telegramId,
          "🤖 T3 控制台已就绪。菜单操作固定在这里，不会再删除或改名当前 Topic。",
          true,
        );
      } catch (error) {
        this.options.logger.warn(
          { err: error, telegram_chat_id: telegramId },
          "could not restore Telegram reply keyboard",
        );
      }
    }
  }

  private async ensureControlTopic(chatId: string): Promise<string | undefined> {
    if (!this.topicsEnabled) return undefined;
    const target = chatTarget(chatId);
    const existing = this.options.repository.getTelegramControlTopic(chatId);
    if (existing) {
      try {
        await this.bot.api.sendChatAction(target, "typing", {
          message_thread_id: Number(existing),
        });
        return existing;
      } catch (error) {
        if (!this.isInvalidTopicError(error)) throw error;
      }
    }
    const topic = await this.bot.api.createForumTopic(target, "🎛 T3 控制台");
    const threadId = String(topic.message_thread_id);
    this.options.repository.saveTelegramControlTopic(chatId, threadId);
    return threadId;
  }

  private async sendControlPanel(chatId: string, text: string, silent = false): Promise<void> {
    const threadId = await this.ensureControlTopic(chatId);
    await this.bot.api.sendMessage(chatTarget(chatId), text, {
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      ...(silent ? { disable_notification: true } : {}),
      reply_markup: this.mainMenu(),
    });
  }

  private async keepMenuActionInControlTopic(ctx: Context): Promise<boolean> {
    if (!this.topicsEnabled) return true;
    const chatId = String(ctx.chat!.id);
    const controlTopic = await this.ensureControlTopic(chatId);
    if (!controlTopic || !ctx.message) return true;
    const sourceTopicId = messageThreadId(ctx);
    routeControlMenuMessage(ctx.message, controlTopic);
    this.options.logger.debug(
      {
        telegram_chat_id: chatId,
        source_topic_id: sourceTopicId,
        control_topic_id: controlTopic,
        menu_action: ctx.message.text,
      },
      "routed exact Telegram control menu action to persistent control topic",
    );
    return true;
  }

  private async beginProjectCreation(ctx: Context): Promise<void> {
    this.pendingMenuActions.set(this.pendingMenuKey(ctx), { type: "project_title" });
    await ctx.reply("请输入新项目名称。\n\n点击其他菜单项可取消创建。", {
      reply_markup: this.mainMenu(),
    });
  }

  private async handlePendingMenuInput(ctx: Context, pending: PendingMenuAction): Promise<void> {
    const input = ctx.message?.text?.trim() ?? "";
    if (pending.type === "connect") {
      const parsed = this.parseConnectionInput(input);
      if (!parsed) {
        await ctx.reply(
          "格式不正确，请发送：\nhttp://T3主机:3773 PAIRING_TOKEN\n\n点击其他菜单项可取消连接。",
        );
        return;
      }
      this.clearPendingMenuAction(ctx);
      await this.connectEnvironment(ctx, input);
      return;
    }

    if (pending.type === "project_title") {
      if (!input || input.length > 200) {
        await ctx.reply("项目名称不能为空，且不能超过 200 个字符。请重新输入。");
        return;
      }
      this.pendingMenuActions.set(this.pendingMenuKey(ctx), {
        type: "project_workspace",
        title: input,
      });
      await ctx.reply(
        "请输入工作区路径。该路径位于 T3 主机上；目录不存在时会自动创建。\n\n例如：/home/user/projects/my-app",
      );
      return;
    }

    if (pending.type === "project_workspace") {
      if (!input || input.length > 4096) {
        await ctx.reply("工作区路径不能为空，且不能超过 4096 个字符。请重新输入。");
        return;
      }
      const environments = this.options.repository.listEnvironments(this.userId(ctx));
      if (environments.length === 0) {
        this.clearPendingMenuAction(ctx);
        await ctx.reply("尚未连接 T3 环境，请先点击“🔌 连接 T3”。");
        return;
      }
      if (environments.length === 1) {
        this.clearPendingMenuAction(ctx);
        await this.createProject(ctx, environments[0]!.id, pending.title, input);
        return;
      }
      this.pendingMenuActions.set(this.pendingMenuKey(ctx), {
        type: "project_environment",
        title: pending.title,
        workspaceRoot: input,
      });
      const keyboard = new InlineKeyboard();
      for (const environment of environments) {
        keyboard.text(environment.name.slice(0, 50), `pc:${environment.id}`).row();
      }
      await ctx.reply("选择在哪个 T3 环境创建项目：", { reply_markup: keyboard });
      return;
    }

    await ctx.reply("请选择上方的 T3 环境，或点击其他菜单项取消。");
  }

  private async createProject(
    ctx: Context,
    environmentId: string,
    title: string,
    workspaceRoot: string,
  ): Promise<void> {
    try {
      await this.requireCapability(environmentId, "projectCreate", "新建项目");
      const project = await this.options.backend.createProject({
        environmentId,
        title,
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      });
      await ctx.reply(
        [
          `✅ 已创建 T3 项目：${project.title}`,
          `工作区：${project.workspaceRoot ?? workspaceRoot}`,
          "",
          "下一步请选择项目默认模型，然后即可新建线程。",
        ].join("\n"),
        { reply_markup: this.mainMenu() },
      );
      await this.showProjectModelProviders(ctx, project.id, environmentId);
    } catch (error) {
      this.logError(ctx, error, "project_create");
      await ctx.reply(safeErrorMessage(error), { reply_markup: this.mainMenu() });
    }
  }

  private async showModelProjects(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const keyboard = new InlineKeyboard();
      let count = 0;
      for (const environment of this.options.repository.listEnvironments(this.userId(ctx))) {
        for (const project of await this.options.backend.listProjects(environment.id)) {
          const current = project.defaultModelSelection
            ? ` · ${project.defaultModelSelection.model}`
            : " · 未设置";
          keyboard
            .text(
              `${environment.name} / ${project.title}${current}`.slice(0, 60),
              `mp:${project.id}`,
            )
            .row();
          count++;
        }
      }
      await ctx.reply(count ? "选择要设置默认模型的项目：" : "当前没有可用项目。", {
        ...(count ? { reply_markup: keyboard } : { reply_markup: this.mainMenu() }),
      });
    } catch (error) {
      this.logError(ctx, error, "model_projects");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showProjectModelProviders(
    ctx: Context,
    projectId: string,
    knownEnvironmentId?: string,
  ): Promise<void> {
    try {
      const found = knownEnvironmentId
        ? {
            environmentId: knownEnvironmentId,
            project: (await this.options.backend.listProjects(knownEnvironmentId)).find(
              (project) => project.id === projectId,
            ),
          }
        : await this.findProject(ctx, projectId);
      if (!found?.project) {
        await ctx.reply("项目尚未出现在 T3 快照中，请稍后点击“⚙️ 项目模型”重试。");
        return;
      }
      const providers = (await this.options.backend.listModelProviders(found.environmentId)).filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.models.length > 0,
      );
      if (!providers.length) {
        await ctx.reply("T3 当前没有已启用且可用的模型 Provider。");
        return;
      }
      const keyboard = new InlineKeyboard();
      providers.forEach((provider, index) => {
        const selected =
          found.project!.defaultModelSelection?.instanceId === provider.instanceId ? "✅ " : "";
        keyboard
          .text(
            `${selected}${provider.displayName} · ${provider.models.length} 个模型`.slice(0, 60),
            `mpp:${projectId}:${index}`,
          )
          .row();
      });
      await ctx.reply(
        `⚙️ ${found.project.title}\n当前默认模型：${found.project.defaultModelSelection ? `${found.project.defaultModelSelection.instanceId} / ${found.project.defaultModelSelection.model}` : "未设置"}\n\n请选择 Provider：`,
        { reply_markup: keyboard },
      );
    } catch (error) {
      this.logError(ctx, error, "model_providers");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showProviderModels(
    ctx: Context,
    projectId: string,
    providerIndex: number,
    offset: number,
    edit: boolean,
  ): Promise<void> {
    try {
      const found = await this.findProject(ctx, projectId);
      if (!found) throw new GatewayError("Project not found", "project_not_found", "项目不存在。");
      const providers = (await this.options.backend.listModelProviders(found.environmentId)).filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.models.length > 0,
      );
      const provider = providers[providerIndex];
      if (!provider)
        throw new GatewayError(
          "Provider list changed",
          "provider_list_changed",
          "Provider 列表已变化，请重新选择项目。",
        );
      const safeOffset = Math.min(
        Math.max(0, Math.floor(offset)),
        Math.max(0, provider.models.length - 1),
      );
      const models = provider.models.slice(safeOffset, safeOffset + MODEL_PAGE_SIZE);
      const keyboard = new InlineKeyboard();
      models.forEach((model, index) => {
        const absoluteIndex = safeOffset + index;
        const selected =
          found.project.defaultModelSelection?.instanceId === provider.instanceId &&
          found.project.defaultModelSelection.model === model.slug;
        keyboard
          .text(
            `${selected ? "✅ " : model.isDefault ? "⭐ " : ""}${model.name}${model.isLegacy ? " · 旧版" : ""}`.slice(
              0,
              60,
            ),
            `mps:${projectId}:${providerIndex}:${absoluteIndex}`,
          )
          .row();
      });
      if (safeOffset > 0)
        keyboard.text(
          "⬅️ 上一页",
          `mpl:${projectId}:${providerIndex}:${Math.max(0, safeOffset - MODEL_PAGE_SIZE)}`,
        );
      if (safeOffset + MODEL_PAGE_SIZE < provider.models.length)
        keyboard.text(
          "下一页 ➡️",
          `mpl:${projectId}:${providerIndex}:${safeOffset + MODEL_PAGE_SIZE}`,
        );
      keyboard.row().text("↩️ Provider", `mp:${projectId}`);
      const text = `⚙️ ${found.project.title}\n${provider.displayName} · ${safeOffset + 1}–${Math.min(safeOffset + MODEL_PAGE_SIZE, provider.models.length)} / ${provider.models.length}\n\n请选择默认模型：`;
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "provider_models");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async setProjectModel(
    ctx: Context,
    projectId: string,
    providerIndex: number,
    modelIndex: number,
  ): Promise<void> {
    try {
      const found = await this.findProject(ctx, projectId);
      if (!found) throw new GatewayError("Project not found", "project_not_found", "项目不存在。");
      const providers = (await this.options.backend.listModelProviders(found.environmentId)).filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.models.length > 0,
      );
      const provider = providers[providerIndex];
      const model = provider?.models[modelIndex];
      if (!provider || !model)
        throw new GatewayError(
          "Model list changed",
          "model_list_changed",
          "模型列表已变化，请重新选择。",
        );
      await this.options.backend.setProjectDefaultModel({
        environmentId: found.environmentId,
        projectId,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
      });
      await ctx.answerCallbackQuery({ text: "默认模型已保存" });
      await ctx.editMessageText(
        `✅ 已设置项目默认模型\n\n项目：${found.project.title}\nProvider：${provider.displayName}\n模型：${model.name} (${model.slug})`,
        {
          reply_markup: new InlineKeyboard()
            .text("➕ 新建线程", `np:${projectId}`)
            .row()
            .text("⚙️ 更换模型", `mp:${projectId}`),
        },
      );
    } catch (error) {
      this.logError(ctx, error, "set_project_model");
      await ctx.answerCallbackQuery({ text: safeErrorMessage(error), show_alert: true });
    }
  }

  private async showHelp(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    await ctx.reply(
      [
        "使用下方菜单即可完成主要操作：",
        "🗂 新建项目 — 在 T3 主机创建工作区项目",
        "⚙️ 项目模型 — 为项目设置或更换默认 Provider/模型",
        "➕ 新建线程 — 选择项目并创建线程",
        "🔗 绑定线程 — 继续已有 T3 线程",
        "🧵 后台线程 — 查看所有监听并切换默认输入线程",
        "📜 历史记录 — 分页查看当前 T3 线程的用户与助手消息",
        "🛠 线程设置 — 修改当前线程的模型和运行权限",
        "🧹 清除会话 — 清除所有线程 Topic 和网关绑定，保留 T3 数据与控制台",
        "📊 状态 — 查看连接、绑定和能力",
        "⏹ 停止 — 中断当前 turn",
        "🧾 Diff — 查看文件变更摘要",
        "",
        "绑定线程后，普通文本会直接发送到当前 T3 线程。切换只改变输入目标，所有保留的绑定都会在后台继续监听。",
        "启用 Telegram 私聊 Topics 后，每个 T3 线程会使用独立 Topic；未启用时，后台回复会带线程名前缀。",
        "斜杠命令仍保留作备用入口。",
      ].join("\n"),
      { reply_markup: this.mainMenu() },
    );
  }

  private parseConnectionInput(input: string):
    | {
        baseUrl: string;
        token: string;
        name?: string;
      }
    | undefined {
    const [baseUrl, token, ...nameParts] = input.split(/\s+/).filter(Boolean);
    if (!baseUrl || !token) return undefined;
    return {
      baseUrl,
      token,
      ...(nameParts.length ? { name: nameParts.join(" ") } : {}),
    };
  }

  private async connectEnvironment(ctx: Context, input: string): Promise<void> {
    const parsed = this.parseConnectionInput(input);
    if (!parsed) {
      this.pendingMenuActions.set(this.pendingMenuKey(ctx), { type: "connect" });
      await ctx.reply(
        "请发送：\nhttp://T3主机:3773 PAIRING_TOKEN\n\n可在 T3 主机运行 `npx t3 pair` 获取一次性 token。",
        { reply_markup: this.mainMenu() },
      );
      return;
    }
    this.clearPendingMenuAction(ctx);
    const tokenMessageDeleted = await ctx
      .deleteMessage()
      .then(() => true)
      .catch(() => false);
    const deletionWarning = tokenMessageDeleted
      ? ""
      : "\n⚠️ 无法删除含 pairing token 的消息，请手动删除。";
    try {
      const result = await this.options.connector.pair({
        userId: this.userId(ctx),
        baseUrl: parsed.baseUrl,
        bootstrapCredential: parsed.token,
        ...(parsed.name ? { name: parsed.name } : {}),
      });
      const online = result.status.state === "connected" || result.status.state === "degraded";
      await ctx.api.sendMessage(
        ctx.chat!.id,
        online
          ? `✅ 已连接 ${result.environment.name}（T3 ${result.environment.serverVersion ?? "未知版本"}）${deletionWarning}`
          : `⚠️ 环境凭据已保存，但当前状态为 ${result.status.state}。请点击“📊 状态”检查。${deletionWarning}`,
        { reply_markup: this.mainMenu() },
      );
    } catch (error) {
      this.logError(ctx, error, "connect");
      await ctx.api.sendMessage(ctx.chat!.id, `${safeErrorMessage(error)}${deletionWarning}`, {
        reply_markup: this.mainMenu(),
      });
    }
  }

  private async showEnvironments(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const environments = this.options.repository.listEnvironments(this.userId(ctx));
    if (!environments.length) {
      await ctx.reply("尚未连接 T3 环境。点击“🔌 连接 T3”。", {
        reply_markup: this.mainMenu(),
      });
      return;
    }
    await ctx.reply(
      environments
        .map(
          (env) =>
            `${env.status === "connected" ? "🟢" : "⚪️"} ${env.name} · ${shortId(env.id)} · T3 ${env.serverVersion ?? "?"}`,
        )
        .join("\n"),
      { reply_markup: this.mainMenu() },
    );
  }

  private async detachBinding(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const removed = this.options.repository.removeBinding(
      this.userId(ctx),
      String(ctx.chat!.id),
      messageThreadId(ctx),
    );
    if (removed) this.subscriptionManager.sync();
    await ctx.reply(removed ? "已解除 Telegram 绑定；T3 线程未被修改。" : "当前没有绑定。", {
      reply_markup: this.mainMenu(),
    });
  }

  private async beginClearSessions(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const userId = this.userId(ctx);
    const chatId = String(ctx.chat!.id);
    const bindings = this.options.repository
      .listBindings(userId)
      .filter((binding) => binding.telegramChatId === chatId);
    if (!bindings.length) {
      await ctx.reply("当前没有可清除的线程会话；T3 控制台会继续保留。", {
        reply_markup: this.mainMenu(),
      });
      return;
    }

    const now = Date.now();
    for (const [id, pending] of this.pendingSessionClears) {
      if (pending.expiresAt <= now) this.pendingSessionClears.delete(id);
    }
    const confirmationId = randomUUID();
    this.pendingSessionClears.set(confirmationId, {
      userId,
      chatId,
      bindingIds: bindings.map((binding) => binding.id),
      expiresAt: now + 10 * 60_000,
    });
    const topicCount = new Set(
      bindings.flatMap((binding) => (binding.telegramThreadId ? [binding.telegramThreadId] : [])),
    ).size;
    const flatCount = bindings.length - topicCount;
    await ctx.reply(
      [
        "⚠️ 确认清除所有 Telegram 会话记录？",
        "",
        `将解除 ${bindings.length} 个网关绑定，并删除 ${topicCount} 个线程 Topic 及其中的消息。`,
        ...(flatCount
          ? [
              `另有 ${flatCount} 个非 Topic 绑定只能解除；Telegram 不允许机器人单独清空普通私聊消息。`,
            ]
          : []),
        "",
        "会保留：🎛 T3 控制台、T3 真实线程、项目、代码和环境连接。之后仍可重新绑定原线程。",
        "",
        "此操作不可恢复，确认按钮将在 10 分钟后失效。",
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("确认清除全部会话", `cac:${confirmationId}`)
          .row()
          .text("取消", `cax:${confirmationId}`),
      },
    );
  }

  private async clearAllSessions(ctx: Context, confirmationId: string): Promise<void> {
    const pending = this.pendingSessionClears.get(confirmationId);
    const userId = this.userId(ctx);
    const chatId = String(ctx.chat!.id);
    if (
      !pending ||
      pending.userId !== userId ||
      pending.chatId !== chatId ||
      pending.expiresAt <= Date.now()
    ) {
      this.pendingSessionClears.delete(confirmationId);
      await ctx.answerCallbackQuery({
        text: "清理确认已失效，请重新点击“🧹 清除会话”。",
        show_alert: true,
      });
      return;
    }
    this.pendingSessionClears.delete(confirmationId);

    const bindings = pending.bindingIds.flatMap((bindingId) => {
      const binding = this.options.repository.findBinding(bindingId);
      return binding?.userId === userId && binding.telegramChatId === chatId ? [binding] : [];
    });
    if (!bindings.length) {
      await ctx.answerCallbackQuery({ text: "这些会话已经清除。" });
      await ctx.editMessageText("✅ 会话已经清除；T3 控制台仍然保留。");
      return;
    }

    await ctx.answerCallbackQuery({ text: "正在逐个清除会话…" });
    let removedBindings = 0;
    for (const binding of bindings) {
      if (this.options.repository.removeBindingById(userId, chatId, binding.id)) {
        removedBindings++;
      }
    }
    this.subscriptionManager.sync();

    const controlTopic = this.options.repository.getTelegramControlTopic(chatId);
    const topicIds = [
      ...new Set(
        bindings.flatMap((binding) =>
          binding.telegramThreadId && binding.telegramThreadId !== controlTopic
            ? [binding.telegramThreadId]
            : [],
        ),
      ),
    ];
    let deletedTopics = 0;
    let failedTopics = 0;
    await new Promise((resolve) => setTimeout(resolve, 150));
    for (const [index, topicId] of topicIds.entries()) {
      try {
        await ctx.api.deleteForumTopic(chatTarget(chatId), Number(topicId));
        deletedTopics++;
      } catch (error) {
        if (this.isInvalidTopicError(error)) deletedTopics++;
        else {
          failedTopics++;
          this.options.logger.warn(
            { err: error, telegram_chat_id: chatId, telegram_thread_id: topicId },
            "could not delete cleared Telegram conversation topic",
          );
        }
      }
      if (index + 1 < topicIds.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    await ctx.editMessageText(
      [
        failedTopics ? "⚠️ 会话绑定已清除，但部分 Topic 删除失败。" : "✅ 所有会话已清除。",
        "",
        `已解除绑定：${removedBindings}`,
        `已删除线程 Topic：${deletedTopics}`,
        ...(failedTopics
          ? [`删除失败：${failedTopics}（已停止监听，可在 Telegram 中手动删除）`]
          : []),
        "",
        "🎛 T3 控制台及 T3 中的线程、项目和代码均已保留。",
      ].join("\n"),
    );
  }

  private pendingMenuKey(ctx: Context): string {
    const chatId = ctx.chat?.id ?? ctx.stoppedMessageGeneration?.chat.id ?? "unknown";
    return `${chatId}:${messageThreadId(ctx) ?? "root"}`;
  }

  private clearPendingMenuAction(ctx: Context): void {
    this.pendingMenuActions.delete(this.pendingMenuKey(ctx));
  }

  private async deleteNavigationMessage(ctx: Context): Promise<void> {
    await ctx.deleteMessage().catch((error: unknown) => {
      this.options.logger.debug(
        { err: error, telegram_chat_id: ctx.chat?.id },
        "could not remove Telegram navigation message",
      );
    });
  }

  private async showProjects(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const environments = this.options.repository.listEnvironments(this.userId(ctx));
      const keyboard = new InlineKeyboard();
      let count = 0;
      for (const environment of environments) {
        const projects = await this.options.backend.listProjects(environment.id);
        for (const project of projects) {
          keyboard.text(`${environment.name} / ${project.title}`, `np:${project.id}`).row();
          count++;
        }
      }
      await ctx.reply(
        count ? "选择项目以创建真实 T3 线程：" : "没有可用项目。请先检查 /status。",
        count ? { reply_markup: keyboard } : {},
      );
    } catch (error) {
      this.logError(ctx, error, "projects");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async createAndBind(ctx: Context, projectId: string): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const found = await this.findProjectEnvironment(ctx, projectId);
      if (!found) return void (await ctx.reply("找不到所选项目，请重新执行 /projects。"));
      await this.requireCapability(found.environmentId, "threadCreate", "新建线程");
      const title = `Telegram ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const thread = await this.options.backend.createThread({
        environmentId: found.environmentId,
        projectId,
        title,
        runtimeMode: "auto",
      });
      const telegramThreadId = await this.ensureTelegramThread(ctx, thread.title);
      const binding = this.options.repository.saveBinding({
        userId: this.userId(ctx),
        telegramChatId: String(ctx.chat!.id),
        ...(telegramThreadId ? { telegramThreadId } : {}),
        environmentId: found.environmentId,
        t3ProjectId: projectId,
        t3ThreadId: thread.id,
        displayName: thread.title,
      });
      this.options.repository.setActiveBinding(binding.userId, binding.telegramChatId, binding.id);
      this.subscriptionManager.sync();
      await ctx.api.sendMessage(
        ctx.chat!.id,
        `✅ 已创建并绑定：${compactThreadName(thread)}\n现在直接发送编码指令即可。`,
        telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {},
      );
      await this.deleteNavigationMessage(ctx);
    } catch (error) {
      this.logError(ctx, error, "new_thread");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showThreads(ctx: Context, query: string): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const environments = this.options.repository.listEnvironments(this.userId(ctx));
      const keyboard = new InlineKeyboard();
      let count = 0;
      for (const environment of environments) {
        const threads = await this.options.backend.listThreads({
          environmentId: environment.id,
          ...(query.length >= 2 ? { query } : {}),
          limit: 10,
        });
        for (const thread of threads) {
          keyboard
            .text(`${environment.name} / ${thread.title}`.slice(0, 60), `at:${thread.id}`)
            .row();
          count++;
        }
      }
      await ctx.reply(
        count ? "选择要绑定的现有 T3 线程（不会克隆）：" : "没有找到线程。",
        count ? { reply_markup: keyboard } : {},
      );
    } catch (error) {
      this.logError(ctx, error, "attach_list");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async attachThread(ctx: Context, threadId: string): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const environments = this.options.repository.listEnvironments(this.userId(ctx));
      let found: { environmentId: string; thread: ThreadSummary } | undefined;
      for (const environment of environments) {
        const threads = await this.options.backend.listThreads({
          environmentId: environment.id,
          limit: 50,
        });
        const thread = threads.find((item) => item.id === threadId);
        if (thread) {
          found = { environmentId: environment.id, thread };
          break;
        }
      }
      if (!found) return void (await ctx.reply("该线程已不存在或已归档，请重新执行 /attach。"));
      const existingBinding = this.options.repository.findBindingForTarget(
        this.userId(ctx),
        String(ctx.chat!.id),
        found.environmentId,
        found.thread.id,
      );
      if (existingBinding) {
        const destination = await this.ensureExistingBindingTopic(
          ctx,
          existingBinding,
          found.thread.title,
        );
        this.options.repository.setActiveBinding(
          destination.userId,
          destination.telegramChatId,
          destination.id,
        );
        this.subscriptionManager.sync();
        await ctx.api.sendMessage(
          ctx.chat!.id,
          `✅ 该 T3 线程已经绑定，已复用原 Topic：${compactThreadName(found.thread)}`,
          destination.telegramThreadId
            ? { message_thread_id: Number(destination.telegramThreadId) }
            : {},
        );
        await this.deleteNavigationMessage(ctx);
        return;
      }
      const telegramThreadId = await this.ensureTelegramThread(ctx, found.thread.title);
      const binding = this.options.repository.saveBinding({
        userId: this.userId(ctx),
        telegramChatId: String(ctx.chat!.id),
        ...(telegramThreadId ? { telegramThreadId } : {}),
        environmentId: found.environmentId,
        t3ProjectId: found.thread.projectId,
        t3ThreadId: found.thread.id,
        displayName: found.thread.title,
      });
      this.options.repository.setActiveBinding(binding.userId, binding.telegramChatId, binding.id);
      this.subscriptionManager.sync();
      await ctx.api.sendMessage(
        ctx.chat!.id,
        `✅ 已绑定同一个 T3 线程：${compactThreadName(found.thread)}`,
        telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {},
      );
      await this.deleteNavigationMessage(ctx);
    } catch (error) {
      this.logError(ctx, error, "attach");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showStatus(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const userId = this.userId(ctx);
    const binding = this.binding(ctx);
    const environments = this.options.repository.listEnvironments(userId);
    if (!environments.length) return void (await ctx.reply("尚未配置环境。使用 /connect。"));
    const blocks: string[] = [];
    for (const environment of environments) {
      const status = await this.options.backend.connect(environment.id);
      const capabilities = await this.options.backend.getCapabilities(environment.id);
      blocks.push(
        `${environment.name} · T3 ${environment.serverVersion ?? "?"}\n状态：${status.state}\n${renderCapabilities(capabilities)}`,
      );
    }
    if (binding)
      blocks.unshift(
        `当前线程：${binding.displayName ?? binding.t3ThreadId} · ${shortId(binding.t3ThreadId)}\n后台监听：${this.options.repository.listBindings(userId).length} 个绑定 / ${this.subscriptionManager.activeCount()} 个 T3 线程`,
      );
    else
      blocks.unshift(
        `当前没有输入线程；后台仍监听 ${this.options.repository.listBindings(userId).length} 个绑定。`,
      );
    await ctx.reply(blocks.join("\n\n"));
  }

  private async showBackgroundThreads(ctx: Context, edit = false, notice?: string): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const userId = this.userId(ctx);
    const chatId = String(ctx.chat!.id);
    const bindings = this.options.repository
      .listBindings(userId)
      .filter((binding) => binding.telegramChatId === chatId);
    if (!bindings.length) {
      const text = [
        ...(notice ? [notice, ""] : []),
        "当前没有后台监听线程。请使用“➕ 新建线程”或“🔗 绑定线程”。",
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: new InlineKeyboard() });
      else await ctx.reply(text, { reply_markup: this.mainMenu() });
      return;
    }

    const active = this.topicsEnabled
      ? undefined
      : this.options.repository.resolveBinding(userId, chatId);
    const currentTopicId = messageThreadId(ctx);
    const keyboard = new InlineKeyboard();
    for (const binding of bindings) {
      const isCurrentTopic =
        currentTopicId !== undefined && binding.telegramThreadId === currentTopicId;
      const isDefault = active?.id === binding.id;
      const marker = isCurrentTopic ? "📍" : isDefault ? "✅" : "▫️";
      keyboard
        .text(
          `${marker} ${binding.displayName ?? shortId(binding.t3ThreadId)}`.slice(0, 60),
          `sb:${binding.id}`,
        )
        .text("🔓 解除", `bd:${binding.id}`)
        .row();
    }
    const text = [
      ...(notice ? [notice, ""] : []),
      `后台正在监听 ${bindings.length} 个绑定。`,
      this.topicsEnabled
        ? "📍 表示当前所在 Topic；点击线程会向目标 Topic 发送一条定位消息。"
        : "✅ 表示普通聊天里的默认输入线程。",
      this.topicsEnabled
        ? "请进入目标 Topic 后发送指令；“全部 / All”页的输入不会路由，以免串线。"
        : "点击线程可将它设为默认输入目标，切换不会停止其他监听。",
      "点击右侧“🔓 解除”可停止该绑定的后台监听；不会删除 T3 线程。",
    ].join("\n");
    if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
    else await ctx.reply(text, { reply_markup: keyboard });
  }

  private async requireManagedBinding(
    ctx: Context,
    bindingId: string,
  ): Promise<BindingRecord | undefined> {
    const binding = this.options.repository.findBinding(bindingId);
    if (
      !binding ||
      binding.userId !== this.userId(ctx) ||
      binding.telegramChatId !== String(ctx.chat!.id)
    ) {
      await ctx.answerCallbackQuery({
        text: "绑定已不存在或无权管理。",
        show_alert: true,
      });
      return undefined;
    }
    return binding;
  }

  private async stopTurn(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = this.binding(ctx);
    if (!binding) return void (await ctx.reply("当前没有绑定 T3 线程。"));
    try {
      const result = await interruptBoundTurn(this.options.backend, binding);
      await ctx.reply(result === "interrupted" ? "⏹ 已向 T3 发出中断请求。" : "该 turn 已结束。");
    } catch (error) {
      this.logError(ctx, error, "stop");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showDiff(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = this.binding(ctx);
    if (!binding) return void (await ctx.reply("当前没有绑定 T3 线程。"));
    try {
      await this.requireCapability(binding.environmentId, "diffThread", "Diff");
      const diff = await this.options.backend.getThreadDiff({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
      });
      await ctx.reply(
        `${binding.displayName ? `[${binding.displayName}]\n` : ""}${renderDiffSummary(diff)}`,
      );
    } catch (error) {
      this.logError(ctx, error, "diff");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showThreadSettings(
    ctx: Context,
    suppliedBinding?: BindingRecord,
    edit = false,
  ): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = suppliedBinding ?? this.binding(ctx);
    if (!binding) {
      await ctx.reply("请进入已经绑定的线程 Topic，再点击“🛠 线程设置”或发送 /threadsettings。");
      return;
    }
    try {
      const thread = await this.findBoundThread(binding);
      const mode = RUNTIME_MODES.find((item) => item.value === thread.runtimeMode);
      const model = thread.modelSelection
        ? `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`
        : "未记录";
      const text = [
        `🛠 ${binding.displayName ?? thread.title}`,
        `模型：${model}`,
        `权限：${mode?.label ?? thread.runtimeMode ?? "未知"}`,
        "",
        "设置会从下一条指令开始生效；正在运行的 turn 不会被打断。",
      ].join("\n");
      const keyboard = new InlineKeyboard()
        .text("🤖 修改模型", `tm:${binding.id}`)
        .row()
        .text("🔐 修改权限", `tr:${binding.id}`);
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_settings");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showThreadModelProviders(
    ctx: Context,
    binding: BindingRecord,
    edit: boolean,
  ): Promise<void> {
    try {
      const thread = await this.findBoundThread(binding);
      const providers = await this.availableModelProviders(binding.environmentId);
      if (!providers.length) {
        await ctx.reply("T3 当前没有已启用且可用的模型 Provider。");
        return;
      }
      const keyboard = new InlineKeyboard();
      providers.forEach((provider, index) => {
        const selected = thread.modelSelection?.instanceId === provider.instanceId ? "✅ " : "";
        const newThread = provider.requiresNewThreadForModelChange ? " · 仅新线程" : "";
        keyboard
          .text(
            `${selected}${provider.displayName} · ${provider.models.length} 个模型${newThread}`.slice(
              0,
              60,
            ),
            `tmp:${binding.id}:${index}`,
          )
          .row();
      });
      keyboard.text("↩️ 线程设置", `ts:${binding.id}`);
      const text = [
        `🤖 ${binding.displayName ?? thread.title}`,
        `当前：${thread.modelSelection ? `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}` : "未记录"}`,
        "",
        "选择 Provider：",
        "标注“仅新线程”的 Provider 无法在已有会话中更换模型。",
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_model_providers");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async showThreadProviderModels(
    ctx: Context,
    binding: BindingRecord,
    providerIndex: number,
    offset: number,
    edit: boolean,
  ): Promise<void> {
    try {
      const thread = await this.findBoundThread(binding);
      const providers = await this.availableModelProviders(binding.environmentId);
      const provider = providers[providerIndex];
      if (!provider) {
        throw new GatewayError(
          "Provider list changed",
          "provider_list_changed",
          "Provider 列表已变化，请重新打开线程设置。",
        );
      }
      const safeOffset = Math.min(
        Math.max(0, Math.floor(offset)),
        Math.max(0, provider.models.length - 1),
      );
      const keyboard = new InlineKeyboard();
      provider.models.slice(safeOffset, safeOffset + MODEL_PAGE_SIZE).forEach((model, index) => {
        const absoluteIndex = safeOffset + index;
        const selected =
          thread.modelSelection?.instanceId === provider.instanceId &&
          thread.modelSelection.model === model.slug;
        keyboard
          .text(
            `${selected ? "✅ " : model.isDefault ? "⭐ " : ""}${model.name}${model.isLegacy ? " · 旧版" : ""}`.slice(
              0,
              60,
            ),
            `tms:${binding.id}:${providerIndex}:${absoluteIndex}`,
          )
          .row();
      });
      if (safeOffset > 0)
        keyboard.text(
          "⬅️ 上一页",
          `tml:${binding.id}:${providerIndex}:${Math.max(0, safeOffset - MODEL_PAGE_SIZE)}`,
        );
      if (safeOffset + MODEL_PAGE_SIZE < provider.models.length)
        keyboard.text(
          "下一页 ➡️",
          `tml:${binding.id}:${providerIndex}:${safeOffset + MODEL_PAGE_SIZE}`,
        );
      keyboard.row().text("↩️ Provider", `tm:${binding.id}`);
      const text = [
        `🤖 ${provider.displayName}`,
        `${safeOffset + 1}–${Math.min(safeOffset + MODEL_PAGE_SIZE, provider.models.length)} / ${provider.models.length}`,
        provider.requiresNewThreadForModelChange
          ? "⚠️ 此 Provider 的模型只能在线程首次对话前切换。"
          : "选择后从下一条指令开始生效。",
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_provider_models");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async setThreadModel(
    ctx: Context,
    binding: BindingRecord,
    providerIndex: number,
    modelIndex: number,
  ): Promise<void> {
    try {
      const providers = await this.availableModelProviders(binding.environmentId);
      const provider = providers[providerIndex];
      const model = provider?.models[modelIndex];
      if (!provider || !model) {
        throw new GatewayError(
          "Model list changed",
          "model_list_changed",
          "模型列表已变化，请重新打开线程设置。",
        );
      }
      await this.options.backend.setThreadModel({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
        modelSelection: { instanceId: provider.instanceId, model: model.slug },
      });
      await ctx.answerCallbackQuery({ text: "线程模型已保存" });
      await ctx.editMessageText(
        [
          "✅ 已修改线程模型",
          `Provider：${provider.displayName}`,
          `模型：${model.name} (${model.slug})`,
          "",
          "下一条指令会使用该模型；T3 会在需要时自动重启底层会话。",
        ].join("\n"),
        { reply_markup: new InlineKeyboard().text("↩️ 线程设置", `ts:${binding.id}`) },
      );
    } catch (error) {
      this.logError(ctx, error, "set_thread_model");
      await ctx.answerCallbackQuery({ text: safeErrorMessage(error), show_alert: true });
    }
  }

  private async showThreadRuntimeModes(
    ctx: Context,
    binding: BindingRecord,
    edit: boolean,
  ): Promise<void> {
    try {
      const thread = await this.findBoundThread(binding);
      const keyboard = new InlineKeyboard();
      RUNTIME_MODES.forEach((mode, index) => {
        const selected = thread.runtimeMode === mode.value ? "✅ " : "";
        keyboard.text(`${selected}${mode.label}`, `trs:${binding.id}:${index}`).row();
      });
      keyboard.text("↩️ 线程设置", `ts:${binding.id}`);
      const descriptions = RUNTIME_MODES.map((mode) => `${mode.label}：${mode.detail}`);
      const text = [
        "🔐 选择线程权限模式",
        "",
        ...descriptions,
        "",
        "权限变更从下一条指令生效。",
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_runtime_modes");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private async confirmFullAccess(ctx: Context, binding: BindingRecord): Promise<void> {
    await ctx.editMessageText(
      [
        "⚠️ 确认启用完全访问？",
        "",
        "T3 将不再询问审批，并可在 T3 主机上绕过文件系统沙箱执行命令。错误指令可能修改工作区外的文件或系统状态。",
        "",
        "仅在你信任该线程中的所有后续指令时启用。",
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("确认完全访问", `trf:${binding.id}`)
          .row()
          .text("取消", `tr:${binding.id}`),
      },
    );
  }

  private async setThreadRuntimeMode(
    ctx: Context,
    binding: BindingRecord,
    modeIndex: number,
  ): Promise<void> {
    const mode = RUNTIME_MODES[modeIndex];
    if (!mode) {
      await ctx.answerCallbackQuery({
        text: "权限选项已失效，请重新打开线程设置。",
        show_alert: true,
      });
      return;
    }
    try {
      await this.options.backend.setThreadRuntimeMode({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
        runtimeMode: mode.value,
      });
      await ctx.answerCallbackQuery({ text: `已设置：${mode.label}` });
      await ctx.editMessageText(
        [
          "✅ 已修改线程权限",
          `当前模式：${mode.label}`,
          mode.detail,
          "",
          "下一条指令开始生效；当前 turn 不会被打断。",
        ].join("\n"),
        { reply_markup: new InlineKeyboard().text("↩️ 线程设置", `ts:${binding.id}`) },
      );
    } catch (error) {
      this.logError(ctx, error, "set_thread_runtime_mode");
      await ctx.answerCallbackQuery({ text: safeErrorMessage(error), show_alert: true });
    }
  }

  private async requireSettingsBinding(
    ctx: Context,
    bindingId: string,
  ): Promise<BindingRecord | undefined> {
    const binding = this.options.repository.findBinding(bindingId);
    const valid =
      binding &&
      binding.userId === this.userId(ctx) &&
      binding.telegramChatId === String(ctx.chat!.id) &&
      (!this.topicsEnabled || binding.telegramThreadId === messageThreadId(ctx));
    if (!valid) {
      await ctx.answerCallbackQuery({
        text: "线程设置已失效，或当前 Topic 与绑定不匹配。",
        show_alert: true,
      });
      return undefined;
    }
    return binding;
  }

  private async findBoundThread(binding: BindingRecord): Promise<ThreadSummary> {
    const thread = (
      await this.options.backend.listThreads({
        environmentId: binding.environmentId,
        limit: 50,
      })
    ).find((item) => item.id === binding.t3ThreadId);
    if (!thread) {
      throw new GatewayError(
        "Thread not found",
        "thread_not_found",
        "绑定的 T3 线程不存在或已归档。",
      );
    }
    return thread;
  }

  private async availableModelProviders(environmentId: string): Promise<ModelProviderSummary[]> {
    return (await this.options.backend.listModelProviders(environmentId)).filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status === "ready" &&
        provider.models.length > 0,
    );
  }

  private async showHistory(
    ctx: Context,
    offset: number,
    suppliedBinding?: BindingRecord,
    edit = false,
  ): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = suppliedBinding ?? this.binding(ctx);
    if (!binding) {
      await ctx.reply("请进入已经绑定的线程 Topic，再点击“📜 历史记录”或发送 /history。");
      return;
    }
    try {
      const history = await this.options.backend.getThreadHistory({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
      });
      if (!history.length) {
        const empty = `📜 ${binding.displayName ?? shortId(binding.t3ThreadId)}\n\n暂无历史消息。`;
        if (edit) await ctx.editMessageText(empty);
        else await ctx.reply(empty);
        return;
      }

      const safeOffset = Math.min(Math.max(0, Math.floor(offset)), Math.max(0, history.length - 1));
      const end = history.length - safeOffset;
      const start = Math.max(0, end - HISTORY_PAGE_SIZE);
      const page = history.slice(start, end);
      const blocks = page.map((message) => {
        const role = message.role === "user" ? "👤 你" : "🤖 T3";
        const time = message.createdAt
          ? ` · ${message.createdAt.replace("T", " ").slice(0, 16)}`
          : "";
        const trimmed = message.text.trim();
        const excerpt = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
        return `${role}${time}\n${excerpt}`;
      });
      const newestPage = Math.floor(safeOffset / HISTORY_PAGE_SIZE) + 1;
      const totalPages = Math.ceil(history.length / HISTORY_PAGE_SIZE);
      const text = [
        `📜 ${binding.displayName ?? shortId(binding.t3ThreadId)}`,
        `第 ${newestPage}/${totalPages} 页 · 显示 ${start + 1}–${end} / ${history.length} 条`,
        "",
        ...blocks.flatMap((block, index) => (index === 0 ? [block] : ["────────", block])),
      ].join("\n");
      const keyboard = new InlineKeyboard();
      if (start > 0) keyboard.text("⬅️ 更早", `hi:${binding.id}:${safeOffset + HISTORY_PAGE_SIZE}`);
      if (safeOffset > 0)
        keyboard.text("更晚 ➡️", `hi:${binding.id}:${Math.max(0, safeOffset - HISTORY_PAGE_SIZE)}`);

      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "history");
      const message = safeErrorMessage(error);
      if (edit)
        await ctx.answerCallbackQuery({ text: message, show_alert: true }).catch(() => undefined);
      else await ctx.reply(message);
    }
  }

  private async startBoundTurn(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    if (!text || text.startsWith("/")) return;
    const currentTopic = messageThreadId(ctx);
    if (this.topicsEnabled && currentTopic === undefined) {
      this.options.logger.warn(
        {
          telegram_chat_id: ctx.chat?.id,
          telegram_message_id: ctx.message?.message_id,
          telegram_is_topic_message: ctx.message?.is_topic_message ?? false,
          telegram_reply_thread_id: ctx.message?.reply_to_message?.message_thread_id,
          telegram_direct_messages_topic_id: ctx.message?.direct_messages_topic?.topic_id,
        },
        "refusing to route Telegram message without a topic id",
      );
      return void (await ctx.reply(
        "⚠️ Telegram 服务端没有为这条消息提供 Topic ID。为避免串线，消息没有发送给 T3。\n\n这也可能发生在客户端仍停留于已经失效或被重建的旧 Topic 页面。请返回 Topic 列表，重新进入目标 Topic 后再发送。",
      ));
    }
    const binding = this.binding(ctx);
    if (!binding) {
      return void (await ctx.reply(
        currentTopic
          ? "当前 Topic 没有绑定 T3 线程。请点击“🔗 绑定线程”；为避免串线，消息没有发送到默认线程。"
          : "当前没有绑定。使用 /new 或 /attach 选择 T3 线程。",
      ));
    }
    try {
      await this.requireCapability(binding.environmentId, "turnStart", "执行 turn");
    } catch (error) {
      this.logError(ctx, error, "turn_capability");
      await ctx.reply(safeErrorMessage(error));
      return;
    }
    const deduplicationKey = `telegram:${ctx.update.update_id}:${ctx.message!.message_id}`;
    if (!this.options.repository.claimTurnStart(deduplicationKey)) return;
    try {
      await this.options.backend.startTurn({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
        text,
        idempotencyKey: deduplicationKey,
      });
      this.options.logger.info(
        {
          telegram_chat_id: binding.telegramChatId,
          telegram_thread_id: messageThreadId(ctx),
          binding_id: binding.id,
          t3_thread_id: binding.t3ThreadId,
        },
        "routed Telegram message to T3 thread",
      );
      await ctx.api.sendMessage(
        chatTarget(binding.telegramChatId),
        `已交给 T3${binding.telegramThreadId ? "" : ` · ${binding.displayName ?? shortId(binding.t3ThreadId)}`}`,
        binding.telegramThreadId ? { message_thread_id: Number(binding.telegramThreadId) } : {},
      );
      this.subscriptionManager.sync();
    } catch (error) {
      this.logError(ctx, error, "turn_start");
      await ctx.reply(safeErrorMessage(error));
    }
  }

  private binding(ctx: Context): BindingRecord | undefined {
    const userId = this.userId(ctx);
    const chatId = String(ctx.chat!.id);
    const currentTopic = messageThreadId(ctx);
    if (this.topicsEnabled && currentTopic === undefined) return undefined;
    return this.options.repository.resolveBinding(userId, chatId, currentTopic);
  }

  private ensureDefaultBindings(): void {
    const seenChats = new Set<string>();
    for (const binding of this.options.repository.listBindings()) {
      if (!this.options.allowedUserIds.has(binding.telegramChatId)) continue;
      const key = `${binding.userId}\u0000${binding.telegramChatId}`;
      if (seenChats.has(key)) continue;
      seenChats.add(key);
      if (!this.options.repository.resolveBinding(binding.userId, binding.telegramChatId))
        this.options.repository.setActiveBinding(
          binding.userId,
          binding.telegramChatId,
          binding.id,
        );
    }
  }

  private userId(ctx: Context): string {
    const sourceId = ctx.from?.id ?? ctx.stoppedMessageGeneration?.chat.id;
    if (sourceId === undefined) throw new Error("Telegram user identity unavailable");
    return this.options.repository.ensureUser(String(sourceId));
  }

  private async findProjectEnvironment(
    ctx: Context,
    projectId: string,
  ): Promise<{ environmentId: string } | undefined> {
    const found = await this.findProject(ctx, projectId);
    return found ? { environmentId: found.environmentId } : undefined;
  }

  private async findProject(
    ctx: Context,
    projectId: string,
  ): Promise<{ environmentId: string; project: ProjectSummary } | undefined> {
    for (const environment of this.options.repository.listEnvironments(this.userId(ctx))) {
      const projects = await this.options.backend.listProjects(environment.id);
      const project = projects.find((item) => item.id === projectId);
      if (project) return { environmentId: environment.id, project };
    }
    return undefined;
  }

  private async ensureTelegramThread(ctx: Context, title: string): Promise<string | undefined> {
    if (!this.topicsEnabled) {
      const botInfo = await ctx.api.getMe();
      this.topicsEnabled = botInfo.has_topics_enabled === true;
    }
    if (!this.topicsEnabled) {
      await ctx.reply(
        "ℹ️ 当前机器人未启用私聊 Topics，将使用带线程名前缀的普通私聊后台监听。可在 @BotFather → Bot Settings → Topics 中开启。",
      );
      return undefined;
    }
    try {
      const topic = await ctx.api.createForumTopic(ctx.chat!.id, title.slice(0, 128));
      return String(topic.message_thread_id);
    } catch (error) {
      this.options.logger.warn(
        { err: error, telegram_chat_id: ctx.chat?.id },
        "failed to create Telegram topic; using flat-chat binding",
      );
      await ctx.reply(
        "⚠️ Telegram Topic 创建失败，已改用普通私聊绑定；后台回复会带线程名前缀。请检查 BotFather 的 Topics 设置。",
      );
      return undefined;
    }
  }

  private async ensureExistingBindingTopic(
    ctx: Context,
    binding: BindingRecord,
    title: string,
  ): Promise<BindingRecord> {
    if (!binding.telegramThreadId) return binding;
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, "typing", {
        message_thread_id: Number(binding.telegramThreadId),
      });
      return binding;
    } catch (error) {
      if (!this.isInvalidTopicError(error)) throw error;
    }

    const topic = await ctx.api.createForumTopic(ctx.chat!.id, title.slice(0, 128));
    return this.options.repository.saveBinding({
      userId: binding.userId,
      telegramChatId: binding.telegramChatId,
      telegramThreadId: String(topic.message_thread_id),
      environmentId: binding.environmentId,
      ...(binding.t3ProjectId ? { t3ProjectId: binding.t3ProjectId } : {}),
      t3ThreadId: binding.t3ThreadId,
      displayName: title,
    });
  }

  private async migrateFlatBindingsToTopics(): Promise<void> {
    const flatBindings = this.options.repository
      .listBindings()
      .filter(
        (binding) =>
          !binding.telegramThreadId && this.options.allowedUserIds.has(binding.telegramChatId),
      );
    for (const binding of flatBindings) {
      try {
        const wasActive =
          this.options.repository.resolveBinding(binding.userId, binding.telegramChatId)?.id ===
          binding.id;
        const topic = await this.bot.api.createForumTopic(
          chatTarget(binding.telegramChatId),
          (binding.displayName ?? `T3 ${shortId(binding.t3ThreadId)}`).slice(0, 128),
        );
        const migrated = this.options.repository.saveBinding({
          userId: binding.userId,
          telegramChatId: binding.telegramChatId,
          telegramThreadId: String(topic.message_thread_id),
          environmentId: binding.environmentId,
          ...(binding.t3ProjectId ? { t3ProjectId: binding.t3ProjectId } : {}),
          t3ThreadId: binding.t3ThreadId,
          ...(binding.displayName ? { displayName: binding.displayName } : {}),
        });
        if (wasActive)
          this.options.repository.setActiveBinding(
            migrated.userId,
            migrated.telegramChatId,
            migrated.id,
          );
        await this.bot.api.sendMessage(
          chatTarget(migrated.telegramChatId),
          `✅ 已将现有绑定迁移到独立 Topic：${migrated.displayName ?? shortId(migrated.t3ThreadId)}\n后续输入和后台回复都会留在这里。`,
          { message_thread_id: topic.message_thread_id },
        );
      } catch (error) {
        this.options.logger.warn(
          {
            err: error,
            telegram_chat_id: binding.telegramChatId,
            binding_id: binding.id,
          },
          "failed to migrate flat binding to Telegram topic",
        );
      }
    }
  }

  private async syncBindingTopicNames(): Promise<void> {
    const bindings = this.options.repository
      .listBindings()
      .filter(
        (binding) =>
          binding.telegramThreadId && this.options.allowedUserIds.has(binding.telegramChatId),
      );
    for (const binding of bindings) {
      try {
        await this.bot.api.sendChatAction(chatTarget(binding.telegramChatId), "typing", {
          message_thread_id: Number(binding.telegramThreadId),
        });
      } catch (error) {
        if (this.isInvalidTopicError(error)) {
          try {
            const topic = await this.bot.api.createForumTopic(
              chatTarget(binding.telegramChatId),
              (binding.displayName ?? `T3 ${shortId(binding.t3ThreadId)}`).slice(0, 128),
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
            this.options.repository.setActiveBinding(
              repaired.userId,
              repaired.telegramChatId,
              repaired.id,
            );
            await this.bot.api.sendMessage(
              chatTarget(repaired.telegramChatId),
              `✅ 已恢复绑定：${repaired.displayName ?? shortId(repaired.t3ThreadId)}\n原 Topic 已不存在，后台监听和 T3 会话保持不变。`,
              { message_thread_id: topic.message_thread_id },
            );
            continue;
          } catch (repairError) {
            this.options.logger.error(
              {
                err: repairError,
                telegram_chat_id: binding.telegramChatId,
                binding_id: binding.id,
              },
              "could not recreate missing Telegram topic",
            );
          }
        }
        this.options.logger.warn(
          {
            err: error,
            telegram_chat_id: binding.telegramChatId,
            telegram_thread_id: binding.telegramThreadId,
          },
          "could not validate Telegram binding topic",
        );
      }
    }
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

  private async requireCapability(
    environmentId: string,
    key: keyof BackendCapabilities,
    label: string,
  ): Promise<void> {
    const status = await this.options.backend.connect(environmentId);
    if (status.state !== "connected" && status.state !== "degraded") {
      throw new GatewayError(
        status.message ?? `T3 environment is ${status.state}`,
        "t3_unavailable",
        "T3 环境当前不可用，请用 /status 检查。",
      );
    }
    const capability = (await this.options.backend.getCapabilities(environmentId))[key];
    if (capability.state === "unknown" || capability.state === "unsupported") {
      throw new CapabilityUnsupportedError(label, capability.reason);
    }
  }

  private logError(ctx: Context, error: unknown, operation: string): void {
    this.options.logger.error(
      {
        err: error,
        operation,
        telegram_update_id: ctx.update.update_id,
        telegram_user_id: ctx.from?.id,
      },
      "telegram operation failed",
    );
  }
}
