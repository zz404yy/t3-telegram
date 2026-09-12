import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { TelegramDraftStreamer } from "@t3-vibe/frontend-telegram";

function fakeApi() {
  const sends: Array<{ text: string; options: unknown; messageId: number }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  const sendMessageDraft = vi.fn();
  const api = {
    raw: { sendMessageDraft },
    sendMessage: async (_chatId: number | string, text: string, options: unknown) => {
      const messageId = sends.length + 1;
      sends.push({ text, options, messageId });
      return { message_id: messageId };
    },
    editMessageText: async (_chatId: number | string, messageId: number, text: string) => {
      edits.push({ messageId, text });
      sends[messageId - 1]!.text = text;
      return true;
    },
  } as unknown as Api;
  return { api, sends, edits, sendMessageDraft };
}

describe("Telegram persistent streamer", () => {
  it("edits one persistent message instead of replacing an ephemeral draft", async () => {
    const { api, sends, edits, sendMessageDraft } = fakeApi();
    const streamer = new TelegramDraftStreamer(api, 99, 7, 0);

    await streamer.update("Hel");
    await streamer.update("Hello");
    await streamer.finalize("Hello world");

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(sends).toEqual([
      { text: "Hello world", options: { message_thread_id: 7 }, messageId: 1 },
    ]);
    expect(edits).toEqual([
      { messageId: 1, text: "Hello" },
      { messageId: 1, text: "Hello world" },
    ]);
  });

  it("adds stable messages only when a response exceeds Telegram's size limit", async () => {
    const { api, sends, sendMessageDraft } = fakeApi();
    const streamer = new TelegramDraftStreamer(api, 99, undefined, 0);

    await streamer.update("Starting");
    await streamer.finalize(`${"a".repeat(3900)}\n${"b".repeat(3900)}`);

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(sends).toHaveLength(2);
    expect(sends.every((message) => message.text.length <= 3900)).toBe(true);
  });
});
