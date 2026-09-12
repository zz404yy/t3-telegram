import type { Api } from "grammy";
import { chunkTelegramText } from "../renderers/text.js";

interface DraftApi {
  sendMessageDraft(args: {
    chat_id: number | string;
    draft_id: number;
    text: string;
    message_thread_id?: number;
    can_stop?: boolean;
    keep_on_stop?: boolean;
  }): Promise<unknown>;
}

export class TelegramDraftStreamer {
  private readonly draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
  private lastSentAt = 0;
  private lastText = "";
  private draftSupported = true;

  constructor(
    private readonly api: Api,
    private readonly chatId: number | string,
    private readonly threadId?: number,
    private readonly cadenceMs = 500,
  ) {}

  async update(text: string, force = false): Promise<void> {
    if (!this.draftSupported || !text || text === this.lastText) return;
    if (!force && Date.now() - this.lastSentAt < this.cadenceMs) return;
    const visible = text.slice(-3900);
    try {
      await (this.api.raw as unknown as DraftApi).sendMessageDraft({
        chat_id: this.chatId,
        draft_id: this.draftId,
        text: visible,
        can_stop: true,
        keep_on_stop: true,
        ...(this.threadId === undefined ? {} : { message_thread_id: this.threadId }),
      });
      this.lastText = text;
      this.lastSentAt = Date.now();
    } catch {
      this.draftSupported = false;
    }
  }

  async finalize(text: string): Promise<void> {
    const chunks = chunkTelegramText(text || "任务已结束，但没有文本输出。");
    for (const chunk of chunks) {
      await this.api.sendMessage(this.chatId, chunk, {
        ...(this.threadId === undefined ? {} : { message_thread_id: this.threadId }),
      });
    }
  }
}
