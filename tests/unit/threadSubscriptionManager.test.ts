import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingBackend, SubscribeThreadInput, ThreadEvent } from "@t3-vibe/core";
import { ThreadSubscriptionManager } from "@t3-vibe/frontend-telegram";
import { CredentialCipher, SqliteGatewayRepository } from "@t3-vibe/persistence";

const repositories: SqliteGatewayRepository[] = [];
const managers: ThreadSubscriptionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  repositories.splice(0).forEach((repository) => repository.close());
});

function setup() {
  const repository = new SqliteGatewayRepository(
    ":memory:",
    new CredentialCipher(randomBytes(32).toString("base64")),
  );
  repository.initialize();
  repositories.push(repository);
  const userId = repository.ensureUser("123");
  repository.setUserLocale(userId, "en");
  const environment = repository.saveEnvironment({
    userId,
    name: "local",
    baseUrl: "http://localhost:3773",
    status: "connected",
  });
  return { repository, userId, environment };
}

function fakeApi() {
  const messages: Array<{ chatId: number | string; text: string; options: unknown }> = [];
  const edits: Array<{ chatId: number | string; messageId: number; text: string }> = [];
  const api = {
    sendMessage: async (chatId: number | string, text: string, options: unknown) => {
      messages.push({ chatId, text, options });
      return { message_id: messages.length };
    },
    editMessageText: async (chatId: number | string, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
      messages[messageId - 1]!.text = text;
      return true;
    },
  } as unknown as Api;
  return { api, messages, edits };
}

function backendWithEvents(events: Record<string, ThreadEvent[]>): CodingBackend {
  return {
    async *subscribeThread(input: SubscribeThreadInput) {
      for (const event of events[input.threadId] ?? []) {
        if (
          event.sequence === undefined ||
          input.afterSequence === undefined ||
          event.sequence > input.afterSequence
        )
          yield event;
      }
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  } as unknown as CodingBackend;
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

describe("ThreadSubscriptionManager", () => {
  it("keeps all flat-chat bindings live while only one is the active input", async () => {
    const { repository, userId, environment } = setup();
    repository.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: environment.id,
      t3ThreadId: "thread-1",
      displayName: "First",
    });
    repository.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: environment.id,
      t3ThreadId: "thread-2",
      displayName: "Second",
    });
    const { api, messages } = fakeApi();
    const manager = new ThreadSubscriptionManager({
      api,
      repository,
      logger,
      allowedUserIds: new Set(["99"]),
      backend: backendWithEvents({
        "thread-1": [
          { type: "turn.started", threadId: "thread-1", turnId: "turn-1", sequence: 1 },
          { type: "assistant.message", text: "working", messageId: "m1", sequence: 2 },
          { type: "response.finalizing", sequence: 3 },
          { type: "assistant.message", text: "answer one", messageId: "m2", sequence: 4 },
          { type: "turn.completed", status: "success", turnId: "turn-1", sequence: 5 },
        ],
        "thread-2": [
          { type: "turn.started", threadId: "thread-2", turnId: "turn-2", sequence: 10 },
          { type: "assistant.message", text: "answer two", messageId: "m2", sequence: 11 },
          { type: "turn.completed", status: "success", turnId: "turn-2", sequence: 12 },
        ],
      }),
    });
    managers.push(manager);
    manager.start();

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages.map((message) => message.text).sort()).toEqual([
      "[First]\n🧭 Progress\n\nworking\n\n━━━━━━━━━━━━\n\n🎯 Final result\n\nanswer one\n\n━━━━━━━━━━━━\n\n✅ Turn completed",
      "[Second]\n🎯 Final result\n\nanswer two\n\n━━━━━━━━━━━━\n\n✅ Turn completed",
    ]);
    expect(repository.resolveBinding(userId, "99")?.t3ThreadId).toBe("thread-2");
    expect(repository.getThreadSubscriptionState(environment.id, "thread-1")).toMatchObject({
      lastSequence: 5,
      lastCompletedTurnId: "turn-1",
    });
  });

  it("baselines a completed first snapshot instead of replaying an old answer", async () => {
    const { repository, userId, environment } = setup();
    repository.saveBinding({
      userId,
      telegramChatId: "99",
      telegramThreadId: "7",
      environmentId: environment.id,
      t3ThreadId: "thread-1",
    });
    const { api, messages } = fakeApi();
    const manager = new ThreadSubscriptionManager({
      api,
      repository,
      logger,
      allowedUserIds: new Set(["99"]),
      backend: backendWithEvents({
        "thread-1": [
          {
            type: "assistant.message",
            text: "old answer",
            messageId: "old-message",
            snapshotSequence: 19,
          },
          {
            type: "turn.completed",
            status: "success",
            turnId: "old-turn",
            snapshotSequence: 19,
          },
          { type: "subscription.synchronized", sequence: 19 },
        ],
      }),
    });
    managers.push(manager);
    manager.start();

    await vi.waitFor(() =>
      expect(repository.getThreadSubscriptionState(environment.id, "thread-1")).toMatchObject({
        lastSequence: 19,
        lastCompletedTurnId: "old-turn",
      }),
    );
    expect(messages).toEqual([]);
  });

  it("renders AI user-input options as Telegram buttons in the bound topic", async () => {
    const { repository, userId, environment } = setup();
    const binding = repository.saveBinding({
      userId,
      telegramChatId: "99",
      telegramThreadId: "7",
      environmentId: environment.id,
      t3ThreadId: "thread-questions",
    });
    const { api, messages } = fakeApi();
    const manager = new ThreadSubscriptionManager({
      api,
      repository,
      logger,
      allowedUserIds: new Set(["99"]),
      backend: backendWithEvents({
        "thread-questions": [
          {
            type: "user-input.requested",
            sequence: 20,
            request: {
              requestId: "request-1",
              questions: [
                {
                  id: "mode",
                  question: "Which mode?",
                  multiSelect: false,
                  allowCustomAnswer: false,
                  options: [
                    { value: "safe", label: "Safe" },
                    { value: "fast", label: "Fast" },
                  ],
                },
              ],
            },
          },
        ],
      }),
    });
    managers.push(manager);
    manager.start();

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toMatchObject({ chatId: 99, text: expect.stringContaining("Which mode?") });
    expect(JSON.parse(JSON.stringify(messages[0]!.options))).toMatchObject({
      message_thread_id: 7,
      reply_markup: {
        inline_keyboard: [
          [{ text: "1. Safe", callback_data: expect.stringMatching(/^ui:/) }],
          [{ text: "2. Fast", callback_data: expect.stringMatching(/^ui:/) }],
        ],
      },
    });
    expect(repository.findPendingUserInputByRequest(binding.id, "request-1")).toMatchObject({
      telegramMessageId: "1",
      status: "pending",
    });
  });
});
