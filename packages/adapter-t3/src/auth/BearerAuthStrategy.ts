import { GatewayError } from "@t3-vibe/core";
import {
  AccessTokenResultSchema,
  WebSocketTicketSchema,
  type T3EnvironmentDescriptor,
} from "../protocol/schemas.js";
import type { AuthInput, T3AuthStrategy, T3Credential } from "./types.js";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const SCOPES = ["orchestration:read", "orchestration:operate"];

async function checkedJson(response: Response, action: string): Promise<unknown> {
  if (!response.ok) {
    throw new GatewayError(
      `${action} failed with HTTP ${response.status}`,
      "t3_auth_failed",
      `T3 认证失败（HTTP ${response.status}）。请确认 pairing token 尚未过期且未被使用。`,
    );
  }
  return response.json();
}

export class BearerAuthStrategy implements T3AuthStrategy {
  private credential: T3Credential | undefined;

  constructor(existing?: T3Credential) {
    this.credential = existing;
  }

  canHandle(_descriptor: T3EnvironmentDescriptor): boolean {
    return true;
  }

  async authenticate(input: AuthInput): Promise<T3Credential> {
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: input.credential,
      subject_token_type: SUBJECT_TYPE,
      requested_token_type: ACCESS_TYPE,
      scope: SCOPES.join(" "),
      client_label: "T3 Vibe Gateway",
      client_device_type: "bot",
    });
    const response = await fetch(new URL("/oauth/token", input.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "t3-vibe-gateway/0.1",
      },
      body,
    });
    const result = AccessTokenResultSchema.parse(await checkedJson(response, "Token exchange"));
    if (result.token_type !== "Bearer") {
      throw new GatewayError(
        `Unsupported token type ${result.token_type}`,
        "unsupported_auth_strategy",
        `该 T3 返回了尚不支持的认证类型：${result.token_type}。`,
      );
    }
    const credential: T3Credential = {
      type: "bearer",
      accessToken: result.access_token,
      scopes: result.scope.split(/\s+/).filter(Boolean),
      expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
    };
    this.credential = credential;
    return credential;
  }

  async authorizeHttp(request: RequestInit): Promise<RequestInit> {
    const token = this.requireCredential();
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token.accessToken}`);
    return { ...request, headers };
  }

  async issueWebSocketTicket(baseUrl: string): Promise<string> {
    const token = this.requireCredential();
    const response = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        accept: "application/json",
        "user-agent": "t3-vibe-gateway/0.1",
      },
    });
    return WebSocketTicketSchema.parse(await checkedJson(response, "WebSocket ticket")).ticket;
  }

  getCredential(): T3Credential | undefined {
    return this.credential;
  }

  private requireCredential(): T3Credential {
    if (!this.credential) {
      throw new GatewayError(
        "Authentication required",
        "auth_required",
        "需要先连接并认证 T3 环境。",
      );
    }
    return this.credential;
  }
}
