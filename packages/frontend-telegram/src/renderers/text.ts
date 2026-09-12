import type { BackendCapabilities, BotLocale, DiffSummary, ThreadSummary } from "@t3-vibe/core";

export function chunkTelegramText(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let split = remaining.lastIndexOf("\n", maxLength);
    if (split < maxLength * 0.5) split = remaining.lastIndexOf(" ", maxLength);
    if (split < maxLength * 0.5) split = maxLength;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function compactThreadName(thread: Pick<ThreadSummary, "title" | "id">): string {
  return `${thread.title} · ${thread.id.slice(0, 8)}`;
}

export function renderDiffSummary(diff: DiffSummary, locale: BotLocale = "zh"): string {
  if (diff.files.length === 0 && diff.diff.trim().length === 0)
    return locale === "zh" ? "本次没有可显示的文件变更。" : "No file changes to display.";
  const lines = [
    locale === "zh"
      ? `变更：${diff.files.length} 个文件，+${diff.additions} / -${diff.deletions}`
      : `Changes: ${diff.files.length} file(s), +${diff.additions} / -${diff.deletions}`,
    "",
    ...diff.files.slice(0, 12).map((file) => `${file.path}  +${file.additions} -${file.deletions}`),
  ];
  if (diff.files.length > 12)
    lines.push(
      locale === "zh"
        ? `…另有 ${diff.files.length - 12} 个文件`
        : `…and ${diff.files.length - 12} more file(s)`,
    );
  return lines.join("\n");
}

export function renderCapabilities(
  capabilities: BackendCapabilities,
  locale: BotLocale = "zh",
): string {
  const labels: Array<[keyof BackendCapabilities, string, string?]> = [
    ["projectsList", "项目", "Projects"],
    ["projectCreate", "新建项目", "Create project"],
    ["threadsList", "线程", "Threads"],
    ["threadCreate", "新建", "Create thread"],
    ["turnStart", "执行", "Run"],
    ["streaming", "流式", "Streaming"],
    ["turnInterrupt", "停止", "Stop"],
    ["approval", "审批", "Approval"],
    ["diffThread", "Diff"],
    ["resumeSubscription", "断线续传", "Resume"],
  ];
  return labels
    .map(([key, zh, en = zh]) => {
      const value = capabilities[key];
      const icon =
        value.state === "supported"
          ? "✅"
          : value.state === "degraded"
            ? "⚠️"
            : value.state === "unsupported"
              ? "❌"
              : "❔";
      return `${icon} ${locale === "zh" ? zh : en}: ${value.state}${"reason" in value && value.reason ? ` (${value.reason})` : ""}`;
    })
    .join("\n");
}
