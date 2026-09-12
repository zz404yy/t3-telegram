import type { Api } from "grammy";
import { chunkTelegramText } from "../renderers/text.js";

/**
 * Streams into persistent Telegram messages.
 *
 * Telegram drafts are deliberately not used here: sendMessageDraft previews expire after roughly
 * 30 seconds and disappear as soon as the final sendMessage is made. Keeping real message IDs and
 * editing them in place prevents the visible disappear-and-retype transition.
 */
export class TelegramDraftStreamer {
  private lastSentAt = 0;
  private lastText = "";
  private streamingSupported = true;
  private readonly messageIds: number[] = [];
  private readonly lastChunks: string[] = [];

  constructor(
    private readonly api: Api,
    private readonly chatId: number | string,
    private readonly threadId?: number,
    private readonly cadenceMs = 750,
  ) {}

  async update(text: string, force = false): Promise<void> {
    if (!this.streamingSupported || !text || text === this.lastText) return;
    if (!force && Date.now() - this.lastSentAt < this.cadenceMs) return;
    try {
      await this.writePersistent(text);
      this.lastText = text;
      this.lastSentAt = Date.now();
    } catch {
      // A final, complete message is still attempted by finalize().
      this.streamingSupported = false;
    }
  }

  async finalize(text: string): Promise<void> {
    const complete = text || "任务已结束，但没有文本输出。";
    try {
      await this.writePersistent(complete);
      this.lastText = complete;
      return;
    } catch {
      // If Telegram rejected an edit, preserve correctness by sending the complete response once.
      // The existing partial message remains visible instead of being deleted underneath the user.
    }

    for (const chunk of chunkTelegramText(complete)) {
      await this.api.sendMessage(this.chatId, chunk, this.threadOptions());
    }
  }

  private async writePersistent(text: string): Promise<void> {
    const chunks = chunkTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      if (this.lastChunks[index] === chunk) continue;
      const messageId = this.messageIds[index];
      if (messageId === undefined) {
        const sent = await this.api.sendMessage(this.chatId, chunk, this.threadOptions());
        this.messageIds[index] = sent.message_id;
      } else {
        await this.api.editMessageText(this.chatId, messageId, chunk);
      }
      this.lastChunks[index] = chunk;
    }
  }

  private threadOptions(): { message_thread_id?: number } {
    return this.threadId === undefined ? {} : { message_thread_id: this.threadId };
  }
}
