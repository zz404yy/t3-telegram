import { z } from "zod";

export const EnvironmentDescriptorSchema = z
  .object({
    environmentId: z.string(),
    label: z.string(),
    platform: z
      .object({
        os: z.string(),
        arch: z.string(),
        machine: z.string().optional(),
      })
      .passthrough(),
    serverVersion: z.string(),
    capabilities: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

export type T3EnvironmentDescriptor = z.infer<typeof EnvironmentDescriptorSchema>;

export const AuthSessionStateSchema = z
  .object({
    authenticated: z.boolean(),
    sessionMethod: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    auth: z
      .object({
        policy: z.string(),
        bootstrapMethods: z.array(z.string()),
        sessionMethods: z.array(z.string()),
        sessionCookieName: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type T3AuthSessionState = z.infer<typeof AuthSessionStateSchema>;

export const AccessTokenResultSchema = z
  .object({
    access_token: z.string(),
    issued_token_type: z.string(),
    token_type: z.string(),
    expires_in: z.number(),
    scope: z.string(),
  })
  .passthrough();

export const WebSocketTicketSchema = z
  .object({ ticket: z.string(), expiresAt: z.string() })
  .passthrough();

export const ShellSnapshotSchema = z
  .object({
    snapshotSequence: z.number(),
    projects: z.array(z.record(z.string(), z.unknown())),
    threads: z.array(z.record(z.string(), z.unknown())),
    updatedAt: z.string(),
  })
  .passthrough();

export type ShellSnapshot = z.infer<typeof ShellSnapshotSchema>;

export const ThreadSnapshotSchema = z
  .object({
    snapshotSequence: z.number(),
    thread: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const DispatchResultSchema = z
  .object({ sequence: z.number().int().nonnegative() })
  .passthrough();

export const RpcFrameSchema = z
  .object({
    _tag: z.string(),
    requestId: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type RpcFrame = z.infer<typeof RpcFrameSchema>;
