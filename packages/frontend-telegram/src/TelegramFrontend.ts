import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import type {
  BackendCapabilities,
  BindingRecord,
  BotLocale,
  CodingBackend,
  EnvironmentConnector,
  GatewayRepository,
  ModelProviderSummary,
  PendingUserInputRecord,
  ProjectSummary,
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
import { buildUserInputView, completedUserInputText } from "./userInput.js";
import {
  CONTROL_MENU_KEYS,
  detectLocale,
  MENUS,
  menuLabels,
  RUNTIME_MODES,
  tr,
  type MenuKey,
} from "./localization.js";

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

/**
 * Legacy reply-keyboard updates can lose their private Topic identity. Only repair an absent
 * identity: overwriting a real Topic here makes binding-aware actions run against the console.
 */
export function routeControlMenuMessage(
  message: MutableTelegramTopicMessage,
  controlTopicId: string,
): boolean {
  if (
    message.message_thread_id !== undefined ||
    message.direct_messages_topic?.topic_id !== undefined
  )
    return false;
  const topicId = Number(controlTopicId);
  message.message_thread_id = topicId;
  message.is_topic_message = true;
  if (message.direct_messages_topic) message.direct_messages_topic.topic_id = topicId;
  return true;
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

const CONTROL_MENU_ACTIONS = CONTROL_MENU_KEYS.flatMap(menuLabels);

export function pendingMenuScopeKey(chatId: string | number, threadId?: string): string {
  return `${chatId}:${threadId ?? "root"}`;
}

export function buildMainMenu(locale: BotLocale, topicsEnabled: true): InlineKeyboard;
export function buildMainMenu(locale: BotLocale, topicsEnabled: false): Keyboard;
export function buildMainMenu(locale: BotLocale, topicsEnabled: boolean): Keyboard | InlineKeyboard;
export function buildMainMenu(
  locale: BotLocale,
  topicsEnabled: boolean,
): Keyboard | InlineKeyboard {
  const menu = MENUS[locale];
  if (topicsEnabled) {
    return new InlineKeyboard()
      .text(menu.newProject, "menu:newProject")
      .text(menu.projectModel, "menu:projectModel")
      .row()
      .text(menu.newThread, "menu:newThread")
      .text(menu.attach, "menu:attach")
      .row()
      .text(menu.backgroundThreads, "menu:backgroundThreads")
      .row()
      .text(menu.history, "menu:history")
      .text(menu.threadSettings, "menu:threadSettings")
      .row()
      .text(menu.status, "menu:status")
      .row()
      .text(menu.stop, "menu:stop")
      .text(menu.diff, "menu:diff")
      .row()
      .text(menu.environments, "menu:environments")
      .text(menu.connect, "menu:connect")
      .row()
      .text(menu.detach, "menu:detach")
      .text(menu.clearSessions, "menu:clearSessions")
      .row()
      .text(menu.help, "menu:help")
      .text(menu.language, "menu:language");
  }
  return new Keyboard()
    .text(menu.newProject)
    .text(menu.projectModel)
    .row()
    .text(menu.newThread)
    .text(menu.attach)
    .row()
    .text(menu.backgroundThreads)
    .row()
    .text(menu.history)
    .text(menu.threadSettings)
    .row()
    .text(menu.status)
    .row()
    .text(menu.stop)
    .text(menu.diff)
    .row()
    .text(menu.environments)
    .text(menu.connect)
    .row()
    .text(menu.detach)
    .text(menu.clearSessions)
    .row()
    .text(menu.help)
    .text(menu.language)
    .resized()
    .persistent();
}

const HISTORY_PAGE_SIZE = 6;
const MODEL_PAGE_SIZE = 8;

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
  private readonly removedLegacyKeyboards = new Set<string>();

  constructor(private readonly options: TelegramFrontendOptions) {
    this.bot = new Bot(options.token);
    this.subscriptionManager = new ThreadSubscriptionManager({
      api: this.bot.api,
      backend: options.backend,
      repository: options.repository,
      logger: options.logger,
      allowedUserIds: options.allowedUserIds,
      localeForUser: (userId) => options.repository.getUserLocale(userId) ?? "zh",
    });
    this.registerHandlers();
  }

  async initialize(): Promise<void> {
    await this.bot.init();
    await this.bot.api.setMyCommands(this.commands("en"));
    await this.bot.api.setMyCommands(this.commands("zh"), { language_code: "zh" });
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
        const locale = detectLocale(ctx.from?.language_code);
        if (ctx.message)
          await ctx.reply(
            tr(
              locale,
              "请在与机器人的私聊中使用 T3 网关。",
              "Use the T3 gateway in a private chat with the bot.",
            ),
          );
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({
            text: tr(locale, "仅支持私聊", "Private chats only"),
            show_alert: true,
          });
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
        const locale = detectLocale(ctx.from?.language_code);
        if (ctx.message)
          await ctx.reply(tr(locale, "无权使用此机器人。", "You are not allowed to use this bot."));
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({
            text: tr(locale, "无权操作", "Not authorized"),
            show_alert: true,
          });
        return;
      }
      if (this.options.repository.hasProcessedUpdate(ctx.update.update_id)) {
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({
            text: this.text(ctx, "该操作已处理", "This action was already handled"),
          });
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
          ? this.text(
              ctx,
              "T3 Vibe Gateway 已就绪。\n\n点击“🔌 连接 T3”开始配置。",
              "T3 Vibe Gateway is ready.\n\nTap “🔌 Connect T3” to get started.",
            )
          : this.text(
              ctx,
              `T3 Vibe Gateway 已就绪，已配置 ${environments.length} 个环境。\n请直接使用下方菜单，或发送编码指令。`,
              `T3 Vibe Gateway is ready with ${environments.length} environment(s).\nUse the menu below or send a coding instruction.`,
            ),
      );
    });

    this.bot.command("help", async (ctx) => this.showHelp(ctx));
    this.bot.command("menu", async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.sendControlPanel(
        String(ctx.chat!.id),
        this.text(ctx, "按钮菜单已恢复。", "The button menu has been restored."),
      );
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

    this.bot.callbackQuery(/^menu:([A-Za-z]+)$/, async (ctx) => {
      const key = ctx.match[1] as MenuKey;
      if (!Object.prototype.hasOwnProperty.call(MENUS.zh, key)) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "菜单操作已失效，请发送 /menu。", "This menu expired. Send /menu."),
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.handleInlineMenu(ctx, key);
    });

    this.bot.hears([...CONTROL_MENU_ACTIONS], async (ctx, next) => {
      if (await this.keepMenuActionInControlTopic(ctx)) await next();
    });

    this.bot.hears(menuLabels("newProject"), async (ctx) => this.beginProjectCreation(ctx));
    this.bot.hears(menuLabels("projectModel"), async (ctx) => this.showModelProjects(ctx));
    this.bot.hears(menuLabels("newThread"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.deleteNavigationMessage(ctx);
      await this.showProjects(ctx);
    });
    this.bot.hears(menuLabels("attach"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.deleteNavigationMessage(ctx);
      await this.showThreads(ctx, "");
    });
    this.bot.hears(menuLabels("status"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showStatus(ctx);
    });
    this.bot.hears(menuLabels("backgroundThreads"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showBackgroundThreads(ctx);
    });
    this.bot.hears(menuLabels("history"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showHistory(ctx, 0);
    });
    this.bot.hears(menuLabels("threadSettings"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showThreadSettings(ctx);
    });
    this.bot.hears(menuLabels("clearSessions"), async (ctx) => this.beginClearSessions(ctx));
    this.bot.hears(menuLabels("stop"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.stopTurn(ctx);
    });
    this.bot.hears(menuLabels("diff"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      await this.showDiff(ctx);
    });
    this.bot.hears(menuLabels("environments"), async (ctx) => this.showEnvironments(ctx));
    this.bot.hears(menuLabels("connect"), async (ctx) => this.beginConnection(ctx));
    this.bot.hears(menuLabels("detach"), async (ctx) => this.detachBinding(ctx));
    this.bot.hears(menuLabels("help"), async (ctx) => this.showHelp(ctx));
    this.bot.hears(menuLabels("language"), async (ctx) => {
      this.clearPendingMenuAction(ctx);
      const locale: BotLocale = ctx.message?.text === MENUS.zh.language ? "en" : "zh";
      await this.setLanguage(ctx, locale);
    });

    this.bot.callbackQuery(/^pc:(.+)$/, async (ctx) => {
      const pending = this.pendingMenuActions.get(this.pendingMenuKey(ctx));
      if (pending?.type !== "project_environment") {
        await ctx.answerCallbackQuery({
          text: this.text(
            ctx,
            "创建流程已失效，请重新点击新建项目。",
            "The creation flow expired. Tap New project again.",
          ),
        });
        return;
      }
      const environmentId = ctx.match[1]!;
      const environment = this.options.repository
        .listEnvironments(this.userId(ctx))
        .find((item) => item.id === environmentId);
      if (!environment) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "环境不存在或无权使用。", "Environment not found or inaccessible."),
          show_alert: true,
        });
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
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "该审批已处理或已失效", "This approval was handled or expired"),
          show_alert: true,
        });
        return;
      }
      const binding = this.options.repository.findBinding(pending.bindingId);
      if (!binding || binding.userId !== this.userId(ctx)) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "无权处理此审批", "You cannot handle this approval"),
          show_alert: true,
        });
        return;
      }
      const option = pending.options[optionIndex];
      if (!option || !this.options.repository.claimPendingApproval(approvalId)) {
        await ctx.answerCallbackQuery({
          text: this.text(
            ctx,
            "审批选项无效或已处理",
            "Invalid or already handled approval option",
          ),
          show_alert: true,
        });
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
        await ctx.answerCallbackQuery({
          text: this.text(ctx, `已提交：${option.label}`, `Submitted: ${option.label}`),
        });
        await ctx
          .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
          .catch(() => undefined);
      } catch (error) {
        this.options.repository.releasePendingApproval(approvalId);
        this.logError(ctx, error, "approval");
        await ctx.answerCallbackQuery({ text: this.errorText(ctx, error), show_alert: true });
      }
    });

    this.bot.callbackQuery(/^ui:([0-9a-f-]+):(\d+)$/, async (ctx) => {
      const pending = await this.requirePendingUserInput(ctx, ctx.match[1]!);
      if (!pending) return;
      const binding = this.options.repository.findBinding(pending.bindingId)!;
      const question = pending.request.questions[pending.questionIndex];
      const option = question?.options[Number(ctx.match[2])];
      if (!question || !option) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "选项已失效。", "This option expired."),
          show_alert: true,
        });
        return;
      }
      const answers = { ...pending.answers };
      if (question.multiSelect) {
        const values = new Set(Array.isArray(answers[question.id]) ? answers[question.id] : []);
        if (values.has(option.value)) values.delete(option.value);
        else values.add(option.value);
        answers[question.id] = [...values];
        const saved = this.options.repository.savePendingUserInput({
          bindingId: binding.id,
          t3RequestId: pending.t3RequestId,
          request: pending.request,
          answers,
          questionIndex: pending.questionIndex,
          awaitingCustomAnswer: false,
        });
        await ctx.answerCallbackQuery();
        await this.editPendingUserInput(ctx, binding, saved);
        return;
      }
      answers[question.id] = option.value;
      const saved = this.options.repository.savePendingUserInput({
        bindingId: binding.id,
        t3RequestId: pending.t3RequestId,
        request: pending.request,
        answers,
        questionIndex: pending.questionIndex + 1,
        awaitingCustomAnswer: false,
      });
      await ctx.answerCallbackQuery({ text: this.text(ctx, "正在提交…", "Submitting…") });
      if (saved.questionIndex >= saved.request.questions.length)
        await this.submitUserInput(ctx, binding, saved);
      else await this.editPendingUserInput(ctx, binding, saved);
    });

    this.bot.callbackQuery(/^uis:([0-9a-f-]+)$/, async (ctx) => {
      const pending = await this.requirePendingUserInput(ctx, ctx.match[1]!);
      if (!pending) return;
      const binding = this.options.repository.findBinding(pending.bindingId)!;
      const question = pending.request.questions[pending.questionIndex];
      const answer = question ? pending.answers[question.id] : undefined;
      if (!question || !Array.isArray(answer) || answer.length === 0) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "请至少选择一项。", "Choose at least one option."),
          show_alert: true,
        });
        return;
      }
      const saved = this.options.repository.savePendingUserInput({
        bindingId: binding.id,
        t3RequestId: pending.t3RequestId,
        request: pending.request,
        answers: pending.answers,
        questionIndex: pending.questionIndex + 1,
        awaitingCustomAnswer: false,
      });
      await ctx.answerCallbackQuery({ text: this.text(ctx, "已确认", "Confirmed") });
      if (saved.questionIndex >= saved.request.questions.length)
        await this.submitUserInput(ctx, binding, saved);
      else await this.editPendingUserInput(ctx, binding, saved);
    });

    this.bot.callbackQuery(/^uic:([0-9a-f-]+)$/, async (ctx) => {
      const pending = await this.requirePendingUserInput(ctx, ctx.match[1]!);
      if (!pending) return;
      const question = pending.request.questions[pending.questionIndex];
      if (!question?.allowCustomAnswer) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "不支持自定义回答。", "Custom answers are not allowed."),
          show_alert: true,
        });
        return;
      }
      this.options.repository.savePendingUserInput({
        bindingId: pending.bindingId,
        t3RequestId: pending.t3RequestId,
        request: pending.request,
        answers: pending.answers,
        questionIndex: pending.questionIndex,
        awaitingCustomAnswer: true,
      });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        this.text(
          ctx,
          `✍️ 请直接发送你的回答：\n${question.question}`,
          `✍️ Send your answer:\n${question.question}`,
        ),
      );
    });

    this.bot.callbackQuery(/^sb:([0-9a-f-]+)$/, async (ctx) => {
      const bindingId = ctx.match[1]!;
      const binding = this.options.repository.findBinding(bindingId);
      if (
        !binding ||
        binding.userId !== this.userId(ctx) ||
        binding.telegramChatId !== String(ctx.chat!.id)
      ) {
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "绑定已不存在或无权访问。", "Binding not found or inaccessible."),
          show_alert: true,
        });
        return;
      }
      if (this.topicsEnabled && binding.telegramThreadId) {
        await ctx.answerCallbackQuery({
          text: this.text(
            ctx,
            "已在目标 Topic 发送定位消息",
            "A locator was sent to the target topic",
          ),
        });
        await ctx.api.sendMessage(
          chatTarget(binding.telegramChatId),
          this.text(
            ctx,
            `📍 ${binding.displayName ?? shortId(binding.t3ThreadId)}\n请进入这个 Topic 后发送编码指令。`,
            `📍 ${binding.displayName ?? shortId(binding.t3ThreadId)}\nOpen this topic, then send your coding instruction.`,
          ),
          {
            message_thread_id: Number(binding.telegramThreadId),
            reply_markup: this.mainMenu(this.locale(ctx)),
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
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "绑定已不存在或无权访问。", "Binding not found or inaccessible."),
          show_alert: true,
        });
        return;
      }
      await ctx.answerCallbackQuery({
        text: this.text(ctx, "已切换默认输入线程", "Default input thread changed"),
      });
      await ctx.reply(
        this.text(
          ctx,
          `✅ 默认输入线程已切换为：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
          `✅ Default input thread: ${binding.displayName ?? shortId(binding.t3ThreadId)}`,
        ),
        { reply_markup: this.mainMenu(this.locale(ctx)) },
      );
    });

    this.bot.callbackQuery(/^bd:([0-9a-f-]+)$/, async (ctx) => {
      const binding = await this.requireManagedBinding(ctx, ctx.match[1]!);
      if (!binding) return;
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        this.text(
          ctx,
          [
            "🔓 确认解除 Telegram 绑定？",
            "",
            `线程：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
            "",
            "这会停止该绑定的后台监听，但不会归档或删除 T3 线程，之后仍可重新绑定。",
          ].join("\n"),
          [
            "🔓 Detach this Telegram binding?",
            "",
            `Thread: ${binding.displayName ?? shortId(binding.t3ThreadId)}`,
            "",
            "This stops its background listener without archiving or deleting the T3 thread. You can attach it again later.",
          ].join("\n"),
        ),
        {
          reply_markup: new InlineKeyboard()
            .text(this.text(ctx, "确认解除", "Detach"), `bdc:${binding.id}`)
            .row()
            .text(this.text(ctx, "取消", "Cancel"), "bdb"),
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
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "绑定已不存在。", "The binding no longer exists."),
          show_alert: true,
        });
        return;
      }
      this.subscriptionManager.sync();
      await ctx.answerCallbackQuery({
        text: this.text(ctx, "已解除 Telegram 绑定", "Telegram binding detached"),
      });
      if (binding.telegramThreadId) {
        await ctx.api
          .sendMessage(
            chatTarget(binding.telegramChatId),
            this.text(
              ctx,
              "🔓 此 Topic 已解除 T3 线程绑定；T3 线程本身未被修改，可从“绑定线程”重新绑定。",
              "🔓 This topic was detached from its T3 thread. The T3 thread was not changed and can be attached again.",
            ),
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
        this.text(
          ctx,
          `✅ 已解除：${binding.displayName ?? shortId(binding.t3ThreadId)}`,
          `✅ Detached: ${binding.displayName ?? shortId(binding.t3ThreadId)}`,
        ),
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
        await ctx.answerCallbackQuery({
          text: this.text(ctx, "清理确认已失效。", "The clear confirmation expired."),
          show_alert: true,
        });
        return;
      }
      this.pendingSessionClears.delete(confirmationId);
      await ctx.answerCallbackQuery({ text: this.text(ctx, "已取消", "Cancelled") });
      await ctx.editMessageText(
        this.text(
          ctx,
          "已取消清除，会话和绑定均未修改。",
          "Clear cancelled. Sessions and bindings were not changed.",
        ),
      );
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
          text: this.text(
            ctx,
            "历史记录绑定已失效或 Topic 不匹配。",
            "The history binding expired or the topic does not match.",
          ),
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
      if (await this.handleCustomUserInput(ctx)) return;
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

  private commands(locale: BotLocale) {
    const descriptions =
      locale === "zh"
        ? [
            "开始与连接状态",
            "重新显示按钮菜单",
            "连接 T3 环境",
            "列出 T3 环境",
            "列出项目",
            "新建 T3 项目",
            "设置项目默认模型",
            "新建并绑定 T3 线程",
            "绑定已有 T3 线程",
            "管理后台监听线程",
            "查看当前线程历史记录",
            "修改当前线程模型与权限",
            "连接与能力状态",
            "停止当前 turn",
            "查看当前线程 diff",
            "仅解除 Telegram 绑定",
            "使用帮助",
          ]
        : [
            "Start and connection status",
            "Restore the button menu",
            "Connect a T3 environment",
            "List T3 environments",
            "List projects",
            "Create a T3 project",
            "Set a project's default model",
            "Create and attach a T3 thread",
            "Attach an existing T3 thread",
            "Manage background thread listeners",
            "View current thread history",
            "Change current thread model and permissions",
            "Connection and capability status",
            "Stop the current turn",
            "View the current thread diff",
            "Detach from Telegram only",
            "Show help",
          ];
    const names = [
      "start",
      "menu",
      "connect",
      "environments",
      "projects",
      "newproject",
      "models",
      "new",
      "attach",
      "threads",
      "history",
      "threadsettings",
      "status",
      "stop",
      "diff",
      "detach",
      "help",
    ];
    return names.map((command, index) => ({ command, description: descriptions[index]! }));
  }

  private async handleInlineMenu(ctx: Context, key: MenuKey): Promise<void> {
    switch (key) {
      case "newProject":
        await this.beginProjectCreation(ctx);
        return;
      case "projectModel":
        await this.showModelProjects(ctx);
        return;
      case "newThread":
        await this.showProjects(ctx);
        return;
      case "attach":
        await this.showThreads(ctx, "");
        return;
      case "backgroundThreads":
        await this.showBackgroundThreads(ctx);
        return;
      case "history":
        await this.showHistory(ctx, 0);
        return;
      case "threadSettings":
        await this.showThreadSettings(ctx);
        return;
      case "clearSessions":
        await this.beginClearSessions(ctx);
        return;
      case "status":
        await this.showStatus(ctx);
        return;
      case "stop":
        await this.stopTurn(ctx);
        return;
      case "diff":
        await this.showDiff(ctx);
        return;
      case "environments":
        await this.showEnvironments(ctx);
        return;
      case "connect":
        await this.beginConnection(ctx);
        return;
      case "detach":
        await this.detachBinding(ctx);
        return;
      case "help":
        await this.showHelp(ctx);
        return;
      case "language": {
        const locale = this.locale(ctx) === "zh" ? "en" : "zh";
        await this.setLanguage(ctx, locale);
      }
    }
  }

  private async beginConnection(ctx: Context): Promise<void> {
    this.pendingMenuActions.set(this.pendingMenuKey(ctx), { type: "connect" });
    await ctx.reply(
      this.text(
        ctx,
        [
          "请在 T3 主机运行 `npx t3 pair` 获取一次性 token。",
          "然后发送一条消息：",
          "http://T3主机:3773 PAIRING_TOKEN",
          "",
          "同机运行可使用：http://127.0.0.1:3773 PAIRING_TOKEN",
        ].join("\n"),
        [
          "Run `npx t3 pair` on the T3 host to get a one-time token.",
          "Then send one message:",
          "http://T3-HOST:3773 PAIRING_TOKEN",
          "",
          "On the same host, use: http://127.0.0.1:3773 PAIRING_TOKEN",
        ].join("\n"),
      ),
    );
  }

  private async setLanguage(ctx: Context, locale: BotLocale): Promise<void> {
    this.clearPendingMenuAction(ctx);
    this.options.repository.setUserLocale(this.userId(ctx), locale);
    await this.sendControlPanel(
      String(ctx.chat!.id),
      tr(locale, "✅ 已切换为中文。", "✅ Switched to English."),
    );
  }

  private mainMenu(locale: BotLocale): Keyboard | InlineKeyboard {
    return buildMainMenu(locale, this.topicsEnabled);
  }

  private async restoreMainMenus(): Promise<void> {
    for (const telegramId of this.options.allowedUserIds) {
      try {
        const locale = this.localeForTelegramUser(telegramId);
        await this.sendControlPanel(
          telegramId,
          tr(
            locale,
            "🤖 T3 控制台已就绪。菜单操作固定在这里，不会再删除或改名当前 Topic。",
            "🤖 T3 Console is ready. Menu actions stay here and will not delete or rename this topic.",
          ),
          true,
        );
      } catch (error) {
        this.options.logger.warn(
          { err: error, telegram_chat_id: telegramId },
          "could not restore Telegram menu",
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
    const locale = this.localeForTelegramUser(chatId);
    const topic = await this.bot.api.createForumTopic(
      target,
      tr(locale, "🎛 T3 控制台", "🎛 T3 Console"),
    );
    const threadId = String(topic.message_thread_id);
    this.options.repository.saveTelegramControlTopic(chatId, threadId);
    return threadId;
  }

  private async sendControlPanel(chatId: string, text: string, silent = false): Promise<void> {
    const locale = this.localeForTelegramUser(chatId);
    const threadId = await this.ensureControlTopic(chatId);
    const target = chatTarget(chatId);
    if (threadId && !this.removedLegacyKeyboards.has(chatId)) {
      const removal = await this.bot.api.sendMessage(target, text, {
        message_thread_id: Number(threadId),
        ...(silent ? { disable_notification: true } : {}),
        reply_markup: { remove_keyboard: true },
      });
      this.removedLegacyKeyboards.add(chatId);
      await this.bot.api.sendMessage(target, text, {
        message_thread_id: Number(threadId),
        ...(silent ? { disable_notification: true } : {}),
        reply_markup: buildMainMenu(locale, true),
      });
      await this.bot.api
        .deleteMessage(target, removal.message_id)
        .catch((error: unknown) =>
          this.options.logger.debug(
            { err: error, telegram_chat_id: chatId },
            "could not delete legacy keyboard removal message",
          ),
        );
      return;
    }
    await this.bot.api.sendMessage(target, text, {
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      ...(silent ? { disable_notification: true } : {}),
      reply_markup: this.mainMenu(locale),
    });
  }

  private async keepMenuActionInControlTopic(ctx: Context): Promise<boolean> {
    if (!this.topicsEnabled) return true;
    const chatId = String(ctx.chat!.id);
    const controlTopic = await this.ensureControlTopic(chatId);
    if (!controlTopic || !ctx.message) return true;
    const sourceTopicId = messageThreadId(ctx);
    const repaired = routeControlMenuMessage(ctx.message, controlTopic);
    this.options.logger.debug(
      {
        telegram_chat_id: chatId,
        source_topic_id: sourceTopicId,
        control_topic_id: controlTopic,
        menu_action: ctx.message.text,
        repaired_missing_topic: repaired,
      },
      repaired
        ? "repaired missing topic on legacy Telegram control menu action"
        : "preserved Telegram topic on menu action",
    );
    return true;
  }

  private async beginProjectCreation(ctx: Context): Promise<void> {
    this.pendingMenuActions.set(this.pendingMenuKey(ctx), { type: "project_title" });
    await ctx.reply(
      this.text(
        ctx,
        "请输入新项目名称。\n\n点击其他菜单项可取消创建。",
        "Enter the new project name.\n\nTap another menu item to cancel.",
      ),
      {
        reply_markup: this.mainMenu(this.locale(ctx)),
      },
    );
  }

  private async handlePendingMenuInput(ctx: Context, pending: PendingMenuAction): Promise<void> {
    const input = ctx.message?.text?.trim() ?? "";
    if (pending.type === "connect") {
      const parsed = this.parseConnectionInput(input);
      if (!parsed) {
        await ctx.reply(
          this.text(
            ctx,
            "格式不正确，请发送：\nhttp://T3主机:3773 PAIRING_TOKEN\n\n点击其他菜单项可取消连接。",
            "Invalid format. Send:\nhttp://T3-HOST:3773 PAIRING_TOKEN\n\nTap another menu item to cancel.",
          ),
        );
        return;
      }
      this.clearPendingMenuAction(ctx);
      await this.connectEnvironment(ctx, input);
      return;
    }

    if (pending.type === "project_title") {
      if (!input || input.length > 200) {
        await ctx.reply(
          this.text(
            ctx,
            "项目名称不能为空，且不能超过 200 个字符。请重新输入。",
            "The project name must be 1–200 characters. Try again.",
          ),
        );
        return;
      }
      this.pendingMenuActions.set(this.pendingMenuKey(ctx), {
        type: "project_workspace",
        title: input,
      });
      await ctx.reply(
        this.text(
          ctx,
          "请输入工作区路径。该路径位于 T3 主机上；目录不存在时会自动创建。\n\n例如：/home/user/projects/my-app",
          "Enter the workspace path on the T3 host. A missing directory will be created.\n\nExample: /home/user/projects/my-app",
        ),
      );
      return;
    }

    if (pending.type === "project_workspace") {
      if (!input || input.length > 4096) {
        await ctx.reply(
          this.text(
            ctx,
            "工作区路径不能为空，且不能超过 4096 个字符。请重新输入。",
            "The workspace path must be 1–4096 characters. Try again.",
          ),
        );
        return;
      }
      const environments = this.options.repository.listEnvironments(this.userId(ctx));
      if (environments.length === 0) {
        this.clearPendingMenuAction(ctx);
        await ctx.reply(
          this.text(
            ctx,
            "尚未连接 T3 环境，请先点击“🔌 连接 T3”。",
            "No T3 environment is connected. Tap “🔌 Connect T3” first.",
          ),
        );
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
      await ctx.reply(
        this.text(
          ctx,
          "选择在哪个 T3 环境创建项目：",
          "Choose the T3 environment for this project:",
        ),
        { reply_markup: keyboard },
      );
      return;
    }

    await ctx.reply(
      this.text(
        ctx,
        "请选择上方的 T3 环境，或点击其他菜单项取消。",
        "Choose a T3 environment above, or tap another menu item to cancel.",
      ),
    );
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
        this.text(
          ctx,
          [
            `✅ 已创建 T3 项目：${project.title}`,
            `工作区：${project.workspaceRoot ?? workspaceRoot}`,
            "",
            "下一步请选择项目默认模型，然后即可新建线程。",
          ].join("\n"),
          [
            `✅ T3 project created: ${project.title}`,
            `Workspace: ${project.workspaceRoot ?? workspaceRoot}`,
            "",
            "Choose the project's default model, then create a thread.",
          ].join("\n"),
        ),
        { reply_markup: this.mainMenu(this.locale(ctx)) },
      );
      await this.showProjectModelProviders(ctx, project.id, environmentId);
    } catch (error) {
      this.logError(ctx, error, "project_create");
      await ctx.reply(this.errorText(ctx, error), {
        reply_markup: this.mainMenu(this.locale(ctx)),
      });
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
            : this.text(ctx, " · 未设置", " · Not set");
          keyboard
            .text(
              `${environment.name} / ${project.title}${current}`.slice(0, 60),
              `mp:${project.id}`,
            )
            .row();
          count++;
        }
      }
      await ctx.reply(
        count
          ? this.text(
              ctx,
              "选择要设置默认模型的项目：",
              "Choose a project to set its default model:",
            )
          : this.text(ctx, "当前没有可用项目。", "No projects are available."),
        {
          ...(count
            ? { reply_markup: keyboard }
            : { reply_markup: this.mainMenu(this.locale(ctx)) }),
        },
      );
    } catch (error) {
      this.logError(ctx, error, "model_projects");
      await ctx.reply(this.errorText(ctx, error));
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
        await ctx.reply(
          this.text(
            ctx,
            "项目尚未出现在 T3 快照中，请稍后点击“⚙️ 项目模型”重试。",
            "The project is not in the latest T3 snapshot yet. Try Project model again shortly.",
          ),
        );
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
        await ctx.reply(
          this.text(
            ctx,
            "T3 当前没有已启用且可用的模型 Provider。",
            "T3 has no enabled, ready model provider.",
          ),
        );
        return;
      }
      const keyboard = new InlineKeyboard();
      providers.forEach((provider, index) => {
        const selected =
          found.project!.defaultModelSelection?.instanceId === provider.instanceId ? "✅ " : "";
        keyboard
          .text(
            this.text(
              ctx,
              `${selected}${provider.displayName} · ${provider.models.length} 个模型`,
              `${selected}${provider.displayName} · ${provider.models.length} models`,
            ).slice(0, 60),
            `mpp:${projectId}:${index}`,
          )
          .row();
      });
      const current = found.project.defaultModelSelection
        ? `${found.project.defaultModelSelection.instanceId} / ${found.project.defaultModelSelection.model}`
        : this.text(ctx, "未设置", "Not set");
      await ctx.reply(
        this.text(
          ctx,
          `⚙️ ${found.project.title}\n当前默认模型：${current}\n\n请选择 Provider：`,
          `⚙️ ${found.project.title}\nCurrent default model: ${current}\n\nChoose a provider:`,
        ),
        { reply_markup: keyboard },
      );
    } catch (error) {
      this.logError(ctx, error, "model_providers");
      await ctx.reply(this.errorText(ctx, error));
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
            `${selected ? "✅ " : model.isDefault ? "⭐ " : ""}${model.name}${model.isLegacy ? this.text(ctx, " · 旧版", " · Legacy") : ""}`.slice(
              0,
              60,
            ),
            `mps:${projectId}:${providerIndex}:${absoluteIndex}`,
          )
          .row();
      });
      if (safeOffset > 0)
        keyboard.text(
          this.text(ctx, "⬅️ 上一页", "⬅️ Previous"),
          `mpl:${projectId}:${providerIndex}:${Math.max(0, safeOffset - MODEL_PAGE_SIZE)}`,
        );
      if (safeOffset + MODEL_PAGE_SIZE < provider.models.length)
        keyboard.text(
          this.text(ctx, "下一页 ➡️", "Next ➡️"),
          `mpl:${projectId}:${providerIndex}:${safeOffset + MODEL_PAGE_SIZE}`,
        );
      keyboard.row().text("↩️ Provider", `mp:${projectId}`);
      const text = this.text(
        ctx,
        `⚙️ ${found.project.title}\n${provider.displayName} · ${safeOffset + 1}–${Math.min(safeOffset + MODEL_PAGE_SIZE, provider.models.length)} / ${provider.models.length}\n\n请选择默认模型：`,
        `⚙️ ${found.project.title}\n${provider.displayName} · ${safeOffset + 1}–${Math.min(safeOffset + MODEL_PAGE_SIZE, provider.models.length)} / ${provider.models.length}\n\nChoose the default model:`,
      );
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "provider_models");
      await ctx.reply(this.errorText(ctx, error));
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
      await ctx.answerCallbackQuery({
        text: this.text(ctx, "默认模型已保存", "Default model saved"),
      });
      await ctx.editMessageText(
        this.text(
          ctx,
          `✅ 已设置项目默认模型\n\n项目：${found.project.title}\nProvider：${provider.displayName}\n模型：${model.name} (${model.slug})`,
          `✅ Project default model set\n\nProject: ${found.project.title}\nProvider: ${provider.displayName}\nModel: ${model.name} (${model.slug})`,
        ),
        {
          reply_markup: new InlineKeyboard()
            .text(this.menu(ctx, "newThread"), `np:${projectId}`)
            .row()
            .text(this.text(ctx, "⚙️ 更换模型", "⚙️ Change model"), `mp:${projectId}`),
        },
      );
    } catch (error) {
      this.logError(ctx, error, "set_project_model");
      await ctx.answerCallbackQuery({ text: this.errorText(ctx, error), show_alert: true });
    }
  }

  private async showHelp(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    await ctx.reply(
      this.text(
        ctx,
        [
          "使用下方菜单即可完成主要操作：",
          "🗂 新建项目 — 在 T3 主机创建工作区项目",
          "⚙️ 项目模型 — 为项目设置或更换默认 Provider/模型",
          "➕ 新建线程 — 选择项目并创建线程",
          "🔗 绑定线程 — 继续已有 T3 线程",
          "🧵 后台线程 — 查看所有监听并切换默认输入线程",
          "📜 历史记录 — 分页查看当前 T3 线程的用户与助手消息",
          "🛠 线程设置 — 修改当前线程的模型和运行权限",
          "🧹 清除会话 — 清除线程 Topic 和网关绑定，保留 T3 数据与控制台",
          "📊 状态 — 查看连接、绑定和能力",
          "⏹ 停止 — 中断当前 turn",
          "🧾 Diff — 查看文件变更摘要",
          "🌐 English — 切换界面语言",
          "",
          "绑定线程后，普通文本会直接发送到当前 T3 线程。所有保留的绑定都会在后台继续监听。",
          "启用 Telegram 私聊 Topics 后，每个 T3 线程会使用独立 Topic。斜杠命令仍保留作备用入口。",
        ].join("\n"),
        [
          "Use the menu below for the main actions:",
          "🗂 New project — create a workspace project on the T3 host",
          "⚙️ Project model — set or change a project's default provider/model",
          "➕ New thread — choose a project and create a thread",
          "🔗 Attach thread — continue an existing T3 thread",
          "🧵 Background threads — view listeners and change the default input",
          "📜 History — page through user and assistant messages",
          "🛠 Thread settings — change the thread model and runtime permissions",
          "🧹 Clear sessions — clear thread topics/bindings while keeping T3 data",
          "📊 Status — inspect connections, bindings, and capabilities",
          "⏹ Stop — interrupt the current turn",
          "🧾 Diff — view the file-change summary",
          "🌐 中文 — switch interface language",
          "",
          "After attaching, normal text is sent to the current T3 thread. Every retained binding continues listening in the background.",
          "With Telegram private Topics enabled, each T3 thread has its own topic. Slash commands remain available as a fallback.",
        ].join("\n"),
      ),
      { reply_markup: this.mainMenu(this.locale(ctx)) },
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
        this.text(
          ctx,
          "请发送：\nhttp://T3主机:3773 PAIRING_TOKEN\n\n可在 T3 主机运行 `npx t3 pair` 获取一次性 token。",
          "Send:\nhttp://T3-HOST:3773 PAIRING_TOKEN\n\nRun `npx t3 pair` on the T3 host to get a one-time token.",
        ),
        { reply_markup: this.mainMenu(this.locale(ctx)) },
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
      : this.text(
          ctx,
          "\n⚠️ 无法删除含 pairing token 的消息，请手动删除。",
          "\n⚠️ The message containing the pairing token could not be deleted. Delete it manually.",
        );
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
          ? this.text(
              ctx,
              `✅ 已连接 ${result.environment.name}（T3 ${result.environment.serverVersion ?? "未知版本"}）${deletionWarning}`,
              `✅ Connected to ${result.environment.name} (T3 ${result.environment.serverVersion ?? "unknown version"})${deletionWarning}`,
            )
          : this.text(
              ctx,
              `⚠️ 环境凭据已保存，但当前状态为 ${result.status.state}。请点击“📊 状态”检查。${deletionWarning}`,
              `⚠️ Credentials were saved, but the environment is ${result.status.state}. Check Status.${deletionWarning}`,
            ),
        { reply_markup: this.mainMenu(this.locale(ctx)) },
      );
    } catch (error) {
      this.logError(ctx, error, "connect");
      await ctx.api.sendMessage(ctx.chat!.id, `${this.errorText(ctx, error)}${deletionWarning}`, {
        reply_markup: this.mainMenu(this.locale(ctx)),
      });
    }
  }

  private async showEnvironments(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const environments = this.options.repository.listEnvironments(this.userId(ctx));
    if (!environments.length) {
      await ctx.reply(
        this.text(
          ctx,
          "尚未连接 T3 环境。点击“🔌 连接 T3”。",
          "No T3 environment is connected. Tap “🔌 Connect T3”.",
        ),
        {
          reply_markup: this.mainMenu(this.locale(ctx)),
        },
      );
      return;
    }
    await ctx.reply(
      environments
        .map(
          (env) =>
            `${env.status === "connected" ? "🟢" : "⚪️"} ${env.name} · ${shortId(env.id)} · T3 ${env.serverVersion ?? "?"}`,
        )
        .join("\n"),
      { reply_markup: this.mainMenu(this.locale(ctx)) },
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
    await ctx.reply(
      removed
        ? this.text(
            ctx,
            "已解除 Telegram 绑定；T3 线程未被修改。",
            "Telegram binding detached; the T3 thread was not changed.",
          )
        : this.text(ctx, "当前没有绑定。", "There is no current binding."),
      {
        reply_markup: this.mainMenu(this.locale(ctx)),
      },
    );
  }

  private async beginClearSessions(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const userId = this.userId(ctx);
    const chatId = String(ctx.chat!.id);
    const bindings = this.options.repository
      .listBindings(userId)
      .filter((binding) => binding.telegramChatId === chatId);
    if (!bindings.length) {
      await ctx.reply(
        this.text(
          ctx,
          "当前没有可清除的线程会话；T3 控制台会继续保留。",
          "There are no thread sessions to clear. The T3 Console remains available.",
        ),
        {
          reply_markup: this.mainMenu(this.locale(ctx)),
        },
      );
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
      this.text(
        ctx,
        [
          "⚠️ 确认清除所有 Telegram 会话记录？",
          "",
          `将解除 ${bindings.length} 个网关绑定，并删除 ${topicCount} 个线程 Topic 及其中的消息。`,
          ...(flatCount
            ? [`另有 ${flatCount} 个非 Topic 绑定只能解除；普通私聊消息无法由机器人清空。`]
            : []),
          "",
          "会保留：🎛 T3 控制台、T3 真实线程、项目、代码和环境连接。之后仍可重新绑定原线程。",
          "",
          "此操作不可恢复，确认按钮将在 10 分钟后失效。",
        ].join("\n"),
        [
          "⚠️ Clear all Telegram session history?",
          "",
          `This detaches ${bindings.length} gateway binding(s) and deletes ${topicCount} thread topic(s) with their messages.`,
          ...(flatCount
            ? [
                `Another ${flatCount} non-topic binding(s) can only be detached; bots cannot clear regular private-chat messages.`,
              ]
            : []),
          "",
          "Kept: 🎛 T3 Console, real T3 threads, projects, code, and environment connections. Threads can be attached again.",
          "",
          "This cannot be undone. The confirmation expires in 10 minutes.",
        ].join("\n"),
      ),
      {
        reply_markup: new InlineKeyboard()
          .text(this.text(ctx, "确认清除全部会话", "Clear all sessions"), `cac:${confirmationId}`)
          .row()
          .text(this.text(ctx, "取消", "Cancel"), `cax:${confirmationId}`),
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
        text: this.text(
          ctx,
          "清理确认已失效，请重新点击“🧹 清除会话”。",
          "The confirmation expired. Tap Clear sessions again.",
        ),
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
      await ctx.answerCallbackQuery({
        text: this.text(ctx, "这些会话已经清除。", "These sessions are already cleared."),
      });
      await ctx.editMessageText(
        this.text(
          ctx,
          "✅ 会话已经清除；T3 控制台仍然保留。",
          "✅ Sessions cleared; the T3 Console remains available.",
        ),
      );
      return;
    }

    await ctx.answerCallbackQuery({
      text: this.text(ctx, "正在逐个清除会话…", "Clearing sessions…"),
    });
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
      this.text(
        ctx,
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
        [
          failedTopics
            ? "⚠️ Session bindings were cleared, but some topics could not be deleted."
            : "✅ All sessions cleared.",
          "",
          `Bindings detached: ${removedBindings}`,
          `Thread topics deleted: ${deletedTopics}`,
          ...(failedTopics
            ? [
                `Failed deletions: ${failedTopics} (listeners stopped; delete them manually in Telegram)`,
              ]
            : []),
          "",
          "🎛 The T3 Console and all T3 threads, projects, and code were kept.",
        ].join("\n"),
      ),
    );
  }

  private pendingMenuKey(ctx: Context): string {
    const chatId = ctx.chat?.id ?? ctx.stoppedMessageGeneration?.chat.id ?? "unknown";
    return pendingMenuScopeKey(chatId, messageThreadId(ctx));
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
        count
          ? this.text(
              ctx,
              "选择项目以创建真实 T3 线程：",
              "Choose a project to create a T3 thread:",
            )
          : this.text(
              ctx,
              "没有可用项目。请先检查 /status。",
              "No projects are available. Check /status first.",
            ),
        count ? { reply_markup: keyboard } : {},
      );
    } catch (error) {
      this.logError(ctx, error, "projects");
      await ctx.reply(this.errorText(ctx, error));
    }
  }

  private async createAndBind(ctx: Context, projectId: string): Promise<void> {
    this.clearPendingMenuAction(ctx);
    try {
      const found = await this.findProjectEnvironment(ctx, projectId);
      if (!found)
        return void (await ctx.reply(
          this.text(
            ctx,
            "找不到所选项目，请重新执行 /projects。",
            "Project not found. Run /projects again.",
          ),
        ));
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
        this.text(
          ctx,
          `✅ 已创建并绑定：${compactThreadName(thread)}\n现在直接发送编码指令即可。`,
          `✅ Created and attached: ${compactThreadName(thread)}\nSend a coding instruction here.`,
        ),
        {
          ...(telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {}),
          reply_markup: this.mainMenu(this.locale(ctx)),
        },
      );
      await this.deleteNavigationMessage(ctx);
    } catch (error) {
      this.logError(ctx, error, "new_thread");
      await ctx.reply(this.errorText(ctx, error));
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
        count
          ? this.text(
              ctx,
              "选择要绑定的现有 T3 线程（不会克隆）：",
              "Choose an existing T3 thread to attach (it will not be cloned):",
            )
          : this.text(ctx, "没有找到线程。", "No threads found."),
        count ? { reply_markup: keyboard } : {},
      );
    } catch (error) {
      this.logError(ctx, error, "attach_list");
      await ctx.reply(this.errorText(ctx, error));
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
      if (!found)
        return void (await ctx.reply(
          this.text(
            ctx,
            "该线程已不存在或已归档，请重新执行 /attach。",
            "That thread no longer exists or is archived. Run /attach again.",
          ),
        ));
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
          this.text(
            ctx,
            `✅ 该 T3 线程已经绑定，已复用原 Topic：${compactThreadName(found.thread)}`,
            `✅ This T3 thread was already attached; reusing its topic: ${compactThreadName(found.thread)}`,
          ),
          {
            ...(destination.telegramThreadId
              ? { message_thread_id: Number(destination.telegramThreadId) }
              : {}),
            reply_markup: this.mainMenu(this.locale(ctx)),
          },
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
        this.text(
          ctx,
          `✅ 已绑定同一个 T3 线程：${compactThreadName(found.thread)}`,
          `✅ Attached to the same T3 thread: ${compactThreadName(found.thread)}`,
        ),
        {
          ...(telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {}),
          reply_markup: this.mainMenu(this.locale(ctx)),
        },
      );
      await this.deleteNavigationMessage(ctx);
    } catch (error) {
      this.logError(ctx, error, "attach");
      await ctx.reply(this.errorText(ctx, error));
    }
  }

  private async showStatus(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const userId = this.userId(ctx);
    const binding = this.binding(ctx);
    const environments = this.options.repository.listEnvironments(userId);
    if (!environments.length)
      return void (await ctx.reply(
        this.text(
          ctx,
          "尚未配置环境。使用 /connect。",
          "No environment is configured. Use /connect.",
        ),
      ));
    const blocks: string[] = [];
    for (const environment of environments) {
      const status = await this.options.backend.connect(environment.id);
      const capabilities = await this.options.backend.getCapabilities(environment.id);
      blocks.push(
        this.text(
          ctx,
          `${environment.name} · T3 ${environment.serverVersion ?? "?"}\n状态：${status.state}\n${renderCapabilities(capabilities)}`,
          `${environment.name} · T3 ${environment.serverVersion ?? "?"}\nStatus: ${status.state}\n${renderCapabilities(capabilities, "en")}`,
        ),
      );
    }
    if (binding)
      blocks.unshift(
        this.text(
          ctx,
          `当前线程：${binding.displayName ?? binding.t3ThreadId} · ${shortId(binding.t3ThreadId)}\n后台监听：${this.options.repository.listBindings(userId).length} 个绑定 / ${this.subscriptionManager.activeCount()} 个 T3 线程`,
          `Current thread: ${binding.displayName ?? binding.t3ThreadId} · ${shortId(binding.t3ThreadId)}\nBackground listeners: ${this.options.repository.listBindings(userId).length} binding(s) / ${this.subscriptionManager.activeCount()} T3 thread(s)`,
        ),
      );
    else
      blocks.unshift(
        this.text(
          ctx,
          `当前没有输入线程；后台仍监听 ${this.options.repository.listBindings(userId).length} 个绑定。`,
          `No current input thread; ${this.options.repository.listBindings(userId).length} binding(s) are still monitored in the background.`,
        ),
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
        this.text(
          ctx,
          "当前没有后台监听线程。请使用“➕ 新建线程”或“🔗 绑定线程”。",
          "No threads are being monitored. Use New thread or Attach thread.",
        ),
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: new InlineKeyboard() });
      else await ctx.reply(text, { reply_markup: this.mainMenu(this.locale(ctx)) });
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
        .text(this.text(ctx, "🔓 解除", "🔓 Detach"), `bd:${binding.id}`)
        .row();
    }
    const text = this.text(
      ctx,
      [
        ...(notice ? [notice, ""] : []),
        `后台正在监听 ${bindings.length} 个绑定。`,
        this.topicsEnabled
          ? "📍 表示当前所在 Topic；点击线程会向目标 Topic 发送一条定位消息。"
          : "✅ 表示普通聊天里的默认输入线程。",
        this.topicsEnabled
          ? "请进入目标 Topic 后发送指令；“全部 / All”页的输入不会路由，以免串线。"
          : "点击线程可将它设为默认输入目标，切换不会停止其他监听。",
        "点击右侧“🔓 解除”可停止该绑定的后台监听；不会删除 T3 线程。",
      ].join("\n"),
      [
        ...(notice ? [notice, ""] : []),
        `${bindings.length} binding(s) are monitored in the background.`,
        this.topicsEnabled
          ? "📍 marks the current topic; tapping a thread sends a locator to its topic."
          : "✅ marks the default input thread in a regular chat.",
        this.topicsEnabled
          ? "Open the target topic before sending instructions. Input on the All page is not routed to prevent cross-thread delivery."
          : "Tap a thread to make it the default input target. Other listeners keep running.",
        "Tap Detach on the right to stop that listener without deleting the T3 thread.",
      ].join("\n"),
    );
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
        text: this.text(ctx, "绑定已不存在或无权管理。", "Binding not found or inaccessible."),
        show_alert: true,
      });
      return undefined;
    }
    return binding;
  }

  private async stopTurn(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = this.binding(ctx);
    if (!binding)
      return void (await ctx.reply(
        this.text(ctx, "当前没有绑定 T3 线程。", "No T3 thread is attached here."),
      ));
    try {
      const result = await interruptBoundTurn(this.options.backend, binding);
      await ctx.reply(
        result === "interrupted"
          ? this.text(ctx, "⏹ 已向 T3 发出中断请求。", "⏹ Interrupt request sent to T3.")
          : this.text(ctx, "该 turn 已结束。", "The turn has already ended."),
      );
    } catch (error) {
      this.logError(ctx, error, "stop");
      await ctx.reply(this.errorText(ctx, error));
    }
  }

  private async showDiff(ctx: Context): Promise<void> {
    this.clearPendingMenuAction(ctx);
    const binding = this.binding(ctx);
    if (!binding)
      return void (await ctx.reply(
        this.text(ctx, "当前没有绑定 T3 线程。", "No T3 thread is attached here."),
      ));
    try {
      await this.requireCapability(binding.environmentId, "diffThread", "Diff");
      const diff = await this.options.backend.getThreadDiff({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
      });
      await ctx.reply(
        `${binding.displayName ? `[${binding.displayName}]\n` : ""}${renderDiffSummary(diff, this.locale(ctx))}`,
      );
    } catch (error) {
      this.logError(ctx, error, "diff");
      await ctx.reply(this.errorText(ctx, error));
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
      await ctx.reply(
        this.text(
          ctx,
          "请进入已经绑定的线程 Topic，再点击“🛠 线程设置”或发送 /threadsettings。",
          "Open an attached thread topic, then tap Thread settings or send /threadsettings.",
        ),
      );
      return;
    }
    try {
      const thread = await this.findBoundThread(binding);
      const mode = RUNTIME_MODES.find((item) => item.value === thread.runtimeMode);
      const model = thread.modelSelection
        ? `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`
        : this.text(ctx, "未记录", "Not recorded");
      const locale = this.locale(ctx);
      const text = this.text(
        ctx,
        [
          `🛠 ${binding.displayName ?? thread.title}`,
          `模型：${model}`,
          `权限：${mode?.label.zh ?? thread.runtimeMode ?? "未知"}`,
          "",
          "设置会从下一条指令开始生效；正在运行的 turn 不会被打断。",
        ].join("\n"),
        [
          `🛠 ${binding.displayName ?? thread.title}`,
          `Model: ${model}`,
          `Permissions: ${mode?.label.en ?? thread.runtimeMode ?? "Unknown"}`,
          "",
          "Settings take effect with the next instruction; a running turn is not interrupted.",
        ].join("\n"),
      );
      const keyboard = new InlineKeyboard()
        .text(tr(locale, "🤖 修改模型", "🤖 Change model"), `tm:${binding.id}`)
        .row()
        .text(tr(locale, "🔐 修改权限", "🔐 Change permissions"), `tr:${binding.id}`);
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_settings");
      await ctx.reply(this.errorText(ctx, error));
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
        await ctx.reply(
          this.text(
            ctx,
            "T3 当前没有已启用且可用的模型 Provider。",
            "T3 has no enabled, ready model provider.",
          ),
        );
        return;
      }
      const keyboard = new InlineKeyboard();
      providers.forEach((provider, index) => {
        const selected = thread.modelSelection?.instanceId === provider.instanceId ? "✅ " : "";
        const newThread = provider.requiresNewThreadForModelChange
          ? this.text(ctx, " · 仅新线程", " · New threads only")
          : "";
        keyboard
          .text(
            this.text(
              ctx,
              `${selected}${provider.displayName} · ${provider.models.length} 个模型${newThread}`,
              `${selected}${provider.displayName} · ${provider.models.length} models${newThread}`,
            ).slice(0, 60),
            `tmp:${binding.id}:${index}`,
          )
          .row();
      });
      keyboard.text(this.text(ctx, "↩️ 线程设置", "↩️ Thread settings"), `ts:${binding.id}`);
      const selectedModel = thread.modelSelection
        ? `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`
        : this.text(ctx, "未记录", "Not recorded");
      const text = this.text(
        ctx,
        `🤖 ${binding.displayName ?? thread.title}\n当前：${selectedModel}\n\n选择 Provider：\n标注“仅新线程”的 Provider 无法在已有会话中更换模型。`,
        `🤖 ${binding.displayName ?? thread.title}\nCurrent: ${selectedModel}\n\nChoose a provider:\nProviders marked “New threads only” cannot change models in an existing session.`,
      );
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_model_providers");
      await ctx.reply(this.errorText(ctx, error));
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
            `${selected ? "✅ " : model.isDefault ? "⭐ " : ""}${model.name}${model.isLegacy ? this.text(ctx, " · 旧版", " · Legacy") : ""}`.slice(
              0,
              60,
            ),
            `tms:${binding.id}:${providerIndex}:${absoluteIndex}`,
          )
          .row();
      });
      if (safeOffset > 0)
        keyboard.text(
          this.text(ctx, "⬅️ 上一页", "⬅️ Previous"),
          `tml:${binding.id}:${providerIndex}:${Math.max(0, safeOffset - MODEL_PAGE_SIZE)}`,
        );
      if (safeOffset + MODEL_PAGE_SIZE < provider.models.length)
        keyboard.text(
          this.text(ctx, "下一页 ➡️", "Next ➡️"),
          `tml:${binding.id}:${providerIndex}:${safeOffset + MODEL_PAGE_SIZE}`,
        );
      keyboard.row().text("↩️ Provider", `tm:${binding.id}`);
      const text = [
        `🤖 ${provider.displayName}`,
        `${safeOffset + 1}–${Math.min(safeOffset + MODEL_PAGE_SIZE, provider.models.length)} / ${provider.models.length}`,
        provider.requiresNewThreadForModelChange
          ? this.text(
              ctx,
              "⚠️ 此 Provider 的模型只能在线程首次对话前切换。",
              "⚠️ Models from this provider can only be changed before the thread's first turn.",
            )
          : this.text(
              ctx,
              "选择后从下一条指令开始生效。",
              "The selection takes effect with the next instruction.",
            ),
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_provider_models");
      await ctx.reply(this.errorText(ctx, error));
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
      await ctx.answerCallbackQuery({
        text: this.text(ctx, "线程模型已保存", "Thread model saved"),
      });
      await ctx.editMessageText(
        this.text(
          ctx,
          `✅ 已修改线程模型\nProvider：${provider.displayName}\n模型：${model.name} (${model.slug})\n\n下一条指令会使用该模型；T3 会在需要时自动重启底层会话。`,
          `✅ Thread model changed\nProvider: ${provider.displayName}\nModel: ${model.name} (${model.slug})\n\nThe next instruction uses this model. T3 restarts the provider session when needed.`,
        ),
        {
          reply_markup: new InlineKeyboard().text(
            this.text(ctx, "↩️ 线程设置", "↩️ Thread settings"),
            `ts:${binding.id}`,
          ),
        },
      );
    } catch (error) {
      this.logError(ctx, error, "set_thread_model");
      await ctx.answerCallbackQuery({ text: this.errorText(ctx, error), show_alert: true });
    }
  }

  private async showThreadRuntimeModes(
    ctx: Context,
    binding: BindingRecord,
    edit: boolean,
  ): Promise<void> {
    try {
      const thread = await this.findBoundThread(binding);
      const locale = this.locale(ctx);
      const keyboard = new InlineKeyboard();
      RUNTIME_MODES.forEach((mode, index) => {
        const selected = thread.runtimeMode === mode.value ? "✅ " : "";
        keyboard.text(`${selected}${mode.label[locale]}`, `trs:${binding.id}:${index}`).row();
      });
      keyboard.text(tr(locale, "↩️ 线程设置", "↩️ Thread settings"), `ts:${binding.id}`);
      const descriptions = RUNTIME_MODES.map(
        (mode) => `${mode.label[locale]}${locale === "zh" ? "：" : ": "}${mode.detail[locale]}`,
      );
      const text = [
        tr(locale, "🔐 选择线程权限模式", "🔐 Choose thread permission mode"),
        "",
        ...descriptions,
        "",
        tr(
          locale,
          "权限变更从下一条指令生效。",
          "Permission changes take effect with the next instruction.",
        ),
      ].join("\n");
      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "thread_runtime_modes");
      await ctx.reply(this.errorText(ctx, error));
    }
  }

  private async confirmFullAccess(ctx: Context, binding: BindingRecord): Promise<void> {
    await ctx.editMessageText(
      this.text(
        ctx,
        "⚠️ 确认启用完全访问？\n\nT3 将不再询问审批，并可在 T3 主机上绕过文件系统沙箱执行命令。错误指令可能修改工作区外的文件或系统状态。\n\n仅在你信任该线程中的所有后续指令时启用。",
        "⚠️ Enable full access?\n\nT3 will stop asking for approvals and can run commands on the T3 host without the filesystem sandbox. Incorrect instructions may modify files or system state outside the workspace.\n\nEnable this only if you trust every future instruction in this thread.",
      ),
      {
        reply_markup: new InlineKeyboard()
          .text(this.text(ctx, "确认完全访问", "Enable full access"), `trf:${binding.id}`)
          .row()
          .text(this.text(ctx, "取消", "Cancel"), `tr:${binding.id}`),
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
        text: this.text(
          ctx,
          "权限选项已失效，请重新打开线程设置。",
          "The permission option expired. Open Thread settings again.",
        ),
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
      const locale = this.locale(ctx);
      await ctx.answerCallbackQuery({
        text: tr(locale, `已设置：${mode.label.zh}`, `Set: ${mode.label.en}`),
      });
      await ctx.editMessageText(
        [
          tr(locale, "✅ 已修改线程权限", "✅ Thread permissions changed"),
          tr(locale, `当前模式：${mode.label.zh}`, `Current mode: ${mode.label.en}`),
          mode.detail[locale],
          "",
          tr(
            locale,
            "下一条指令开始生效；当前 turn 不会被打断。",
            "This takes effect with the next instruction; the current turn is not interrupted.",
          ),
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard().text(
            tr(locale, "↩️ 线程设置", "↩️ Thread settings"),
            `ts:${binding.id}`,
          ),
        },
      );
    } catch (error) {
      this.logError(ctx, error, "set_thread_runtime_mode");
      await ctx.answerCallbackQuery({ text: this.errorText(ctx, error), show_alert: true });
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
        text: this.text(
          ctx,
          "线程设置已失效，或当前 Topic 与绑定不匹配。",
          "Thread settings expired or this topic does not match the binding.",
        ),
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

  private async requirePendingUserInput(
    ctx: Context,
    id: string,
  ): Promise<PendingUserInputRecord | undefined> {
    const pending = this.options.repository.findPendingUserInput(id);
    const binding = pending && this.options.repository.findBinding(pending.bindingId);
    const valid =
      pending?.status === "pending" &&
      binding &&
      binding.userId === this.userId(ctx) &&
      binding.telegramChatId === String(ctx.chat!.id) &&
      (!this.topicsEnabled || binding.telegramThreadId === messageThreadId(ctx));
    if (!valid) {
      await ctx.answerCallbackQuery({
        text: this.text(
          ctx,
          "该问题已处理、已失效，或不属于当前 Topic。",
          "This question was handled, expired, or belongs to another topic.",
        ),
        show_alert: true,
      });
      return undefined;
    }
    return pending;
  }

  private async editPendingUserInput(
    ctx: Context,
    binding: BindingRecord,
    pending: PendingUserInputRecord,
  ): Promise<void> {
    if (!pending.telegramMessageId) return;
    const view = buildUserInputView(pending, this.locale(ctx));
    await ctx.api.editMessageText(
      chatTarget(binding.telegramChatId),
      Number(pending.telegramMessageId),
      view.text,
      { reply_markup: view.keyboard },
    );
  }

  private async submitUserInput(
    ctx: Context,
    binding: BindingRecord,
    pending: PendingUserInputRecord,
  ): Promise<void> {
    if (!this.options.repository.claimPendingUserInput(pending.id)) return;
    try {
      await this.options.backend.respondToUserInput({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
        requestId: pending.t3RequestId,
        answers: pending.answers,
      });
      this.options.repository.resolvePendingUserInput(pending.id);
      if (pending.telegramMessageId)
        await ctx.api.editMessageText(
          chatTarget(binding.telegramChatId),
          Number(pending.telegramMessageId),
          completedUserInputText(pending, this.locale(ctx)),
          { reply_markup: { inline_keyboard: [] } },
        );
      this.subscriptionManager.sync();
    } catch (error) {
      this.options.repository.releasePendingUserInput(pending.id);
      this.logError(ctx, error, "user_input");
      await ctx.reply(this.errorText(ctx, error));
    }
  }

  private async handleCustomUserInput(ctx: Context): Promise<boolean> {
    const binding = this.binding(ctx);
    if (!binding) return false;
    const pending = this.options.repository.findPendingUserInputForBinding(binding.id);
    if (!pending?.awaitingCustomAnswer) return false;
    const question = pending.request.questions[pending.questionIndex];
    const answer = ctx.message?.text?.trim();
    if (!question || !answer) return false;
    const saved = this.options.repository.savePendingUserInput({
      bindingId: binding.id,
      t3RequestId: pending.t3RequestId,
      request: pending.request,
      answers: { ...pending.answers, [question.id]: answer },
      questionIndex: pending.questionIndex + 1,
      awaitingCustomAnswer: false,
    });
    if (saved.questionIndex >= saved.request.questions.length)
      await this.submitUserInput(ctx, binding, saved);
    else await this.editPendingUserInput(ctx, binding, saved);
    return true;
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
      await ctx.reply(
        this.text(
          ctx,
          "请进入已经绑定的线程 Topic，再点击“📜 历史记录”或发送 /history。",
          "Open an attached thread topic, then tap History or send /history.",
        ),
      );
      return;
    }
    try {
      const history = await this.options.backend.getThreadHistory({
        environmentId: binding.environmentId,
        threadId: binding.t3ThreadId,
      });
      if (!history.length) {
        const empty = this.text(
          ctx,
          `📜 ${binding.displayName ?? shortId(binding.t3ThreadId)}\n\n暂无历史消息。`,
          `📜 ${binding.displayName ?? shortId(binding.t3ThreadId)}\n\nNo history yet.`,
        );
        if (edit) await ctx.editMessageText(empty);
        else await ctx.reply(empty);
        return;
      }

      const safeOffset = Math.min(Math.max(0, Math.floor(offset)), Math.max(0, history.length - 1));
      const end = history.length - safeOffset;
      const start = Math.max(0, end - HISTORY_PAGE_SIZE);
      const page = history.slice(start, end);
      const blocks = page.map((message) => {
        const role = message.role === "user" ? this.text(ctx, "👤 你", "👤 You") : "🤖 T3";
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
        this.text(
          ctx,
          `第 ${newestPage}/${totalPages} 页 · 显示 ${start + 1}–${end} / ${history.length} 条`,
          `Page ${newestPage}/${totalPages} · Showing ${start + 1}–${end} / ${history.length}`,
        ),
        "",
        ...blocks.flatMap((block, index) => (index === 0 ? [block] : ["────────", block])),
      ].join("\n");
      const keyboard = new InlineKeyboard();
      if (start > 0)
        keyboard.text(
          this.text(ctx, "⬅️ 更早", "⬅️ Older"),
          `hi:${binding.id}:${safeOffset + HISTORY_PAGE_SIZE}`,
        );
      if (safeOffset > 0)
        keyboard.text(
          this.text(ctx, "更晚 ➡️", "Newer ➡️"),
          `hi:${binding.id}:${Math.max(0, safeOffset - HISTORY_PAGE_SIZE)}`,
        );

      if (edit) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (error) {
      this.logError(ctx, error, "history");
      const message = this.errorText(ctx, error);
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
        this.text(
          ctx,
          "⚠️ Telegram 服务端没有为这条消息提供 Topic ID。为避免串线，消息没有发送给 T3。\n\n这也可能发生在客户端仍停留于已经失效或被重建的旧 Topic 页面。请返回 Topic 列表，重新进入目标 Topic 后再发送。",
          "⚠️ Telegram did not provide a Topic ID for this message, so it was not sent to T3 to prevent cross-thread delivery.\n\nYou may still be viewing an old topic that was removed or rebuilt. Return to the topic list, reopen the target topic, and send again.",
        ),
      ));
    }
    const binding = this.binding(ctx);
    if (!binding) {
      return void (await ctx.reply(
        currentTopic
          ? this.text(
              ctx,
              "当前 Topic 没有绑定 T3 线程。请点击“🔗 绑定线程”；为避免串线，消息没有发送到默认线程。",
              "This topic has no T3 thread binding. Tap Attach thread. The message was not sent to a default thread.",
            )
          : this.text(
              ctx,
              "当前没有绑定。使用 /new 或 /attach 选择 T3 线程。",
              "Nothing is attached. Use /new or /attach to choose a T3 thread.",
            ),
      ));
    }
    try {
      await this.requireCapability(binding.environmentId, "turnStart", "执行 turn");
    } catch (error) {
      this.logError(ctx, error, "turn_capability");
      await ctx.reply(this.errorText(ctx, error));
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
        this.text(
          ctx,
          `已交给 T3${binding.telegramThreadId ? "" : ` · ${binding.displayName ?? shortId(binding.t3ThreadId)}`}`,
          `Sent to T3${binding.telegramThreadId ? "" : ` · ${binding.displayName ?? shortId(binding.t3ThreadId)}`}`,
        ),
        {
          ...(binding.telegramThreadId
            ? { message_thread_id: Number(binding.telegramThreadId) }
            : {}),
          reply_markup: this.mainMenu(this.locale(ctx)),
        },
      );
      this.subscriptionManager.sync();
    } catch (error) {
      this.logError(ctx, error, "turn_start");
      await ctx.reply(this.errorText(ctx, error));
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

  private locale(ctx: Context): BotLocale {
    const userId = this.userId(ctx);
    const stored = this.options.repository.getUserLocale(userId);
    if (stored) return stored;
    const locale = detectLocale(ctx.from?.language_code);
    this.options.repository.setUserLocale(userId, locale);
    return locale;
  }

  private localeForTelegramUser(telegramUserId: string): BotLocale {
    const userId = this.options.repository.findUserId(telegramUserId);
    return userId ? (this.options.repository.getUserLocale(userId) ?? "zh") : "zh";
  }

  private text(ctx: Context, zh: string, en: string): string {
    return tr(this.locale(ctx), zh, en);
  }

  private menu(ctx: Context, key: MenuKey): string {
    return MENUS[this.locale(ctx)][key];
  }

  private errorText(ctx: Context, error: unknown): string {
    if (this.locale(ctx) === "zh") return safeErrorMessage(error);
    if (error instanceof CapabilityUnsupportedError)
      return "This T3 environment does not support that capability.";
    if (error instanceof GatewayError) {
      const known: Record<string, string> = {
        project_not_found: "Project not found.",
        thread_not_found: "The attached T3 thread no longer exists or is archived.",
        provider_list_changed: "The provider list changed. Please open the selection again.",
        model_list_changed: "The model list changed. Please open the selection again.",
        t3_unavailable: "The T3 environment is unavailable. Check /status.",
      };
      return known[error.code] ?? error.message;
    }
    return "The operation failed. Check the connection with /status.";
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
        this.text(
          ctx,
          "ℹ️ 当前机器人未启用私聊 Topics，将使用带线程名前缀的普通私聊后台监听。可在 @BotFather → Bot Settings → Topics 中开启。",
          "ℹ️ Private-chat Topics are disabled for this bot. Background replies will use thread-name prefixes. Enable Topics in @BotFather → Bot Settings → Topics.",
        ),
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
        this.text(
          ctx,
          "⚠️ Telegram Topic 创建失败，已改用普通私聊绑定；后台回复会带线程名前缀。请检查 BotFather 的 Topics 设置。",
          "⚠️ Telegram could not create a topic, so a regular private-chat binding is being used. Background replies include a thread prefix. Check the Topics setting in BotFather.",
        ),
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
          tr(
            this.options.repository.getUserLocale(migrated.userId) ?? "zh",
            `✅ 已将现有绑定迁移到独立 Topic：${migrated.displayName ?? shortId(migrated.t3ThreadId)}\n后续输入和后台回复都会留在这里。`,
            `✅ Existing binding moved to its own topic: ${migrated.displayName ?? shortId(migrated.t3ThreadId)}\nFuture input and background replies stay here.`,
          ),
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
              tr(
                this.options.repository.getUserLocale(repaired.userId) ?? "zh",
                `✅ 已恢复绑定：${repaired.displayName ?? shortId(repaired.t3ThreadId)}\n原 Topic 已不存在，后台监听和 T3 会话保持不变。`,
                `✅ Binding restored: ${repaired.displayName ?? shortId(repaired.t3ThreadId)}\nThe old topic no longer exists; the background listener and T3 session were preserved.`,
              ),
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
