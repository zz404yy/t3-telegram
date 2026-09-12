import type { BackendConnectionStatus, EnvironmentRecord } from "../domain/types.js";

export interface PairEnvironmentInput {
  userId: string;
  baseUrl: string;
  bootstrapCredential: string;
  name?: string;
}

export interface PairEnvironmentResult {
  environment: EnvironmentRecord;
  status: BackendConnectionStatus;
}

export interface EnvironmentConnector {
  pair(input: PairEnvironmentInput): Promise<PairEnvironmentResult>;
}
