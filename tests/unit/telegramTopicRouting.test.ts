import { describe, expect, it } from "vitest";
import { routeControlMenuMessage } from "../../packages/frontend-telegram/src/TelegramFrontend.js";

describe("Telegram control menu topic routing", () => {
  it("restores a missing topic on reply-keyboard updates", () => {
    const message: {
      message_thread_id?: number;
      is_topic_message?: boolean;
      direct_messages_topic?: { topic_id: number };
    } = {};

    routeControlMenuMessage(message, "41633");

    expect(message).toEqual({ message_thread_id: 41633, is_topic_message: true });
  });

  it("overrides both Telegram topic fields for exact control actions", () => {
    const message = {
      message_thread_id: 41595,
      is_topic_message: true,
      direct_messages_topic: { topic_id: 41595 },
    };

    routeControlMenuMessage(message, "41633");

    expect(message).toEqual({
      message_thread_id: 41633,
      is_topic_message: true,
      direct_messages_topic: { topic_id: 41633 },
    });
  });
});
