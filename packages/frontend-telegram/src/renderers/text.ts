import type { BackendCapabilities, DiffSummary, ThreadSummary } from "@t3-vibe/core";

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

export function renderDiffSummary(diff: DiffSummary): string {
  if (diff.files.length === 0 && diff.diff.trim().length === 0) return "本次没有可显示的文件变更。";
  const lines = [
    `变更：${diff.files.length} 个文件，+${diff.additions} / -${diff.deletions}`,
    "",
    ...diff.files.slice(0, 12).map((file) => `${file.path}  +${file.additions} -${file.deletions}`),
  ];
  if (diff.files.length > 12) lines.push(`…另有 ${diff.files.length - 12} 个文件`);
  return lines.join("\n");
}

export function renderCapabilities(capabilities: BackendCapabilities): string {
  const labels: Array<[keyof BackendCapabilities, string]> = [
    ["projectsList", "项目"],
    ["projectCreate", "新建项目"],
    ["threadsList", "线程"],
    ["threadCreate", "新建"],
    ["turnStart", "执行"],
    ["streaming", "流式"],
    ["turnInterrupt", "停止"],
    ["approval", "审批"],
    ["diffThread", "Diff"],
    ["resumeSubscription", "断线续传"],
  ];
  return labels
    .map(([key, label]) => {
      const value = capabilities[key];
      const icon =
        value.state === "supported"
          ? "✅"
          : value.state === "degraded"
            ? "⚠️"
            : value.state === "unsupported"
              ? "❌"
              : "❔";
      return `${icon} ${label}: ${value.state}${"reason" in value && value.reason ? ` (${value.reason})` : ""}`;
    })
    .join("\n");
}
