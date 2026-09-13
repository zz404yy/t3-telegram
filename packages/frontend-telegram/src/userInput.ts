import { InlineKeyboard } from "grammy";
import type { BotLocale, PendingUserInputRecord, UserInputOption } from "@t3-vibe/core";

function compactButtonLabel(index: number, option: UserInputOption, selected: boolean): string {
  const prefix = `${selected ? "✅" : `${index + 1}.`} `;
  const available = Math.max(1, 60 - prefix.length);
  return `${prefix}${option.label.length > available ? `${option.label.slice(0, available - 1)}…` : option.label}`;
}

export function buildUserInputView(
  pending: PendingUserInputRecord,
  locale: BotLocale,
): { text: string; keyboard: InlineKeyboard } {
  const question = pending.request.questions[pending.questionIndex]!;
  const selected = pending.answers[question.id];
  const selectedValues = new Set(Array.isArray(selected) ? selected : selected ? [selected] : []);
  const heading =
    locale === "zh"
      ? `🤖 AI 需要你的选择 · ${pending.questionIndex + 1}/${pending.request.questions.length}`
      : `🤖 AI needs your choice · ${pending.questionIndex + 1}/${pending.request.questions.length}`;
  const optionLines = question.options.map((option, index) => {
    const description = option.description?.trim();
    return `${index + 1}. ${option.label}${description && description !== option.label ? `\n   ${description}` : ""}`;
  });
  const hint = question.multiSelect
    ? locale === "zh"
      ? "可多选；选好后点击“提交选择”。"
      : "Multiple choices allowed; tap Submit when ready."
    : locale === "zh"
      ? "请选择一个选项。"
      : "Choose one option.";
  const text = [heading, question.header, "", question.question, "", ...optionLines, "", hint]
    .filter((line) => line !== undefined)
    .join("\n")
    .slice(0, 4096);
  const keyboard = new InlineKeyboard();
  question.options.forEach((option, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      compactButtonLabel(index, option, selectedValues.has(option.value)),
      `ui:${pending.id}:${index}`,
    );
  });
  if (question.allowCustomAnswer)
    keyboard
      .row()
      .text(locale === "zh" ? "✍️ 自定义回答" : "✍️ Custom answer", `uic:${pending.id}`);
  if (question.multiSelect)
    keyboard.row().text(locale === "zh" ? "✅ 提交选择" : "✅ Submit", `uis:${pending.id}`);
  return { text, keyboard };
}

export function completedUserInputText(pending: PendingUserInputRecord, locale: BotLocale): string {
  const answerLines = pending.request.questions.flatMap((question) => {
    const answer = pending.answers[question.id];
    if (answer === undefined) return [];
    const values = Array.isArray(answer) ? answer : [answer];
    const labels = values.map(
      (value) => question.options.find((option) => option.value === value)?.label ?? value,
    );
    return [`${question.header ?? question.question}: ${labels.join(", ")}`];
  });
  return [locale === "zh" ? "✅ 已提交给 AI" : "✅ Submitted to AI", "", ...answerLines].join("\n");
}
