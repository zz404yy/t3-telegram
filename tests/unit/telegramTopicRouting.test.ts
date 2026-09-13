import { describe, expect, it } from "vitest";
import {
  buildMainMenu,
  pendingMenuScopeKey,
  routeControlMenuMessage,
} from "../../packages/frontend-telegram/src/TelegramFrontend.js";

describe("Telegram control menu topic routing", () => {
  it("restores a missing topic on reply-keyboard updates", () => {
    const message: {
      message_thread_id?: number;
      is_topic_message?: boolean;
      direct_messages_topic?: { topic_id: number };
    } = {};

    expect(routeControlMenuMessage(message, "41633")).toBe(true);

    expect(message).toEqual({ message_thread_id: 41633, is_topic_message: true });
  });

  it("preserves a real topic on exact control actions", () => {
    const message = {
      message_thread_id: 41595,
      is_topic_message: true,
      direct_messages_topic: { topic_id: 41595 },
    };

    expect(routeControlMenuMessage(message, "41633")).toBe(false);

    expect(message).toEqual({
      message_thread_id: 41595,
      is_topic_message: true,
      direct_messages_topic: { topic_id: 41595 },
    });
  });

  it("uses callbacks instead of reply-keyboard messages when Topics are enabled", () => {
    const menu = JSON.parse(JSON.stringify(buildMainMenu("zh", true))) as {
      inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
      keyboard?: unknown;
    };

    expect(menu.keyboard).toBeUndefined();
    expect(menu.inline_keyboard?.flat()).toContainEqual({
      text: "🔗 绑定线程",
      callback_data: "menu:attach",
    });
    expect(menu.inline_keyboard?.flat().every((button) => button.callback_data)).toBe(true);
  });

  it("keeps the reply keyboard only for flat private chats", () => {
    const menu = JSON.parse(JSON.stringify(buildMainMenu("en", false))) as {
      inline_keyboard?: unknown;
      keyboard?: Array<Array<{ text: string }>>;
    };

    expect(menu.inline_keyboard).toBeUndefined();
    expect(menu.keyboard?.flat()).toContainEqual({ text: "🔗 Attach thread" });
  });

  it("isolates pending menu input between private-chat topics", () => {
    const chatId = 372399501;

    expect(pendingMenuScopeKey(chatId, "41633")).not.toBe(pendingMenuScopeKey(chatId));
    expect(pendingMenuScopeKey(chatId, "41913")).not.toBe(pendingMenuScopeKey(chatId, "41633"));
    expect(pendingMenuScopeKey(chatId)).toBe("372399501:root");
  });
});
