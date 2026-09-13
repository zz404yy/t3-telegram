import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialCipher, SqliteGatewayRepository } from "@t3-vibe/persistence";

const repositories: SqliteGatewayRepository[] = [];
function repository(): SqliteGatewayRepository {
  const repo = new SqliteGatewayRepository(
    ":memory:",
    new CredentialCipher(randomBytes(32).toString("base64")),
  );
  repo.initialize();
  repositories.push(repo);
  return repo;
}
afterEach(() => repositories.splice(0).forEach((repo) => repo.close()));

describe("SQLite gateway repository", () => {
  it("persists a Telegram user's selected language", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    expect(repo.getUserLocale(userId)).toBeUndefined();
    repo.setUserLocale(userId, "en");
    expect(repo.getUserLocale(userId)).toBe("en");
    repo.setUserLocale(userId, "zh");
    expect(repo.getUserLocale(userId)).toBe("zh");
  });

  it("persists one replaceable control topic per Telegram chat", () => {
    const repo = repository();
    expect(repo.getTelegramControlTopic("99")).toBeUndefined();
    repo.saveTelegramControlTopic("99", "10");
    expect(repo.getTelegramControlTopic("99")).toBe("10");
    repo.saveTelegramControlTopic("99", "11");
    expect(repo.getTelegramControlTopic("99")).toBe("11");
  });

  it("resolves topic bindings independently and uses an active flat-chat binding", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    const env = repo.saveEnvironment({
      userId,
      name: "local",
      baseUrl: "http://localhost:3773",
      status: "disconnected",
    });
    repo.saveBinding({
      userId,
      telegramChatId: "99",
      telegramThreadId: "10",
      environmentId: env.id,
      t3ThreadId: "thread-topic",
    });
    repo.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: env.id,
      t3ThreadId: "thread-flat",
    });
    expect(repo.resolveBinding(userId, "99", "10")?.t3ThreadId).toBe("thread-topic");
    expect(repo.resolveBinding(userId, "99", "unknown")).toBeUndefined();
    expect(repo.resolveBinding(userId, "99")?.t3ThreadId).toBe("thread-flat");
  });

  it("keeps prior flat-chat bindings monitored while changing the active input target", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    const env = repo.saveEnvironment({
      userId,
      name: "local",
      baseUrl: "http://localhost:3773",
      status: "disconnected",
    });
    const first = repo.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: env.id,
      t3ThreadId: "thread-1",
      displayName: "First",
    });
    repo.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: env.id,
      t3ThreadId: "thread-2",
      displayName: "Second",
    });

    expect(repo.resolveBinding(userId, "99")?.t3ThreadId).toBe("thread-2");
    expect(repo.listBindings(userId).map((binding) => binding.t3ThreadId)).toEqual([
      "thread-2",
      "thread-1",
    ]);
    expect(repo.listBindingsForThread(env.id, "thread-1")).toEqual([first]);
    expect(repo.findBindingForTarget(userId, "99", env.id, "thread-1")).toEqual(first);
    expect(repo.findBindingForTarget(userId, "other", env.id, "thread-1")).toBeUndefined();

    expect(repo.removeBindingById(userId, "other", first.id)).toBe(false);
    expect(repo.removeBindingById(userId, "99", first.id)).toBe(true);
    expect(repo.findBinding(first.id)).toBeUndefined();
    expect(repo.listBindings(userId).map((binding) => binding.t3ThreadId)).toEqual(["thread-2"]);
  });

  it("persists resumable subscription cursors without erasing completion state", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    const env = repo.saveEnvironment({
      userId,
      name: "local",
      baseUrl: "http://localhost:3773",
      status: "disconnected",
    });
    repo.saveThreadSubscriptionState({
      environmentId: env.id,
      t3ThreadId: "thread-1",
      lastSequence: 41,
      lastCompletedTurnId: "turn-1",
    });
    const updated = repo.saveThreadSubscriptionState({
      environmentId: env.id,
      t3ThreadId: "thread-1",
      lastSequence: 42,
    });

    expect(updated).toMatchObject({
      lastSequence: 42,
      lastCompletedTurnId: "turn-1",
    });
  });

  it("moves an existing flat binding into a topic without duplicating its listener", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    const env = repo.saveEnvironment({
      userId,
      name: "local",
      baseUrl: "http://localhost:3773",
      status: "disconnected",
    });
    const flat = repo.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: env.id,
      t3ThreadId: "thread-1",
    });
    const topic = repo.saveBinding({
      userId,
      telegramChatId: "99",
      telegramThreadId: "7",
      environmentId: env.id,
      t3ThreadId: "thread-1",
    });

    expect(topic.id).toBe(flat.id);
    expect(repo.listBindings(userId)).toHaveLength(1);
    expect(repo.resolveBinding(userId, "99", "7")?.t3ThreadId).toBe("thread-1");
    expect(repo.resolveBinding(userId, "99")).toBeUndefined();
    expect(repo.setActiveBinding(userId, "99", topic.id)).toBe(true);
    expect(repo.resolveBinding(userId, "99")?.id).toBe(topic.id);
    expect(repo.setActiveBinding(userId, "other-chat", topic.id)).toBe(false);

    const repaired = repo.saveBinding({
      userId,
      telegramChatId: "99",
      telegramThreadId: "8",
      environmentId: env.id,
      t3ThreadId: "thread-1",
    });
    expect(repaired.id).toBe(topic.id);
    expect(repo.resolveBinding(userId, "99", "7")).toBeUndefined();
    expect(repo.resolveBinding(userId, "99", "8")?.id).toBe(topic.id);
  });

  it("encrypts credentials and makes turn/approval claims idempotent", () => {
    const repo = repository();
    const userId = repo.ensureUser("123");
    const env = repo.saveEnvironment({
      userId,
      name: "local",
      baseUrl: "http://localhost:3773",
      credential: "access-secret",
      credentialType: "bearer",
      status: "disconnected",
    });
    expect(repo.getEnvironment(env.id)?.credential).toBe("access-secret");
    expect(repo.claimTurnStart("telegram:1")).toBe(true);
    expect(repo.claimTurnStart("telegram:1")).toBe(false);
    const binding = repo.saveBinding({
      userId,
      telegramChatId: "99",
      environmentId: env.id,
      t3ThreadId: "thread-1",
    });
    const approval = repo.savePendingApproval({
      bindingId: binding.id,
      t3RequestId: "req-1",
      options: [{ decision: "decline", label: "Deny" }],
    });
    expect(repo.claimPendingApproval(approval.id)).toBe(true);
    expect(repo.claimPendingApproval(approval.id)).toBe(false);

    const request = {
      requestId: "input-1",
      questions: [
        {
          id: "mode",
          question: "Choose mode",
          multiSelect: false,
          allowCustomAnswer: false,
          options: [{ value: "safe", label: "Safe" }],
        },
      ],
    };
    const pendingInput = repo.savePendingUserInput({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      request,
    });
    const selected = repo.savePendingUserInput({
      bindingId: binding.id,
      t3RequestId: request.requestId,
      request,
      answers: { mode: "safe" },
      questionIndex: 1,
    });
    expect(selected.id).toBe(pendingInput.id);
    expect(repo.findPendingUserInputForBinding(binding.id)).toMatchObject({
      answers: { mode: "safe" },
      questionIndex: 1,
    });
    expect(repo.claimPendingUserInput(pendingInput.id)).toBe(true);
    expect(repo.claimPendingUserInput(pendingInput.id)).toBe(false);
  });
});
