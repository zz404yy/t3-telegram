import { createServer, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import { T3Backend, T3DiscoveryClient } from "@t3-vibe/adapter-t3";
import { TelegramFrontend } from "@t3-vibe/frontend-telegram";
import { CredentialCipher, SqliteGatewayRepository } from "@t3-vibe/persistence";
import type { GatewayConfig } from "./config.js";

export interface GatewayApplication {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function bootstrap(config: GatewayConfig): GatewayApplication {
  if (config.databasePath !== ":memory:")
    mkdirSync(dirname(config.databasePath), { recursive: true });
  const logger = pino({
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "authorization",
        "token",
        "credential",
        "accessToken",
        "TELEGRAM_BOT_TOKEN",
        "GATEWAY_MASTER_KEY",
      ],
      censor: "[REDACTED]",
    },
  });
  const repository = new SqliteGatewayRepository(
    config.databasePath,
    new CredentialCipher(config.masterKey),
  );
  repository.initialize();
  const discovery = new T3DiscoveryClient({
    allowedHosts: config.t3AllowedHosts,
    allowPrivateNetworks: config.t3AllowPrivateNetworks,
  });
  const backend = new T3Backend(repository, discovery);
  const telegram = new TelegramFrontend({
    token: config.telegramBotToken,
    allowedUserIds: config.telegramAllowedUserIds,
    backend,
    connector: backend,
    repository,
    logger,
  });
  let ready = false;
  let healthServer: Server | undefined;

  return {
    async start() {
      healthServer = createServer((request, response) => {
        if (request.url === "/healthz") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "ok" }));
          return;
        }
        if (request.url === "/readyz") {
          response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) =>
        healthServer!.listen(config.healthPort, config.healthHost, resolve),
      );
      logger.info({ host: config.healthHost, port: config.healthPort }, "health server listening");
      await telegram.initialize();
      ready = true;
      await telegram.start();
    },
    async stop() {
      ready = false;
      try {
        await telegram.stop();
      } catch {
        // The bot may not have entered polling if initialization failed.
      }
      try {
        repository.close();
      } catch {
        // Shutdown is idempotent.
      }
      if (healthServer) await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    },
  };
}
