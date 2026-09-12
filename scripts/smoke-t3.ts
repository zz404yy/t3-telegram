import { randomBytes } from "node:crypto";
import { T3Backend, T3DiscoveryClient } from "@t3-vibe/adapter-t3";
import { CredentialCipher, SqliteGatewayRepository } from "@t3-vibe/persistence";

const baseUrl = process.env.T3_BASE_URL;
const accessToken = process.env.T3_ACCESS_TOKEN;
const projectId = process.env.T3_SMOKE_PROJECT_ID;
if (!baseUrl || !accessToken || !projectId || process.env.T3_SMOKE_ALLOW_MUTATION !== "true") {
  throw new Error(
    "Set T3_BASE_URL, T3_ACCESS_TOKEN, T3_SMOKE_PROJECT_ID and T3_SMOKE_ALLOW_MUTATION=true. The project must be disposable.",
  );
}

const repository = new SqliteGatewayRepository(
  ":memory:",
  new CredentialCipher(randomBytes(32).toString("base64")),
);
repository.initialize();
const userId = repository.ensureUser("smoke-test");
const discovered = await new T3DiscoveryClient({
  allowedHosts: [],
  allowPrivateNetworks: true,
}).discover(baseUrl);
const environment = repository.saveEnvironment({
  userId,
  name: "smoke",
  baseUrl: discovered.baseUrl,
  credential: accessToken,
  credentialType: "bearer",
  serverVersion: discovered.descriptor.serverVersion,
  status: "disconnected",
});
const backend = new T3Backend(
  repository,
  new T3DiscoveryClient({ allowedHosts: [], allowPrivateNetworks: true }),
);
const status = await backend.connect(environment.id);
if (status.state !== "connected" && status.state !== "degraded")
  throw new Error(`Connection failed: ${status.state}`);
const project = (await backend.listProjects(environment.id)).find((item) => item.id === projectId);
if (!project) throw new Error("Disposable smoke project not found");
const thread = await backend.createThread({
  environmentId: environment.id,
  projectId,
  title: `gateway-smoke-${Date.now()}`,
  runtimeMode: "auto",
});
try {
  const turn = await backend.startTurn({
    environmentId: environment.id,
    threadId: thread.id,
    text: "Reply with exactly SMOKE_OK. Do not inspect or modify files.",
    idempotencyKey: randomBytes(16).toString("hex"),
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  let completed = false;
  for await (const event of backend.subscribeThread({
    environmentId: environment.id,
    threadId: thread.id,
    afterSequence: Math.max(0, turn.sequence - 1),
    signal: abort.signal,
  })) {
    if (event.type === "turn.completed") {
      completed = true;
      break;
    }
  }
  clearTimeout(timer);
  if (!completed) throw new Error("Smoke turn did not complete");
  process.stdout.write(`Smoke passed for T3 ${discovered.descriptor.serverVersion}\n`);
} finally {
  await backend.archiveThread({ environmentId: environment.id, threadId: thread.id });
  await backend.disconnect(environment.id);
  repository.close();
}
