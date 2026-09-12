import type { BotLocale, SupportedThreadRuntimeMode } from "@t3-vibe/core";

export type MenuKey = keyof typeof MENUS.zh;

export const MENUS = {
  zh: {
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
    language: "🌐 English",
  },
  en: {
    newProject: "🗂 New project",
    projectModel: "⚙️ Project model",
    newThread: "➕ New thread",
    attach: "🔗 Attach thread",
    backgroundThreads: "🧵 Background threads",
    history: "📜 History",
    threadSettings: "🛠 Thread settings",
    clearSessions: "🧹 Clear sessions",
    status: "📊 Status",
    stop: "⏹ Stop",
    diff: "🧾 Diff",
    environments: "🌐 Environments",
    connect: "🔌 Connect T3",
    detach: "🔓 Detach",
    help: "❓ Help",
    language: "🌐 中文",
  },
} as const;

export const CONTROL_MENU_KEYS: readonly MenuKey[] = [
  "newProject",
  "projectModel",
  "newThread",
  "attach",
  "backgroundThreads",
  "clearSessions",
  "status",
  "environments",
  "connect",
  "help",
  "language",
];

export function menuLabels(key: MenuKey): string[] {
  return [MENUS.zh[key], MENUS.en[key]];
}

export function detectLocale(languageCode?: string): BotLocale {
  return languageCode?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function tr(locale: BotLocale, zh: string, en: string): string {
  return locale === "zh" ? zh : en;
}

export const RUNTIME_MODES: ReadonlyArray<{
  value: SupportedThreadRuntimeMode;
  label: Record<BotLocale, string>;
  detail: Record<BotLocale, string>;
}> = [
  {
    value: "approval-required",
    label: { zh: "🔒 每次审批", en: "🔒 Ask every time" },
    detail: {
      zh: "只读沙箱；写文件和执行操作通常需要你确认。",
      en: "Read-only sandbox; file writes and actions usually require approval.",
    },
  },
  {
    value: "auto-accept-edits",
    label: { zh: "✍️ 自动批准编辑", en: "✍️ Auto-approve edits" },
    detail: {
      zh: "允许工作区写入；敏感命令仍会向你申请。",
      en: "Workspace writes are allowed; sensitive commands may still ask for approval.",
    },
  },
  {
    value: "auto",
    label: { zh: "🤖 自动审批", en: "🤖 Automatic approval" },
    detail: {
      zh: "允许工作区写入，并由 T3 自动审查审批请求。",
      en: "Workspace writes are allowed and T3 reviews approval requests automatically.",
    },
  },
  {
    value: "full-access",
    label: { zh: "⚠️ 完全访问", en: "⚠️ Full access" },
    detail: {
      zh: "不询问审批，且不使用文件系统沙箱。风险最高。",
      en: "No approval prompts and no filesystem sandbox. Highest risk.",
    },
  },
];
