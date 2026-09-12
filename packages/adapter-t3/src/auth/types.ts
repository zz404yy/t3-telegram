import type { T3EnvironmentDescriptor } from "../protocol/schemas.js";

export interface AuthInput {
  baseUrl: string;
  credential: string;
}

export interface T3Credential {
  type: "bearer" | "dpop";
  accessToken: string;
  expiresAt?: string;
  scopes: string[];
}

export interface T3AuthStrategy {
  canHandle(descriptor: T3EnvironmentDescriptor): boolean;
  authenticate(input: AuthInput): Promise<T3Credential>;
  authorizeHttp(request: RequestInit): Promise<RequestInit>;
  issueWebSocketTicket(baseUrl: string): Promise<string>;
}
