import { createHash } from "node:crypto";
import { GatewayError } from "@t3-vibe/core";
import {
  AuthSessionStateSchema,
  EnvironmentDescriptorSchema,
  type T3AuthSessionState,
  type T3EnvironmentDescriptor,
} from "../protocol/schemas.js";
import { validateT3BaseUrl, type UrlPolicyOptions } from "./urlPolicy.js";

export interface DiscoveryResult {
  baseUrl: string;
  descriptor: T3EnvironmentDescriptor;
  auth: T3AuthSessionState;
  discoveredAt: string;
  descriptorFingerprint: string;
}

async function fetchJson(url: URL, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
    headers: { accept: "application/json", "user-agent": "t3-vibe-gateway/0.1" },
  });
  if (!response.ok) {
    throw new GatewayError(
      `T3 discovery failed with HTTP ${response.status}`,
      "discovery_http_error",
      `T3 探测失败（HTTP ${response.status}）。`,
    );
  }
  return response.json();
}

export class T3DiscoveryClient {
  constructor(
    private readonly policy: UrlPolicyOptions,
    private readonly timeoutMs = 10_000,
  ) {}

  async discover(input: string): Promise<DiscoveryResult> {
    const base = await validateT3BaseUrl(input, this.policy);
    const descriptorUrl = new URL("/.well-known/t3/environment", base);
    const sessionUrl = new URL("/api/auth/session", base);
    const [descriptorRaw, authRaw] = await Promise.all([
      fetchJson(descriptorUrl, this.timeoutMs),
      fetchJson(sessionUrl, this.timeoutMs),
    ]);
    const descriptor = EnvironmentDescriptorSchema.parse(descriptorRaw);
    const auth = AuthSessionStateSchema.parse(authRaw);
    const canonical = JSON.stringify({
      keys: Object.keys(descriptor).sort(),
      capabilityKeys: Object.keys(descriptor.capabilities).sort(),
      authPolicy: auth.auth?.policy,
      bootstrapMethods: [...(auth.auth?.bootstrapMethods ?? [])].sort(),
      sessionMethods: [...(auth.auth?.sessionMethods ?? [])].sort(),
    });
    return {
      baseUrl: base.toString().replace(/\/$/, ""),
      descriptor,
      auth,
      discoveredAt: new Date().toISOString(),
      descriptorFingerprint: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    };
  }
}
