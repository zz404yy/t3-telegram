import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { T3Backend, T3DiscoveryClient } from "@t3-vibe/adapter-t3";
import { CredentialCipher, SqliteGatewayRepository } from "@t3-vibe/persistence";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("T3 backend capability resolution", () => {
  it("uses safe method probes and leaves mutations degraded until observed", async () => {
    const http = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/.well-known/t3/environment") {
        response.end(
          JSON.stringify({
            environmentId: "environment-test",
            label: "Test T3",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.40",
            capabilities: {},
          }),
        );
        return;
      }
      if (request.url === "/api/auth/session") {
        response.end(JSON.stringify({ authenticated: true }));
        return;
      }
      if (request.url === "/api/auth/websocket-ticket" && request.method === "POST") {
        response.end(
          JSON.stringify({ ticket: "ticket-test", expiresAt: new Date(Date.now() + 60_000) }),
        );
        return;
      }
      if (request.url === "/api/orchestration/shell") {
        response.end(
          JSON.stringify({
            snapshotSequence: 1,
            projects: [],
            threads: [
              {
                id: "thread-settings",
                projectId: "project-test",
                title: "Thread settings",
                modelSelection: { instanceId: "codex-work", model: "gpt-test" },
                runtimeMode: "approval-required",
                interactionMode: "default",
                archivedAt: null,
                latestTurn: null,
                updatedAt: new Date().toISOString(),
              },
            ],
            updatedAt: new Date().toISOString(),
          }),
        );
        return;
      }
      if (request.url === "/api/orchestration/threads/thread-history") {
        response.end(
          JSON.stringify({
            snapshotSequence: 3,
            thread: {
              id: "thread-history",
              messages: [
                {
                  id: "message-user",
                  role: "user",
                  text: "implement history",
                  createdAt: "2026-09-12T07:00:00.000Z",
                },
                {
                  id: "message-assistant",
                  role: "assistant",
                  text: "history implemented",
                  turnId: "turn-history",
                },
                { id: "message-system", role: "system", text: "hidden" },
              ],
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const webSocket = new WebSocketServer({ server: http, path: "/ws" });
    const probed = new Set<string>();
    let createdProject: Record<string, unknown> | undefined;
    let updatedProject: Record<string, unknown> | undefined;
    let updatedThreadModel: Record<string, unknown> | undefined;
    let updatedThreadRuntime: Record<string, unknown> | undefined;
    webSocket.on("connection", (socket) => {
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame._tag !== "Request") return;
        const tag = String(frame.tag);
        probed.add(tag);
        if (tag === "orchestration.searchThreads") {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { matches: [] } },
            }),
          );
          return;
        }
        if (tag === "server.getConfig") {
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: {
                _tag: "Success",
                value: {
                  providers: [
                    {
                      instanceId: "codex-work",
                      driver: "codex",
                      displayName: "Work Codex",
                      enabled: true,
                      installed: true,
                      status: "ready",
                      requiresNewThreadForModelChange: true,
                      models: [
                        { slug: "gpt-test", name: "GPT Test", isDefault: true, isCustom: false },
                        { slug: "gpt-next", name: "GPT Next", isDefault: false, isCustom: false },
                      ],
                    },
                  ],
                },
              },
            }),
          );
          return;
        }
        if (
          tag === "orchestration.dispatchCommand" &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          (frame.payload as Record<string, unknown>).type === "project.create"
        ) {
          createdProject = frame.payload as Record<string, unknown>;
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { sequence: 2 } },
            }),
          );
          return;
        }
        if (
          tag === "orchestration.dispatchCommand" &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          (frame.payload as Record<string, unknown>).type === "thread.meta.update"
        ) {
          updatedThreadModel = frame.payload as Record<string, unknown>;
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { sequence: 4 } },
            }),
          );
          return;
        }
        if (
          tag === "orchestration.dispatchCommand" &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          (frame.payload as Record<string, unknown>).type === "thread.runtime-mode.set"
        ) {
          updatedThreadRuntime = frame.payload as Record<string, unknown>;
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { sequence: 5 } },
            }),
          );
          return;
        }
        if (
          tag === "orchestration.dispatchCommand" &&
          typeof frame.payload === "object" &&
          frame.payload !== null &&
          (frame.payload as Record<string, unknown>).type === "project.meta.update"
        ) {
          updatedProject = frame.payload as Record<string, unknown>;
          socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: frame.id,
              exit: { _tag: "Success", value: { sequence: 3 } },
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            _tag: "Exit",
            requestId: frame.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Die", defect: "payload schema validation failed" }],
            },
          }),
        );
      });
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          webSocket.clients.forEach((client) => client.terminate());
          webSocket.close(() => http.close(() => resolve()));
        }),
    );

    const repository = new SqliteGatewayRepository(
      ":memory:",
      new CredentialCipher(randomBytes(32).toString("base64")),
    );
    repository.initialize();
    cleanup.push(() => repository.close());
    const userId = repository.ensureUser("telegram-test");
    const environment = repository.saveEnvironment({
      userId,
      name: "Test T3",
      baseUrl: `http://127.0.0.1:${address.port}`,
      credential: "access-token-test",
      credentialType: "bearer",
      status: "disconnected",
    });
    const backend = new T3Backend(
      repository,
      new T3DiscoveryClient({ allowedHosts: ["127.0.0.1"], allowPrivateNetworks: true }),
    );
    cleanup.push(() => backend.disconnect(environment.id));

    await expect(backend.connect(environment.id)).resolves.toMatchObject({ state: "connected" });
    const capabilities = await backend.getCapabilities(environment.id);
    expect(capabilities.projectsList.state).toBe("supported");
    expect(capabilities.diffTurn.state).toBe("supported");
    expect(capabilities.streaming.state).toBe("supported");
    expect(capabilities.projectCreate.state).toBe("degraded");
    expect(capabilities.threadCreate.state).toBe("degraded");
    expect(capabilities.turnInterrupt.state).toBe("degraded");
    expect(probed).toEqual(
      new Set([
        "orchestration.searchThreads",
        "orchestration.dispatchCommand",
        "orchestration.getTurnDiff",
        "orchestration.getFullThreadDiff",
        "orchestration.subscribeThread",
      ]),
    );
    await expect(
      backend.createProject({
        environmentId: environment.id,
        title: "Telegram project",
        workspaceRoot: "/workspace/telegram-project",
      }),
    ).resolves.toMatchObject({
      title: "Telegram project",
      workspaceRoot: "/workspace/telegram-project",
    });
    expect(createdProject).toMatchObject({
      type: "project.create",
      title: "Telegram project",
      workspaceRoot: "/workspace/telegram-project",
      createWorkspaceRootIfMissing: true,
    });
    expect((await backend.getCapabilities(environment.id)).projectCreate.state).toBe("supported");
    await expect(
      backend.getThreadHistory({ environmentId: environment.id, threadId: "thread-history" }),
    ).resolves.toEqual([
      {
        id: "message-user",
        role: "user",
        text: "implement history",
        createdAt: "2026-09-12T07:00:00.000Z",
      },
      {
        id: "message-assistant",
        role: "assistant",
        text: "history implemented",
        turnId: "turn-history",
      },
    ]);
    await expect(backend.listModelProviders(environment.id)).resolves.toEqual([
      {
        instanceId: "codex-work",
        displayName: "Work Codex",
        enabled: true,
        installed: true,
        status: "ready",
        requiresNewThreadForModelChange: true,
        models: [
          { slug: "gpt-test", name: "GPT Test", isDefault: true },
          { slug: "gpt-next", name: "GPT Next" },
        ],
      },
    ]);
    await expect(
      backend.setProjectDefaultModel({
        environmentId: environment.id,
        projectId: "project-test",
        modelSelection: { instanceId: "codex-work", model: "gpt-test" },
      }),
    ).resolves.toBeUndefined();
    expect(updatedProject).toMatchObject({
      type: "project.meta.update",
      projectId: "project-test",
      defaultModelSelection: { instanceId: "codex-work", model: "gpt-test" },
    });
    await expect(
      backend.setThreadModel({
        environmentId: environment.id,
        threadId: "thread-settings",
        modelSelection: { instanceId: "codex-work", model: "gpt-next" },
      }),
    ).resolves.toBeUndefined();
    expect(updatedThreadModel).toMatchObject({
      type: "thread.meta.update",
      threadId: "thread-settings",
      modelSelection: { instanceId: "codex-work", model: "gpt-next" },
    });
    await expect(
      backend.setThreadRuntimeMode({
        environmentId: environment.id,
        threadId: "thread-settings",
        runtimeMode: "full-access",
      }),
    ).resolves.toBeUndefined();
    expect(updatedThreadRuntime).toMatchObject({
      type: "thread.runtime-mode.set",
      threadId: "thread-settings",
      runtimeMode: "full-access",
    });
  });
});
