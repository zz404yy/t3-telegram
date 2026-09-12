import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  DATABASE_URL: z.string().default("file:./data/gateway.db"),
  GATEWAY_MASTER_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  PUBLIC_BASE_URL: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  T3_ALLOWED_HOSTS: z.string().default(""),
  T3_ALLOW_PRIVATE_NETWORKS: z.string().default("true"),
  HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export interface GatewayConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: Set<string>;
  databasePath: string;
  masterKey: string;
  logLevel: string;
  telegramMode: "polling" | "webhook";
  t3AllowedHosts: string[];
  t3AllowPrivateNetworks: boolean;
  healthHost: string;
  healthPort: number;
}

function databasePath(url: string): string {
  if (!url.startsWith("file:"))
    throw new Error("Only file: SQLite DATABASE_URL values are supported");
  const path = url.slice("file:".length);
  return path === ":memory:" ? path : resolve(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = EnvSchema.parse(env);
  if (parsed.TELEGRAM_MODE !== "polling") {
    throw new Error("Webhook mode is reserved for P1; set TELEGRAM_MODE=polling");
  }
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: new Set(
      parsed.TELEGRAM_ALLOWED_USER_IDS.split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    databasePath: databasePath(parsed.DATABASE_URL),
    masterKey: parsed.GATEWAY_MASTER_KEY,
    logLevel: parsed.LOG_LEVEL,
    telegramMode: parsed.TELEGRAM_MODE,
    t3AllowedHosts: parsed.T3_ALLOWED_HOSTS.split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    t3AllowPrivateNetworks: parsed.T3_ALLOW_PRIVATE_NETWORKS.toLowerCase() === "true",
    healthHost: parsed.HEALTH_HOST,
    healthPort: parsed.HEALTH_PORT,
  };
}
