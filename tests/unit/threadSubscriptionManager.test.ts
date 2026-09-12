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
  const drafts: unknown[] = [];
  const api = {
    raw: {
      sendMessageDraft: async (input: unknown) => {
        drafts.push(input);
        return true;
      },
    },
    sendMessage: async (chatId: number | string, text: string, options: unknown) => {
      messages.push({ chatId, text, options });
      return { message_id: messages.length };
    },
  } as unknown as Api;
  return { api, messages, drafts };
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
          { type: "assistant.message", text: "answer one", messageId: "m1", sequence: 2 },
          { type: "turn.completed", status: "success", turnId: "turn-1", sequence: 3 },
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
      "[First]\nanswer one\n\n✅ Turn success",
      "[Second]\nanswer two\n\n✅ Turn success",
    ]);
    expect(repository.resolveBinding(userId, "99")?.t3ThreadId).toBe("thread-2");
    expect(repository.getThreadSubscriptionState(environment.id, "thread-1")).toMatchObject({
      lastSequence: 3,
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
});
